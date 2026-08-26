/**
 * Credit system Phase 4, Task 4.3 — a small, vendored static list of
 * disposable/temporary-email domains, consulted ONLY at the free-credit
 * grant point (`OnboardingService.complete()`), never at registration —
 * matching §26's "never break signup" rule. A disposable-domain signup
 * still completes onboarding and gets hired employees exactly as normal;
 * it simply receives no free-credit grant.
 *
 * Deliberately small and maintained by hand rather than a fetched/updated
 * feed: this is a cheap abuse deterrent, not a security boundary — a
 * determined abuser can always register a fresh throwaway domain the list
 * doesn't know about yet. The domain-velocity counter (Task 4.2) is the
 * layer that actually bounds repeat abuse from ANY domain, disposable or not.
 */
const DISPOSABLE_EMAIL_DOMAINS = new Set([
  'mailinator.com',
  'guerrillamail.com',
  'guerrillamail.info',
  '10minutemail.com',
  '10minutemail.net',
  'tempmail.com',
  'temp-mail.org',
  'throwawaymail.com',
  'yopmail.com',
  'trashmail.com',
  'getnada.com',
  'dispostable.com',
  'sharklasers.com',
  'maildrop.cc',
  'fakeinbox.com',
  'mailnesia.com',
  'mintemail.com',
  'spamgourmet.com',
  'discard.email',
  'mailcatch.com',
]);

/** True when `domain` (case-insensitive) is a known disposable-email provider. */
export function isDisposableEmailDomain(domain: string): boolean {
  return DISPOSABLE_EMAIL_DOMAINS.has(domain.trim().toLowerCase());
}
