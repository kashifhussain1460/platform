import { gdriveAdapter } from './gdrive.adapter';

function mockFetchSequence(...responses: Array<{ ok: boolean; status?: number; json: () => Promise<unknown> }>) {
  const fn = jest.fn();
  for (const r of responses) fn.mockResolvedValueOnce(r);
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

describe('gdriveAdapter', () => {
  afterEach(() => jest.restoreAllMocks());

  it('reports INVALID_CREDENTIALS with no access token', async () => {
    const result = await gdriveAdapter.validateCredentials({ creds: {}, config: {} });
    expect(result.code).toBe('INVALID_CREDENTIALS');
  });

  it('validateCredentials passes and names the account', async () => {
    mockFetchSequence({
      ok: true,
      status: 200,
      json: async () => ({ user: { emailAddress: 'hr@company.com', displayName: 'HR' } }),
    });
    const result = await gdriveAdapter.validateCredentials({ creds: { accessToken: 'tok' }, config: {} });
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('hr@company.com');
  });

  it('discoverAccount returns the user email', async () => {
    mockFetchSequence({
      ok: true,
      status: 200,
      json: async () => ({ user: { emailAddress: 'hr@company.com' } }),
    });
    const result = await gdriveAdapter.discoverAccount!({ creds: { accessToken: 'tok' }, config: {} });
    expect(result.account).toBe('hr@company.com');
  });

  it('test() creates then deletes a real file, and still passes if cleanup fails', async () => {
    mockFetchSequence(
      { ok: true, status: 200, json: async () => ({ id: 'file-1' }) }, // upload
      { ok: false, status: 500, json: async () => ({}) }, // delete fails
    );
    const result = await gdriveAdapter.test!({ creds: { accessToken: 'tok' }, config: {} });
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('could not remove it automatically');
  });

  it('test() uses the configured folder as a parent when set', async () => {
    const fetchMock = mockFetchSequence(
      { ok: true, status: 200, json: async () => ({ id: 'file-2' }) },
      { ok: true, status: 200, json: async () => ({}) },
    );
    await gdriveAdapter.test!({ creds: { accessToken: 'tok' }, config: { folderId: 'folder-abc' } });
    const [, uploadInit] = fetchMock.mock.calls[0];
    expect((uploadInit as { body: string }).body).toContain('folder-abc');
  });

  it('test() fails cleanly when upload fails', async () => {
    mockFetchSequence({ ok: false, status: 403, json: async () => ({ error: { message: 'insufficient scope' } }) });
    const result = await gdriveAdapter.test!({ creds: { accessToken: 'tok' }, config: {} });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('INSUFFICIENT_SCOPE');
  });

  it('healthCheck delegates to validateCredentials', async () => {
    mockFetchSequence({ ok: true, status: 200, json: async () => ({ user: {} }) });
    const result = await gdriveAdapter.healthCheck!({ creds: { accessToken: 'tok' }, config: {} });
    expect(result.ok).toBe(true);
  });
});
