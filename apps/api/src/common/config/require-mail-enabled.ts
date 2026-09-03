/**
 * Refuse to boot in production without a real mail channel.
 *
 * ## Why this is unconditional
 *
 * `MailService.generateOtp()` returns the FIXED dev code (`DEV_OTP_CODE`,
 * default `123456`) whenever `MAIL_ENABLED !== 'true'` — and `MAIL_ENABLED`
 * defaults to unset. That generator serves BOTH email verification AND
 * `AuthService.forgotPassword`, so with mail off the password-reset code is a
 * public constant. The 2026-09-02 audit reproduced the whole chain against a
 * live API: `forgot-password` → `verify-reset-otp` with `123456` →
 * `reset-password` → the attacker logs in and the owner is locked out, knowing
 * nothing but the victim's email address.
 *
 * This guard used to fire only when `CREDIT_GRANTS_ENABLED === 'true'`, because
 * it was written for a narrower problem (free credits going to unverified
 * mailboxes — kill-critic Q11). Credit grants default to `false`, so the
 * common production configuration booted happily with every OTP pinned to a
 * known value. The condition is gone: account recovery is not a feature you
 * can have half of.
 *
 * `scripts/preflight-env.mjs` checks the same thing at deploy time. That gate
 * is real but it is OUTSIDE the application — it depends on `NODE_ENV` being
 * present in the pulled Vercel env, and a manual `vercel deploy`, a different
 * host or a self-hosted install bypasses it entirely. This function is the
 * half that travels with the code.
 */
export function requireMailEnabledInProduction(): void {
  if (process.env.NODE_ENV === 'production' && process.env.MAIL_ENABLED !== 'true') {
    throw new Error(
      'MAIL_ENABLED is not "true" but NODE_ENV is production — refusing to start. ' +
        `MailService.generateOtp() would return the fixed code ${
          process.env.DEV_OTP_CODE || '123456'
        }, ` +
        'which is used for BOTH email verification and password reset: anyone could take ' +
        'over any account from its email address alone. Set MAIL_ENABLED=true with real ' +
        'SMTP_* configuration.',
    );
  }

  // Belt and braces for the case the guard above cannot see: a deployment that
  // is really production but does not say so in NODE_ENV. Nothing can be
  // enforced from here, so say it loudly instead of failing silently.
  //
  // Not under NODE_ENV=test: the e2e suite boots ~100 Nest apps with mail
  // deliberately off, and the first version of this warning printed once per
  // boot — a wall of identical text that trained people to scroll past the
  // suite's real output. A test process cannot be "exposed to the internet".
  if (process.env.MAIL_ENABLED !== 'true' && process.env.NODE_ENV !== 'test') {
    // eslint-disable-next-line no-console -- runs before the Nest logger exists
    console.warn(
      '[auth] MAIL_ENABLED is not "true": every verification AND password-reset ' +
        `OTP is the fixed value ${process.env.DEV_OTP_CODE || '123456'}. This is safe ` +
        'ONLY on a local or test environment. Never expose this process to the internet.',
    );
  }

  if (process.env.NODE_ENV === 'production' && process.env.DEV_OTP_CODE) {
    throw new Error(
      'DEV_OTP_CODE is set in production — refusing to start. It pins every OTP to a ' +
        'known value even when mail is enabled. Remove it.',
    );
  }
}
