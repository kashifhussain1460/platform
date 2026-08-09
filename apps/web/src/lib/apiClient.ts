import axios, {
  AxiosError,
  type InternalAxiosRequestConfig,
} from 'axios';
import { useSessionStore } from '@/stores/session.store';

const baseURL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

/** Normalized error shape surfaced to hooks/components. */
export interface NormalizedApiError {
  status: number;
  message: string;
  raw?: unknown;
}

export function normalizeError(error: unknown): NormalizedApiError {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status ?? 0;
    const data = error.response?.data as
      | { message?: string | string[] }
      | undefined;
    const message = Array.isArray(data?.message)
      ? data?.message.join(', ')
      : data?.message ?? error.message;
    return { status, message, raw: error.response?.data };
  }
  return { status: 0, message: 'Unexpected error', raw: error };
}

/**
 * The SINGLE axios instance for the app (module singleton).
 * - withCredentials so the httpOnly refresh cookie flows.
 * - request interceptor attaches the access token from the Zustand store.
 * - response interceptor attempts a single refresh on 401, then normalizes.
 */
export const apiClient = axios.create({
  baseURL,
  withCredentials: true,
  headers: { 'Content-Type': 'application/json' },
});

apiClient.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  const token = useSessionStore.getState().accessToken;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// De-dupe concurrent refreshes into a single in-flight promise.
let refreshing: Promise<string | null> | null = null;

async function refreshAccessToken(): Promise<string | null> {
  try {
    const { data } = await axios.post<{ tokens?: { accessToken?: string } }>(
      `${baseURL}/auth/refresh`,
      {},
      { withCredentials: true },
    );
    const token = data?.tokens?.accessToken ?? null;
    if (token) {
      useSessionStore.getState().setAccessToken(token);
    }
    return token;
  } catch {
    useSessionStore.getState().clear();
    return null;
  }
}

/**
 * Endpoints that answer "is this session still good?". A 401 from one of these
 * means the session is genuinely over (expired, revoked, or the account was
 * disabled mid-session) and the client must drop it. Credential-submitting
 * endpoints (/auth/login, /auth/register) are excluded on purpose: a 401 there
 * just means "wrong password" and is handled by the form.
 */
const SESSION_VALIDATION_PATHS = ['/auth/me', '/auth/refresh'];

apiClient.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const original = error.config as
      | (InternalAxiosRequestConfig & { _retry?: boolean })
      | undefined;

    const url = original?.url ?? '';
    const isAuthCall = url.includes('/auth/');

    // Without this, a disabled account holding a not-yet-expired access token
    // stayed "authenticated" client-side while every request 401'd — a broken
    // half-logged-in app instead of a clean bounce to /login.
    if (
      error.response?.status === 401 &&
      SESSION_VALIDATION_PATHS.some((path) => url.includes(path))
    ) {
      useSessionStore.getState().clear();
      return Promise.reject(normalizeError(error));
    }

    if (
      error.response?.status === 401 &&
      original &&
      !original._retry &&
      !isAuthCall
    ) {
      original._retry = true;
      refreshing = refreshing ?? refreshAccessToken();
      const token = await refreshing;
      refreshing = null;

      if (token) {
        original.headers.Authorization = `Bearer ${token}`;
        return apiClient(original);
      }
    }

    return Promise.reject(normalizeError(error));
  },
);
