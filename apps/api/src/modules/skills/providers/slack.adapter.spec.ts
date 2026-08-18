import { slackAdapter } from './slack.adapter';

function mockFetchSequence(...bodies: unknown[]) {
  const fn = jest.fn();
  for (const body of bodies) fn.mockResolvedValueOnce({ ok: true, status: 200, json: async () => body });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

describe('slackAdapter', () => {
  afterEach(() => jest.restoreAllMocks());

  it('reports INVALID_CREDENTIALS with no bot token', async () => {
    const result = await slackAdapter.validateCredentials({ creds: {}, config: {} });
    expect(result.code).toBe('INVALID_CREDENTIALS');
  });

  it('validateCredentials passes on a real auth.test call', async () => {
    mockFetchSequence({ ok: true, team: 'Acme', user: 'orlixa-bot', team_id: 'T1', user_id: 'U1' });
    const result = await slackAdapter.validateCredentials({ creds: { accessToken: 'xoxb-1' }, config: {} });
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('Acme');
  });

  it('treats Slack\'s HTTP-200-with-{ok:false} as a failure, not a pass', async () => {
    mockFetchSequence({ ok: false, error: 'invalid_auth' });
    const result = await slackAdapter.validateCredentials({ creds: { accessToken: 'xoxb-bad' }, config: {} });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('REVOKED');
  });

  it('maps missing_scope to INSUFFICIENT_SCOPE', async () => {
    mockFetchSequence({ ok: false, error: 'missing_scope' });
    const result = await slackAdapter.validateCredentials({ creds: { accessToken: 'xoxb-1' }, config: {} });
    expect(result.code).toBe('INSUFFICIENT_SCOPE');
  });

  it('discoverAccount returns the workspace name from auth.test, no second call', async () => {
    const fetchMock = mockFetchSequence({ ok: true, team: 'Acme', user: 'orlixa-bot' });
    const result = await slackAdapter.discoverAccount!({ creds: { accessToken: 'xoxb-1' }, config: {} });
    expect(result.account).toBe('Acme');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('test() DMs the resolved user — lookup, open, then post', async () => {
    const fetchMock = mockFetchSequence(
      { ok: true, user: { id: 'U123' } }, // users.lookupByEmail
      { ok: true, channel: { id: 'D123' } }, // conversations.open
      { ok: true, ts: '123.456' }, // chat.postMessage
    );
    const result = await slackAdapter.test!(
      { creds: { accessToken: 'xoxb-1' }, config: {} },
      { requesterEmail: 'hr@company.com' },
    );
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [postUrl, postInit] = fetchMock.mock.calls[2];
    expect(postUrl).toContain('chat.postMessage');
    expect(JSON.parse((postInit as { body: string }).body).channel).toBe('D123');
  });

  it('test() prefers an explicit opts.to over requesterEmail', async () => {
    mockFetchSequence(
      { ok: true, user: { id: 'U999' } },
      { ok: true, channel: { id: 'D999' } },
      { ok: true, ts: '1' },
    );
    await slackAdapter.test!(
      { creds: { accessToken: 'xoxb-1' }, config: {} },
      { to: 'explicit@company.com', requesterEmail: 'ignored@company.com' },
    );
    const fetchMock = global.fetch as jest.Mock;
    const [lookupUrl] = fetchMock.mock.calls[0];
    expect(lookupUrl).toContain(encodeURIComponent('explicit@company.com'));
  });

  it('test() fails cleanly (never falls back to a real channel) when no email is available', async () => {
    const result = await slackAdapter.test!({ creds: { accessToken: 'xoxb-1' }, config: {} });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('TEST_FAILED');
  });

  it('test() fails cleanly when the email has no Slack account', async () => {
    mockFetchSequence({ ok: false, error: 'users_not_found' });
    const result = await slackAdapter.test!(
      { creds: { accessToken: 'xoxb-1' }, config: {} },
      { requesterEmail: 'nobody@company.com' },
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe('ACCOUNT_NOT_FOUND');
  });

  it('healthCheck delegates to validateCredentials', async () => {
    mockFetchSequence({ ok: true, team: 'Acme', user: 'orlixa-bot' });
    const result = await slackAdapter.healthCheck!({ creds: { accessToken: 'xoxb-1' }, config: {} });
    expect(result.ok).toBe(true);
  });
});
