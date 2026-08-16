import {
  getProviderAdapter,
  runVerification,
  type SkillProviderAdapter,
} from './index';
import { resolveSmtpSettings, smtpAdapter } from './smtp.adapter';

/**
 * The connection framework's contract (plan §3, §28, §37).
 *
 * The behaviour under test is the one the plan is built around: a connection
 * cannot reach READY until every required stage passes, and a stage that could
 * not run must report SKIPPED rather than a green tick.
 */
describe('provider adapter registry', () => {
  it('resolves the SMTP adapter for the email skill', () => {
    expect(getProviderAdapter('email')).toBe(smtpAdapter);
  });

  it('returns null for a skill with no adapter, so it keeps the old behaviour', () => {
    // Deliberate: the strict verify gate only applies to providers Orlixa can
    // actually check. Returning a stub here would reject connections for a
    // dozen integrations that have no way to validate anything.
    expect(getProviderAdapter('stripe')).toBeNull();
    expect(getProviderAdapter('github')).toBeNull();
  });
});

describe('runVerification', () => {
  const base = (over: Partial<SkillProviderAdapter> = {}): SkillProviderAdapter => ({
    key: 'test',
    validateCredentials: async () => ({ ok: true }),
    classifyError: () => 'ERROR',
    ...over,
  });
  const input = { creds: {}, config: {} };

  it('stops at the first failure instead of running later stages', async () => {
    const test = jest.fn();
    const result = await runVerification(
      base({
        validateCredentials: async () => ({
          ok: false,
          detail: 'bad password',
          code: 'INVALID_CREDENTIALS',
        }),
        test,
      }),
      input,
      { includeTest: true },
    );

    expect(result.ok).toBe(false);
    expect(result.code).toBe('INVALID_CREDENTIALS');
    // Running a test send against credentials that already failed produces a
    // second, more confusing error for the same root cause.
    expect(test).not.toHaveBeenCalled();
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]).toMatchObject({ key: 'credentials', status: 'FAILED' });
  });

  it('marks an unrun test as SKIPPED, never PASSED', async () => {
    // §37: a connection is only complete when it has been tested. An untested
    // one must say so rather than showing a tick it did not earn.
    const result = await runVerification(base({ test: async () => ({ ok: true }) }), input, {
      includeTest: false,
    });

    expect(result.ok).toBe(true);
    const outbound = result.steps.find((s) => s.key === 'outbound');
    expect(outbound?.status).toBe('SKIPPED');
  });

  it('runs the test action when asked and reports its failure', async () => {
    const result = await runVerification(
      base({ test: async () => ({ ok: false, detail: 'relay denied', code: 'TEST_FAILED' }) }),
      input,
      { includeTest: true },
    );

    expect(result.ok).toBe(false);
    expect(result.code).toBe('TEST_FAILED');
    expect(result.steps.find((s) => s.key === 'outbound')?.detail).toBe('relay denied');
  });

  it('reports the discovered account', async () => {
    const result = await runVerification(
      base({ discoverAccount: async () => ({ account: 'hr@dotsquares.com' }) }),
      input,
    );
    expect(result.account).toBe('hr@dotsquares.com');
    expect(result.steps.find((s) => s.key === 'account')?.status).toBe('PASSED');
  });

  it('turns a thrown provider error into a classified failure, not a 500', async () => {
    const result = await runVerification(
      base({
        validateCredentials: async () => {
          throw new Error('socket hang up');
        },
        classifyError: () => 'CONNECTION_FAILED',
      }),
      input,
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe('CONNECTION_FAILED');
    expect(result.steps[0].detail).toContain('socket hang up');
  });
});

describe('resolveSmtpSettings', () => {
  const full = {
    config: {
      smtpHost: 'smtp.dotsquares.com',
      smtpPort: 587,
      smtpSecurity: 'starttls',
      smtpUser: 'kashif.hussain@dotsquares.com',
      fromAddress: 'hr@dotsquares.com',
      fromName: 'Dotsquares HR',
    },
    creds: { smtpPassword: 'app-password' },
  };

  it('reads host/user from config and the password ONLY from credentials', () => {
    const settings = resolveSmtpSettings(full);
    expect(settings).toMatchObject({
      host: 'smtp.dotsquares.com',
      port: 587,
      user: 'kashif.hussain@dotsquares.com',
      password: 'app-password',
      from: 'hr@dotsquares.com',
    });
  });

  it('ignores a password placed in plaintext config', () => {
    // The password is a `secret: true` catalog field, so it is stored encrypted
    // in credentials. Accepting it from config would silently allow a plaintext
    // password if the schema were ever mis-edited.
    const settings = resolveSmtpSettings({
      config: { ...full.config, smtpPassword: 'plaintext-leak' },
      creds: {},
    });
    expect(settings).toBeNull();
  });

  it('maps port 465 to implicit TLS and 587 to required STARTTLS', () => {
    const tls = resolveSmtpSettings({
      config: { ...full.config, smtpPort: 465, smtpSecurity: 'tls' },
      creds: full.creds,
    });
    expect(tls).toMatchObject({ secure: true, requireTLS: false });

    const starttls = resolveSmtpSettings(full);
    // requireTLS, not just "offer TLS": without it nodemailer will continue
    // unencrypted if the server's STARTTLS advertisement is missing/stripped,
    // and the mailbox password crosses the wire in clear.
    expect(starttls).toMatchObject({ secure: false, requireTLS: true });
  });

  it('defaults security from the port when it is not set', () => {
    const settings = resolveSmtpSettings({
      config: { smtpHost: 'mail.example.com', smtpPort: 465, smtpUser: 'a@b.com' },
      creds: { smtpPassword: 'x' },
    });
    expect(settings).toMatchObject({ secure: true });
  });

  it('falls back to the username when no From address is given', () => {
    const settings = resolveSmtpSettings({
      config: { smtpHost: 'mail.example.com', smtpUser: 'a@b.com' },
      creds: { smtpPassword: 'x' },
    });
    expect(settings?.from).toBe('a@b.com');
  });

  it('returns null until host, user AND password are all present', () => {
    expect(resolveSmtpSettings({ config: {}, creds: {} })).toBeNull();
    expect(
      resolveSmtpSettings({ config: { smtpHost: 'h', smtpUser: 'u' }, creds: {} }),
    ).toBeNull();
  });
});

describe('smtpAdapter.classifyError', () => {
  it('maps a rejected password to INVALID_CREDENTIALS', () => {
    const err = Object.assign(new Error('Invalid login: 535-5.7.8 Username and Password not accepted'), {
      code: 'EAUTH',
    });
    expect(smtpAdapter.classifyError(err)).toBe('INVALID_CREDENTIALS');
  });

  it('maps an unreachable host to CONNECTION_FAILED', () => {
    const err = Object.assign(new Error('getaddrinfo ENOTFOUND smtp.wrong.com'), {
      code: 'ENOTFOUND',
    });
    expect(smtpAdapter.classifyError(err)).toBe('CONNECTION_FAILED');
  });

  it('maps a refused sender/recipient to TEST_FAILED', () => {
    const err = Object.assign(new Error('Mail from address not accepted'), {
      code: 'EENVELOPE',
    });
    expect(smtpAdapter.classifyError(err)).toBe('TEST_FAILED');
  });

  it('refuses to verify with incomplete settings rather than pretending', async () => {
    const check = await smtpAdapter.validateCredentials({ creds: {}, config: {} });
    expect(check.ok).toBe(false);
    expect(check.code).toBe('INVALID_CREDENTIALS');
  });
});
