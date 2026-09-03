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
 * What a customer sees when things go WRONG.
 *
 * ## Why this file exists
 *
 * The 2026-09-02 audit found the browser suite covered the happy path
 * thoroughly and had **no failure-path coverage at all** — none of insufficient
 * credits, approval rejection, a disabled employee, a permission denial or a
 * duplicate submission. That is the wrong way round: the happy path is what a
 * demo shows, and the failure paths are what a customer meets on day three.
 *
 * The rule every assertion here enforces is the one the audit named the
 * "silent-success defect class": **an operation that did not happen must never
 * look like one that did.** A green run that sent nothing, a "Credits 0" on a
 * billed run, a `notified: true` with no message — all the same bug.
 */
test.describe('Failure journeys', () => {
  /**
   * A rejected approval must FAIL the run, not quietly complete it.
   *
   * The mirror image of the golden journey. That one proves approve → execute
   * exactly once; without this one, a build where "reject" silently behaved
   * like "approve" would still be green.
   */
  test('rejecting an approval fails the run and executes nothing', async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const stamp = unique('reject');
    const { email, password } = await signUpThroughUi(page, 'reject');
    await verifyEmailThroughUi(page);
    const owner = await apiLogin(request, email, password);
    await completeOnboarding(request, owner.accessToken);

    const employee = await apiPost<{ id: string }>(
      request,
      owner.accessToken,
      '/employees',
      { name: `Rej${stamp.slice(-5)}`, role: 'MARKETING' },
    );
    // stripe is highRisk in the catalog, which is what makes the run pause.
    const installed = await apiPost<{ id: string }>(
      request,
      owner.accessToken,
      '/skills/install',
      { skillKey: 'stripe' },
    );
    await apiPost(request, owner.accessToken, `/employees/${employee.id}/skills`, {
      installedSkillId: installed.id,
    });

    const definition = {
      nodes: [
        { id: 'trigger', type: 'TRIGGER', config: {} },
        {
          id: 'charge',
          type: 'TOOL_ACTION',
          config: {
            skillKey: 'stripe',
            tool: 'create_payment_link',
            employeeId: employee.id,
            args: { amount: 999, currency: 'usd', description: 'Should never happen' },
            outputKey: 'link',
          },
        },
      ],
      edges: [{ from: 'trigger', to: 'charge' }],
    };
    const workflow = await apiPost<{ id: string }>(
      request,
      owner.accessToken,
      '/workflows',
      { name: `REJECT-${stamp.slice(-5)}`, definition },
    );
    await request.put(`${API}/workflows/${workflow.id}/draft`, {
      headers: authHeaders(owner.accessToken),
      data: { definition },
    });
    await apiPost(request, owner.accessToken, `/workflows/${workflow.id}/publish`, {
      activate: true,
    });
    const run = await apiPost<{ id: string }>(
      request,
      owner.accessToken,
      `/workflows/${workflow.id}/run`,
      {},
    );

    const waiting = await waitForRunStatus(request, owner.accessToken, run.id, (s) =>
      ['WAITING', 'COMPLETED', 'FAILED'].includes(s),
    );
    expect(waiting, 'a high-risk tool must pause for a human').toBe('WAITING');

    // Reject it through the real screen — the button a real approver clicks.
    await page.goto('/approvals');
    await expect(
      page.getByText(/create_payment_link|stripe/i).first(),
      'the approvals queue should name the gated tool',
    ).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: /^reject$/i }).first().click();

    const final = await waitForRunStatus(request, owner.accessToken, run.id, (s) =>
      ['COMPLETED', 'FAILED', 'CANCELLED'].includes(s),
    );
    expect(
      final,
      'a rejected approval must fail the run — completing it would mean the ' +
        'rejection changed nothing',
    ).not.toBe('COMPLETED');

    // And nothing was executed. This is the assertion that matters: a run can
    // fail for any number of reasons, but a REJECTED gate must leave the side
    // effect unperformed.
    const activity = await apiGet<{ toolCalls?: number }>(
      request,
      owner.accessToken,
      '/analytics/activity',
    );
    expect(
      activity.toolCalls ?? 0,
      'no tool call may happen after a rejection',
    ).toBe(0);

    // The run page must SAY it failed, not show a blank or a success.
    await page.goto(`/runs/${run.id}`);
    await page.waitForLoadState('networkidle');
    const body = await page.locator('body').innerText();
    expect(body, 'the run page must show the failure').toMatch(/failed|cancelled/i);
    expect(body, 'the run page must not claim success').not.toMatch(/completed/i);
  });

  /**
   * A DISABLED user cannot start a run, and is told why.
   *
   * `02-security-journey` proves a disabled user cannot use the app. This is the
   * narrower, more dangerous case: a token issued BEFORE the disable, used
   * against the one endpoint that spends money and touches the outside world.
   */
  test('a disabled user cannot trigger a workflow with a token issued before the disable', async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const stamp = unique('disabled');
    const { email, password } = await signUpThroughUi(page, 'disabled-owner');
    await verifyEmailThroughUi(page);
    const owner = await apiLogin(request, email, password);
    await completeOnboarding(request, owner.accessToken);

    const memberEmail = `${unique('member')}@example.com`;
    const memberPassword = 'BrowserE2E-pass1';
    const member = await apiPost<{ id: string }>(
      request,
      owner.accessToken,
      '/users',
      {
        name: 'Soon Disabled',
        email: memberEmail,
        password: memberPassword,
        role: 'ADMIN',
      },
    );
    const memberSession = await apiLogin(request, memberEmail, memberPassword);

    const definition = {
      nodes: [
        { id: 'trigger', type: 'TRIGGER', config: {} },
        { id: 'note', type: 'NOTIFY', config: { message: 'ran' } },
      ],
      edges: [{ from: 'trigger', to: 'note' }],
    };
    const workflow = await apiPost<{ id: string }>(
      request,
      memberSession.accessToken,
      '/workflows',
      { name: `DISABLED-${stamp.slice(-5)}`, definition },
    );
    await request.put(`${API}/workflows/${workflow.id}/draft`, {
      headers: authHeaders(memberSession.accessToken),
      data: { definition },
    });
    await apiPost(
      request,
      memberSession.accessToken,
      `/workflows/${workflow.id}/publish`,
      { activate: true },
    );

    // The token still works right up to the moment the account is disabled —
    // establishing that the NEXT assertion is about the disable, not about a
    // token that never worked.
    const beforeDisable = await request.post(
      `${API}/workflows/${workflow.id}/run`,
      { headers: authHeaders(memberSession.accessToken), data: {} },
    );
    expect(beforeDisable.ok(), 'an active admin can run their workflow').toBeTruthy();

    await request.patch(`${API}/users/${member.id}`, {
      headers: authHeaders(owner.accessToken),
      data: { status: 'DISABLED' },
    });

    const afterDisable = await request.post(
      `${API}/workflows/${workflow.id}/run`,
      { headers: authHeaders(memberSession.accessToken), data: {} },
    );
    expect(
      afterDisable.ok(),
      'a DISABLED user must not be able to start a run with an already-issued token',
    ).toBeFalsy();
    expect([401, 403]).toContain(afterDisable.status());
  });

  /**
   * A skill that cannot really act must refuse the credential handover.
   *
   * Audit P1-E: `hubspot` has fully working OAuth and no executor, so a
   * customer could grant Orlixa live CRM access for a capability that does not
   * exist. The gate is server-side because the authorize endpoint is reachable
   * directly — hiding the button is not a control, which is exactly what this
   * test calls the endpoint to prove.
   */
  test('a demo-only skill refuses to start an OAuth flow', async ({ page, request }) => {
    test.setTimeout(120_000);
    const { email, password } = await signUpThroughUi(page, 'fakeskill');
    await verifyEmailThroughUi(page);
    const owner = await apiLogin(request, email, password);
    await completeOnboarding(request, owner.accessToken);

    const installed = await apiPost<{ id: string }>(
      request,
      owner.accessToken,
      '/skills/install',
      { skillKey: 'hubspot' },
    );

    const authorize = await request.get(
      `${API}/skills/installed/${installed.id}/oauth/authorize`,
      { headers: authHeaders(owner.accessToken) },
    );
    expect(
      authorize.ok(),
      'a skill with no real executor must not begin an OAuth flow',
    ).toBeFalsy();
    const message = await authorize.text();
    expect(
      message,
      'the refusal must explain WHY, not just say no',
    ).toMatch(/simulated|real action|demo/i);

    // A skill that CAN act is unaffected — the gate is targeted, not a blanket
    // "OAuth is broken".
    const gmail = await apiPost<{ id: string }>(
      request,
      owner.accessToken,
      '/skills/install',
      { skillKey: 'gmail' },
    );
    const gmailAuth = await request.get(
      `${API}/skills/installed/${gmail.id}/oauth/authorize`,
      { headers: authHeaders(owner.accessToken) },
    );
    // Either a real URL (OAuth configured) or a "not configured" error — but
    // NOT the can't-act refusal, which is the thing under test.
    expect(await gmailAuth.text()).not.toMatch(/simulated|demo only/i);
  });

  /**
   * The same idempotency key must not run the workflow twice.
   *
   * The browser equivalent of a double-click, and the one failure mode where
   * "it worked twice" costs a customer real money.
   */
  test('a duplicate submission produces one run, not two', async ({ page, request }) => {
    test.setTimeout(120_000);
    const stamp = unique('dupe');
    const { email, password } = await signUpThroughUi(page, 'dupe');
    await verifyEmailThroughUi(page);
    const owner = await apiLogin(request, email, password);
    await completeOnboarding(request, owner.accessToken);

    const definition = {
      nodes: [
        { id: 'trigger', type: 'TRIGGER', config: {} },
        { id: 'note', type: 'NOTIFY', config: { message: 'once only' } },
      ],
      edges: [{ from: 'trigger', to: 'note' }],
    };
    const workflow = await apiPost<{ id: string }>(
      request,
      owner.accessToken,
      '/workflows',
      { name: `DUPE-${stamp.slice(-5)}`, definition },
    );
    await request.put(`${API}/workflows/${workflow.id}/draft`, {
      headers: authHeaders(owner.accessToken),
      data: { definition },
    });
    await apiPost(request, owner.accessToken, `/workflows/${workflow.id}/publish`, {
      activate: true,
    });

    const key = `dupe-${stamp}`;
    const [first, second] = await Promise.all([
      request.post(`${API}/workflows/${workflow.id}/run`, {
        headers: { ...authHeaders(owner.accessToken), 'Idempotency-Key': key },
        data: {},
      }),
      request.post(`${API}/workflows/${workflow.id}/run`, {
        headers: { ...authHeaders(owner.accessToken), 'Idempotency-Key': key },
        data: {},
      }),
    ]);
    expect(first.ok() && second.ok(), 'both calls should be accepted').toBeTruthy();

    const runA = (await first.json()) as { id: string };
    const runB = (await second.json()) as { id: string };
    expect(
      runA.id,
      'the same idempotency key must return the SAME run, not a second one',
    ).toBe(runB.id);

    const runs = await apiGet<unknown[]>(
      request,
      owner.accessToken,
      `/workflows/${workflow.id}/runs`,
    );
    expect(runs.length, 'exactly one run should exist').toBe(1);
  });
});

/** Poll a run until `done(status)`, or fail with the last status seen. */
async function waitForRunStatus(
  request: Parameters<typeof apiGet>[0],
  token: string,
  runId: string,
  done: (status: string) => boolean,
  timeoutMs = 90_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = 'UNKNOWN';
  while (Date.now() < deadline) {
    const run = await apiGet<{ status: string }>(
      request,
      token,
      `/workflows/runs/${runId}`,
    );
    last = run.status;
    if (done(last)) return last;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`run ${runId} never reached a terminal state (last: ${last})`);
}
