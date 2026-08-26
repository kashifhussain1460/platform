/**
 * Refuse to boot in production with `CREDIT_GRANTS_ENABLED=true` but no real
 * mail channel to verify a signup email actually belongs to the signer.
 * Mirrors `requireRealProviderInProduction`'s exact shape — a config omission
 * should fail loudly at startup, not silently let free credits go out to
 * anyone who can type an email address nobody will ever verify.
 *
 * Kill-critic Q11: the free-grant premise is exploitable without this — the
 * default OTP is `123456` and there is no production boot-guard tying a
 * grant to a verified mailbox. This function is the boot-guard half of that
 * fix (the other half, the domain-velocity counter, runs at grant time —
 * Task 4.4 — never at registration, per §26's "never break signup" rule).
 */
export function requireMailEnabledInProduction(): void {
  if (
    process.env.NODE_ENV === 'production' &&
    process.env.CREDIT_GRANTS_ENABLED === 'true' &&
    process.env.MAIL_ENABLED !== 'true'
  ) {
    throw new Error(
      'CREDIT_GRANTS_ENABLED is true but MAIL_ENABLED is not — refusing to ' +
        'start in production granting free credits with no way to verify a ' +
        'signup email. Set MAIL_ENABLED=true (with real mail provider config) ' +
        'or leave CREDIT_GRANTS_ENABLED off.',
    );
  }
}
