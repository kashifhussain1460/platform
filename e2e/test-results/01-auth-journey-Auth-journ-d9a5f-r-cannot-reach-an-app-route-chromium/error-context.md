# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: 01-auth-journey.spec.ts >> Auth journey >> an unauthenticated visitor cannot reach an app route
- Location: tests\01-auth-journey.spec.ts:62:7

# Error details

```
Error: expect(page).toHaveURL(expected) failed

Expected pattern: /\/login/
Received string:  "http://localhost:3200/workflows"
Timeout: 30000ms

Call log:
  - Expect "toHaveURL" with timeout 30000ms
    62 × locator resolved to <html lang="en" class="__variable_f367f3 __variable_dd5b2f __variable_3c557b">…</html>
       - unexpected value "http://localhost:3200/workflows"

```

```yaml
- text: Loading your workspace…
```

# Test source

```ts
  1  | import { expect, test } from '@playwright/test';
  2  | import { logInThroughUi, signUpThroughUi } from './support/app';
  3  | 
  4  | /**
  5  |  * WAVE 7 §7.4 — signup, login, and the auth surface a real user meets first.
  6  |  *
  7  |  * These run before everything else on purpose: every later journey depends on
  8  |  * being able to create an account and sign in, so if this file is red the rest
  9  |  * of the suite's failures are noise.
  10 |  */
  11 | test.describe('Auth journey', () => {
  12 |   test('a visitor can sign up, and lands authenticated', async ({ page }) => {
  13 |     const { email } = await signUpThroughUi(page, 'auth');
  14 |     expect(email).toContain('@');
  15 |     // Left the auth area entirely — the app decides whether that is onboarding
  16 |     // or the dashboard, and pinning the exact route here would make a product
  17 |     // decision into a test failure.
  18 |     await expect(page).not.toHaveURL(/\/(register|login)/);
  19 |   });
  20 | 
  21 |   test('a registered user can log out and log back in', async ({ page, browser }) => {
  22 |     const { email, password } = await signUpThroughUi(page, 'relogin');
  23 | 
  24 |     // A brand-new CONTEXT, not `clearCookies()`. The app keeps its access token
  25 |     // in a persisted client store as well as the httpOnly refresh cookie, so
  26 |     // clearing cookies alone leaves the session alive — `/login` then redirects
  27 |     // straight back to the app and the password field never renders. A fresh
  28 |     // context is the only honest simulation of "came back on another machine",
  29 |     // and it is what proves the login form itself works rather than a live
  30 |     // session quietly carrying the test.
  31 |     const fresh = await browser.newContext();
  32 |     const freshPage = await fresh.newPage();
  33 | 
  34 |     await freshPage.goto('/dashboard');
  35 |     await expect(freshPage).toHaveURL(/\/login/, { timeout: 30_000 });
  36 | 
  37 |     await logInThroughUi(freshPage, email, password);
  38 |     await expect(freshPage).not.toHaveURL(/\/login/);
  39 |     await fresh.close();
  40 |   });
  41 | 
  42 |   test('a wrong password is rejected and does not authenticate', async ({
  43 |     page,
  44 |     browser,
  45 |   }) => {
  46 |     const { email } = await signUpThroughUi(page, 'badpass');
  47 | 
  48 |     const fresh = await browser.newContext();
  49 |     const freshPage = await fresh.newPage();
  50 |     await freshPage.goto('/login');
  51 |     await freshPage.getByLabel(/email/i).fill(email);
  52 |     await freshPage.getByLabel('Password', { exact: true }).fill('definitely-not-the-password');
  53 |     await freshPage.getByRole('button', { name: /sign in|log in/i }).click();
  54 | 
  55 |     // Still on login, and an authenticated route still bounces.
  56 |     await expect(freshPage).toHaveURL(/\/login/);
  57 |     await freshPage.goto('/dashboard');
  58 |     await expect(freshPage).toHaveURL(/\/login/);
  59 |     await fresh.close();
  60 |   });
  61 | 
  62 |   test('an unauthenticated visitor cannot reach an app route', async ({
  63 |     page,
  64 |   }) => {
  65 |     await page.goto('/workflows');
> 66 |     await expect(page).toHaveURL(/\/login/, { timeout: 30_000 });
     |                        ^ Error: expect(page).toHaveURL(expected) failed
  67 |   });
  68 | });
  69 | 
```