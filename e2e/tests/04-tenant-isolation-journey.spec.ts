import { expect, test } from '@playwright/test';
import {
  apiGet,
  apiLogin,
  apiPost,
  authHeaders,
  completeOnboarding,
  signUpThroughUi,
  unique,
  verifyEmailThroughUi,
} from './support/app';

const API = process.env.E2E_API_URL ?? 'http://localhost:4000';

/**
 * Two companies, in one browser, proving they cannot see each other.
 *
 * ## Why this file exists
 *
 * The 2026-09-02 audit verified tenant isolation by hand — two tenants, a
 * ten-endpoint cross-tenant attack sweep, every one denied — and then had to
 * record that there was **no automated browser test** doing the same thing. The
 * existing security journey covers department scoping and role scoping WITHIN
 * one company; nothing covered the boundary between two.
 *
 * That is the wrong gap to leave open. Cross-tenant leakage is the single
 * failure a multi-tenant SaaS cannot recover its reputation from, and it is the
 * kind of regression a refactor introduces silently — one forgotten `companyId`
 * in a `where` clause.
 *
 * ## What it asserts, and in which layer
 *
 * Both, deliberately:
 *
 * - **API**: company A's token against company B's resource ids. This is the
 *   real control. A UI that hides a row is not a control.
 * - **Browser**: A's screens never render B's data. This is what a customer
 *   would actually see, and it catches the case where an endpoint is correctly
 *   scoped but a page fetches from somewhere else entirely.
 *
 * Company A is configured for Marketing and company B for HR, so the test also
 * pins the *capability* boundary: neither tenant should be offered the other's
 * product areas.
 */
