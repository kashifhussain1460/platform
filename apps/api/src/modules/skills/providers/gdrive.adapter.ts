import { googleApiGet, classifyGoogleError, accessTokenFrom } from './google-api.util';
import type {
  AdapterCheck,
  AdapterInput,
  ConnectionFailureCode,
  DiscoveredAccount,
  SkillProviderAdapter,
} from './provider-adapter';

/** GOOGLE DRIVE — plan §19. */

const MISSING = 'Reconnect this Google account — no access token is stored yet.';
const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';
const TEST_TIMEOUT_MS = 10_000;

export const gdriveAdapter: SkillProviderAdapter = {
  key: 'gdrive',

  async validateCredentials(input: AdapterInput): Promise<AdapterCheck> {
    const token = accessTokenFrom(input.creds);
    if (!token) return { ok: false, detail: MISSING, code: 'INVALID_CREDENTIALS' };
    const result = await googleApiGet<{ user?: { emailAddress?: string } }>(
      'https://www.googleapis.com/drive/v3/about?fields=user',
      token,
    );
    if (!result.ok) {
      return { ok: false, detail: result.error.message, code: classifyGoogleError(result.error) };
    }
    return {
      ok: true,
      detail: `Signed in to Google Drive as ${result.body.user?.emailAddress ?? 'unknown user'}`,
    };
  },

  async discoverAccount(input: AdapterInput): Promise<DiscoveredAccount> {
    const token = accessTokenFrom(input.creds);
    if (!token) return { account: null };
    const result = await googleApiGet<{ user?: { emailAddress?: string } }>(
      'https://www.googleapis.com/drive/v3/about?fields=user',
      token,
    );
    return { account: result.ok ? (result.body.user?.emailAddress ?? null) : null };
  },

  /** §19 "Test List Files" — creates a small real file, then deletes it. */
  async test(input: AdapterInput): Promise<AdapterCheck> {
    const token = accessTokenFrom(input.creds);
    if (!token) return { ok: false, detail: MISSING, code: 'INVALID_CREDENTIALS' };
    const folderId = str(input.config?.['folderId']);
    const boundary = `orlixa-${Date.now()}`;
    const metadata: Record<string, unknown> = { name: 'Orlixa connection test.txt' };
    if (folderId) metadata.parents = [folderId];
    const body =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\nContent-Type: text/plain\r\n\r\nCreated by Orlixa to test this connection.\r\n` +
      `--${boundary}--`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
    let created: { id?: string; error?: { message?: string } };
    let status = 0;
    try {
      const res = await fetch(UPLOAD_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': `multipart/related; boundary=${boundary}`,
        },
        body,
        signal: controller.signal,
      });
      status = res.status;
      created = (await res.json().catch(() => ({}))) as typeof created;
      if (!res.ok || !created.id) {
        return {
          ok: false,
          detail: created.error?.message ?? `Drive upload failed (${status})`,
          code: classifyGoogleError({ status, reason: null, message: created.error?.message ?? '' }),
        };
      }
    } catch (error) {
      return { ok: false, detail: message(error), code: classifyGoogleError(error) };
    } finally {
      clearTimeout(timer);
    }
    const deleted = await deleteFile(token, created.id);
    return {
      ok: true,
      detail: deleted
        ? 'Created and removed a test file in Google Drive.'
        : 'Created a test file in Google Drive (could not remove it automatically — delete "Orlixa connection test.txt" manually).',
    };
  },

  async healthCheck(input: AdapterInput): Promise<AdapterCheck> {
    return gdriveAdapter.validateCredentials(input);
  },

  classifyError(error: unknown): ConnectionFailureCode {
    return classifyGoogleError(error);
  },
};

async function deleteFile(token: string, fileId: string): Promise<boolean> {
  try {
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`,
      { method: 'DELETE', headers: { authorization: `Bearer ${token}` } },
    );
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? 'Unknown error');
}
