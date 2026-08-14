import { createHmac } from 'node:crypto';
import { UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { CryptoService } from '../../../common/crypto/crypto.service';
import { PlaneClientService } from './plane-client.service';
import { PmWebhookController } from './pm-webhook.controller';

/**
 * WAVE 3 §3.5 — Plane inbound webhooks.
 *
 * Plane had no inbound path at all before this, so these tests are the first
 * statement of what "verified, deduped, canonical" means for the PM engine.
 */
describe('PmWebhookController', () => {
  const secret = 'plane-webhook-secret';
  const slug = 'acme';

  function build() {
    const prisma = {
      planeWorkspace: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'ws-row-1',
          companyId: 'company-1',
          planeWorkspaceSlug: slug,
          webhookSecret: `encrypted(${secret})`,
        }),
      },
    };
    const crypto = {
      decrypt: jest.fn((env: string) =>
        env.replace('encrypted(', '').replace(')', ''),
      ),
    } as unknown as CryptoService;
    const plane = new PlaneClientService({
      get: () => undefined,
    } as unknown as ConfigService);
    const ingest = {
      ingestVerified: jest
        .fn()
        .mockResolvedValue({ deduped: false, rawEventId: 'raw-1' }),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const controller = new PmWebhookController(
      prisma as never,
      crypto,
      plane,
      ingest as never,
      audit as never,
    );
    return { controller, prisma, ingest, audit };
  }

  /** Plane: plain hex HMAC of the RAW body — no timestamp, unlike Chatwoot. */
  const sign = (body: string, withSecret = secret) =>
    createHmac('sha256', withSecret).update(Buffer.from(body, 'utf8')).digest('hex');

  const req = (body: string) =>
    ({ rawBody: Buffer.from(body, 'utf8') }) as never;

  const body = JSON.stringify({
    event: 'issue',
    action: 'created',
    workspace_slug: slug,
    data: { id: 'issue-1', project: 'proj-1', name: 'Fix login' },
  });

  it('accepts a correctly signed delivery and ingests it', async () => {
    const { controller, ingest, audit } = build();
    const res = await controller.receive(req(body), sign(body));

    expect(res).toEqual({ ok: true });
    const arg = ingest.ingestVerified.mock.calls[0][0];
    expect(arg.provider).toBe('plane');
    expect(arg.companyId).toBe('company-1');
    // Tenant comes from the resolved workspace row, NEVER from the payload.
    expect(arg.connectorId).toBe('ws-row-1');
    expect(audit.record).toHaveBeenCalled();
  });

  it('rejects a wrong signature with 401 and ingests nothing', async () => {
    const { controller, ingest, audit } = build();
    await expect(
      controller.receive(req(body), sign(body, 'not-the-real-secret')),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(ingest.ingestVerified).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('rejects a missing signature header', async () => {
    const { controller, ingest } = build();
    await expect(
      controller.receive(req(body), undefined),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(ingest.ingestVerified).not.toHaveBeenCalled();
  });

  it('rejects an unknown workspace BEFORE verifying anything else', async () => {
    const { controller, prisma, ingest } = build();
    prisma.planeWorkspace.findFirst.mockResolvedValueOnce(null);
    await expect(
      controller.receive(req(body), sign(body)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(ingest.ingestVerified).not.toHaveBeenCalled();
  });

  it('rejects a payload with no workspace context', async () => {
    const { controller } = build();
    const noSlug = JSON.stringify({ event: 'issue', action: 'created' });
    await expect(
      controller.receive(req(noSlug), sign(noSlug)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('a DUPLICATE delivery is a no-op that still returns 200', async () => {
    // 200 stops Plane retrying; doing nothing further keeps side effects
    // at-most-once.
    const { controller, ingest, audit } = build();
    ingest.ingestVerified.mockResolvedValueOnce({
      deduped: true,
      rawEventId: 'raw-1',
    });
    const res = await controller.receive(req(body), sign(body));
    expect(res).toEqual({ ok: true });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('verifies the LITERAL bytes, so a re-serialised body does not match', async () => {
    // Re-serialising changes key order and whitespace; the HMAC would never
    // match. This pins the requirement rather than leaving it to a comment.
    const { controller } = build();
    const spaced = JSON.stringify(JSON.parse(body), null, 2);
    await expect(
      controller.receive(req(spaced), sign(body)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
