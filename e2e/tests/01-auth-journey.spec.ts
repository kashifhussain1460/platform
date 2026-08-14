import { expect, test } from '@playwright/test';
import { logInThroughUi, signUpThroughUi } from './support/app';

/**
 * WAVE 7 §7.4 — signup, login, and the auth surface a real user meets first.
 *
 * These run before everything else on purpose: every later journey depends on
 * being able to create an account and sign in, so if this file is red the rest
 * of the suite's failures are noise.
 */
test.describe('Auth journey', () => {
  test('a visitor can sign up, and lands authenticated', async ({ page }) => {
    const { email } = await signUpThroughUi(page, 'auth');
    expect(email).toContain('@');
    // Left the auth area entirely — the app decides whether that is onboarding
    // or the dashboard, and pinning the exact route here would make a product
    // decision into a test failure.
    await expect(page).not.toHaveURL(/\/(register|login)/);
  });

  test('a registered user can log out and log back in', async ({ page, browser }) => {
    const { email, password } = await signUpThroughUi(page, 'relogin');

    // A brand-new CONTEXT, not `clearCookies()`. The app keeps its access token
    // in a persisted client store as well as the httpOnly refresh cookie, so
    // clearing cookies alone leaves the session alive — `/login` then redirects
    // straight back to the app and the password field never renders. A fresh
    // context is the only honest simulation of "came back on another machine",
    // and it is what proves the login form itself works rather than a live
    // session quietly carrying the test.
    const fresh = await browser.newContext();
    const freshPage = await fresh.newPage();

    await freshPage.goto('/dashboard');
    await expect(freshPage).toHaveURL(/\/login/, { timeout: 30_000 });

    await logInThroughUi(freshPage, email, password);
    await expect(freshPage).not.toHaveURL(/\/login/);
    await fresh.close();
  });

  test('a wrong password is rejected and does not authenticate', async ({
    page,
    browser,
  }) => {
    const { email } = await signUpThroughUi(page, 'badpass');

    const fresh = await browser.newContext();
    const freshPage = await fresh.newPage();
    await freshPage.goto('/login');
    await freshPage.getByLabel(/email/i).fill(email);
    await freshPage.getByLabel('Password', { exact: true }).fill('definitely-not-the-password');
    await freshPage.getByRole('button', { name: /sign in|log in/i }).click();

    // Still on login, and an authenticated route still bounces.
    await expect(freshPage).toHaveURL(/\/login/);
    await freshPage.goto('/dashboard');
    await expect(freshPage).toHaveURL(/\/login/);
    await fresh.close();
  });

  test('an unauthenticated visitor cannot reach an app route', async ({
    page,
  }) => {
    await page.goto('/workflows');
    await expect(page).toHaveURL(/\/login/, { timeout: 30_000 });
  });
});
