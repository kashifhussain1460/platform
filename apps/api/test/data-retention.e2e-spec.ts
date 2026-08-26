import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { STORAGE_PROVIDER_TOKEN } from '../src/modules/knowledge/storage/storage.provider';
import { DataRetentionService } from '../src/modules/retention/data-retention.service';

/**
 * WAVE 8 §8.3 — operational data retention, against real Postgres.
 *
 * The claims worth proving are the ones that are dangerous when wrong:
 *
 * - a legal hold stops the sweep dead;
 * - an IN-FLIGHT run is never deleted, however old (deleting a WAITING run
 *   destroys a live approval);
 * - deleting a row also deletes its FILE, or the data was not really deleted;
 * - the deletion is itself recorded, so "what happened to March?" has an answer;
 * - a preview deletes nothing.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

const DAY = 24 * 60 * 60 * 1000;

describeIfDb('WAVE 8 §8.3 — data retention', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let retention: DataRetentionService;

  /** Object keys the fake storage was asked to delete. */
  const deletedKeys: string[] = [];
  /** Archive objects written before runs were removed. */
  const writtenKeys: string[] = [];

  const stamp = Date.now();
  let companyId = '';
  let workflowId = '';
  let employeeId = '';

  /** Old enough to be swept by a 30-day policy. */
  const ancient = new Date(stamp - 400 * DAY);

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      // A fake storage provider rather than the real one: this suite is about
      // whether the sweep ASKS for the blob to be deleted, and recording the
      // calls is a far stronger assertion than checking a file vanished from a
      // temp directory.
      .overrideProvider(STORAGE_PROVIDER_TOKEN)
      .useValue({
        put: async (key: string) => {
          writtenKeys.push(key);
        },
        get: async () => Buffer.from(''),
        delete: async (key: string) => {
          deletedKeys.push(key);
        },
      })
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);
    retention = app.get(DataRetentionService);

    const company = await prisma.company.create({
      data: { name: `Retention Co ${stamp}`, slug: `retention-${stamp}` },
    });
    companyId = company.id;

    // 30-day window. Without a policy the sweep skips the tenant entirely.
    await prisma.securityPolicy.create({
      data: { companyId, dataRetentionDays: 30 },
    });

    const workflow = await prisma.workflow.create({
      data: {
        companyId,
        name: 'Retention WF',
        definition: { nodes: [{ id: 't', type: 'TRIGGER', config: {} }], edges: [] },
      },
    });
    workflowId = workflow.id;

    const employee = await prisma.aiEmployee.create({
      data: { companyId, name: 'Retention Employee', role: 'HR' },
    });
    employeeId = employee.id;
  });

  afterAll(async () => {
    await prisma?.company.delete({ where: { id: companyId } }).catch(() => undefined);
    await app?.close();
  });

  /** A terminal run, old enough to expire, with a step and an outbox row. */
  async function makeOldRun(status: 'COMPLETED' | 'WAITING') {
    const run = await prisma.workflowRun.create({
      data: { companyId, workflowId, status, createdAt: ancient },
    });
    await prisma.workflowStepRun.create({
      data: {
        companyId,
        runId: run.id,
        nodeId: 'n1',
        type: 'NOOP',
        status: 'COMPLETED',
        createdAt: ancient,
      },
    });
    await prisma.runEventOutbox.create({
      data: { companyId, runId: run.id, eventType: 'run.completed', payload: {} },
    });
    return run;
  }

  it('deletes an expired terminal run, its steps and its outbox rows', async () => {
    const old = await makeOldRun('COMPLETED');

    const result = await retention.runForCompany(companyId, 'test-actor');

    expect(result.deleted.workflowRuns).toBeGreaterThanOrEqual(1);
    expect(result.deleted.workflowStepRuns).toBeGreaterThanOrEqual(1);
    expect(result.deleted.outboxEvents).toBeGreaterThanOrEqual(1);
    expect(await prisma.workflowRun.findUnique({ where: { id: old.id } })).toBeNull();
    // Cascade, not orphan: a step row pointing at a deleted run is worse than
    // either keeping both or deleting both.
    expect(
      await prisma.workflowStepRun.count({ where: { runId: old.id } }),
    ).toBe(0);
  });

  it('ARCHIVES a run before deleting it', async () => {
    writtenKeys.length = 0;
    await makeOldRun('COMPLETED');
    await retention.runForCompany(companyId, 'test-actor');

    // Retention should bound what is ONLINE, not erase what happened.
    expect(writtenKeys.some((k) => k.startsWith(`run-archive/${companyId}/`))).toBe(
      true,
    );
  });

  it('NEVER deletes an in-flight run, however old', async () => {
    // The dangerous case: a WAITING run is parked on a human approval. Deleting
    // it would silently destroy live work and strand whoever was waiting.
    const waiting = await makeOldRun('WAITING');

    await retention.runForCompany(companyId, 'test-actor');

    expect(
      await prisma.workflowRun.findUnique({ where: { id: waiting.id } }),
    ).not.toBeNull();
  });

  it('deletes an expired document AND the file behind it', async () => {
    deletedKeys.length = 0;
    const doc = await prisma.knowledgeDocument.create({
      data: {
        companyId,
        filename: 'old-handbook.pdf',
        storageKey: `knowledge/${companyId}/old-handbook.pdf`,
        mimeType: 'application/pdf',
        sizeBytes: 10,
        status: 'READY',
        createdAt: ancient,
      },
    });

    const result = await retention.runForCompany(companyId, 'test-actor');

    expect(result.deleted.knowledgeDocuments).toBeGreaterThanOrEqual(1);
    expect(
      await prisma.knowledgeDocument.findUnique({ where: { id: doc.id } }),
    ).toBeNull();
    // The point of the whole exercise: a row deleted while its bytes stay in the
    // bucket has not been deleted in any sense that matters to an auditor.
    expect(deletedKeys).toContain(`knowledge/${companyId}/old-handbook.pdf`);
  });

  it('sweeps memory, conversations, skill executions and provider snapshots', async () => {
    await prisma.employeeMemory.create({
      data: {
        companyId,
        employeeId,
        kind: 'FACT',
        content: 'stale fact',
        createdAt: ancient,
      },
    });
    await prisma.conversation.create({
      data: { companyId, employeeId, title: 'old chat', createdAt: ancient },
    });
    await prisma.rawEvent.create({
      data: {
        companyId,
        connectorId: `conn-${stamp}`,
        provider: 'github',
        payload: {},
        signatureVerified: true,
        receivedAt: ancient,
      },
    });

    const result = await retention.runForCompany(companyId, 'test-actor');

    expect(result.deleted.employeeMemories).toBeGreaterThanOrEqual(1);
    expect(result.deleted.conversations).toBeGreaterThanOrEqual(1);
    // Raw provider payloads are the rawest personal data held — a whole inbound
    // email, headers included. They must not outlive the window.
    expect(result.deleted.rawEvents).toBeGreaterThanOrEqual(1);
  });

  // ── S-09: Support conversations/messages ────────────────────────────────

  it('sweeps a RESOLVED support conversation and its messages, but leaves OPEN ones and the ChatwootAccount alone', async () => {
    const account = await prisma.chatwootAccount.create({
      data: {
        companyId,
        chatwootAccountId: `s09-${stamp}`,
        agentBotId: '1',
        agentBotToken: 'encrypted-placeholder',
        webhookSecret: 'encrypted-placeholder',
      },
    });
    const resolvedConvo = await prisma.supportConversation.create({
      data: {
        companyId,
        chatwootAccountId: account.id,
        chatwootConversationId: `resolved-${stamp}`,
        contactEmail: 'customer@example.com',
        status: 'RESOLVED',
        lastMessageAt: ancient,
      },
    });
    await prisma.supportMessage.create({
      data: {
        companyId,
        conversationId: resolvedConvo.id,
        direction: 'IN',
        content: 'I need a refund',
      },
    });
    const openConvo = await prisma.supportConversation.create({
      data: {
        companyId,
        chatwootAccountId: account.id,
        chatwootConversationId: `open-${stamp}`,
        status: 'OPEN',
        lastMessageAt: ancient, // equally old, but NOT resolved — must survive
      },
    });

    const result = await retention.runForCompany(companyId, 'test-actor');

    expect(result.deleted.supportConversations).toBeGreaterThanOrEqual(1);
    expect(result.deleted.supportMessages).toBeGreaterThanOrEqual(1);
    expect(
      await prisma.supportConversation.findUnique({ where: { id: resolvedConvo.id } }),
    ).toBeNull();
    expect(
      await prisma.supportMessage.count({ where: { conversationId: resolvedConvo.id } }),
    ).toBe(0);
    // Live work, not terminal — must NOT be deleted, however old.
    expect(
      await prisma.supportConversation.findUnique({ where: { id: openConvo.id } }),
    ).not.toBeNull();
    // The connector/integration row itself is never pruned by this sweep.
    expect(
      await prisma.chatwootAccount.findUnique({ where: { id: account.id } }),
    ).not.toBeNull();

    await prisma.supportConversation.delete({ where: { id: openConvo.id } }).catch(() => undefined);
    await prisma.chatwootAccount.delete({ where: { id: account.id } }).catch(() => undefined);
  });

  it('records the deletion in the audit trail', async () => {
    await makeOldRun('COMPLETED');
    await retention.runForCompany(companyId, 'test-actor');

    const entry = await prisma.auditLog.findFirst({
      where: { companyId, action: 'data.retention.deleted' },
      orderBy: { createdAt: 'desc' },
    });
    expect(entry).not.toBeNull();
    // §8.3 "audit evidence": what was removed, and how far back.
    expect(entry?.metadata).toMatchObject({ workflowRuns: expect.any(Number) });
  });

  // ── legal hold ────────────────────────────────────────────────────────────

  it('a legal hold stops the sweep entirely', async () => {
    const held = await makeOldRun('COMPLETED');
    const hold = await prisma.legalHold.create({
      data: { companyId, reason: 'Pending litigation', scope: 'ALL' },
    });

    const result = await retention.runForCompany(companyId, 'test-actor');

    expect(result.companiesHeld).toBe(1);
    expect(result.deleted.workflowRuns).toBe(0);
    expect(await prisma.workflowRun.findUnique({ where: { id: held.id } })).not.toBeNull();

    // ...and once released, the same data ages out normally.
    await prisma.legalHold.update({
      where: { id: hold.id },
      data: { releasedAt: new Date() },
    });
    const after = await retention.runForCompany(companyId, 'test-actor');
    expect(after.deleted.workflowRuns).toBeGreaterThanOrEqual(1);
    expect(await prisma.workflowRun.findUnique({ where: { id: held.id } })).toBeNull();
  });

  it('an AUDIT-scoped hold does not freeze operational data', async () => {
    // Scope means something: a hold on the evidence trail is not a hold on
    // everything, or the narrower scope would be a lie.
    const run = await makeOldRun('COMPLETED');
    const hold = await prisma.legalHold.create({
      data: { companyId, reason: 'Audit only', scope: 'AUDIT' },
    });

    const result = await retention.runForCompany(companyId, 'test-actor');
    expect(result.companiesHeld).toBe(0);
    expect(await prisma.workflowRun.findUnique({ where: { id: run.id } })).toBeNull();

    await prisma.legalHold.update({
      where: { id: hold.id },
      data: { releasedAt: new Date() },
    });
  });

  // ── preview ───────────────────────────────────────────────────────────────

  it('preview reports what WOULD go, and deletes nothing', async () => {
    const survivor = await makeOldRun('COMPLETED');

    const preview = await retention.preview(companyId);

    expect(preview.dryRun).toBe(true);
    expect(preview.deleted.workflowRuns).toBeGreaterThanOrEqual(1);
    // The whole value of a preview is that it is safe to run.
    expect(
      await prisma.workflowRun.findUnique({ where: { id: survivor.id } }),
    ).not.toBeNull();
  });

  it('a company with no retention policy is never swept', async () => {
    // 0 / unset means "keep for ever". Shipping this must not start deleting
    // data for tenants who never asked for a retention window.
    //
    // Driven through `runForCompany` and NOT the cross-tenant `sweep()`:
    // `sweep()` deliberately walks every tenant that has a policy, so calling it
    // from a test would delete other tenants' real data out of the shared
    // development database. Same code path, same branch (days <= 0 → no-op),
    // without a test that reaches outside its own fixture.
    const other = await prisma.company.create({
      data: { name: `No Policy ${stamp}`, slug: `nopolicy-${stamp}` },
    });
    const wf = await prisma.workflow.create({
      data: {
        companyId: other.id,
        name: 'Untouched',
        definition: { nodes: [], edges: [] },
      },
    });
    const run = await prisma.workflowRun.create({
      data: {
        companyId: other.id,
        workflowId: wf.id,
        status: 'COMPLETED',
        createdAt: ancient,
      },
    });

    const result = await retention.runForCompany(other.id, 'test-actor');

    expect(result.companiesScanned).toBe(0);
    expect(await prisma.workflowRun.findUnique({ where: { id: run.id } })).not.toBeNull();
    await prisma.company.delete({ where: { id: other.id } }).catch(() => undefined);
  });
});
