import { resolveFreshCredentials, type AccessTokenResolver } from './credentials.util';

describe('resolveFreshCredentials', () => {
  it('returns credentials unchanged for a non-oauth connection', async () => {
    const tokens: AccessTokenResolver = { getAccessToken: jest.fn() };
    const creds = { smtpPassword: 'secret' };
    const result = await resolveFreshCredentials(tokens, { id: 'c1', connectionType: 'api_key' }, creds);
    expect(result).toBe(creds);
    expect(tokens.getAccessToken).not.toHaveBeenCalled();
  });

  it('returns credentials unchanged for oauth with no refresh token', async () => {
    const tokens: AccessTokenResolver = { getAccessToken: jest.fn() };
    const creds = { accessToken: 'still-valid' };
    const result = await resolveFreshCredentials(tokens, { id: 'c1', connectionType: 'oauth' }, creds);
    expect(result).toBe(creds);
    expect(tokens.getAccessToken).not.toHaveBeenCalled();
  });

  it('splices in a fresh access token for oauth with a refresh token', async () => {
    const tokens: AccessTokenResolver = { getAccessToken: jest.fn().mockResolvedValue('fresh-token') };
    const creds = { accessToken: 'stale', refreshToken: 'rt-1' };
    const result = await resolveFreshCredentials(tokens, { id: 'c1', connectionType: 'oauth' }, creds);
    expect(result).toEqual({ accessToken: 'fresh-token', refreshToken: 'rt-1' });
    expect(tokens.getAccessToken).toHaveBeenCalledWith('c1');
  });

  it('keeps the original credentials and reports the error when refresh throws', async () => {
    const tokens: AccessTokenResolver = {
      getAccessToken: jest.fn().mockRejectedValue(new Error('invalid_grant')),
    };
    const creds = { accessToken: 'stale', refreshToken: 'rt-1' };
    const onError = jest.fn();
    const result = await resolveFreshCredentials(
      tokens,
      { id: 'c1', connectionType: 'oauth' },
      creds,
      onError,
    );
    expect(result).toBe(creds);
    expect(onError).toHaveBeenCalledWith('invalid_grant');
  });

  it('keeps the original credentials when getAccessToken returns empty (connector not found)', async () => {
    const tokens: AccessTokenResolver = { getAccessToken: jest.fn().mockResolvedValue('') };
    const creds = { accessToken: 'stale', refreshToken: 'rt-1' };
    const result = await resolveFreshCredentials(tokens, { id: 'c1', connectionType: 'oauth' }, creds);
    expect(result).toBe(creds);
  });
});
