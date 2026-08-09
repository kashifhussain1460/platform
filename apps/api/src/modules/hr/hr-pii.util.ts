import type { CryptoService } from '../../common/crypto/crypto.service';

/**
 * Application-layer PII encryption for the HR domain (Wave P3-01).
 *
 * Special-category (health) and personal PII is stored as a CryptoService
 * AES-256-GCM envelope in the SAME String column (never a separate table, never
 * indexed, never used in WHERE). We seal on write and open on read; the DTOs the
 * API returns always carry decrypted plaintext, and only OWNER/ADMIN can read HR.
 *
 * The field lists below are the single source of truth for "what is encrypted"
 * and are mirrored by the 🔒 annotations in schema.prisma.
 */

export const STAFF_MEMBER_PII_FIELDS = ['personalEmail', 'phone'] as const;
export const LEAVE_REQUEST_PII_FIELDS = ['reason'] as const;
export const STAFF_DOCUMENT_PII_FIELDS = ['fileName'] as const;
export const PERFORMANCE_REVIEW_PII_FIELDS = ['aiDraft', 'finalReview'] as const;

/** A CryptoService envelope always starts with the version tag. */
const ENVELOPE_PREFIX = 'v1:';

/**
 * Return a shallow copy of `data` with the named fields encrypted. `null`,
 * `undefined` and empty strings pass through untouched (nothing to protect, and
 * we must preserve "clear this field" semantics on update).
 */
export function sealPii<T extends Record<string, unknown>>(
  crypto: CryptoService,
  data: T,
  fields: readonly string[],
): T {
  const out: Record<string, unknown> = { ...data };
  for (const field of fields) {
    const value = out[field];
    if (typeof value === 'string' && value.length > 0) {
      out[field] = crypto.encrypt(value);
    }
  }
  return out as T;
}

/**
 * Return a shallow copy of `row` with the named fields decrypted. A value that
 * is not an envelope (e.g. legacy plaintext) is left as-is. A value that IS an
 * envelope but fails to decrypt is a real problem (wrong ENCRYPTION_KEY or
 * tampering) — we throw with the field name (never the ciphertext) rather than
 * silently leak an unreadable blob to the client.
 */
export function openPii<T extends Record<string, unknown>>(
  crypto: CryptoService,
  row: T,
  fields: readonly string[],
): T {
  const out: Record<string, unknown> = { ...row };
  for (const field of fields) {
    const value = out[field];
    if (typeof value === 'string' && value.startsWith(ENVELOPE_PREFIX)) {
      try {
        out[field] = crypto.decrypt(value);
      } catch (err) {
        throw new Error(
          `Failed to decrypt HR PII field "${field}": ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }
  return out as T;
}
