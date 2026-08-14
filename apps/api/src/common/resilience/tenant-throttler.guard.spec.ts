import { createHmac } from 'node:crypto';
import { TenantAwareThrottlerGuard } from './tenant-throttler.guard';

const SECRET = 'test-access-secret';

const b64url = (obj: unknown) =>
  Buffer.from(JSON.stringify(obj)).toString('base64url');

/** A properly HS256-signed access token, as the app issues. */
function signedJwt(
  payload: Record<string, unknown>,
  secret = SECRET,
  alg = 'HS256',
): string {
  const head = b64url({ alg, typ: 'JWT' });
  const body = b64url(payload);
  const sig = createHmac('sha256', secret)
    .update(`${head}.${body}`)
    .digest('base64url');
  return `${head}.${body}.${sig}`;
}

/** A syntactically-valid but UNSIGNED token — what an attacker can trivially make. */
function forgedJwt(payload: Record<string, unknown>): string {
  return `${b64url({ alg: 'none' })}.${b64url(payload)}.sig`;
}

describe('TenantAwareThrottlerGuard.getTracker', () => {
  // getTracker is `protected` -- exercise it through a tiny subclass so the
  // test doesn't need a full Nest DI/module bootstrap for something that's
  // pure string-in/string-out logic.
  class TestableGuard extends TenantAwareThrottlerGuard {
    public track(req: Record<string, unknown>): Promise<string> {
      return this.getTracker(req);
    }
  }
  const guard = Object.create(TestableGuard.prototype) as TestableGuard;

  const previous = process.env.JWT_ACCESS_SECRET;
  beforeAll(() => {
    process.env.JWT_ACCESS_SECRET = SECRET;
  });
  afterAll(() => {
    process.env.JWT_ACCESS_SECRET = previous;
  });

  const track = (auth?: string, ip = '5.6.7.8') =>
    guard.track({
      headers: auth ? { authorization: auth } : {},
      ip,
    });

  it('keys by companyId when a Bearer JWT is present AND verifies', async () => {
    const token = signedJwt({ sub: 'user1', companyId: 'company-abc' });
    expect(await track(`Bearer ${token}`, '1.2.3.4')).toBe(
      'company:company-abc',
    );
  });

  // ── WAVE 2 §2.6 — the reason verification was added ────────────────────────

  it('IGNORES a forged (unsigned) companyId and falls back to IP', async () => {
    // Unverified, this claim let an attacker (a) escape their own limit by
    // rotating companyIds and (b) exhaust a VICTIM tenant's bucket by claiming
    // their id — neither of which needs an account with that tenant.
    const token = forgedJwt({ sub: 'attacker', companyId: 'victim-co' });
    expect(await track(`Bearer ${token}`)).toBe('5.6.7.8');
  });

  it('ignores a token signed with the WRONG secret', async () => {
    const token = signedJwt(
      { sub: 'u', companyId: 'victim-co' },
      'not-the-real-secret',
    );
    expect(await track(`Bearer ${token}`)).toBe('5.6.7.8');
  });

  it('rejects alg confusion — a valid signature under a declared alg we do not use', async () => {
    const token = signedJwt({ sub: 'u', companyId: 'victim-co' }, SECRET, 'none');
    expect(await track(`Bearer ${token}`)).toBe('5.6.7.8');
  });

  it('ignores an EXPIRED token, so it cannot keep steering a bucket', async () => {
    const token = signedJwt({
      sub: 'u',
      companyId: 'company-abc',
      exp: Math.floor(Date.now() / 1000) - 60,
    });
    expect(await track(`Bearer ${token}`)).toBe('5.6.7.8');
  });

  it('falls back to IP when no secret is configured — fails CLOSED', async () => {
    delete process.env.JWT_ACCESS_SECRET;
    const token = signedJwt({ sub: 'u', companyId: 'company-abc' });
    expect(await track(`Bearer ${token}`)).toBe('5.6.7.8');
    process.env.JWT_ACCESS_SECRET = SECRET;
  });

  // ── Unchanged behaviour ────────────────────────────────────────────────────

  it('falls back to IP when there is no Authorization header (pre-auth: login/register)', async () => {
    expect(await track(undefined)).toBe('5.6.7.8');
  });

  it('falls back to IP when the Authorization header is malformed', async () => {
    expect(await track('Bearer not-a-jwt')).toBe('5.6.7.8');
  });

  it('falls back to IP when the JWT verifies but has no companyId claim', async () => {
    expect(await track(`Bearer ${signedJwt({ sub: 'user1' })}`)).toBe(
      '5.6.7.8',
    );
  });
});
