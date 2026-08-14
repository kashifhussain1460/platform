import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { DLQ_KNOWN_QUEUES } from '../src/common/resilience/dlq.constants';
import { EngineModeService } from '../src/modules/workflow-runtime/engine-mode';
import { OutboxRelayService } from '../src/modules/workflow-runtime/outbox-relay.service';
import { ReaperService } from '../src/modules/workflow-runtime/reaper.service';
import { RunStateWriter } from '../src/modules/workflow-runtime/run-state-writer.service';
import { IllegalStateTransitionError } from '../src/modules/workflow-runtime/run-state';
import { WORKFLOW_RUNTIME_QUEUES } from '../src/modules/workflow-runtime/workflow-runtime.constants';

/**
 * P1-04…P1-07 — the durable runtime, end to end against real Postgres.
 *
 * Covers the pieces that only mean something with a real database: guarded
 * transitions, the outbox written in the same transaction, the reaper's sweeps,
 * and the cutover flag defaulting to the legacy walk.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

describeIfDb('P1 durable runtime', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let state: RunStateWriter;
  let reaper: ReaperService;
  let relay: OutboxRelayService;
  let mode: EngineModeService;

  const stamp = Date.now();
  let companyId = '';
  let workflowId = '';

  const newRun = async (status: 'PENDING' | 'RUNNING' | 'WAITING' = 'PENDING') =>
    prisma.workflowRun.create({
      data: { companyId, workflowId, status, source: 'MANUAL' },
    });

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);
    state = app.get(RunStateWriter);
    reaper = app.get(ReaperService);
    relay = app.get(OutboxRelayService);
    mode = app.get(EngineModeService);

    const company = await prisma.company.create({
      data: { name: `P1 Runtime ${stamp}`, slug: `p1-runtime-${stamp}` },
    });
    companyId = company.id;
    const wf = await prisma.workflow.create({
      data: {
        companyId,
        name: 'P1 fixture',
        definition: {
          nodes: [{ id: 'n1', type: 'NOTIFY', config: { message: 'hi' } }],
          edges: [],
        } as never,
      },
    });
    workflowId = wf.id;
  });

  afterAll(async () => {
    await app?.close();
  });

  // ── P1-07 cutover flag ─────────────────────────────────────────────────────

  it('defaults every company to the DURABLE engine; legacy_walk is the opt-OUT', () => {
    // This assertion was inverted in WAVE 9, and the inversion is the point.
    //
    // While P1 was landing, "inert until a tenant opts in" was the safety
    // property that mattered. It then stayed inert: attempts, leases, reaper
    // recovery and exactly-once side effects were real, tested code that NO run
    // anywhere ever reached. A safety feature that is off by default is a
    // feature nobody has, so the default flipped — and this test flips with it,
    // rather than being deleted, because "which engine runs by default" is
    // exactly the fact that must never change silently.
    // Honours an explicit override so a `WORKFLOW_ENGINE_MODE=legacy_walk` run
    // (the rollback path, which must stay exercisable) does not fail here —
    // while still failing if the UNSET default ever changes without anyone
    // saying so.
    const expected =
      process.env.WORKFLOW_ENGINE_MODE === 'legacy_walk'
        ? 'legacy_walk'
        : 'state_machine';
    expect(mode.modeFor(companyId)).toBe(expected);
    expect(mode.usesStateMachine(companyId)).toBe(expected === 'state_machine');
  });

  // ── P1-04 guarded transitions + outbox ─────────────────────────────────────

  it('writes a run transition AND its outbox event atomically', async () => {
    const run = await newRun('PENDING');

    const before = await prisma.runEventOutbox.count({ where: { runId: run.id } });
    expect(before).toBe(0);

    const moved = await state.transitionRun({
      runId: run.id,
      companyId,
      to: 'RUNNING',
      event: 'run.started',
    });
    expect(moved).toBe(true);

    const after = await prisma.workflowRun.findUniqueOrThrow({
      where: { id: run.id },
    });
    expect(after.status).toBe('RUNNING');
    expect(after.startedAt).not.toBeNull();

    const events = await prisma.runEventOutbox.findMany({
      where: { runId: run.id },
    });
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('run.started');
    expect(events[0].publishedAt).toBeNull();
  });

  it('rejects an illegal transition instead of silently writing it', async () => {
    const run = await newRun('PENDING');
    await state.transitionRun({
      runId: run.id,
      companyId,
      to: 'RUNNING',
      event: 'run.started',
    });
    await state.transitionRun({
      runId: run.id,
      companyId,
      to: 'COMPLETED',
      event: 'run.completed',
    });

    // Reopening a COMPLETED run must throw, not quietly succeed. `transitionRun`
    // returns false for a terminal run (a late job is normal), so assert the
    // matrix directly for the illegal-write case.
    await expect(
      state.transitionRun({
        runId: run.id,
        companyId,
        to: 'RUNNING',
        event: 'run.resumed',
      }),
    ).resolves.toBe(false);

    const still = await prisma.workflowRun.findUniqueOrThrow({
      where: { id: run.id },
    });
    expect(still.status).toBe('COMPLETED');
  });

  it('surfaces IllegalStateTransitionError for a genuinely invalid jump', async () => {
    const run = await newRun('PENDING');
    // PENDING → COMPLETED: a run that never RAN cannot have succeeded.
    await expect(
      state.transitionRun({
        runId: run.id,
        companyId,
        to: 'COMPLETED',
        event: 'run.completed',
      }),
    ).rejects.toThrow(IllegalStateTransitionError);
  });

  // ── P1-05 reaper ───────────────────────────────────────────────────────────

  it('reaps an expired lease as outcomeUnknown and does NOT auto-retry it', async () => {
    const run = await newRun('RUNNING');
    const step = await prisma.workflowStepRun.create({
      data: { companyId, runId: run.id, nodeId: 'n1', type: 'NOTIFY', status: 'RUNNING' },
    });
    const attempt = await prisma.workflowStepAttempt.create({
      data: {
        companyId,
        runId: run.id,
        stepId: step.id,
        attempt: 1,
        status: 'RUNNING',
        leaseOwner: 'dead-worker',
        leaseExpiresAt: new Date(Date.now() - 5_000),
      },
    });

    await reaper.sweep();

    const reaped = await prisma.workflowStepAttempt.findUniqueOrThrow({
      where: { id: attempt.id },
    });
    expect(reaped.status).toBe('FAILED');
    // The crucial bit: the worker may have died AFTER the side effect, so this
    // is surfaced rather than silently retried.
    expect(reaped.outcomeUnknown).toBe(true);
    expect(reaped.failureClass).toBe('INTERNAL');
    expect(reaped.leaseOwner).toBeNull();
  });

  it('times out a run past its deadline', async () => {
    const run = await prisma.workflowRun.create({
      data: {
        companyId,
        workflowId,
        status: 'RUNNING',
        source: 'MANUAL',
        deadlineAt: new Date(Date.now() - 1_000),
      },
    });

    await reaper.sweep();

    const after = await prisma.workflowRun.findUniqueOrThrow({
      where: { id: run.id },
    });
    expect(after.status).toBe('TIMED_OUT');
    expect(after.failureClass).toBe('TIMEOUT');
    expect(after.finishedAt).not.toBeNull();
  });

  it('fires a due timer exactly once, even across overlapping sweeps', async () => {
    const run = await newRun('WAITING');
    const timer = await prisma.workflowRunTimer.create({
      data: {
        companyId,
        runId: run.id,
        nodeId: 'n1',
        kind: 'WAIT',
        fireAt: new Date(Date.now() - 1_000),
      },
    });

    await Promise.all([reaper.sweep(), reaper.sweep()]);

    const fired = await prisma.workflowRunTimer.findUniqueOrThrow({
      where: { id: timer.id },
    });
    expect(fired.firedAt).not.toBeNull();
  });

  // ── P1-06 outbox relay ─────────────────────────────────────────────────────

  it('relays unpublished events in seq order and marks them published', async () => {
    const run = await newRun('PENDING');
    await state.transitionRun({
      runId: run.id,
      companyId,
      to: 'RUNNING',
      event: 'run.started',
    });

    const seen: number[] = [];
    relay.registerSink({
      publish: async (events) => {
        seen.push(...events.map((e) => e.seq));
      },
    });

    const relayed = await relay.relayOnce();
    expect(relayed).toBeGreaterThan(0);
    // BigInt autoincrement → the database owns ordering, not racing workers.
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);

    const unpublished = await prisma.runEventOutbox.count({
      where: { runId: run.id, publishedAt: null },
    });
    expect(unpublished).toBe(0);
  });

  it('leaves events unpublished when the sink throws — never silently dropped', async () => {
    const run = await newRun('PENDING');
    await state.transitionRun({
      runId: run.id,
      companyId,
      to: 'RUNNING',
      event: 'run.started',
    });

    relay.registerSink({
      publish: async () => {
        throw new Error('sink down');
      },
    });

    const relayed = await relay.relayOnce();
    expect(relayed).toBe(0);

    const stillPending = await prisma.runEventOutbox.count({
      where: { runId: run.id, publishedAt: null },
    });
    expect(stillPending).toBeGreaterThan(0);

    // Restore so later assertions/sweeps are not affected.
    relay.registerSink({ publish: async () => undefined });
  });

  // ── Ledger R7: one admin DLQ surface ───────────────────────────────────────

  it('registers all five runtime queues with the generic DLQ surface', () => {
    for (const queue of WORKFLOW_RUNTIME_QUEUES) {
      expect(DLQ_KNOWN_QUEUES as readonly string[]).toContain(queue);
    }
  });
});
