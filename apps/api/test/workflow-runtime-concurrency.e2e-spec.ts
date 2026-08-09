import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import {
  AttemptLeaseService,
  attemptIdempotencyKey,
} from '../src/modules/workflow-runtime/attempt-lease.service';
import {
  LOCK_NOT_ACQUIRED,
  RunLockService,
} from '../src/modules/workflow-runtime/run-lock.service';

/**
 * P1-04 — concurrency primitives, against REAL Postgres.
 *
 * These cannot be meaningfully unit-tested: a mocked advisory lock or a mocked
 * `UPDATE … WHERE` proves nothing about what two workers racing actually do.
 * Doc 24 §7 prohibits mocking Postgres for exactly this reason.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

describeIfDb('P1-04 runtime concurrency primitives', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let locks: RunLockService;
  let leases: AttemptLeaseService;

  const stamp = Date.now();
  let companyId = '';
  let runId = '';
  let stepId = '';

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);
    locks = app.get(RunLockService);
    leases = app.get(AttemptLeaseService);

    const company = await prisma.company.create({
      data: { name: `Runtime Co ${stamp}`, slug: `runtime-${stamp}` },
    });
    companyId = company.id;

    const workflow = await prisma.workflow.create({
      data: {
        companyId,
        name: 'Runtime fixture',
        definition: { nodes: [], edges: [] } as never,
      },
    });
    const run = await prisma.workflowRun.create({
      data: { companyId, workflowId: workflow.id, status: 'RUNNING', source: 'MANUAL' },
    });
    runId = run.id;

    const step = await prisma.workflowStepRun.create({
      data: {
        companyId,
        runId,
        nodeId: 'n1',
        type: 'TOOL_ACTION',
        status: 'PENDING',
      },
    });
    stepId = step.id;
  });

  afterAll(async () => {
    await app?.close();
  });

  // ── Per-run serialisation (doc 16 §6.2) ────────────────────────────────────

  it('never lets two advances run concurrently on the same run', async () => {
    let inside = 0;
    let maxInside = 0;
    let advanced = 0;

    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        locks.withRunLock(runId, async () => {
          inside += 1;
          maxInside = Math.max(maxInside, inside);
          advanced += 1;
          // Hold the lock so any genuinely-simultaneous entrant is observed.
          await new Promise((r) => setTimeout(r, 30));
          inside -= 1;
          return 'ADVANCED' as const;
        }),
      ),
    );

    // THE invariant: mutual exclusion. Never two bodies inside at once.
    //
    // NOT "exactly one of the 50 succeeds" — that would be wrong. Prisma's
    // connection pool is far smaller than 50, so the calls run in batches and a
    // later one legitimately acquires the lock AFTER an earlier one commits.
    // Sequential entry is correct behaviour; concurrent entry is the bug.
    expect(maxInside).toBe(1);

    const busy = results.filter((r) => r === LOCK_NOT_ACQUIRED).length;
    expect(advanced + busy).toBe(50);
    // Contention must actually have happened, or the test proves nothing.
    expect(busy).toBeGreaterThan(0);
  });

  it('releases the lock on commit, so a later advance can acquire it', async () => {
    const again = await locks.withRunLock(runId, async () => 'ADVANCED');
    expect(again).toBe('ADVANCED');
  });

  it('releases the lock on ROLLBACK too (a throwing advance must not wedge the run)', async () => {
    await expect(
      locks.withRunLock(runId, async () => {
        throw new Error('node blew up');
      }),
    ).rejects.toThrow('node blew up');

    // If the advisory lock were not transaction-scoped, this would hang or fail
    // forever — the exact way a single bad node wedges a run permanently.
    const after = await locks.withRunLock(runId, async () => 'ADVANCED');
    expect(after).toBe('ADVANCED');
  });

  it('locks are per-run — a different run is never blocked', async () => {
    const otherRun = await prisma.workflowRun.create({
      data: {
        companyId,
        workflowId: (await prisma.workflowRun.findUniqueOrThrow({
          where: { id: runId },
          select: { workflowId: true },
        })).workflowId,
        status: 'RUNNING',
        source: 'MANUAL',
      },
    });

    const [a, b] = await Promise.all([
      locks.withRunLock(runId, async () => {
        await new Promise((r) => setTimeout(r, 80));
        return 'A' as const;
      }),
      locks.withRunLock(otherRun.id, async () => {
        await new Promise((r) => setTimeout(r, 80));
        return 'B' as const;
      }),
    ]);

    expect([a, b]).toEqual(['A', 'B']);
  });

  // ── Attempt leases (doc 16 §6.3) ───────────────────────────────────────────

  const makeAttempt = async (attempt: number) =>
    prisma.workflowStepAttempt.create({
      data: { companyId, runId, stepId, attempt, status: 'PENDING' },
    });

  it('only ONE of 20 concurrent claims wins the lease', async () => {
    const row = await makeAttempt(1);

    const claims = await Promise.all(
      Array.from({ length: 20 }, () => leases.claim(row.id)),
    );

    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.filter((c) => c === null)).toHaveLength(19);

    const stored = await prisma.workflowStepAttempt.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(stored.status).toBe('RUNNING');
    expect(stored.leaseOwner).toBe(leases.workerId);
    expect(stored.leaseExpiresAt).not.toBeNull();
  });

  it('an EXPIRED lease can be reclaimed — this is how a dead worker recovers', async () => {
    const row = await makeAttempt(2);
    expect(await leases.claim(row.id)).not.toBeNull();

    // Simulate the owning worker dying: its lease ages out with no heartbeat.
    await prisma.workflowStepAttempt.update({
      where: { id: row.id },
      data: { leaseExpiresAt: new Date(Date.now() - 1000) },
    });

    expect(await leases.claim(row.id)).not.toBeNull();
  });

  it('a live lease cannot be stolen', async () => {
    const row = await makeAttempt(3);
    expect(await leases.claim(row.id)).not.toBeNull();
    // Same worker id here, but the WHERE clause is what matters: a live,
    // unexpired lease matches nothing.
    expect(await leases.claim(row.id)).toBeNull();
  });

  it('renew extends an owned lease and release frees it', async () => {
    const row = await makeAttempt(4);
    await leases.claim(row.id);

    expect(await leases.renew(row.id)).toBe(true);

    await leases.release(row.id);
    const freed = await prisma.workflowStepAttempt.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(freed.leaseOwner).toBeNull();
    // Freed means immediately claimable again, without waiting out the TTL.
    expect(await leases.claim(row.id)).not.toBeNull();
  });

  it('renew fails once another owner holds the lease', async () => {
    const row = await makeAttempt(5);
    await leases.claim(row.id);

    await prisma.workflowStepAttempt.update({
      where: { id: row.id },
      data: { leaseOwner: 'some-other-worker' },
    });

    // Must be false, not a throw: the caller has to STOP working, and it needs
    // a value it can branch on.
    expect(await leases.renew(row.id)).toBe(false);
  });

  // ── Idempotency (doc 16 §6.4) ──────────────────────────────────────────────

  it('the idempotency key is stable per attempt and CHANGES on retry', () => {
    const a1 = attemptIdempotencyKey('run-1', 'node-1', 1);
    const a1again = attemptIdempotencyKey('run-1', 'node-1', 1);
    const a2 = attemptIdempotencyKey('run-1', 'node-1', 2);

    expect(a1).toBe(a1again);
    // Per ATTEMPT, not per node: a retry must be allowed to re-issue the call,
    // because the first attempt may have died before reaching the provider.
    // Keying per node would turn every retry into a silent provider no-op.
    expect(a2).not.toBe(a1);

    expect(attemptIdempotencyKey('run-2', 'node-1', 1)).not.toBe(a1);
    expect(attemptIdempotencyKey('run-1', 'node-2', 1)).not.toBe(a1);
  });
});
