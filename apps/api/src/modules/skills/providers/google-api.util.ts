import { asFetchResponse } from '../../../common/http/fetch-response';
import type { ConnectionFailureCode } from './provider-adapter';

/**
 * Shared, plain-function Google API helpers for the Wave-2 adapters (Gmail,
 * Calendar, Drive all speak the same Google JSON-error shape). Mirrors
 * `google-calendar.util.ts`'s "no injected services, just an access token in"
 * design so adapters stay easy to unit test.
 */

const GOOGLE_TIMEOUT_MS = 10_000;

export interface GoogleApiError {
  status: number;
  /** Google's `error.status` enum value, e.g. `PERMISSION_DENIED`. */
  reason: string | null;
  message: string;
}

export type GoogleApiResult<T> =
  | { ok: true; body: T }
  | { ok: false; error: GoogleApiError };

/** GET a Google API endpoint with a bearer token. Never throws for an HTTP-level failure. */
export async function googleApiGet<T = Record<string, unknown>>(
  url: string,
  accessToken: string,
): Promise<GoogleApiResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GOOGLE_TIMEOUT_MS);
  try {
    const res = asFetchResponse(
      await fetch(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${accessToken}` },
        signal: controller.signal,
      }),
    );
    const body = (await res.json().catch(() => ({}))) as {
      error?: { status?: string; message?: string };
    } & T;
    if (!res.ok) {
      return {
        ok: false,
        error: {
          status: res.status,
          reason: body?.error?.status ?? null,
          message: body?.error?.message ?? `Google API error (${res.status})`,
        },
      };
    }
    return { ok: true, body: body as T };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Maps a Google-shaped error (from {@link googleApiGet}, a thrown network
 * error, or the plain `"... (403): ..."` strings `google-calendar.util.ts`
 * already returns) onto the plan §3 vocabulary. A thrown `Error` is always a
 * network/timeout/DNS problem here — HTTP-level failures never throw.
 */
export function classifyGoogleError(error: unknown): ConnectionFailureCode {
  if (error instanceof Error) {
    return 'CONNECTION_FAILED';
  }
  const shape = normalise(error);
  if (!shape) return 'ERROR';
  if (shape.status === 401) return shape.reason === 'UNAUTHENTICATED' ? 'EXPIRED' : 'AUTH_FAILED';
  if (shape.status === 403) return 'INSUFFICIENT_SCOPE';
  if (shape.status === 404) return 'ACCOUNT_NOT_FOUND';
  if (shape.status >= 500) return 'CONNECTION_FAILED';
  return 'ERROR';
}

function normalise(error: unknown): { status: number; reason: string | null } | null {
  if (error && typeof error === 'object' && 'status' in error) {
    const e = error as GoogleApiError;
    return { status: e.status, reason: e.reason ?? null };
  }
  if (typeof error === 'string') {
    const match = error.match(/\((\d{3})\)/);
    if (match) return { status: Number(match[1]), reason: null };
  }
  return null;
}

/** First non-empty trimmed access token field (providers spell it differently). */
export function accessTokenFrom(creds: Record<string, unknown>): string | null {
  const token = creds['accessToken'] ?? creds['access_token'];
  return typeof token === 'string' && token.trim() ? token.trim() : null;
}
