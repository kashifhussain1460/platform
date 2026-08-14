import type { APIRequestContext, Page } from '@playwright/test';
import { expect } from '@playwright/test';

const API = process.env.E2E_API_URL ?? 'http://localhost:4000';

export interface TestUser {
  name: string;
  email: string;
  password: string;
  companyId: string;
  userId: string;
  accessToken: string;
}

/** Unique per run, so a re-run never collides with the last one's data. */
export function unique(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
}

/**
 * Register a fresh company + owner THROUGH THE BROWSER.
 *
 * Deliberately the real form rather than an API call: signup is itself one of
 * the required browser tests (§7.4), and every later journey depends on it — so
 * if the form breaks, the whole suite should say so loudly on the first test
 * rather than quietly falling back to an API shortcut.
 */
export async function signUpThroughUi(
  page: Page,
  label: string,
): Promise<{ email: string; password: string; name: string }> {
  const email = `${unique(label)}@example.com`;
  const password = 'BrowserE2E-pass1';
  const name = `${label} Owner`;

  await page.goto('/register');
  await page.getByLabel('Full name').fill(name);
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByLabel('Confirm password').fill(password);
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: /create account/i }).click();

  // Registration lands somewhere authenticated — onboarding for a brand new
  // company, dashboard otherwise. Asserting "we left /register" is the honest
  // check: which landing page is a product decision that may change.
  await expect(page).not.toHaveURL(/\/register/, { timeout: 45_000 });
  return { email, password, name };
}

/**
 * Clear the email-verification gate, through the real screen.
 *
 * An INVITED user is parked at `/verify-email` until they enter the code, so
 * every multi-user journey needs this — and §7.4 lists email verification as a
 * required browser test in its own right, so it is done through the UI rather
 * than flipped in the database.
 *
 * `123456` is the fixed development OTP, which only exists because the config
 * forces `MAIL_ENABLED=false` for this suite (see playwright.config.ts).
 */
export async function verifyEmailThroughUi(page: Page): Promise<void> {
  // Wait for the app to settle FIRST. Checking `page.url()` immediately after a
  // click is a race: the redirect to /verify-email may not have happened yet, the
  // helper returns believing there is nothing to do, and the caller then fails on
  // a screen it did not expect.
  await page.waitForLoadState('networkidle').catch(() => undefined);
  if (!page.url().includes('/verify-email')) return;

  // The field is a controlled input identified by its aria-label; the submit
  // button stays disabled until exactly 6 digits are present.
  await page.getByLabel('6-digit verification code').fill('123456');
  await page.getByRole('button', { name: /verify email/i }).click();
  await expect(page).not.toHaveURL(/\/verify-email/, { timeout: 30_000 });
}

/** Sign in through the real form. */
export async function logInThroughUi(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  await page.goto('/login');
  await page.getByLabel(/email/i).fill(email);
  // `exact` — a loose /password/i also matches "Forgot password?" affordances.
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: /sign in|log in/i }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 45_000 });
  // An invited user lands on the verification gate; clear it so callers get a
  // usable session rather than a screen they did not expect.
  await verifyEmailThroughUi(page);
}

/**
 * An API client for SETUP and ASSERTION only — never for the behaviour a test
 * is about.
 *
 * Building a department hierarchy or a second admin through the UI would make
 * every journey a 60-step click-through that fails for reasons unrelated to what
 * it is testing. The rule this file follows: the thing under test goes through
 * the browser; the scaffolding around it, and the verification of server state
 * afterwards, may use the API.
 */
export async function apiLogin(
  request: APIRequestContext,
  email: string,
  password: string,
): Promise<TestUser> {
  const res = await request.post(`${API}/auth/login`, {
    data: { email, password },
  });
  expect(res.ok(), `login failed for ${email}: ${await res.text()}`).toBeTruthy();
  const body = (await res.json()) as {
    tokens: { accessToken: string };
    user: { id: string; companyId: string; name: string };
  };
  return {
    name: body.user.name,
    email,
    password,
    companyId: body.user.companyId,
    userId: body.user.id,
    accessToken: body.tokens.accessToken,
  };
}

export function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

/** POST helper that fails loudly with the server's message. */
export async function apiPost<T>(
  request: APIRequestContext,
  token: string,
  path: string,
  data: unknown,
): Promise<T> {
  const res = await request.post(`${API}${path}`, {
    headers: authHeaders(token),
    data: data as Record<string, unknown>,
  });
  expect(
    res.ok(),
    `POST ${path} → ${res.status()}: ${await res.text()}`,
  ).toBeTruthy();
  return (await res.json()) as T;
}

export async function apiGet<T>(
  request: APIRequestContext,
  token: string,
  path: string,
): Promise<T> {
  const res = await request.get(`${API}${path}`, {
    headers: authHeaders(token),
  });
  expect(res.ok(), `GET ${path} → ${res.status()}`).toBeTruthy();
  return (await res.json()) as T;
}

/**
 * Finish onboarding for a brand-new company.
 *
 * Required scaffolding for almost every journey: until `onboardedAt` is stamped
 * the app routes EVERY user of that company to `/onboarding`, so a test that
 * navigates to `/workflows` silently lands somewhere else and fails with
 * "element not found" — which reads like a UI bug and is not one. Found exactly
 * that way by the security journey.
 */
export async function completeOnboarding(
  request: APIRequestContext,
  token: string,
): Promise<void> {
  const res = await request.post(`${API}/onboarding/complete`, {
    headers: authHeaders(token),
    data: {
      business: { industry: 'Software', size: '1-10' },
      // `departments` is required by the DTO even though the wizard treats it as
      // optional — the server is the authority, so match it.
      departments: ['SUPPORT'],
      employees: [{ role: 'SUPPORT', name: 'Ada' }],
    },
  });
  expect(
    res.ok(),
    `onboarding/complete → ${res.status()}: ${await res.text()}`,
  ).toBeTruthy();
}
