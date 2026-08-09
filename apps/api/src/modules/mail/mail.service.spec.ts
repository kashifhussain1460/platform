import { MailService } from './mail.service';

const cfg = (values: Record<string, string | undefined>) =>
  ({ get: (k: string) => values[k], getOrThrow: (k: string) => values[k]! }) as never;

describe('MailService.generateOtp', () => {
  it('returns the fixed dev OTP 123456 when mail is disabled (default)', () => {
    const svc = new MailService(cfg({}));
    expect(svc.enabled()).toBe(false);
    expect(svc.generateOtp()).toBe('123456');
  });

  it('honours a custom DEV_OTP_CODE while disabled', () => {
    const svc = new MailService(cfg({ DEV_OTP_CODE: '000111' }));
    expect(svc.generateOtp()).toBe('000111');
  });

  it('returns a random 6-digit code when mail is enabled', () => {
    const svc = new MailService(cfg({ MAIL_ENABLED: 'true' }));
    expect(svc.enabled()).toBe(true);
    const code = svc.generateOtp();
    expect(code).toMatch(/^\d{6}$/);
  });

  it('does not deliver (no throw) when disabled', async () => {
    const svc = new MailService(cfg({}));
    await expect(svc.sendVerificationOtp('a@b.co', '123456')).resolves.toBeUndefined();
  });
});
