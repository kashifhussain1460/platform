import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * WAVE 2 §2.6 — read a JWT's `companyId` claim, but ONLY after verifying the
 * signature.
 *
 * This used to decode the payload without any signature check, on the reasoning
 * that the value "only picks a rate-limit bucket" and grants no authorization.
 * That reasoning misses what a rate-limit bucket IS: shared, exhaustible state
 * keyed by a value the caller controls. Unverified, an attacker could
 *
 *  1. **escape their own limit** — forge a fresh `companyId` per request and
 *     never hit a bucket twice, which removes the limit entirely; and
 *  2. **exhaust a victim's limit** — forge a competitor's `companyId` and burn
 *     their quota, denying service to a tenant they have no account with.
 *
 * Neither needs a valid signature, and both are invisible in an audit log that
 * records the real caller. Verification turns the claim into something the
 * caller cannot choose.
 *
 * A token that fails verification is not an error here — it falls back to the
 * per-IP bucket, exactly like an unauthenticated request. The endpoint's own
 * `JwtAuthGuard` is what rejects it.
 */
function verifiedCompanyId(authHeader: unknown): string | null {
  if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  const secret = process.env.JWT_ACCESS_SECRET;
  if (!secret) {
    // No secret configured (tests/dev): fall back to per-IP rather than trust an
    // unverified claim. Failing CLOSED here costs a little fairness; failing
    // open would reinstate the exact hole this function exists to close.
    return null;
  }

  const token = authHeader.slice('Bearer '.length);
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = parts;

  try {
    const header = JSON.parse(
      Buffer.from(headerB64, 'base64url').toString('utf8'),
    ) as { alg?: unknown };
    // Only HS256 — the algorithm the app signs with. Honouring whatever the
    // token declares is the classic `alg: none` confusion attack.
    if (header?.alg !== 'HS256') return null;

    const expected = createHmac('sha256', secret)
      .update(`${headerB64}.${payloadB64}`)
      .digest();
    const actual = Buffer.from(signatureB64, 'base64url');
    if (
      expected.length !== actual.length ||
      !timingSafeEqual(expected, actual)
    ) {
      return null;
    }

    const payload = JSON.parse(
      Buffer.from(payloadB64, 'base64url').toString('utf8'),
    ) as { companyId?: unknown; exp?: unknown };

    // An expired token must not keep steering a bucket.
    if (typeof payload.exp === 'number' && payload.exp * 1000 < Date.now()) {
      return null;
    }
    const companyId = payload.companyId;
    return typeof companyId === 'string' && companyId ? companyId : null;
  } catch {
    return null;
  }
}

/**
 * Rate-limit key: per-company when the request carries a VERIFIED JWT with a
 * companyId claim (every authenticated endpoint), else per-IP (pre-auth
 * endpoints like login/register, where per-IP is the correct signal — there's
 * no tenant yet to key on, and it's exactly the brute-force guard those limits
 * exist for).
 *
 * Closes the founder-audit edge-case finding (2026-07-19): plain IP-based
 * limiting unfairly throttles an entire company sharing one office/VPN IP
 * together, and doesn't isolate one company's traffic from a different company
 * that happens to share the same IP (e.g. behind the same corporate proxy).
 */
@Injectable()
export class TenantAwareThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    const headers = req.headers as Record<string, unknown> | undefined;
    const companyId = verifiedCompanyId(headers?.authorization);
    if (companyId) {
      return `company:${companyId}`;
    }
    return super.getTracker(req);
  }
}
