import { createHash } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import { CryptoService } from '../../../common/crypto/crypto.service';
import type { PrismaService } from '../../../common/prisma/prisma.service';
import type { SkillsService } from '../skills.service';
import { OAuthService } from './oauth.service';

/**
 * WAVE 2 §2.5 — OAuth hardening.
 *
 * The flow used to be entirely stateless: an HMAC-signed `state` and nothing on
 * the server. That signs the state but does not make it SINGLE-USE, so anyone
 * who captured the callback URL could re-submit it until the TTL expired, and
 * there was nowhere to keep a PKCE verifier.
 */
const env: Record<string, string> = {
  WEB_ORIGIN: 'http://localhost:3000',
  OAUTH_REDIRECT_BASE: 'http://localhost:4000',
  OAUTH_GOOGLE_CLIENT_ID: 'client-id',
  OAUTH_GOOGLE_CLIENT_SECRET: 'client-secret',
  ENCRYPTION_KEY: 'a'.repeat(64),
};

const config = {
  get: (k: string) => env[k],
} as unknown as ConfigService;

describe('OAuthService — state + PKCE', () => {
  const crypto = new CryptoService(config);

  /** An in-memory stand-in for the OAuthAuthorizationRequest table. */
  function makePrisma() {
    const rows = new Map<string, Record<string, unknown>>();
    return {
      rows,
      oAuthAuthorizationRequest: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          rows.set(data.nonce as string, { id: `r_${rows.size}`, ...data });
          return rows.get(data.nonce as string);
        }),
        findUnique: jest.fn(
          async ({ where }: { where: { nonce: string } }) =>
            rows.get(where.nonce) ?? null,
        ),
        updateMany: jest.fn(
          async ({
            where,
            data,
          }: {
            where: { id: string; usedAt: null };
            data: { usedAt: Date };
          }) => {
            for (const row of rows.values()) {
              if (row.id === where.id && row.usedAt == null) {
                row.usedAt = data.usedAt;
                return { count: 1 };
              }
            }
            return { count: 0 };
          },
        ),
      },
    } as unknown as PrismaService & {
      rows: Map<string, Record<string, unknown>>;
    };
  }

  const skills = {
    getOwnedInstalled: jest.fn(async () => ({ skillKey: 'gmail' })),
    connectOAuth: jest.fn(async () => undefined),
  } as unknown as SkillsService;

  const build = () => {
    const prisma = makePrisma();
    return { prisma, oauth: new OAuthService(config, crypto, skills, prisma) };
  };

  const stateFrom = (url: string) =>
    new URL(url).searchParams.get('state') as string;

  it('sends an S256 PKCE challenge and keeps the verifier server-side', async () => {
    const { prisma, oauth } = build();
    const url = await oauth.buildAuthorizeUrl('co1', 'is1', { userId: 'u1' });
    const params = new URL(url).searchParams;

    expect(params.get('code_challenge_method')).toBe('S256');
    const challenge = params.get('code_challenge');
    expect(challenge).toBeTruthy();

    // The verifier is stored, never sent. An authorization code intercepted
    // from the redirect is useless without it — that is the whole point of PKCE.
    const row = [...prisma.rows.values()][0];
    const verifier = row.codeVerifier as string;
    expect(verifier).toBeTruthy();
    expect(url).not.toContain(verifier);
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(
      challenge,
    );
  });

  it('records the pending request bound to the tenant, skill and user', async () => {
    const { prisma, oauth } = build();
    await oauth.buildAuthorizeUrl('co1', 'is1', { userId: 'u1' });
    const row = [...prisma.rows.values()][0];
    expect(row.companyId).toBe('co1');
    expect(row.installedSkillId).toBe('is1');
    expect(row.userId).toBe('u1');
    expect(row.usedAt).toBeUndefined();
    expect((row.expiresAt as Date).getTime()).toBeGreaterThan(Date.now());
  });

  it('consumes the state exactly once — a replayed callback is rejected', async () => {
    const { prisma, oauth } = build();
    const url = await oauth.buildAuthorizeUrl('co1', 'is1', {});
    const state = stateFrom(url);

    // The token exchange itself is out of scope here (it needs the network), so
    // assert on the CLAIM instead: the first callback marks the row used, and
    // the guarded update makes the second one impossible.
    const first = await oauth.handleCallback('code-1', state);
    const row = [...prisma.rows.values()][0];
    expect(row.usedAt).toBeInstanceOf(Date);
    // The exchange fails (no network), which is fine — the state was consumed.
    expect(first).toContain('http://localhost:3000');

    const second = await oauth.handleCallback('code-1', state);
    expect(second).toContain('state_already_used');
  });

  it('rejects a state whose stored row disagrees with the signed payload', async () => {
    const { prisma, oauth } = build();
    const url = await oauth.buildAuthorizeUrl('co1', 'is1', {});
    const state = stateFrom(url);
    // Simulate tampering: the signed state and the row are produced together,
    // so any disagreement means one of them was altered.
    const row = [...prisma.rows.values()][0];
    row.companyId = 'other-co';

    const result = await oauth.handleCallback('code-1', state);
    expect(result).toContain('invalid_state');
  });

  it('rejects an expired pending request', async () => {
    const { prisma, oauth } = build();
    const url = await oauth.buildAuthorizeUrl('co1', 'is1', {});
    const state = stateFrom(url);
    const row = [...prisma.rows.values()][0];
    row.expiresAt = new Date(Date.now() - 1000);

    const result = await oauth.handleCallback('code-1', state);
    expect(result).toContain('state_expired');
  });

  it('rejects an unknown nonce — a forged state never reaches the exchange', async () => {
    const { oauth } = build();
    const url = await oauth.buildAuthorizeUrl('co1', 'is1', {});
    const state = stateFrom(url);
    // Same signed state, but the server has no record of it (e.g. swept).
    const { oauth: fresh } = build();
    const result = await fresh.handleCallback('code-1', state);
    expect(result).toContain('invalid_state');
  });
});
