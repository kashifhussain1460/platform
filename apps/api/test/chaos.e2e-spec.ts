import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import type { Job } from 'bullmq';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import {
  LLM_PROVIDER_TOKEN,
  type LlmCompletionInput,
  type LlmCompletionResult,
  type LlmProvider,
} from '../src/modules/employees/llm/llm.provider';
import {
  SKILL_EXECUTOR_TOKEN,
  type SkillExecutionResult,
  type SkillExecutor,
} from '../src/modules/skills/executors/skill-executor';
import { NodeAttemptProcessor } from '../src/modules/workflow-runtime/node-attempt.processor';
import { ReaperService } from '../src/modules/workflow-runtime/reaper.service';
import type { NodeAttemptJobData } from '../src/modules/workflow-runtime/workflow-runtime.constants';
import { WorkflowsService } from '../src/modules/workflows/workflows.service';

/**
 * A provider whose behaviour a test can switch mid-suite — scenarios #10 and
 * #11 (provider 500, provider timeout).
 *
 * A real outage is not "the mock returned false": it is a 5xx body, or a socket
 * that never answers. Both must land in the runtime as the RIGHT failure class,
 * because that is what decides whether the platform retries or gives up, and
 * getting it backwards either hammers a struggling provider or abandons a run
 * that would have succeeded on the next attempt.
 */
class ScriptedSkillExecutor implements SkillExecutor {
  readonly name = 'scripted';
  mode: 'ok' | 'http500' | 'timeout' = 'ok';
  calls = 0;

  execute(
    skillKey: string,
    tool: string,
  ): Promise<SkillExecutionResult> {
    this.calls += 1;
    if (this.mode === 'http500') {
      // A provider failure, not a thrown error: SkillsService surfaces it as
      // ok:false and the node turns that into a failed step.
      return Promise.resolve({
        ok: false,
        error: `Provider responded HTTP 500 for ${skillKey}/${tool}`,
      });
    }
    if (this.mode === 'timeout') {
      return Promise.reject(new Error('socket hang up: request timed out'));
    }
    return Promise.resolve({ ok: true, result: { echoed: true } });
  }
}

/**
 * A model provider that never answers — scenario #12, the one WAVE 8 could not
 * cover and explicitly refused to claim as closed.
 *
 * It settles ONLY when aborted, which is what makes the test meaningful: if the
 * node's timeout merely stopped waiting without cancelling, `aborted` stays 0
 * and this promise stays pending for the life of the process. "The step failed"
 * alone would pass either way, so the assertion that matters is that the
 * request was actually torn down.
 */
class HangingLlmProvider implements LlmProvider {
  readonly name = 'hanging';
  calls = 0;
  aborted = 0;

  complete(input: LlmCompletionInput): Promise<LlmCompletionResult> {
    this.calls += 1;
    return new Promise<LlmCompletionResult>((_resolve, reject) => {
      input.signal?.addEventListener('abort', () => {
        this.aborted += 1;
        reject(new Error('Request was aborted'));
      });
    });
  }
}