test.describe('Tenant isolation (two companies)', () => {
  test('one company cannot see or touch another’s data, in the API or the browser', async ({
    page,
    browser,
    request,
  }) => {
    test.setTimeout(180_000);

    // ── Company A — Marketing ────────────────────────────────────────────────
    const a = await signUpThroughUi(page, 'tenant-a');
    await verifyEmailThroughUi(page);
    const ownerA = await apiLogin(request, a.email, a.password);
    await completeOnboarding(request, ownerA.accessToken);

    const employeeA = await apiPost<{ id: string; name: string }>(
      request,
      ownerA.accessToken,
      '/employees',
      { name: `AlphaBot${unique('a').slice(-5)}`, role: 'MARKETING' },
    );
    const workflowA = await apiPost<{ id: string }>(
      request,
      ownerA.accessToken,
      '/workflows',
      {
        name: `ALPHA-SECRET-${unique('a').slice(-5)}`,
        definition: {
          nodes: [{ id: 'trigger', type: 'TRIGGER', config: {} }],
          edges: [],
        },
      },
    );

    // ── Company B — HR, in its own browser context ───────────────────────────
    // A separate context, not a second tab: sharing storage would mean sharing
    // the session, and the whole point is that these are two customers.
    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    const b = await signUpThroughUi(pageB, 'tenant-b');
    await verifyEmailThroughUi(pageB);
    const ownerB = await apiLogin(request, b.email, b.password);
    await completeOnboarding(request, ownerB.accessToken);

    const employeeB = await apiPost<{ id: string; name: string }>(
      request,
      ownerB.accessToken,
      '/employees',
      { name: `BravoBot${unique('b').slice(-5)}`, role: 'HR' },
    );
    const workflowB = await apiPost<{ id: string }>(
      request,
      ownerB.accessToken,
      '/workflows',
      {
        name: `BRAVO-SECRET-${unique('b').slice(-5)}`,
        definition: {
          nodes: [{ id: 'trigger', type: 'TRIGGER', config: {} }],
          edges: [],
        },
      },
    );
    const staffB = await apiPost<{ id: string }>(
      request,
      ownerB.accessToken,
      '/hr/staff',
      { fullName: 'Bravo Confidential Person', workEmail: 'bravo@tenant-b.test' },
    );

    // ── 1. THE control: A's token against B's ids ────────────────────────────
    // 404 rather than 403 on purpose — "not found" does not confirm the id
    // exists in some other tenant, which a 403 would.
    for (const path of [
      `/employees/${employeeB.id}`,
      `/workflows/${workflowB.id}`,
      `/workflows/${workflowB.id}/runs`,
      `/hr/staff/${staffB.id}`,
    ]) {
      const res = await request.get(`${API}${path}`, {
        headers: authHeaders(ownerA.accessToken),
      });
      expect(
        res.status(),
        `company A must not READ company B's ${path}`,
      ).toBe(404);
    }

    // Writes too. A read-only leak is bad; a cross-tenant write is worse, and
    // they are different code paths.
    const hijack = await request.patch(`${API}/employees/${employeeB.id}`, {
      headers: authHeaders(ownerA.accessToken),
      data: { name: 'PWNED BY TENANT A' },
    });
    expect(hijack.status(), "company A must not WRITE company B's employee").toBe(404);

    const destroy = await request.delete(`${API}/workflows/${workflowB.id}`, {
      headers: authHeaders(ownerA.accessToken),
    });
    expect(destroy.status(), "company A must not DELETE company B's workflow").toBe(404);

    // And B is untouched afterwards — the guard rejected the call rather than
    // half-applying it.
    const survivor = await apiGet<{ name: string }>(
      request,
      ownerB.accessToken,
      `/employees/${employeeB.id}`,
    );
    expect(survivor.name, "company B's employee must be unchanged").toBe(
      employeeB.name,
    );

    // ── 2. Their own data still works (else the above proves nothing) ────────
    const ownEmployee = await request.get(`${API}/employees/${employeeA.id}`, {
      headers: authHeaders(ownerA.accessToken),
    });
    expect(ownEmployee.status(), 'company A must still read its OWN employee').toBe(200);

    // ── 3. The browser: A's screens never render B's data ───────────────────
    for (const route of ['/employees', '/workflows', '/dashboard']) {
      await page.goto(route);
      await page.waitForLoadState('networkidle');
      const body = await page.locator('body').innerText();
      expect(body, `${route} must not show company B's employee`).not.toContain(
        employeeB.name,
      );
      expect(body, `${route} must not show company B's workflow`).not.toContain(
        'BRAVO-SECRET',
      );
    }

    // A sees its own, so "sees nothing" cannot pass this test by accident.
    await page.goto('/employees');
    await expect(
      page.getByText(employeeA.name).first(),
      'company A must see its OWN employee',
    ).toBeVisible({ timeout: 30_000 });

    // ── 4. Capability boundary: an HR tenant is not a Marketing tenant ───────
    // The resolver decides product areas from what each company hired. If this
    // ever returns the same set for both, configuration has stopped driving the
    // product — which is the concept the whole platform is built on.
    const contextA = await apiGet<{ productAreas: string[] }>(
      request,
      ownerA.accessToken,
      '/product-context',
    );
    const ctxB = await apiGet<{ productAreas: string[] }>(
      request,
      ownerB.accessToken,
      '/product-context',
    );
    expect(contextA.productAreas, 'a Marketing tenant gets the Marketing area').toContain(
      'MARKETING',
    );
    expect(ctxB.productAreas, 'an HR tenant gets the People area').toContain('HR');
    expect(ctxB.productAreas, 'an HR tenant is not given Marketing').not.toContain(
      'MARKETING',
    );
    expect(contextA.productAreas, 'a Marketing tenant is not given People').not.toContain(
      'HR',
    );

    // Company B is real too: it can read its own HR record that A was refused.
    const ownStaff = await request.get(`${API}/hr/staff/${staffB.id}`, {
      headers: authHeaders(ownerB.accessToken),
    });
    expect(ownStaff.status(), 'company B must read its OWN staff record').toBe(200);

    await contextB.close();
  });
});
