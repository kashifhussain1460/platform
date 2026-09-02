import { requireMailEnabledInProduction } from './require-mail-enabled';

describe('requireMailEnabledInProduction', () => {
  const originalEnv = {
    NODE_ENV: process.env.NODE_ENV,
    CREDIT_GRANTS_ENABLED: process.env.CREDIT_GRANTS_ENABLED,
    MAIL_ENABLED: process.env.MAIL_ENABLED,
    DEV_OTP_CODE: process.env.DEV_OTP_CODE,
  };
  let warn: jest.SpyInstance;

  beforeEach(() => {
    // The non-production branch warns on purpose; keep the test output readable.
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  /**
   * THE regression this file exists for (audit 2026-09-02, P0-1). The guard
   * used to require `CREDIT_GRANTS_ENABLED === 'true'`, and grants default to
   * false — so the ordinary production configuration booted with every
   * verification AND password-reset OTP pinned to `123456`.
   */
  it('throws in production when mail is off, even with credit grants DISABLED', () => {
    process.env.NODE_ENV = 'production';
    process.env.CREDIT_GRANTS_ENABLED = 'false';
    delete process.env.MAIL_ENABLED;
    expect(() => requireMailEnabledInProduction()).toThrow(/MAIL_ENABLED/);
  });

  it('throws in production when mail is off and credit grants are UNSET', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.CREDIT_GRANTS_ENABLED;
    delete process.env.MAIL_ENABLED;
    expect(() => requireMailEnabledInProduction()).toThrow(/take over any account/);
  });

  it('throws in production when mail is off and credit grants are enabled', () => {
    process.env.NODE_ENV = 'production';
    process.env.CREDIT_GRANTS_ENABLED = 'true';
    delete process.env.MAIL_ENABLED;
    expect(() => requireMailEnabledInProduction()).toThrow(/MAIL_ENABLED/);
  });

  it('treats MAIL_ENABLED="false" the same as unset', () => {
    process.env.NODE_ENV = 'production';
    process.env.MAIL_ENABLED = 'false';
    expect(() => requireMailEnabledInProduction()).toThrow(/MAIL_ENABLED/);
  });

  it('does not throw in production when mail is enabled', () => {
    process.env.NODE_ENV = 'production';
    process.env.MAIL_ENABLED = 'true';
    delete process.env.DEV_OTP_CODE;
    expect(() => requireMailEnabledInProduction()).not.toThrow();
  });

  it('throws in production when DEV_OTP_CODE is set, even with mail enabled', () => {
    process.env.NODE_ENV = 'production';
    process.env.MAIL_ENABLED = 'true';
    process.env.DEV_OTP_CODE = '000111';
    expect(() => requireMailEnabledInProduction()).toThrow(/DEV_OTP_CODE/);
  });

  it('does not throw outside production with mail off — but warns loudly', () => {
    process.env.NODE_ENV = 'test';
    delete process.env.MAIL_ENABLED;
    expect(() => requireMailEnabledInProduction()).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('123456'));
  });

  it('does not warn outside production when mail is enabled', () => {
    process.env.NODE_ENV = 'test';
    process.env.MAIL_ENABLED = 'true';
    requireMailEnabledInProduction();
    expect(warn).not.toHaveBeenCalled();
  });
});
