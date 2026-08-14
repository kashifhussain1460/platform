import { defineConfig, devices } from '@playwright/test';

/**
 * WAVE 7 — browser E2E.
 *
 * The plan's rule for this wave is the whole reason it exists: *"Record
 * evidence. Do not equate 'harness exists' with 'E2E passed'."* So this config
 * is written to run against a REAL stack — the actual Next.js app talking to the
 * actual NestJS API talking to real Postgres and Redis — not against mocks.
 *
 * `webServer` starts both for you (and reuses them locally if already up), so
 * "the suite passed" always means "the product worked", never "the harness
 * compiled".
 */
// 3200, not 3000: `apps/web`'s dev script is `next dev --port 3200`. Reading the
// package script rather than assuming the framework default is the difference
// between a suite that runs and one that times out looking at nothing.
const WEB = process.env.E2E_WEB_URL ?? 'http://localhost:3200';
const API = process.env.E2E_API_URL ?? 'http://localhost:4000';

export default defineConfig({
  testDir: './tests',
  // Compile the entry routes once before the first test — see global-setup.ts.
  // Without it the first test pays Next.js's dev-mode route compile and fails
  // intermittently for a reason that has nothing to do with what it asserts.
  globalSetup: './global-setup.ts',
  // Serial. These journeys share one database, and a "create a company, then
  // assert on its audit trail" test cannot be trusted while another worker is
  // writing to the same tenant tables.
  workers: 1,
  fullyParallel: false,
  // A browser journey is slow by nature: real navigation, real API calls, real
  // queue round trips. A tight timeout here produces flakes that get dismissed,
  // which is exactly how a suite stops being believed.
  timeout: 120_000,
  expect: { timeout: 15_000 },
  // Never silently pass a suite that only passed on retry in CI.
  retries: process.env.CI ? 1 : 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: [['list'], ['html', { outputFolder: 'report', open: 'never' }]],

  use: {
    baseURL: WEB,
    // Evidence, per the gate: a trace and a screenshot for anything that fails,
    // so "it failed on CI" is diagnosable without re-running it locally.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 20_000,
    navigationTimeout: 45_000,
  },

  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],

  // Both servers, because a browser journey that stubs the API proves nothing
  // about the product. `reuseExistingServer` keeps a local dev loop fast.
  webServer: [
    {
      command: 'pnpm --filter @vaep/api run dev',
      url: `${API}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      cwd: '..',
      stdout: 'ignore',
      stderr: 'pipe',
      env: {
        ...process.env,
        // `apps/api/.env` carries MAIL_ENABLED=true with LIVE SMTP credentials.
        // Left alone, this suite would (a) get a random verification OTP instead
        // of the fixed dev `123456`, so no browser journey could get past
        // /verify-email, and (b) DELIVER REAL EMAIL to every address the tests
        // invent. The same leak was found in the Jest suite; browser E2E needs
        // its own guard because it starts the server itself.
        MAIL_ENABLED: 'false',
        // Offline, deterministic providers — a browser journey must not depend
        // on an LLM vendor being reachable or on a real card being charged.
        LLM_PROVIDER: 'mock',
        SKILL_EXECUTOR: 'mock',
        BILLING_PROVIDER: 'mock',
        EMBEDDINGS_PROVIDER: 'hash',
        STORAGE_PROVIDER: 'local',
        // These journeys sign up and log in a dozen times inside a minute from
        // ONE address, and `/auth/*` allows 10/min per IP. Left alone, the suite
        // rate-limits ITSELF: the seventh journey ("a MEMBER cannot reach the HR
        // area") failed with a 429 that said nothing about the behaviour under
        // test. That is not a hypothetical — it is what the first real runner
        // execution of 02-security-journey.spec.ts produced, after the file had
        // been "verified by hand" and never actually run.
        //
        // Raising it here does not weaken any assertion: no browser test covers
        // throttling, and production keeps the default of 10.
        AUTH_THROTTLE_LIMIT: '1000',
      },
    },
    {
      command: 'pnpm --filter @vaep/web run dev',
      url: WEB,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      cwd: '..',
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
});
