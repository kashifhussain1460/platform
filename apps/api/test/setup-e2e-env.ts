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

const CREDENTIALS_TESTS_MUST_NOT_SEE = [
  'OAUTH_GOOGLE_CLIENT_ID',
  'OAUTH_GOOGLE_CLIENT_SECRET',
  'OAUTH_MICROSOFT_CLIENT_ID',
  'OAUTH_MICROSOFT_CLIENT_SECRET',
  'OAUTH_SLACK_CLIENT_ID',
  'OAUTH_SLACK_CLIENT_SECRET',
  'OAUTH_HUBSPOT_CLIENT_ID',
  'OAUTH_HUBSPOT_CLIENT_SECRET',
] as const;

for (const key of CREDENTIALS_TESTS_MUST_NOT_SEE) {
  process.env[key] = '';
}

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
