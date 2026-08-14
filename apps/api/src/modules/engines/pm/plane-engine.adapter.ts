import { Injectable } from '@nestjs/common';
import { CryptoService } from '../../../common/crypto/crypto.service';
import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  EngineCapabilityUnsupportedError,
  type EngineAdapter,
  type EngineCapability,
  type EngineHealth,
  type EngineWebhookResult,
} from '../engine-adapter';
import { PlaneClientService } from './plane-client.service';

/**
 * §39 — Plane, behind the shared connector contract.
 *
 * A thin delegation to `PlaneClientService`. It adds no credential handling, no
 * audit and no retry: those live in the platform layers and duplicating them
 * here is what the contract exists to prevent.
 */
@Injectable()
export class PlaneEngineAdapter implements EngineAdapter {
  readonly engineKey = 'plane';

  constructor(
    private readonly plane: PlaneClientService,
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  capabilities(): readonly EngineCapability[] {
    // No `connect`: provisioning a workspace needs a live Plane instance to
    // verify the session-based sequence against, and `provisionWorkspace`
    // deliberately throws rather than pretending. Declaring it here would make
    // that honesty invisible to a caller.
    return ['disconnect', 'healthCheck', 'refresh', 'handleWebhook'];
  }

  tools(): readonly string[] {
    return ['plane.create_issue', 'plane.list_issues', 'plane.update_issue_status'];
  }

  connect(): Promise<never> {
    return Promise.reject(
      new EngineCapabilityUnsupportedError(
        this.engineKey,
        'connect',
        'workspace provisioning needs a live Plane instance to verify the session-based sequence; a workspace is registered out of band today',
      ),
    );
  }

  async disconnect(companyId: string): Promise<void> {
    // Removing the workspace row is what stops inbound deliveries verifying:
    // the webhook controller looks the secret up by workspace, so an unknown
    // workspace is rejected at the door.
    await this.prisma.planeWorkspace.deleteMany({ where: { companyId } });
  }

  async healthCheck(companyId: string): Promise<EngineHealth> {
    const workspace = await this.prisma.planeWorkspace.findFirst({
      where: { companyId },
      select: { id: true },
    });
    return workspace
      ? { ok: true }
      : { ok: false, detail: 'no Plane workspace is registered for this company' };
  }

  refresh(): Promise<void> {
    // Plane authenticates with a long-lived API key, so there is nothing to
    // refresh. A no-op, stated rather than left to be inferred from silence.
    return Promise.resolve();
  }

  reconcile(): Promise<{ checked: number; updated: number }> {
    return Promise.reject(
      new EngineCapabilityUnsupportedError(
        this.engineKey,
        'reconcile',
        'issues are event-driven; there is no local mirror of Plane state to re-derive',
      ),
    );
  }

  /**
   * Verify an inbound delivery. REAL verification — the HMAC is recomputed over
   * the literal bytes against the tenant's stored secret.
   *
   * Ingestion itself stays in `PmWebhookController`: it already resolves the
   * tenant and calls the canonical pipeline, and a second ingress path is
   * exactly what §37 forbids. So this answers "is this delivery genuine?" and
   * nothing else — which is the question the contract is for.
   *
   * A header-presence check would have been the tempting shortcut here, and it
   * would have reported `verified: true` for any forged request.
   */
  async handleWebhook(input: {
    rawBody: Buffer;
    headers: Record<string, string | undefined>;
  }): Promise<EngineWebhookResult> {
    const signature = input.headers['x-plane-signature'];
    if (!signature) return { verified: false };

    let payload: { workspace_slug?: string };
    try {
      payload = JSON.parse(input.rawBody.toString('utf8')) as {
        workspace_slug?: string;
      };
    } catch {
      return { verified: false };
    }

    const slug = payload.workspace_slug?.trim();
    if (!slug) return { verified: false };

    const workspace = await this.prisma.planeWorkspace.findFirst({
      where: { planeWorkspaceSlug: slug },
      select: { webhookSecret: true },
    });
    if (!workspace) return { verified: false };

    const secret = this.crypto.decrypt(workspace.webhookSecret);
    return {
      verified: this.plane.verifyWebhookSignature(
        input.rawBody,
        signature,
        secret,
      ),
    };
  }
}
