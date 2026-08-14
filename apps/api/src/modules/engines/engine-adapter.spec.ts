import type { CryptoService } from '../../common/crypto/crypto.service';
import type { PrismaService } from '../../common/prisma/prisma.service';
import {
  ENGINE_ADAPTER_METHODS,
  EngineCapabilityUnsupportedError,
  type EngineAdapter,
} from './engine-adapter';
import type { MarketingSyncService } from './marketing/marketing-sync.service';
import type { PostizClientService } from './marketing/postiz-client.service';
import { PostizEngineAdapter } from './marketing/postiz-engine.adapter';
import type { PlaneClientService } from './pm/plane-client.service';
import { PlaneEngineAdapter } from './pm/plane-engine.adapter';
import type { ChatwootClientService } from './support/chatwoot-client.service';
import { ChatwootEngineAdapter } from './support/chatwoot-engine.adapter';

/**
 * §39 — the connector contract, enforced rather than described.
 *
 * A contract that lives only in a doc comment is a convention, and the reason
 * §39 exists is that three engines had already drifted into three conventions.
 * This suite is what makes the next engine implement it: add an adapter to
 * `ADAPTERS` below and the shape is checked for you.
 */
describe('EngineAdapter contract (§39)', () => {
  const verifyWebhookSignature = jest.fn();
  const plane = { verifyWebhookSignature } as unknown as PlaneClientService;
  const findFirst = jest.fn();
  const deleteMany = jest.fn().mockResolvedValue({ count: 1 });
  const chatwootFindFirst = jest.fn();
  const prisma = {
    planeWorkspace: { findFirst, deleteMany },
    chatwootAccount: { findFirst: chatwootFindFirst, deleteMany },
  } as unknown as PrismaService;

  const chatwoot = {
    verifyWebhookSignature: jest.fn().mockReturnValue(true),
  } as unknown as ChatwootClientService;
  const postiz = {
    getConnectUrl: jest.fn().mockResolvedValue({ url: 'https://postiz.test/x' }),
    listIntegrations: jest.fn().mockResolvedValue([]),
  } as unknown as PostizClientService;
  const sync = {
    sweep: jest.fn().mockResolvedValue({ reconciled: 0 }),
  } as unknown as MarketingSyncService;
  const crypto = {
    decrypt: jest.fn().mockReturnValue('plain-secret'),
  } as unknown as CryptoService;

  // Every engine, so the contract is enforced across all three rather than
  // demonstrated on one. Adding a new engine means adding a line here.
  const ADAPTERS: EngineAdapter[] = [
    new PlaneEngineAdapter(plane, prisma, crypto),
    new ChatwootEngineAdapter(chatwoot, prisma, crypto),
    new PostizEngineAdapter(postiz, sync),
  ];

  beforeEach(() => {
    verifyWebhookSignature.mockReset().mockReturnValue(true);
    findFirst.mockReset();
    (crypto.decrypt as jest.Mock).mockClear();
  });

  it.each(ADAPTERS.map((a) => [a.engineKey, a] as const))(
    '%s implements every method the contract requires',
    (_key, adapter) => {
      for (const method of ENGINE_ADAPTER_METHODS) {
        expect(typeof adapter[method]).toBe('function');
      }
      expect(adapter.engineKey).toBeTruthy();
    },
  );

  it.each(ADAPTERS.map((a) => [a.engineKey, a] as const))(
    '%s declares only capabilities it will not throw on',
    async (_key, adapter) => {
      // The honesty check. A capability list is only useful if calling something
      // it advertises does not immediately reject — otherwise a caller who
      // checks first is no better off than one who guesses.
      const declared = adapter.capabilities();
      if (declared.includes('refresh')) {
        await expect(adapter.refresh('co_1')).resolves.toBeUndefined();
      }
      if (!declared.includes('connect')) {
        await expect(adapter.connect('co_1')).rejects.toBeInstanceOf(
          EngineCapabilityUnsupportedError,
        );
      }
      if (!declared.includes('reconcile')) {
        await expect(adapter.reconcile('co_1')).rejects.toBeInstanceOf(
          EngineCapabilityUnsupportedError,
        );
      } else {
        await expect(adapter.reconcile('co_1')).resolves.toMatchObject({
          checked: expect.any(Number),
          updated: expect.any(Number),
        });
      }
      if (!declared.includes('handleWebhook')) {
        await expect(
          adapter.handleWebhook({ rawBody: Buffer.from('{}'), headers: {} }),
        ).rejects.toBeInstanceOf(EngineCapabilityUnsupportedError);
      }
    },
  );

  it.each(ADAPTERS.map((a) => [a.engineKey, a] as const))(
    '%s names its tools as skillKey.tool',
    (_key, adapter) => {
      for (const tool of adapter.tools()) {
        expect(tool).toMatch(/^[a-z0-9_]+\.[a-z0-9_]+$/);
        expect(tool.startsWith(`${adapter.engineKey}.`)).toBe(true);
      }
    },
  );

  describe('plane.handleWebhook actually verifies', () => {
    const adapter = new PlaneEngineAdapter(plane, prisma, crypto);
    const body = Buffer.from(JSON.stringify({ workspace_slug: 'acme' }));

    it('rejects a delivery with no signature without touching the database', async () => {
      const result = await adapter.handleWebhook({ rawBody: body, headers: {} });

      expect(result.verified).toBe(false);
      expect(findFirst).not.toHaveBeenCalled();
    });

    it('rejects an unknown workspace', async () => {
      findFirst.mockResolvedValue(null);

      const result = await adapter.handleWebhook({
        rawBody: body,
        headers: { 'x-plane-signature': 'deadbeef' },
      });

      expect(result.verified).toBe(false);
      expect(verifyWebhookSignature).not.toHaveBeenCalled();
    });

    it('recomputes the HMAC over the LITERAL bytes against the stored secret', async () => {
      // Not a header-presence check. That shortcut would report verified:true
      // for any forged request, which is the whole failure mode signatures
      // exist to prevent.
      findFirst.mockResolvedValue({ webhookSecret: 'enc:...' });

      const result = await adapter.handleWebhook({
        rawBody: body,
        headers: { 'x-plane-signature': 'deadbeef' },
      });

      expect(result.verified).toBe(true);
      expect(verifyWebhookSignature).toHaveBeenCalledWith(
        body,
        'deadbeef',
        'plain-secret',
      );
    });

    it('reports NOT verified when the HMAC does not match', async () => {
      findFirst.mockResolvedValue({ webhookSecret: 'enc:...' });
      verifyWebhookSignature.mockReturnValue(false);

      const result = await adapter.handleWebhook({
        rawBody: body,
        headers: { 'x-plane-signature': 'wrong' },
      });

      expect(result.verified).toBe(false);
    });
  });
});
