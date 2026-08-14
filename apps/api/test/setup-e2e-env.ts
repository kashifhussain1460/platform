/**
 * Jest `setupFiles` hook — runs BEFORE any test module is imported.
 *
 * Why this file has to exist at all: `ConfigModule.forRoot()` is evaluated when
 * `config.module.ts` is *imported*, not when a test's `beforeAll` runs. By the
 * time a spec could clear an environment variable, dotenv has already read
 * `apps/api/.env` and the value is baked into ConfigService. So neutralising
 * real credentials must happen here, at the earliest possible point.
 *
 * What it fixes: `integrations.e2e-spec.ts` asserts the OAuth-UNCONFIGURED
 * branch (`GET .../oauth/authorize` → 400). Any developer with real
 * `OAUTH_GOOGLE_*` values in their local `.env` saw that test fail while CI
 * passed — which is precisely the "known flaky, ignore it" state that lets real
 * regressions hide. Tests must never pick up a developer's live credentials.
 *
 * Set to '' rather than deleted on purpose: dotenv only populates keys that are
 * absent from `process.env`, so an empty string both reads as unconfigured and
 * blocks the file value from being re-applied.
 */

/**
 * Real mail is the same class of problem as real OAuth credentials, and worse.
 *
 * `apps/api/.env` carries `MAIL_ENABLED=true` with live Hostinger SMTP
 * credentials, so with the file value in force the e2e suite (a) generates a
 * RANDOM verification OTP instead of the fixed dev `123456`, which is why
 * `auth-email-verification.e2e-spec.ts` failed with 400 on every full run, and
 * (b) would attempt to DELIVER real messages to the addresses tests invent.
 *
 * Forcing it off here is not a test convenience — it is the difference between
 * a deterministic suite and one that emails strangers.
 */
process.env.MAIL_ENABLED = 'false';

const CREDENTIALS_TESTS_MUST_NOT_SEE = [
  'OAUTH_GOOGLE_CLIENT_ID',
  'OAUTH_GOOGLE_CLIENT_SECRET',
  'OAUTH_MICROSOFT_CLIENT_ID',
  'OAUTH_MICROSOFT_CLIENT_SECRET',
  'OAUTH_SLACK_CLIENT_ID',
  'OAUTH_SLACK_CLIENT_SECRET',
  'OAUTH_HUBSPOT_CLIENT_ID',
  'OAUTH_HUBSPOT_CLIENT_SECRET',
  // Same reasoning: a real SMTP password must never be reachable from a test.
  'SMTP_PASS',
  // And the same again for model vendors.
  //
  // `apps/api/.env` carries `LLM_PROVIDER=openai` with a live key. Provider
  // SELECTION deliberately is not pinned here (see the note at the bottom of
  // this file — pinning it broke engines-support), so a run that forgets to
  // export `LLM_PROVIDER=mock` reaches the real OpenAI provider. That is how a
  // suite quietly starts spending money and returning non-deterministic text,
  // and it is how a `400 Unrecognized request argument supplied: signal` from
  // the LIVE API turned up in a workflow test.
  //
  // Blanking the KEYS is the belt to that braces: selection may still land on a
  // vendor, but the provider then fails loudly at `getOrThrow` instead of
  // silently calling out. Loud and free beats quiet and billed.
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
] as const;

for (const key of CREDENTIALS_TESTS_MUST_NOT_SEE) {
  process.env[key] = '';
}

/**
 * The operator/cron shared secret, pinned for the same import-time reason as
 * everything above.
 *
 * `CronController` and `MetricsController` compare against
 * `config.get('CRON_SECRET')`, and ConfigService SNAPSHOTS the environment when
 * `config.module.ts` is imported. Two suites set `process.env.CRON_SECRET` in
 * their own `beforeAll`, which is far too late: on any machine whose `.env`
 * already carries a CRON_SECRET, ConfigService holds the developer's value, the
 * request carries the test's, and six assertions get a 403 that has nothing to
 * do with the behaviour under test. It passed in CI (no `.env`) and failed
 * locally — the exact shape of "known flaky" that hides real regressions.
 *
 * Pinned here, ConfigService and the tests agree by construction.
 *
 * NOTE for anyone touching `inline-execution.e2e-spec.ts`: because of that same
 * snapshot, its `delete process.env.CRON_SECRET` cannot actually disable the
 * routes mid-suite. Its "disabled when unset" case currently passes because an
 * absent header is rejected anyway — it does not prove the disabled branch.
 */
process.env.CRON_SECRET = 'e2e-cron-secret';

// NOTHING ELSE BELONGS HERE.
//
// An earlier version of this file also defaulted LLM_PROVIDER / SKILL_EXECUTOR /
// BILLING_PROVIDER here. That broke `e2e/engines-support.e2e-spec.ts`: because
// dotenv has not run yet at this point, `process.env.SKILL_EXECUTOR` is still
// undefined, so a `??=` default silently WON over the `auto` value in
// apps/api/.env — and dotenv then refused to overwrite it. The suite's expected
// ERROR became SUCCESS.
//
// Provider selection is a per-run choice (CI pins it explicitly in
// .github/workflows/api-ci.yml). This file's single job is to make sure no test
// ever sees a developer's real credentials.
