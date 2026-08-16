import { chromium, type FullConfig } from '@playwright/test';

const WEB = process.env.E2E_WEB_URL ?? 'http://localhost:3200';
const API = process.env.E2E_API_URL ?? 'http://localhost:4000';

/**
 * Refuse to run against an API that sends REAL verification email.
 *
 * `playwright.config.ts` starts the API with `MAIL_ENABLED=false` precisely so
 * the fixed dev OTP works and no test address is ever emailed — but
 * `reuseExistingServer` means that env block is SILENTLY SKIPPED whenever a
 * developer already has `pnpm dev` running, and `apps/api/.env` carries live
 * SMTP credentials. Both consequences are real and were both observed:
 *
 *  - every journey died at /verify-email after a 30s timeout whose message
 *    ("unexpected value .../verify-email") named nothing that was wrong;
 *  - and had verification ever succeeded, the run would have delivered live
 *    mail to every address the tests invent, from the company's real domain.
 *
 * So the harness proves the bypass is active before a single test runs, using
 * the product's own endpoints rather than a new one — the liveness probe is
 * deliberately config-free and must stay that way.
 */
async function assertDevOtpActive(): Promise<void> {
  const email = `e2e_preflight_${Date.now()}@example.com`;
  const post = async (
    path: string,
    body: unknown,
    token?: string,
  ): Promise<Response> =>
    fetch(`${API}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });

  let registered: Response;
  try {
    registered = await post('/auth/register', {
      companyName: 'E2E Preflight',
      name: 'E2E Preflight',
      email,
      password: 'password123',
    });
  } catch (err) {
    // Nothing to assert about mail if the API is not answering at all; the
    // webServer wait will report that far more clearly than we can here.
    console.warn(`[e2e] preflight skipped — API unreachable: ${String(err)}`);
    return;
  }
  if (!registered.ok) {
    console.warn(`[e2e] preflight skipped — register returned ${registered.status}`);
    return;
  }

  // `/auth/verify-email` identifies the user from the token, not the body.
  const token = (
    (await registered.json()) as { tokens?: { accessToken?: string } }
  ).tokens?.accessToken;
  if (!token) {
    console.warn('[e2e] preflight skipped — register returned no access token');
    return;
  }

  const verified = await post('/auth/verify-email', { code: '123456' }, token);
  if (verified.ok) return;

  throw new Error(
    [
      'The API this suite is pointed at is sending REAL verification codes, so the',
      'fixed development OTP does not work and no browser journey can get past',
      '/verify-email. Worse, every address these tests invent would be emailed for',
      'real from the company domain.',
      '',
      `Cause: an API is already running on ${API} with MAIL_ENABLED=true (that is`,
      "what apps/api/.env carries), and playwright.config.ts's MAIL_ENABLED=false",
      'only applies to a server Playwright starts itself — reuseExistingServer',
      'skipped it.',
      '',
      'Fix: stop the running dev API and let Playwright start its own, or start',
      'that dev API with MAIL_ENABLED=false.',
    ].join('\n'),
  );
}

/**
 * Warm the Next.js dev server before the first test runs.
 *
 * `webServer` waits for the app to ANSWER, which is not the same as being ready:
 * Next.js in dev compiles each route on its first request, and that compile can
 * take longer than a navigation timeout. The cost lands entirely on whichever
 * test happens to go first — so the suite failed occasionally on "a visitor can
 * sign up", a test that has nothing wrong with it, while a re-run passed.
 *
 * Raising the timeout would have hidden it. Paying the compile ONCE, here,
 * removes it: every test then meets an already-compiled route, and a failure on
 * the first test means something is actually broken.
 *
 * Deliberately best-effort — a warm-up that could fail the whole run would be a
 * new source of the flakiness it exists to remove.
 */
async function globalSetup(_config: FullConfig): Promise<void> {
  // Before anything else: a run that cannot pass, and would email real people
  // trying, should stop here rather than three minutes in.
  await assertDevOtpActive();

  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    // The routes the suites enter through. Login and register are compiled by
    // every journey; /dashboard is the first authenticated landing.
    for (const path of ['/login', '/register', '/dashboard']) {
      await page
        .goto(`${WEB}${path}`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
        .catch(() => undefined);
    }
  } finally {
    await page.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}

export default globalSetup;
