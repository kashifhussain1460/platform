import { gmailAdapter } from './gmail.adapter';

function mockFetchSequence(...responses: Array<{ ok: boolean; status?: number; json: () => Promise<unknown> }>) {
  const fn = jest.fn();
  for (const r of responses) fn.mockResolvedValueOnce(r);
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

describe('gmailAdapter', () => {
  afterEach(() => jest.restoreAllMocks());

  it('reports INVALID_CREDENTIALS when there is no access token', async () => {
    const result = await gmailAdapter.validateCredentials({ creds: {}, config: {} });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('INVALID_CREDENTIALS');
  });

  it('validateCredentials passes on a real profile fetch and names the account', async () => {
    mockFetchSequence({ ok: true, status: 200, json: async () => ({ emailAddress: 'hr@company.com' }) });
    const result = await gmailAdapter.validateCredentials({ creds: { accessToken: 'tok' }, config: {} });
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('hr@company.com');
  });

  it('classifies a 403 as INSUFFICIENT_SCOPE with a safe detail message', async () => {
    mockFetchSequence({
      ok: false,
      status: 403,
      json: async () => ({ error: { status: 'PERMISSION_DENIED', message: 'Insufficient scope' } }),
    });
    const result = await gmailAdapter.validateCredentials({ creds: { accessToken: 'tok' }, config: {} });
    expect(result).toEqual({ ok: false, detail: 'Insufficient scope', code: 'INSUFFICIENT_SCOPE' });
  });

  it('discoverAccount returns the profile email', async () => {
    mockFetchSequence({ ok: true, status: 200, json: async () => ({ emailAddress: 'hr@company.com' }) });
    const result = await gmailAdapter.discoverAccount!({ creds: { accessToken: 'tok' }, config: {} });
    expect(result).toEqual({ account: 'hr@company.com' });
  });

  it('validateInbound reports an honest "assumed" pass — Gmail is polled, not configured here', async () => {
    const result = await gmailAdapter.validateInbound!({ creds: { accessToken: 'tok' }, config: {} });
    expect(result.ok).toBe(true);
    expect(result.assumed).toBe(true);
  });

  it('test() defaults to the connection\'s own address and sends a real message', async () => {
    const fetchMock = mockFetchSequence(
      { ok: true, status: 200, json: async () => ({ emailAddress: 'hr@company.com' }) }, // discoverAccount
      { ok: true, status: 200, json: async () => ({ id: 'msg-1' }) }, // send
    );
    const result = await gmailAdapter.test!({ creds: { accessToken: 'tok' }, config: {} });
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('hr@company.com');
    const [sendUrl, sendInit] = fetchMock.mock.calls[1];
    expect(sendUrl).toContain('/messages/send');
    const body = JSON.parse((sendInit as { body: string }).body);
    expect(typeof body.raw).toBe('string');
  });

  it('test() sends to an explicit address when opts.to is given, without a discoverAccount call', async () => {
    const fetchMock = mockFetchSequence({ ok: true, status: 200, json: async () => ({ id: 'msg-2' }) });
    const result = await gmailAdapter.test!(
      { creds: { accessToken: 'tok' }, config: {} },
      { to: 'someone@else.com' },
    );
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('healthCheck delegates to validateCredentials', async () => {
    mockFetchSequence({ ok: true, status: 200, json: async () => ({ emailAddress: 'hr@company.com' }) });
    const result = await gmailAdapter.healthCheck!({ creds: { accessToken: 'tok' }, config: {} });
    expect(result.ok).toBe(true);
  });

  it('classifyError delegates to classifyGoogleError', () => {
    expect(gmailAdapter.classifyError({ status: 401, reason: 'UNAUTHENTICATED', message: '' })).toBe(
      'EXPIRED',
    );
  });
});
