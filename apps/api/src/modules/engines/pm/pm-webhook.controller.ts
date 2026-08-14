import {
  Controller,
  Headers,
  HttpCode,
  Logger,
  Post,
  Req,
  UnauthorizedException,
  type RawBodyRequest,
} from '@nestjs/common';
import type { Request } from 'express';
import { CryptoService } from '../../../common/crypto/crypto.service';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AuditLogService } from '../../audit/audit-log.service';
import { CanonicalIngestService } from '../../events/ingestion/canonical-ingest.service';
import { PlaneClientService } from './plane-client.service';
import { PLANE_PROVIDER, PLANE_SIGNATURE_HEADER } from './pm.constants';

interface PlaneWebhookPayload {
  event?: string;
  action?: string;
  /** Plane echoes the workspace the delivery belongs to. */
  workspace_slug?: string;
  data?: Record<string, unknown>;
}

/**
 * WAVE 3 §3.5 — PUBLIC Plane webhook ingress.
 *
 * Plane had NO inbound path at all before this: `plane-client.service.ts` could
 * push work out, but nothing could come back, so no workflow could react to an
 * issue being created or moved. This is the missing half.
 *
 * **Plane does not sign the way Chatwoot does.** The plan calls that out
 * explicitly and it is true: Chatwoot's HMAC covers `timestamp.body` and arrives
 * in `x-chatwoot-signature`, while Plane sends a plain hex HMAC of the raw body
 * in `x-plane-signature` with no timestamp component. Sharing a verifier between
 * them would have to guess, and a signature check that guesses is not a
 * signature check — so verification stays with each engine and only the
 * downstream pipeline is shared.
 *
 * ORDERING, same rule as the Support engine: verification completes BEFORE any
 * tenant data is read or written, and a failure returns 401 having touched
 * nothing. The single pre-verification read is the `PlaneWorkspace` lookup
 * needed to know which secret to verify against — keyed by the untrusted
 * workspace slug in the payload, read-only, and yielding nothing to the caller
 * either way.
 */
@Controller('engines/pm/webhook')
export class PmWebhookController {
  private readonly logger = new Logger(PmWebhookController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly plane: PlaneClientService,
    private readonly ingest: CanonicalIngestService,
    private readonly audit: AuditLogService,
  ) {}

  @Post()
  @HttpCode(200)
  async receive(
    @Req() req: RawBodyRequest<Request>,
    @Headers(PLANE_SIGNATURE_HEADER) signature?: string,
  ): Promise<{ ok: boolean }> {
    if (!req.rawBody) {
      throw new UnauthorizedException('Missing request body');
    }
    if (!signature) {
      throw new UnauthorizedException('Missing webhook signature');
    }

    let payload: PlaneWebhookPayload;
    try {
      payload = JSON.parse(req.rawBody.toString('utf8')) as PlaneWebhookPayload;
    } catch {
      throw new UnauthorizedException('Invalid payload');
    }

    const slug = payload.workspace_slug?.trim();
    if (!slug) {
      throw new UnauthorizedException('Missing workspace context');
    }

    const workspace = await this.prisma.planeWorkspace.findFirst({
      where: { planeWorkspaceSlug: slug },
    });
    if (!workspace) {
      throw new UnauthorizedException('Unknown Plane workspace');
    }

    const secret = this.crypto.decrypt(workspace.webhookSecret);
    // Verify the LITERAL bytes received. Re-serialising the parsed object first
    // would change key order and whitespace, and the HMAC would never match.
    const verified = this.plane.verifyWebhookSignature(
      req.rawBody,
      signature,
      secret,
    );
    if (!verified) {
      this.logger.warn(
        `Rejected Plane webhook: signature mismatch for workspace=${slug}`,
      );
      throw new UnauthorizedException('Invalid webhook signature');
    }

    // ---- Signature verified. Only past this line may tenant data be written. ----
    const ingest = await this.ingest.ingestVerified({
      companyId: workspace.companyId,
      connectorId: workspace.id,
      provider: PLANE_PROVIDER,
      rawBody: req.rawBody,
      headers: { [PLANE_SIGNATURE_HEADER]: signature },
      payload,
    });

    if (ingest.deduped) {
      this.logger.log(`Duplicate Plane delivery ignored (workspace=${slug})`);
      return { ok: true };
    }

    await this.audit.record({
      companyId: workspace.companyId,
      action: 'pm.webhook.received',
      entityType: 'RawEvent',
      entityId: ingest.rawEventId ?? undefined,
      metadata: {
        provider: PLANE_PROVIDER,
        event: payload.event ?? null,
        planeAction: payload.action ?? null,
        workspaceSlug: slug,
      },
    });
    return { ok: true };
  }
}
