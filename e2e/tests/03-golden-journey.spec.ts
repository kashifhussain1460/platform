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
 * WAVE 6 / §23 — the Golden Enterprise Journey, in a real browser.
 *
 * The hardening plan lists this journey step by step and its Definition of Done
 * names each stage separately. Until now the browser suite proved auth and
 * authorization only; everything past login — employees, skills, knowledge,
 * workflows, execution, approval, audit, analytics — was covered by API tests
 * alone. An API test cannot tell you the Approvals screen never renders the
 * button, and that is precisely the failure a customer meets first.
 *
 * ## What is driven through the UI, and why not all of it
 *
 * The stages the DoD names as *browser* proof are clicked: signup, employee
 * creation, skill connection, knowledge upload, the workflow list, the approval
 * decision, and the dashboard. Graph authoring is done through the API on
 * purpose — the builder is a drag-and-drop canvas, and driving it by mouse would
 * make this test a canvas-interaction test that fails for layout reasons and
 * tells you nothing about the journey. The same rule the security journey
 * already follows: assert the server's answer, then assert what the human sees.
 *
 * ## The step that matters most
 *
 * A high-risk `TOOL_ACTION` must PAUSE the run, surface an approval a human can
 * act on **in the UI**, and then execute exactly once. That single path is the
 * whole product claim: "an AI Employee can act, and a person stays in control."
 */
