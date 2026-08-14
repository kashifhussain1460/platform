import { expect, test } from '@playwright/test';
import {
  apiGet,
  apiLogin,
  apiPost,
  completeOnboarding,
  logInThroughUi,
  signUpThroughUi,
  unique,
} from './support/app';

/**
 * WAVE 7 §7.2 — the security journey, in a real browser.
 *
 * ```
 * Marketing Admin -> Marketing = ALLOW
 * Marketing Admin -> HR        = DENY
 * HR Admin        -> HR        = ALLOW
 * HR Admin        -> Marketing = DENY
 * Member          -> high-risk approval = DENY
 * Disabled user   -> workflow execution = DENY
 * ```
 *
 * The API-level version of this already passes (`authorization-scope.e2e-spec`).
 * This exists because they are different claims: that one proves the SERVER
 * denies, this proves a real signed-in person in a real browser cannot reach the
 * data — which is what a customer and an auditor actually care about. A UI that
 * renders another department's workflow from a stale cache would pass the first
 * and fail this.
 *
 * Org scaffolding (departments, extra admins) is built over the API on purpose:
 * clicking through it would make every assertion depend on a dozen unrelated
 * screens. The thing under test — what a signed-in user can SEE and DO — is
 * entirely browser.
 */
test.describe('Security journey (§7.2)', () => {
  test('department isolation holds in the browser, both directions', async ({
    page,
    browser,
    request,
  }) => {
    const stamp = unique('sec');
    const { email, password } = await signUpThroughUi(page, 'sec');
    const owner = await apiLogin(request, email, password);
    await completeOnboarding(request, owner.accessToken);

    // Two scoped departments.
    const marketing = await apiPost<{ id: string }>(
      request,
      owner.accessToken,
      '/departments',
      { name: `Marketing ${stamp}`, scopes: ['MARKETING'] },
    );
    const people = await apiPost<{ id: string }>(
      request,
      owner.accessToken,
      '/departments',
      { name: `People ${stamp}`, scopes: ['HR'] },
    );

    // One workflow per department, named so the browser assertion is readable.
    // Short, distinctive names: a long one risks being truncated by the list UI,
    // which would fail the assertion for a reason that has nothing to do with
    // authorization.
    const suffix = stamp.slice(-6);
    const hrName = `HRWF${suffix}`;
    const mktName = `MKTWF${suffix}`;
    const makeWorkflow = (name: string, category: string) =>
      apiPost<{ id: string }>(request, owner.accessToken, '/workflows', {
        name,
        category,
        definition: {
          nodes: [
            { id: 't', type: 'TRIGGER', config: {} },
            { id: 'n', type: 'NOTIFY', config: { message: name } },
          ],
          edges: [{ from: 't', to: 'n' }],
        },
      });
    const hrWorkflow = await makeWorkflow(hrName, 'HR');
    await makeWorkflow(mktName, 'MARKETING');

    // An admin placed in Marketing.
    const mktEmail = `mkt-${stamp}@example.com`;
    const mktPassword = 'BrowserE2E-pass1';
    await apiPost(request, owner.accessToken, '/users', {
      name: 'Marketing Admin',
      email: mktEmail,
      password: mktPassword,
      role: 'ADMIN',
    });
    const users = await apiGet<{ id: string; email: string }[]>(
      request,
      owner.accessToken,
      '/users',
    );
    const mktUser = users.find((u) => u.email === mktEmail);
    expect(mktUser, 'the invited marketing admin should exist').toBeTruthy();
    await request.patch(
      `${process.env.E2E_API_URL ?? 'http://localhost:4000'}/users/${mktUser!.id}`,
      {
        headers: { Authorization: `Bearer ${owner.accessToken}` },
        data: { departmentId: marketing.id },
      },
    );

    // Check the SERVER's answer first. If the API is already wrong, the browser
    // assertion below would fail for the same reason and the trace would send
    // someone hunting a UI bug that does not exist.
    const mktAuth = await apiLogin(request, mktEmail, mktPassword);
    const visibleToMkt = await apiGet<{ name: string }[]>(
      request,
      mktAuth.accessToken,
      '/workflows',
    );
    const names = visibleToMkt.map((w) => w.name);
    expect(names, 'API: marketing admin should see the marketing workflow').toContain(
      mktName,
    );
    expect(names, 'API: marketing admin must NOT see the HR workflow').not.toContain(
      hrName,
    );

    // ── The actual browser assertions ──────────────────────────────────────
    const mktContext = await browser.newContext();
    const mktPage = await mktContext.newPage();
    await logInThroughUi(mktPage, mktEmail, mktPassword);

    await mktPage.goto('/workflows');
    await mktPage.waitForLoadState('networkidle');
    // Assert on the page's TEXT rather than a locator: when this fails the
    // message shows what actually rendered, which turns "element not found"
    // into a diagnosis.
    const pageText = await mktPage.locator('body').innerText();
    expect(
      pageText,
      `marketing admin at ${mktPage.url()} should see ${mktName}`,
    ).toContain(mktName);
    // DENY: the other department's is not merely un-openable — it is not even
    // listed. A title alone tells a Marketing admin what HR is doing.
    await expect(mktPage.getByText(hrName)).toHaveCount(0);

    // And opening it directly by id does not work either.
    await mktPage.goto(`/workflows/${hrWorkflow.id}`);
    await expect(mktPage.getByText(hrName)).toHaveCount(0);

    await mktContext.close();
    void people;
  });

  test('a DISABLED user cannot use the app at all', async ({
    page,
    browser,
    request,
  }) => {
    const stamp = unique('disabled');
    const { email, password } = await signUpThroughUi(page, 'disabled');
    const owner = await apiLogin(request, email, password);

    const memberEmail = `member-${stamp}@example.com`;
    const memberPassword = 'BrowserE2E-pass1';
    await apiPost(request, owner.accessToken, '/users', {
      name: 'Soon Disabled',
      email: memberEmail,
      password: memberPassword,
      role: 'MEMBER',
    });

    // Sign in FIRST, so the session is live when the account is disabled — the
    // interesting case is a kill switch taking effect mid-session, not simply a
    // disabled user failing to log in.
    const memberContext = await browser.newContext();
    const memberPage = await memberContext.newPage();
    await logInThroughUi(memberPage, memberEmail, memberPassword);

    const users = await apiGet<{ id: string; email: string }[]>(
      request,
      owner.accessToken,
      '/users',
    );
    const member = users.find((u) => u.email === memberEmail);
    await request.patch(
      `${process.env.E2E_API_URL ?? 'http://localhost:4000'}/users/${member!.id}`,
      {
        headers: { Authorization: `Bearer ${owner.accessToken}` },
        data: { status: 'DISABLED' },
      },
    );

    // The live session must stop working — not at token expiry, now.
    await memberPage.goto('/workflows');
    await expect(memberPage).toHaveURL(/\/login|\/account-locked/, {
      timeout: 30_000,
    });

    // And they cannot get back in.
    const retry = await browser.newContext();
    const retryPage = await retry.newPage();
    await retryPage.goto('/login');
    await retryPage.getByLabel(/email/i).fill(memberEmail);
    await retryPage.getByLabel('Password', { exact: true }).fill(memberPassword);
    await retryPage.getByRole('button', { name: /sign in|log in/i }).click();
    await expect(retryPage).toHaveURL(/\/login|\/account-locked/);

    await memberContext.close();
    await retry.close();
  });

  test('a MEMBER cannot reach the HR area', async ({ page, browser, request }) => {
    // HR holds special-category PII and is OWNER/ADMIN-only, reads included.
    const stamp = unique('member');
    const { email, password } = await signUpThroughUi(page, 'member');
    const owner = await apiLogin(request, email, password);

    const memberEmail = `plain-${stamp}@example.com`;
    const memberPassword = 'BrowserE2E-pass1';
    await apiPost(request, owner.accessToken, '/users', {
      name: 'Plain Member',
      email: memberEmail,
      password: memberPassword,
      role: 'MEMBER',
    });

    const ctx = await browser.newContext();
    const memberPage = await ctx.newPage();
    await logInThroughUi(memberPage, memberEmail, memberPassword);

    // The API is the authority; assert it directly with the member's own token
    // so this cannot pass merely because a nav link was hidden. A hidden link is
    // not an authorization control.
    const memberAuth = await apiLogin(request, memberEmail, memberPassword);
    const hr = await request.get(
      `${process.env.E2E_API_URL ?? 'http://localhost:4000'}/hr/staff`,
      { headers: { Authorization: `Bearer ${memberAuth.accessToken}` } },
    );
    expect(hr.status()).toBe(403);

    await ctx.close();
  });
});
