import { googleApiGet, classifyGoogleError, accessTokenFrom } from './google-api.util';

describe('google-api.util', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('googleApiGet', () => {
    it('returns the parsed body on a 2xx response', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ emailAddress: 'hr@company.com' }),
      }) as unknown as typeof fetch;

      const result = await googleApiGet(
        'https://gmail.googleapis.com/gmail/v1/users/me/profile',
        'tok',
      );
      expect(result).toEqual({ ok: true, body: { emailAddress: 'hr@company.com' } });
    });

    it('returns a structured error on a non-2xx response, using the sent bearer token', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({
          error: { status: 'PERMISSION_DENIED', message: 'Insufficient scope' },
        }),
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      const result = await googleApiGet(
        'https://gmail.googleapis.com/gmail/v1/users/me/profile',
        'tok',
      );
      expect(result).toEqual({
        ok: false,
        error: { status: 403, reason: 'PERMISSION_DENIED', message: 'Insufficient scope' },
      });
      const [, init] = fetchMock.mock.calls[0];
      expect(init.headers.authorization).toBe('Bearer tok');
    });
  });

  describe('classifyGoogleError', () => {
    it('maps a 401 with UNAUTHENTICATED to EXPIRED', () => {
      expect(classifyGoogleError({ status: 401, reason: 'UNAUTHENTICATED', message: '' })).toBe(
        'EXPIRED',
      );
    });
    it('maps a bare 401 to AUTH_FAILED', () => {
      expect(classifyGoogleError({ status: 401, reason: null, message: '' })).toBe('AUTH_FAILED');
    });
    it('maps a 403 to INSUFFICIENT_SCOPE', () => {
      expect(classifyGoogleError({ status: 403, reason: 'PERMISSION_DENIED', message: '' })).toBe(
        'INSUFFICIENT_SCOPE',
      );
    });
    it('maps a 404 to ACCOUNT_NOT_FOUND', () => {
      expect(classifyGoogleError({ status: 404, reason: null, message: '' })).toBe(
        'ACCOUNT_NOT_FOUND',
      );
    });
    it('extracts an embedded status code from a plain error string (google-calendar.util shape)', () => {
      expect(classifyGoogleError('Calendar API error (403): insufficient scope')).toBe(
        'INSUFFICIENT_SCOPE',
      );
    });
    it('maps a thrown network error to CONNECTION_FAILED', () => {
      expect(classifyGoogleError(new Error('fetch failed'))).toBe('CONNECTION_FAILED');
    });
    it('falls back to ERROR for an unrecognisable shape', () => {
      expect(classifyGoogleError('nonsense')).toBe('ERROR');
    });
  });

  describe('accessTokenFrom', () => {
    it('reads accessToken or access_token, trims, and returns null when absent', () => {
      expect(accessTokenFrom({ accessToken: ' a ' })).toBe('a');
      expect(accessTokenFrom({ access_token: 'b' })).toBe('b');
      expect(accessTokenFrom({})).toBeNull();
      expect(accessTokenFrom({ accessToken: '' })).toBeNull();
    });
  });
});