test.describe('Golden Enterprise Journey (§23)', () => {
  test('signup → employee → skill → knowledge → workflow → approval → execution → audit', async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const stamp = unique('gold');
    const suffix = stamp.slice(-6);

    // ── 1. Register + login (browser) ────────────────────────────────────────
    const { email, password } = await signUpThroughUi(page, 'gold');
    // A fresh owner is parked at /verify-email; every app route below redirects
    // there until the gate is cleared.
    await verifyEmailThroughUi(page);
    const owner = await apiLogin(request, email, password);
    await completeOnboarding(request, owner.accessToken);

    // ── 2. Hire an AI Employee — asserted in the browser ─────────────────────
    const employeeName = `Nova${suffix}`;
    const employee = await apiPost<{ id: string; name: string }>(
      request,
      owner.accessToken,
      '/employees',
      { name: employeeName, role: 'MARKETING' },
    );

    await page.goto('/employees');
    // An auto-retrying assertion, not a one-shot innerText snapshot: the list is
    // fetched client-side and `networkidle` can settle before the query does, so
    // a snapshot races the render and fails for a reason that is not the product.
    await expect(
      page.getByText(employeeName).first(),
      'the roster should show the hired employee',
    ).toBeVisible({ timeout: 30_000 });

    // ── 3. Connect a skill — asserted in the browser ─────────────────────────
    // stripe is `highRisk` in the catalog, which is what makes step 7 pause.
    const installed = await apiPost<{ id: string }>(
      request,
      owner.accessToken,
      '/skills/install',
      { skillKey: 'stripe' },
    );

    // GRANT it to this employee. Not optional scaffolding — §12: a skill the
    // company has installed is NOT usable by an employee it was never granted
    // to, and the check is at EXECUTION, not merely when listing tools. The
    // first run of this journey proved it by failing here with
    // "Skill \"stripe\" is not assigned to this AI employee" after the approval
    // had already been granted, which is exactly the right order: a human
    // approving something does not widen what the employee is allowed to do.
    await apiPost(
      request,
      owner.accessToken,
      `/employees/${employee.id}/skills`,
      { installedSkillId: installed.id },
    );

    await page.goto('/skills');
    await expect(
      page.getByText(/stripe/i).first(),
      'the skills screen should show the installed skill',
    ).toBeVisible({ timeout: 30_000 });

    // ── 4. Upload knowledge — through the real screen ────────────────────────
    const docName = `handbook-${suffix}.txt`;
    await page.goto('/knowledge');
    await page.waitForLoadState('networkidle');
    // Choosing who can read the document is now a REQUIRED step, not a default.
    // The page used to default to "Shared (everyone)", so a document uploaded by
    // someone who never opened this dropdown became readable by every AI
    // Employee — an HR salary band answerable by the Sales assistant, with
    // nothing anywhere saying so. Uploads are blocked until a human decides, so
    // the journey has to decide too.
    await page.getByLabel(/visible to/i).selectOption('SHARED');
    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.setInputFiles({
      name: docName,
      mimeType: 'text/plain',
      buffer: Buffer.from(
        'Refunds over 100 USD require a manager to approve them first.',
      ),
    });
    // Ingestion is a queued job; the row appears immediately, its status settles
    // later. The journey only needs the document to EXIST.
    await expect(page.getByText(docName)).toBeVisible({ timeout: 45_000 });

    // ── 5. Create + publish + activate a workflow ────────────────────────────
    const workflowName = `GOLD${suffix}`;
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
            // `description` is required by the catalog tool. It was absent and
            // the mock executor accepted the call anyway; a real Stripe call
            // would have rejected it, and TOOL_ACTION now refuses to send a
            // required argument that resolved to nothing. The approval gate is
            // what this journey tests, so the args just need to be the ones a
            // customer would really set.
            args: {
              amount: 4200,
              currency: 'usd',
              description: 'Golden journey payment link',
            },
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
      { name: workflowName, category: 'MARKETING', definition },
    );

    // Publish works from the DRAFT version, not from the workflow row — an edit
    // in progress must never be able to change what is already live. So the
    // graph is saved as a draft first, exactly as the builder does.
    const draftRes = await request.put(
      `${API}/workflows/${workflow.id}/draft`,
      { headers: authHeaders(owner.accessToken), data: { definition } },
    );
    expect(
      draftRes.ok(),
      `save draft → ${draftRes.status()}: ${await draftRes.text()}`,
    ).toBeTruthy();

    await apiPost(
      request,
      owner.accessToken,
      `/workflows/${workflow.id}/publish`,
      {},
    );
    await apiPost(
      request,
      owner.accessToken,
      `/workflows/${workflow.id}/activate`,
      {},
    );

    await page.goto('/workflows');
    await expect(
      page.getByText(workflowName).first(),
      'the workflow list should show the published workflow',
    ).toBeVisible({ timeout: 30_000 });

    // ── 6. Trigger it ────────────────────────────────────────────────────────
    const run = await apiPost<{ id: string }>(
      request,
      owner.accessToken,
      `/workflows/${workflow.id}/run`,
      {},
    );

    // ── 7. It must PAUSE, not sail through ───────────────────────────────────
    const waiting = await waitForRunStatus(
      request,
      owner.accessToken,
      run.id,
      (s) => s === 'WAITING' || s === 'COMPLETED' || s === 'FAILED',
    );
    expect(
      waiting,
      'a high-risk tool must pause the run for a human, never execute unapproved',
    ).toBe('WAITING');

    // Nothing has been executed yet — the gate sits BEFORE the side effect.
    // `/analytics/activity` counts real SkillExecution rows, so this asks the
    // question the customer cares about: has anyone been charged yet?
    expect(
      await toolCallCount(request, owner.accessToken),
      'no tool call may have happened while the run is WAITING',
    ).toBe(0);

    // ── 8. Approve it IN THE BROWSER ─────────────────────────────────────────
    await page.goto('/approvals');
    await expect(
      page.getByText(/create_payment_link|stripe/i).first(),
      'the approvals queue should name the gated tool',
    ).toBeVisible({ timeout: 30_000 });

    // The button a real approver clicks. If this is missing, the API can be
    // perfect and the feature still does not exist for a customer.
    await page.getByRole('button', { name: /^approve$/i }).first().click();

    // ── 9. The run resumes and finishes ──────────────────────────────────────
    const final = await waitForRunStatus(
      request,
      owner.accessToken,
      run.id,
      (s) => s === 'COMPLETED' || s === 'FAILED' || s === 'CANCELLED',
    );
    if (final !== 'COMPLETED') {
      // Print WHY. "Expected COMPLETED, received FAILED" sends someone hunting;
      // the run's own error names the step that broke.
      const detail = await apiGet<{ error?: string; steps?: unknown[] }>(
        request,
        owner.accessToken,
        `/workflows/runs/${run.id}`,
      );
      throw new Error(
        `run ${run.id} ended ${final}: ${detail.error ?? '(no error)'}
steps=${JSON.stringify(detail.steps)}`,
      );
    }

    // ── 10. EXACTLY ONCE ─────────────────────────────────────────────────────
    expect(
      await toolCallCount(request, owner.accessToken),
      'the approved tool must run exactly once — never zero, never twice',
    ).toBe(1);

    // ── 11. Audit ────────────────────────────────────────────────────────────
    // Verified through the API: the platform has no audit SCREEN yet, and
    // asserting against a page that does not exist would be the "harness exists,
    // therefore it passed" failure this wave is about.
    const auditText = JSON.stringify(
      await apiGet<unknown[]>(request, owner.accessToken, '/audit-log'),
    );
    expect(auditText, 'the approval decision must be on the audit trail').toMatch(
      /approval\.approved/,
    );

    const verification = await apiGet<{ valid: boolean; checked: number }>(
      request,
      owner.accessToken,
      '/audit-log/verify',
    );
    expect(verification.valid, 'the audit hash chain must verify').toBe(true);

    // ── 12. Analytics, in the browser ────────────────────────────────────────
    await page.goto('/dashboard');
    await page.waitForLoadState('networkidle');
    const dashboard = await page.locator('body').innerText();
    expect(
      dashboard,
      'the dashboard should render the company after a real run',
    ).not.toMatch(/something went wrong|failed to load/i);
  });
});

/**
 * How many times `stripe.create_payment_link` has actually executed.
 *
 * Counted from `/analytics/activity`, which aggregates real `SkillExecution`
 * rows — the same rows a customer's invoice would be built from. Asserting on
 * the run's own output instead would only prove the engine believes it ran.
 */
async function toolCallCount(
  request: import('@playwright/test').APIRequestContext,
  token: string,
): Promise<number> {
  // The feed is grouped per employee, each with `items: {label, count}[]`.
  const feed = await apiGet<
    { items?: { label: string; count: number }[] }[]
  >(request, token, '/analytics/activity');
  return feed
    .flatMap((row) => row.items ?? [])
    .filter((item) => item.label.includes('create_payment_link'))
    .reduce((sum, item) => sum + item.count, 0);
}

/** Poll a run until `done(status)`, then return the status it settled on. */
async function waitForRunStatus(
  request: import('@playwright/test').APIRequestContext,
  token: string,
  runId: string,
  done: (status: string) => boolean,
  timeoutMs = 60_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let status = 'PENDING';
  while (Date.now() < deadline) {
    const res = await request.get(`${API}/workflows/runs/${runId}`, {
      headers: authHeaders(token),
    });
    if (res.ok()) {
      status = ((await res.json()) as { status: string }).status;
      if (done(status)) return status;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return status;
}
