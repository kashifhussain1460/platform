import { calendarAdapter } from './calendar.adapter';

function mockFetchSequence(...responses: Array<{ ok: boolean; status?: number; json: () => Promise<unknown> }>) {
  const fn = jest.fn();
  for (const r of responses) fn.mockResolvedValueOnce(r);
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

describe('calendarAdapter', () => {
  afterEach(() => jest.restoreAllMocks());

  it('reports INVALID_CREDENTIALS with no access token', async () => {
    const result = await calendarAdapter.validateCredentials({ creds: {}, config: {} });
    expect(result.code).toBe('INVALID_CREDENTIALS');
  });

  it('validateCredentials passes on a real calendarList fetch', async () => {
    mockFetchSequence({
      ok: true,
      status: 200,
      json: async () => ({ items: [{ id: 'primary', summary: 'hr@company.com', primary: true }] }),
    });
    const result = await calendarAdapter.validateCredentials({ creds: { accessToken: 'tok' }, config: {} });
    expect(result.ok).toBe(true);
  });

  it('discoverAccount returns the primary calendar id', async () => {
    mockFetchSequence({
      ok: true,
      status: 200,
      json: async () => ({ items: [{ id: 'hr@company.com', summary: 'HR', primary: true }] }),
    });
    const result = await calendarAdapter.discoverAccount!({ creds: { accessToken: 'tok' }, config: {} });
    expect(result.account).toBe('hr@company.com');
  });

  it('test() creates then deletes a real event, and still passes if cleanup fails', async () => {
    mockFetchSequence(
      { ok: true, status: 200, json: async () => ({ id: 'evt-1', htmlLink: 'https://x', conferenceData: undefined }) }, // create
      { ok: false, status: 500, json: async () => ({}) }, // delete fails
    );
    const result = await calendarAdapter.test!({ creds: { accessToken: 'tok' }, config: {} });
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('could not remove it automatically');
  });

  it('test() fails cleanly when event creation fails', async () => {
    mockFetchSequence({ ok: false, status: 403, json: async () => ({ error: { message: 'insufficient scope' } }) });
    const result = await calendarAdapter.test!({ creds: { accessToken: 'tok' }, config: {} });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('INSUFFICIENT_SCOPE');
  });

  it('healthCheck delegates to validateCredentials', async () => {
    mockFetchSequence({ ok: true, status: 200, json: async () => ({ items: [] }) });
    const result = await calendarAdapter.healthCheck!({ creds: { accessToken: 'tok' }, config: {} });
    expect(result.ok).toBe(true);
  });
});
