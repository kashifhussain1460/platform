# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: 01-auth-journey.spec.ts >> Auth journey >> a visitor can sign up, and lands authenticated
- Location: tests\01-auth-journey.spec.ts:12:7

# Error details

```
TimeoutError: locator.fill: Timeout 20000ms exceeded.
Call log:
  - waiting for getByLabel('Full name')

```

# Page snapshot

```yaml
- generic [active] [ref=e1]: Loading…
```

# Test source

```ts
  1   | import type { APIRequestContext, Page } from '@playwright/test';
  2   | import { expect } from '@playwright/test';
  3   | 
  4   | const API = process.env.E2E_API_URL ?? 'http://localhost:4000';
  5   | 
  6   | export interface TestUser {
  7   |   name: string;
  8   |   email: string;
  9   |   password: string;
  10  |   companyId: string;
  11  |   userId: string;
  12  |   accessToken: string;
  13  | }
  14  | 
  15  | /** Unique per run, so a re-run never collides with the last one's data. */
  16  | export function unique(prefix: string): string {
  17  |   return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
  18  | }
  19  | 
  20  | /**
  21  |  * Register a fresh company + owner THROUGH THE BROWSER.
  22  |  *
  23  |  * Deliberately the real form rather than an API call: signup is itself one of
  24  |  * the required browser tests (§7.4), and every later journey depends on it — so
  25  |  * if the form breaks, the whole suite should say so loudly on the first test
  26  |  * rather than quietly falling back to an API shortcut.
  27  |  */
  28  | export async function signUpThroughUi(
  29  |   page: Page,
  30  |   label: string,
  31  | ): Promise<{ email: string; password: string; name: string }> {
  32  |   const email = `${unique(label)}@example.com`;
  33  |   const password = 'BrowserE2E-pass1';
  34  |   const name = `${label} Owner`;
  35  | 
  36  |   await page.goto('/register');
> 37  |   await page.getByLabel('Full name').fill(name);
      |                                      ^ TimeoutError: locator.fill: Timeout 20000ms exceeded.
  38  |   await page.getByLabel('Work email').fill(email);
  39  |   await page.getByLabel('Password', { exact: true }).fill(password);
  40  |   await page.getByLabel('Confirm password').fill(password);
  41  |   await page.getByRole('checkbox').check();
  42  |   await page.getByRole('button', { name: /create account/i }).click();
  43  | 
  44  |   // Registration lands somewhere authenticated — onboarding for a brand new
  45  |   // company, dashboard otherwise. Asserting "we left /register" is the honest
  46  |   // check: which landing page is a product decision that may change.
  47  |   await expect(page).not.toHaveURL(/\/register/, { timeout: 45_000 });
  48  |   return { email, password, name };
  49  | }
  50  | 
  51  | /**
  52  |  * Clear the email-verification gate, through the real screen.
  53  |  *
  54  |  * An INVITED user is parked at `/verify-email` until they enter the code, so
  55  |  * every multi-user journey needs this — and §7.4 lists email verification as a
  56  |  * required browser test in its own right, so it is done through the UI rather
  57  |  * than flipped in the database.
  58  |  *
  59  |  * `123456` is the fixed development OTP, which only exists because the config
  60  |  * forces `MAIL_ENABLED=false` for this suite (see playwright.config.ts).
  61  |  */
  62  | export async function verifyEmailThroughUi(page: Page): Promise<void> {
  63  |   // Wait for the app to settle FIRST. Checking `page.url()` immediately after a
  64  |   // click is a race: the redirect to /verify-email may not have happened yet, the
  65  |   // helper returns believing there is nothing to do, and the caller then fails on
  66  |   // a screen it did not expect.
  67  |   await page.waitForLoadState('networkidle').catch(() => undefined);
  68  |   if (!page.url().includes('/verify-email')) return;
  69  | 
  70  |   // The field is a controlled input identified by its aria-label; the submit
  71  |   // button stays disabled until exactly 6 digits are present.
  72  |   await page.getByLabel('6-digit verification code').fill('123456');
  73  |   await page.getByRole('button', { name: /verify email/i }).click();
  74  |   await expect(page).not.toHaveURL(/\/verify-email/, { timeout: 30_000 });
  75  | }
  76  | 
  77  | /** Sign in through the real form. */
  78  | export async function logInThroughUi(
  79  |   page: Page,
  80  |   email: string,
  81  |   password: string,
  82  | ): Promise<void> {
  83  |   await page.goto('/login');
  84  |   await page.getByLabel(/email/i).fill(email);
  85  |   // `exact` — a loose /password/i also matches "Forgot password?" affordances.
  86  |   await page.getByLabel('Password', { exact: true }).fill(password);
  87  |   await page.getByRole('button', { name: /sign in|log in/i }).click();
  88  |   await expect(page).not.toHaveURL(/\/login/, { timeout: 45_000 });
  89  |   // An invited user lands on the verification gate; clear it so callers get a
  90  |   // usable session rather than a screen they did not expect.
  91  |   await verifyEmailThroughUi(page);
  92  | }
  93  | 
  94  | /**
  95  |  * An API client for SETUP and ASSERTION only — never for the behaviour a test
  96  |  * is about.
  97  |  *
  98  |  * Building a department hierarchy or a second admin through the UI would make
  99  |  * every journey a 60-step click-through that fails for reasons unrelated to what
  100 |  * it is testing. The rule this file follows: the thing under test goes through
  101 |  * the browser; the scaffolding around it, and the verification of server state
  102 |  * afterwards, may use the API.
  103 |  */
  104 | export async function apiLogin(
  105 |   request: APIRequestContext,
  106 |   email: string,
  107 |   password: string,
  108 | ): Promise<TestUser> {
  109 |   const res = await request.post(`${API}/auth/login`, {
  110 |     data: { email, password },
  111 |   });
  112 |   expect(res.ok(), `login failed for ${email}: ${await res.text()}`).toBeTruthy();
  113 |   const body = (await res.json()) as {
  114 |     tokens: { accessToken: string };
  115 |     user: { id: string; companyId: string; name: string };
  116 |   };
  117 |   return {
  118 |     name: body.user.name,
  119 |     email,
  120 |     password,
  121 |     companyId: body.user.companyId,
  122 |     userId: body.user.id,
  123 |     accessToken: body.tokens.accessToken,
  124 |   };
  125 | }
  126 | 
  127 | export function authHeaders(token: string): Record<string, string> {
  128 |   return { Authorization: `Bearer ${token}` };
  129 | }
  130 | 
  131 | /** POST helper that fails loudly with the server's message. */
  132 | export async function apiPost<T>(
  133 |   request: APIRequestContext,
  134 |   token: string,
  135 |   path: string,
  136 |   data: unknown,
  137 | ): Promise<T> {
```