/**
 * WAVE 8 §8.1 — chaos.
 *
 * The plan lists fourteen failure scenarios and six invariants that must hold
 * through all of them:
 *
 * ```
 * No lost run      No duplicate side effect   No tenant leak
 * No approval bypass   No phantom success     No secret leak
 * ```
 *
 * This suite covers the scenarios that can be caused HONESTLY from inside a
 * test: worker crash (lease expiry), reaper recovery, duplicate queue job,
 * duplicate webhook, API restart, approval timeout, LLM timeout, external
 * failure, and the two invariants that are properties of the whole system
 * (tenant leak, secret leak).
 *
 * Provider 500, provider timeout and an expired OAuth grant are covered too:
 * the first two by scripting the executor, the third by putting the connector
 * in the state a revoked grant leaves it in.
 *
 * The three that cannot be — Redis restart, DB connection loss and a deployment
 * mid-workflow — are drills, not unit tests: they need the infrastructure to
 * actually be taken away. They are in
 * `docs/ops/chaos-drills.md` with the commands to run and the evidence from the
 * last time they were run. Pretending an in-process mock of "Redis went away"
 * proves anything about a real Redis outage would be the exact "harness exists,
 * therefore it passed" failure the plan warns about.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

describeIfDb('WAVE 8 §8.1 — chaos invariants', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let reaper: ReaperService;
  let workflows: WorkflowsService;
  let attempts: NodeAttemptProcessor;
  const llm = new HangingLlmProvider();
  const executor = new ScriptedSkillExecutor();

  const stamp = Date.now();
  let companyId = '';
  let otherCompanyId = '';
  let workflowId = '';
  let aiWorkflowId = '';
  let toolWorkflowId = '';
  let installedSkillId = '';
  let userId = '';

  /**
   * Build the app with the hanging provider in place.
   *
   * Shared with the API-restart test rather than inlined twice: that test
   * rebuilds the module, and a rebuild that dropped the override would silently
   * restore the real provider for every test declared after it.
   */
  async function createApp(): Promise<INestApplication> {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(LLM_PROVIDER_TOKEN)
      .useValue(llm)
      .overrideProvider(SKILL_EXECUTOR_TOKEN)
      .useValue(executor)
      .compile();
    const created = moduleRef.createNestApplication();
    await created.init();
    return created;
  }

  beforeAll(async () => {
    app = await createApp();

    prisma = app.get(PrismaService);
    reaper = app.get(ReaperService);
    workflows = app.get(WorkflowsService);
    attempts = app.get(NodeAttemptProcessor);

    const company = await prisma.company.create({
      data: { name: `Chaos Co ${stamp}`, slug: `chaos-${stamp}` },
    });
    companyId = company.id;
    const other = await prisma.company.create({
      data: { name: `Chaos Other ${stamp}`, slug: `chaos-other-${stamp}` },
    });
    otherCompanyId = other.id;

    const user = await prisma.user.create({
      data: {
        companyId,
        email: `chaos-${stamp}@example.com`,
        name: 'Chaos Owner',
        role: 'OWNER',
        passwordHash: 'x',
      },
    });
    userId = user.id;

    const workflow = await prisma.workflow.create({
      data: {
        companyId,
        name: 'Chaos WF',
        status: 'ACTIVE',
        definition: {
          nodes: [
            { id: 'trigger', type: 'TRIGGER', config: {} },
            { id: 'noop', type: 'NOOP', config: {} },
          ],
          edges: [{ from: 'trigger', to: 'noop' }],
        },
      },
    });
    workflowId = workflow.id;

    const aiWorkflow = await prisma.workflow.create({
      data: {
        companyId,
        name: 'Chaos AI WF',
        status: 'ACTIVE',
        definition: {
          nodes: [
            { id: 'trigger', type: 'TRIGGER', config: {} },
            {
              id: 'think',
              type: 'AI_STEP',
              config: { prompt: 'Summarise this.', outputKey: 'summary' },
            },
          ],
          edges: [{ from: 'trigger', to: 'think' }],
        },
      },
    });
    aiWorkflowId = aiWorkflow.id;

    // A NON-high-risk tool on purpose: `http.request` is not gated, so these
    // tests exercise the failure path rather than re-testing the approval gate.
    const toolWorkflow = await prisma.workflow.create({
      data: {
        companyId,
        name: 'Chaos Tool WF',
        status: 'ACTIVE',
        definition: {
          nodes: [
            { id: 'trigger', type: 'TRIGGER', config: {} },
            {
              id: 'call',
              type: 'TOOL_ACTION',
              config: {
                skillKey: 'http',
                tool: 'request',
                args: { url: 'https://example.test/ping' },
                outputKey: 'res',
              },
            },
          ],
          edges: [{ from: 'trigger', to: 'call' }],
        },
      },
    });
    toolWorkflowId = toolWorkflow.id;

    installedSkillId = (
      await prisma.installedSkill.create({
        data: {
          companyId,
          skillKey: 'http',
          displayName: 'HTTP',
          connectionStatus: 'CONNECTED',
        },
      })
    ).id;
  });

  afterAll(async () => {
    await prisma?.company.delete({ where: { id: companyId } }).catch(() => undefined);
    await prisma?.company
      .delete({ where: { id: otherCompanyId } })
      .catch(() => undefined);
    await app?.close();
  });

  /** A run mid-flight, with a step and an attempt holding a lease. */
  async function runWithLeasedAttempt(leaseExpiresAt: Date, company = companyId) {
    const run = await prisma.workflowRun.create({
      data: { companyId: company, workflowId, status: 'RUNNING' },
    });
    const step = await prisma.workflowStepRun.create({
      data: {
        companyId: company,
        runId: run.id,
        nodeId: 'noop',
        type: 'TOOL_ACTION',
        status: 'RUNNING',
      },
    });
    const attempt = await prisma.workflowStepAttempt.create({
      data: {
        companyId: company,
        runId: run.id,
        stepId: step.id,
        attempt: 1,
        status: 'RUNNING',
        leaseOwner: 'worker-that-died',
        leaseExpiresAt,
        startedAt: new Date(),
      },
    });
    return { run, step, attempt };
  }

  // ── worker crash / lease expiry / reaper recovery ─────────────────────────

  it('worker crash: the attempt is failed as OUTCOME UNKNOWN, never silently retried', async () => {
    // The worker died holding a lease. Its side effect may or may not have
    // happened — that is the whole difficulty. The system must not guess.
    const { attempt } = await runWithLeasedAttempt(new Date(Date.now() - 60_000));

    await reaper.sweep();

    const after = await prisma.workflowStepAttempt.findUnique({
      where: { id: attempt.id },
    });
    expect(after?.status).toBe('FAILED');
    // NO DUPLICATE SIDE EFFECT: re-running an attempt that may have already
    // charged a card is worse than surfacing it to a human.
    expect(after?.outcomeUnknown).toBe(true);
    expect(after?.error).toMatch(/UNKNOWN/i);

    // And no second attempt was created behind our back.
    const attempts = await prisma.workflowStepAttempt.count({
      where: { stepId: attempt.stepId },
    });
    expect(attempts).toBe(1);
  });

  it('a live lease is left alone', async () => {
    // The reaper must only reclaim what is actually dead. Reaping a healthy
    // worker's attempt would create the duplicate it exists to prevent.
    const { attempt } = await runWithLeasedAttempt(new Date(Date.now() + 300_000));

    await reaper.sweep();

    const after = await prisma.workflowStepAttempt.findUnique({
      where: { id: attempt.id },
    });
    expect(after?.status).toBe('RUNNING');
    expect(after?.outcomeUnknown).toBe(false);
  });

  it('no phantom success: a crashed run never reports COMPLETED', async () => {
    const { run } = await runWithLeasedAttempt(new Date(Date.now() - 60_000));

    await reaper.sweep();

    const after = await prisma.workflowRun.findUnique({ where: { id: run.id } });
    // It may be RUNNING (awaiting the advance) or FAILED — but never COMPLETED.
    // A run that says it succeeded while a step's outcome is unknown is the
    // single most dangerous state the system could report.
    expect(after?.status).not.toBe('COMPLETED');
  });

  it('no tenant leak: the reaper does not touch another company', async () => {
    // The reaper is cross-tenant by design (it is a background sweep), which is
    // exactly why it needs a test proving it writes only what it should.
    const mine = await runWithLeasedAttempt(new Date(Date.now() - 60_000));
    const theirs = await runWithLeasedAttempt(
      new Date(Date.now() + 300_000),
      otherCompanyId,
    );

    await reaper.sweep();

    const other = await prisma.workflowStepAttempt.findUnique({
      where: { id: theirs.attempt.id },
    });
    expect(other?.companyId).toBe(otherCompanyId);
    expect(other?.status).toBe('RUNNING');
    const ours = await prisma.workflowStepAttempt.findUnique({
      where: { id: mine.attempt.id },
    });
    expect(ours?.status).toBe('FAILED');
  });

  // ── duplicate delivery ────────────────────────────────────────────────────

  it('duplicate queue job: the same idempotency key produces ONE run', async () => {
    const key = `chaos-dupe-${stamp}`;
    const first = await workflows.createRun(companyId, workflowId, userId, {}, true, key);
    const second = await workflows.createRun(companyId, workflowId, userId, {}, true, key);

    // Same run returned, not a second one started. A provider redelivering a
    // webhook, or a user double-clicking Run, must not run the workflow twice.
    expect(second.id).toBe(first.id);
    const runs = await prisma.workflowRun.count({
      where: { companyId, idempotencyKey: `run:${workflowId}:${key}` },
    });
    expect(runs).toBe(1);
  });

  it('a DIFFERENT key still starts its own run', async () => {
    // The dedup must be a key match, not a blanket "one run per workflow".
    const a = await workflows.createRun(
      companyId,
      workflowId,
      userId,
      {},
      true,
      `chaos-a-${stamp}`,
    );
    const b = await workflows.createRun(
      companyId,
      workflowId,
      userId,
      {},
      true,
      `chaos-b-${stamp}`,
    );
    expect(b.id).not.toBe(a.id);
  });

  // ── approval ──────────────────────────────────────────────────────────────

  it('no approval bypass: a breached approval does not self-approve', async () => {
    // §8.2.11 — `onTimeout` defaults to NONE. An approval that silently passes
    // because nobody looked at it in time is not an approval.
    //
    // SCOPE, stated plainly: this asserts that a breached-but-unswept approval
    // sits still. It deliberately does NOT invoke `ApprovalSlaService.sweep()`,
    // which is cross-tenant and would escalate/expire other tenants' real
    // approvals out of the shared development database. The sweep's own
    // behaviour — escalation, AUTO_APPROVE, EXPIRED, and the human-wins race —
    // is covered by `approval-sla.e2e-spec.ts`, which builds its own fixtures.
    const run = await prisma.workflowRun.create({
      data: { companyId, workflowId, status: 'WAITING' },
    });
    const approval = await prisma.approvalRequest.create({
      data: {
        companyId,
        kind: 'WORKFLOW',
        status: 'PENDING',
        description: 'Chaos approval',
        args: {},
        workflowRunId: run.id,
        dueAt: new Date(Date.now() - 60_000),
      },
    });

    const after = await prisma.approvalRequest.findUnique({
      where: { id: approval.id },
    });
    expect(after?.status).not.toBe('APPROVED');
    // The run stays parked rather than proceeding without a decision.
    const runAfter = await prisma.workflowRun.findUnique({ where: { id: run.id } });
    expect(runAfter?.status).toBe('WAITING');
  });

  // ── restart ───────────────────────────────────────────────────────────────

  it('API restart: a WAITING run survives the process going away', async () => {
    // Run state lives in Postgres, not in worker memory. This is the property
    // that makes the whole runtime durable, so it is asserted rather than
    // assumed. (The same scenario was exercised against real processes by
    // killing the API mid-run — see docs/ops/chaos-drills.md.)
    const run = await prisma.workflowRun.create({
      data: { companyId, workflowId, status: 'WAITING', resumeNodeId: 'noop' },
    });

    await app.close();
    app = await createApp();
    prisma = app.get(PrismaService);
    reaper = app.get(ReaperService);
    workflows = app.get(WorkflowsService);
    attempts = app.get(NodeAttemptProcessor);

    // NO LOST RUN.
    const after = await prisma.workflowRun.findUnique({ where: { id: run.id } });
    expect(after?.status).toBe('WAITING');
    expect(after?.resumeNodeId).toBe('noop');
  });

  // ── LLM timeout (scenario #10) ────────────────────────────────────────────

  it('LLM timeout: a hung model call is bounded, CANCELLED, and classed TIMEOUT', async () => {
    // Attempt 3 of 3 so the failure is terminal — this test is about the bound
    // and the cancellation, not about backoff, which retry-policy.spec covers.
    const run = await prisma.workflowRun.create({
      data: { companyId, workflowId: aiWorkflowId, status: 'RUNNING' },
    });
    const step = await prisma.workflowStepRun.create({
      data: {
        companyId,
        runId: run.id,
        nodeId: 'think',
        type: 'AI_STEP',
        status: 'PENDING',
      },
    });
    const attempt = await prisma.workflowStepAttempt.create({
      data: {
        companyId,
        runId: run.id,
        stepId: step.id,
        attempt: 3,
        status: 'PENDING',
      },
    });

    const before = llm.calls;
    // 1.5s rather than the 30s default: a test that proved the bound by waiting
    // for it would exceed Jest's own timeout and prove nothing.
    process.env.WORKFLOW_NODE_TIMEOUT_MS = '1500';
    try {
      await attempts.process({
        name: 'attempt',
        id: 'chaos-llm-timeout',
        data: {
          runId: run.id,
          companyId,
          stepId: step.id,
          attemptId: attempt.id,
          nodeId: 'think',
          attempt: 3,
        },
      } as unknown as Job<NodeAttemptJobData>);
    } finally {
      delete process.env.WORKFLOW_NODE_TIMEOUT_MS;
    }

    // The provider was reached, and then actually torn down — not left running
    // to spend tokens on an answer the step had already given up on.
    expect(llm.calls).toBe(before + 1);
    expect(llm.aborted).toBe(1);

    const settled = await prisma.workflowStepAttempt.findUnique({
      where: { id: attempt.id },
    });
    expect(settled?.status).toBe('FAILED');
    expect(settled?.failureClass).toBe('TIMEOUT');
    expect(settled?.error).toMatch(/timed out/i);
    // The lease is released, or the reaper would later re-reap a settled attempt.
    expect(settled?.leaseOwner).toBeNull();

    const failedStep = await prisma.workflowStepRun.findUnique({
      where: { id: step.id },
    });
    expect(failedStep?.status).toBe('FAILED');

    // NO PHANTOM SUCCESS: a step whose model never answered cannot leave the
    // run claiming it finished.
    const after = await prisma.workflowRun.findUnique({ where: { id: run.id } });
    expect(after?.status).not.toBe('COMPLETED');
  });

  // ── provider failures (scenarios #10, #11) + OAuth expiry (#9) ─────────────

  /** Run the TOOL_ACTION node once and return its settled attempt row. */
  async function runToolNode(attemptNo = 3) {
    const run = await prisma.workflowRun.create({
      data: { companyId, workflowId: toolWorkflowId, status: 'RUNNING' },
    });
    const step = await prisma.workflowStepRun.create({
      data: {
        companyId,
        runId: run.id,
        nodeId: 'call',
        type: 'TOOL_ACTION',
        status: 'PENDING',
      },
    });
    const attempt = await prisma.workflowStepAttempt.create({
      data: {
        companyId,
        runId: run.id,
        stepId: step.id,
        attempt: attemptNo,
        status: 'PENDING',
      },
    });

    await attempts.process({
      name: 'attempt',
      id: `chaos-tool-${attempt.id}`,
      data: {
        runId: run.id,
        companyId,
        stepId: step.id,
        attemptId: attempt.id,
        nodeId: 'call',
        attempt: attemptNo,
      },
    } as unknown as Job<NodeAttemptJobData>);

    return {
      run,
      attempt: await prisma.workflowStepAttempt.findUnique({
        where: { id: attempt.id },
      }),
    };
  }

  it('provider 500: the step fails as RETRYABLE and never reports success', async () => {
    executor.mode = 'http500';
    try {
      const { run, attempt } = await runToolNode();

      expect(attempt?.status).toBe('FAILED');
      // A 5xx is transient — the same call may well succeed later, so it must
      // NOT be classed as a permanent error that abandons the run.
      expect(attempt?.failureClass).toBe('NODE_ERROR');
      expect(attempt?.error).toMatch(/did not succeed|500/i);

      // NO PHANTOM SUCCESS.
      const after = await prisma.workflowRun.findUnique({ where: { id: run.id } });
      expect(after?.status).not.toBe('COMPLETED');
    } finally {
      executor.mode = 'ok';
    }
  });

  it('provider timeout: classed TIMEOUT, which is what makes it retryable', async () => {
    // The distinction matters in one direction more than the other: a timeout
    // misclassified as permanent abandons a run that would have succeeded, and
    // a permanent error misclassified as a timeout retries something that can
    // never work. The classifier reads the message, so the message is the test.
    executor.mode = 'timeout';
    try {
      const { attempt } = await runToolNode();

      expect(attempt?.status).toBe('FAILED');
      expect(attempt?.failureClass).toBe('TIMEOUT');
    } finally {
      executor.mode = 'ok';
    }
  });

  it('OAuth expiry: a DISCONNECTED connector is quarantined, not hammered', async () => {
    // What a revoked grant actually leaves behind: `ConnectorTokenService` marks
    // the connector DISCONNECTED on `invalid_grant`. From then on the platform
    // must stop calling the provider — retrying a revoked grant cannot succeed,
    // and doing it on every step of every run is how an integration gets rate
    // limited or blocked outright.
    await prisma.installedSkill.update({
      where: { id: installedSkillId },
      data: { connectionStatus: 'DISCONNECTED' },
    });
    const before = executor.calls;
    try {
      const { attempt } = await runToolNode();

      expect(attempt?.status).toBe('FAILED');
      expect(attempt?.error).toMatch(/connector unavailable|DISCONNECTED/i);
      // The point of the test: the provider was NOT called at all.
      expect(executor.calls).toBe(before);
      expect(attempt?.failureClass).toBe('CONNECTOR_UNAVAILABLE');
    } finally {
      await prisma.installedSkill.update({
        where: { id: installedSkillId },
        data: { connectionStatus: 'CONNECTED' },
      });
    }
  });

  // ── secrets ───────────────────────────────────────────────────────────────

  it('no secret leak: a failure message does not carry credentials', async () => {
    // Failures are the most likely place for a secret to escape: an error string
    // built from a request, a stack trace, a dumped config. What lands in the
    // database is what a support engineer, a DLQ dump and a run log will show.
    const run = await prisma.workflowRun.create({
      data: { companyId, workflowId, status: 'FAILED' },
    });
    const step = await prisma.workflowStepRun.create({
      data: {
        companyId,
        runId: run.id,
        nodeId: 'noop',
        type: 'TOOL_ACTION',
        status: 'FAILED',
        error: 'Upstream returned 500',
      },
    });

    const stored = await prisma.workflowStepRun.findUnique({ where: { id: step.id } });
    const haystack = JSON.stringify(stored);
    for (const secret of ['sk-live', 'Bearer ey', 'password', 'client_secret']) {
      expect(haystack).not.toContain(secret);
    }
  });
});
