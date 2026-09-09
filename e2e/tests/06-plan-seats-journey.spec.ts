import { expect, test } from '@playwright/test';
import {
  apiLogin,
  apiPost,
  authHeaders,
  completeOnboarding,
  signUpThroughUi,
  verifyEmailThroughUi,
} from './support/app';

const API = process.env.E2E_API_URL ?? 'http://localhost:4000';

/**
 * Role-based hiring plans (docs/product/2026-09-04-role-based-hiring-plans.md), in
 * the browser.
 *
 * The server refuses a hire the plan does not allow (`employees-seats.e2e-spec`
 * proves that). This spec proves the OTHER half: a customer is told BEFORE they
 * try. The Free plan is 2 roles × 1 — the same numbers the resolver serves to the
 * hire form, the roster header and the billing page.
 *
 * `completeOnboarding` hires one SUPPORT employee, so the tenant starts at
 * 1 of 2 seats with the Support slot full.
 */
test.describe('Plan seats journey (Free: 2 roles × 1)', () => {
  test('the hire form greys the full role, then all seats, and billing shows the rule', async ({
    page,
    request,
  }) => {
    test.setTimeout(150_000);
    const { email, password } = await signUpThroughUi(page, 'seats');
    await verifyEmailThroughUi(page);
    const owner = await apiLogin(request, email, password);
    await completeOnboarding(request, owner.accessToken); // hires 1 SUPPORT

    // ── 1 of 2 seats: Support is full, every other role is still open ──────
    await page.goto('/employees');
    await page.waitForLoadState('networkidle');
    await expect(page.getByText(/1 of 2 seats/).first()).toBeVisible({ timeout: 30_000 });

    const roleSelect = page.locator('select#role');
    await expect(roleSelect.locator('option[value="SUPPORT"]')).toBeDisabled();
    await expect(roleSelect.locator('option[value="SUPPORT"]')).toHaveText(/1 of 1/);
    await expect(roleSelect.locator('option[value="HR"]')).toBeEnabled();

    // Picking the full role disables the button and explains why — before any
    // request is made. The server would 403 this; the customer never gets there.
    await roleSelect.selectOption('HR'); // an open role first, to confirm the button works
    await expect(page.getByRole('button', { name: /hire employee/i })).toBeEnabled();

    // ── Hire the second role through the real form ─────────────────────────
    await page.locator('input#name').fill('Hana');
    await page.getByRole('button', { name: /hire employee/i }).click();
    await expect(page.getByText('Hana').first()).toBeVisible({ timeout: 30_000 });

    // ── 2 of 2: every seat taken, the form says so, the button is off ───────
    await expect(page.getByText(/2 of 2 seats/).first()).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByText(/All 2 seats on your plan are taken/i),
      'the form must explain the block and offer the upgrade path',
    ).toBeVisible();
    await expect(page.getByRole('button', { name: /hire employee/i })).toBeDisabled();
    await expect(page.getByRole('link', { name: /upgrade your plan/i })).toBeVisible();

    // The server agrees — hidden is not a control, so prove the backstop too.
    const refused = await request.post(`${API}/employees`, {
      headers: authHeaders(owner.accessToken),
      data: { name: 'Third', role: 'MARKETING' },
    });
    expect(refused.status(), 'a third hire on a 2-seat plan must be refused').toBe(403);
    expect(await refused.text()).toMatch(/seats are taken/i);

    // ── Retiring an employee frees the seat, in the UI too ─────────────────
    const list = await request.get(`${API}/employees`, { headers: authHeaders(owner.accessToken) });
    const support = ((await list.json()) as Array<{ id: string; role: string }>).find(
      (e) => e.role === 'SUPPORT',
    )!;
    await request.patch(`${API}/employees/${support.id}`, {
      headers: authHeaders(owner.accessToken),
      data: { status: 'DISABLED' },
    });
    await page.reload();
    await page.waitForLoadState('networkidle');
    await expect(page.getByText(/1 of 2 seats/).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: /hire employee/i })).toBeEnabled();

    // ── Billing states the rule and the ceiling, not just a seat count ──────
    await page.goto('/billing');
    await page.waitForLoadState('networkidle');
    const billing = await page.locator('body').innerText();
    expect(billing).toMatch(/any 2 roles, 1 each/);
    expect(billing).toMatch(/500 credits per employee/);
    expect(billing).toMatch(/Growth/); // the $40 tier is offered as the way up
    expect(billing).toMatch(/\$40/);

    // ── The employee's own settings show the plan ceiling ───────────────────
    const hr = ((await list.json()) as Array<{ id: string; role: string }>).find(
      (e) => e.role === 'HR',
    )!;
    await page.goto(`/employees/${hr.id}`);
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: 'Settings' }).last().click();
    await expect(page.getByText(/up to \$5 on your plan/i)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/500 credits per employee per month/i)).toBeVisible();
  });
});
