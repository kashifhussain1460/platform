import { requireMailEnabledInProduction } from './require-mail-enabled';

describe('requireMailEnabledInProduction', () => {
  const originalEnv = {
    NODE_ENV: process.env.NODE_ENV,
    CREDIT_GRANTS_ENABLED: process.env.CREDIT_GRANTS_ENABLED,
    MAIL_ENABLED: process.env.MAIL_ENABLED,
  };

  afterEach(() => {
    process.env.NODE_ENV = originalEnv.NODE_ENV;
    process.env.CREDIT_GRANTS_ENABLED = originalEnv.CREDIT_GRANTS_ENABLED;
    process.env.MAIL_ENABLED = originalEnv.MAIL_ENABLED;
  });

  it('throws in production when grants are enabled but mail is not', () => {
    process.env.NODE_ENV = 'production';
    process.env.CREDIT_GRANTS_ENABLED = 'true';
    delete process.env.MAIL_ENABLED;
    expect(() => requireMailEnabledInProduction()).toThrow(/MAIL_ENABLED/);
  });

  it('does not throw in production when grants are enabled and mail is enabled', () => {
    process.env.NODE_ENV = 'production';
    process.env.CREDIT_GRANTS_ENABLED = 'true';
    process.env.MAIL_ENABLED = 'true';
    expect(() => requireMailEnabledInProduction()).not.toThrow();
  });

  it('does not throw in production when grants are disabled, regardless of mail', () => {
    process.env.NODE_ENV = 'production';
    process.env.CREDIT_GRANTS_ENABLED = 'false';
    delete process.env.MAIL_ENABLED;
    expect(() => requireMailEnabledInProduction()).not.toThrow();
  });

  it('does not throw outside production even with grants on and mail off', () => {
    process.env.NODE_ENV = 'test';
    process.env.CREDIT_GRANTS_ENABLED = 'true';
    delete process.env.MAIL_ENABLED;
    expect(() => requireMailEnabledInProduction()).not.toThrow();
  });
});
