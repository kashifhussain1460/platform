import { chromium, type FullConfig } from '@playwright/test';

const WEB = process.env.E2E_WEB_URL ?? 'http://localhost:3200';

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
