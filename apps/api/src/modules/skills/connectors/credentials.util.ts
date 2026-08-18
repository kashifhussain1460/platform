import type { Prisma } from '@prisma/client';
import type { CryptoService } from '../../../common/crypto/crypto.service';

/**
 * Shared credential envelope helpers for the connector layer (SkillsService,
 * ConnectorHealthService, ConnectorTokenService). Secrets are stored on
 * `InstalledSkill.credentials` as an encrypted `{ enc: <v1:iv:tag:ct> }` envelope
 * and NEVER returned raw. Centralised here (single source of truth) so the health
 * probe + token refresh can read/re-seal creds without depending on SkillsService
 * (which would close a DI cycle).
 */

/**
 * Decrypt/unwrap stored credentials into the raw secrets object. Handles the
 * `{ enc: <envelope> }` shape, an empty/null column (→ `{}`), and legacy
 * plaintext objects written before encryption (→ used as-is).
 */
export function readCredentials(
  crypto: CryptoService,
  stored: Prisma.JsonValue | null,
): Record<string, unknown> {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
    return {};
  }
  const obj = stored as Record<string, unknown>;
  if (typeof obj.enc === 'string') {
    return crypto.decryptJson<Record<string, unknown>>(obj.enc);
  }
  // Back-compat: pre-encryption plaintext credentials — treat as raw secrets.
  return obj;
}

/**
 * Encrypt a raw secrets object into the `{ enc: <envelope> }` shape. Returns `{}`
 * for an empty object so `credentialsSet` stays false (no ciphertext for "no
 * secrets").
 */
export function sealCredentials(
  crypto: CryptoService,
  raw: Record<string, unknown>,
): Prisma.InputJsonObject {
  if (Object.keys(raw).length === 0) {
    return {};
  }
  return { enc: crypto.encryptJson(raw) };
}

/**
 * First non-empty trimmed string value among `keys` in `creds` (or ''). Used to
 * read token fields that providers spell differently (accessToken/access_token).
 */
export function credString(
  creds: Record<string, unknown>,
  ...keys: string[]
): string {
  for (const key of keys) {
    const value = creds[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

/** The one method `resolveFreshCredentials` needs — satisfied by `ConnectorTokenService` as-is. */
export interface AccessTokenResolver {
  getAccessToken(installedSkillId: string): Promise<string>;
}

/**
 * Refresh an OAuth connector's access token if it's near/passed expiry, and
 * return credentials with the fresh value spliced in. Extracted from
 * `SkillsService.resolveExecutorContext` (the tool-execution path already did
 * this) so `verifyConnection` and the health-check sweep get the SAME
 * guarantee: neither should report a perfectly valid connection as broken just
 * because the last real tool call was over an hour ago.
 *
 * Non-oauth connectors, and oauth connectors with no refresh token, are
 * returned unchanged — mirrors the existing tool-execution check exactly.
 */
export async function resolveFreshCredentials(
  tokens: AccessTokenResolver,
  installed: { id: string; connectionType: string | null },
  credentials: Record<string, unknown>,
  onRefreshError?: (message: string) => void,
): Promise<Record<string, unknown>> {
  const hasRefreshToken = Boolean(credString(credentials, 'refreshToken', 'refresh_token'));
  if (installed.connectionType !== 'oauth' || !hasRefreshToken) {
    return credentials;
  }
  try {
    const fresh = await tokens.getAccessToken(installed.id);
    if (fresh) {
      return { ...credentials, accessToken: fresh };
    }
  } catch (err) {
    onRefreshError?.(err instanceof Error ? err.message : String(err));
  }
  return credentials;
}
