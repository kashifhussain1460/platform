import type { ConfigService } from '@nestjs/config';
import { CryptoService } from '../../common/crypto/crypto.service';
import {
  LEAVE_REQUEST_PII_FIELDS,
  openPii,
  sealPii,
  STAFF_MEMBER_PII_FIELDS,
} from './hr-pii.util';

/**
 * Unit test for HR PII sealing (P3-01). Uses the real CryptoService with the
 * offline dev key (no ENCRYPTION_KEY) so it needs no infra.
 */
describe('hr-pii.util', () => {
  // A ConfigService stub that returns no ENCRYPTION_KEY → deterministic dev key.
  const crypto = new CryptoService({
    get: () => undefined,
  } as unknown as ConfigService);

  it('sealPii encrypts listed string fields into a v1 envelope', () => {
    const sealed = sealPii(
      crypto,
      { personalEmail: 'jane@home.com', phone: '+15551234', workEmail: 'jane@acme.com' },
      STAFF_MEMBER_PII_FIELDS,
    );
    expect(sealed.personalEmail).toMatch(/^v1:/);
    expect(sealed.phone).toMatch(/^v1:/);
    // Unlisted field is untouched.
    expect(sealed.workEmail).toBe('jane@acme.com');
  });

  it('round-trips through openPii back to plaintext', () => {
    const sealed = sealPii(
      crypto,
      { reason: 'Back surgery recovery' },
      LEAVE_REQUEST_PII_FIELDS,
    );
    expect(sealed.reason).toMatch(/^v1:/);
    const opened = openPii(crypto, sealed, LEAVE_REQUEST_PII_FIELDS);
    expect(opened.reason).toBe('Back surgery recovery');
  });

  it('leaves null / undefined / empty values untouched (preserves "clear" semantics)', () => {
    const sealed = sealPii(
      crypto,
      { personalEmail: null, phone: undefined, extra: '' as string },
      STAFF_MEMBER_PII_FIELDS,
    );
    expect(sealed.personalEmail).toBeNull();
    expect(sealed.phone).toBeUndefined();
  });

  it('openPii passes through a non-envelope value unchanged', () => {
    const opened = openPii(
      crypto,
      { reason: 'not-encrypted-legacy' },
      LEAVE_REQUEST_PII_FIELDS,
    );
    expect(opened.reason).toBe('not-encrypted-legacy');
  });

  it('openPii throws (never silently leaks) on a tampered envelope', () => {
    expect(() =>
      openPii(crypto, { reason: 'v1:aaa:bbb:ccc' }, LEAVE_REQUEST_PII_FIELDS),
    ).toThrow(/Failed to decrypt HR PII field "reason"/);
  });

  it('produces different ciphertext each time (random IV) but same plaintext', () => {
    const a = sealPii(crypto, { reason: 'same' }, LEAVE_REQUEST_PII_FIELDS);
    const b = sealPii(crypto, { reason: 'same' }, LEAVE_REQUEST_PII_FIELDS);
    expect(a.reason).not.toBe(b.reason);
    expect(openPii(crypto, a, LEAVE_REQUEST_PII_FIELDS).reason).toBe('same');
    expect(openPii(crypto, b, LEAVE_REQUEST_PII_FIELDS).reason).toBe('same');
  });
});
