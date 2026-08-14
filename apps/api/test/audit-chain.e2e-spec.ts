import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AuditLogService } from '../src/modules/audit/audit-log.service';
import { AuditRetentionService } from '../src/modules/audit/audit-retention.service';

/**
 * WAVE 4 — tamper evidence, retention and legal hold against real Postgres.
 *
 * The chain's arithmetic is covered by `audit-chain.spec.ts`. What can only be
 * proven here is that the SERVICE actually chains what it writes, that
 * concurrent writers do not fork the chain, and that retention refuses to delete
 * under a hold.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

describeIfDb('WAVE 4 — audit chain, retention, legal hold', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let audit: AuditLogService;
  let retention: AuditRetentionService;

  const ts = Date.now();
  const password = 'password123';
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  const http = () => request(app.getHttpServer());

  let token = '';
  let companyId = '';

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();

    prisma = app.get(PrismaService);
    audit = app.get(AuditLogService);
    retention = app.get(AuditRetentionService);

    const reg = await http()
      .post('/auth/register')
      .send({
        companyName: `Audit Co ${ts}`,
        name: 'Audit Owner',
        email: `audit_owner_${ts}@example.com`,
        password,
      })
      .expect(201);
    token = reg.body.tokens.accessToken;
    companyId = reg.body.user.companyId;
  });

  afterAll(async () => {
    await app?.close();
  });

  // ── §4.4 the chain ─────────────────────────────────────────────────────────

  it('chains every entry it writes, and verifies clean', async () => {
    for (let i = 0; i < 5; i++) {
      await audit.record({
        companyId,
        action: 'test.action',
        entityType: 'Test',
        entityId: `e${i}`,
        metadata: { i },
      });
    }

    const rows = await prisma.auditLog.findMany({
      where: { companyId },
      orderBy: { seq: 'asc' },
    });
    expect(rows.length).toBeGreaterThanOrEqual(5);
    // Gap-free sequence, and every entry links to its predecessor.
    rows.forEach((row, i) => {
      expect(row.seq).toBe(BigInt(i + 1));
      expect(row.eventHash).toBeTruthy();
      expect(row.previousHash).toBe(i === 0 ? null : rows[i - 1].eventHash);
    });

    const res = await http()
      .get('/audit-log/verify')
      .set(bearer(token))
      .expect(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.breaks).toEqual([]);
  });

  it('detects an entry edited directly in the database', async () => {
    // The whole point: someone with database access CAN change a row. The chain
    // does not prevent it — it makes it impossible to hide.
    const victim = await prisma.auditLog.findFirstOrThrow({
      where: { companyId },
      orderBy: { seq: 'asc' },
    });
    await prisma.auditLog.update({
      where: { id: victim.id },
      data: { action: 'test.action.tampered' },
    });

    const res = await http()
      .get('/audit-log/verify')
      .set(bearer(token))
      .expect(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.breaks[0].kind).toBe('CONTENT_MISMATCH');

    // Put it back so later assertions in this file start from a clean chain.
    await prisma.auditLog.update({
      where: { id: victim.id },
      data: { action: victim.action },
    });
    const after = await http()
      .get('/audit-log/verify')
      .set(bearer(token))
      .expect(200);
    expect(after.body.valid).toBe(true);
  });

  it('does not fork the chain under concurrent writes', async () => {
    // Without the per-company advisory lock, concurrent writers read the same
    // predecessor and both chain off it — a fork that is indistinguishable from
    // tampering.
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        audit.record({
          companyId,
          action: 'test.concurrent',
          entityType: 'Test',
          entityId: `c${i}`,
        }),
      ),
    );

    const res = await http()
      .get('/audit-log/verify')
      .set(bearer(token))
      .expect(200);
    expect(res.body.valid).toBe(true);

    const seqs = (
      await prisma.auditLog.findMany({
        where: { companyId },
        orderBy: { seq: 'asc' },
        select: { seq: true },
      })
    ).map((r) => Number(r.seq));
    // Gap-free and unique.
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs[seqs.length - 1] - seqs[0]).toBe(seqs.length - 1);
  });

  // ── §4.2 sensitive values ──────────────────────────────────────────────────

  it('redacts secret-looking metadata VALUES on write', async () => {
    // The audit log is the most widely read table in the system — exported,
    // shipped to a SIEM, handed to an auditor. A credential here has the widest
    // possible blast radius.
    await audit.record({
      companyId,
      action: 'test.secrets',
      entityType: 'Test',
      metadata: {
        password: 'hunter2',
        apiKey: 'sk-live-123',
        nested: { refreshToken: 'rt-abc', keep: 'visible' },
        safe: 'plain value',
      },
    });

    const row = await prisma.auditLog.findFirstOrThrow({
      where: { companyId, action: 'test.secrets' },
    });
    const meta = row.metadata as Record<string, unknown>;
    expect(meta.password).toBe('[redacted]');
    expect(meta.apiKey).toBe('[redacted]');
    expect((meta.nested as Record<string, unknown>).refreshToken).toBe(
      '[redacted]',
    );
    // Only the sensitive keys — redaction must not gut the useful context.
    expect((meta.nested as Record<string, unknown>).keep).toBe('visible');
    expect(meta.safe).toBe('plain value');
  });

  // ── §4.1 query + export ────────────────────────────────────────────────────

  it('queries by action and by time range', async () => {
    const res = await http()
      .get('/audit-log?action=test.secrets')
      .set(bearer(token))
      .expect(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].action).toBe('test.secrets');

    const future = new Date(Date.now() + 60_000).toISOString();
    const empty = await http()
      .get(`/audit-log?from=${encodeURIComponent(future)}`)
      .set(bearer(token))
      .expect(200);
    expect(empty.body).toEqual([]);
  });

  it('exports NDJSON WITH the hashes, so the recipient can verify it', async () => {
    const res = await http()
      .get('/audit-log/export')
      .set(bearer(token))
      .expect(200);

    const lines = (res.text as string).trim().split('\n');
    expect(lines.length).toBeGreaterThan(0);
    const first = JSON.parse(lines[0]);
    // An export without hashes cannot be verified by whoever receives it,
    // which defeats the point of keeping a chain.
    expect(first).toHaveProperty('eventHash');
    expect(first).toHaveProperty('previousHash');
    expect(first).toHaveProperty('seq');
    // Oldest first, so it can be walked as a chain.
    expect(Number(first.seq)).toBe(1);
  });

  // ── §4.5 retention + legal hold ────────────────────────────────────────────

  it('keeps audit longer than the company data-retention setting', async () => {
    // A company setting 30-day data retention is talking about operational
    // data, not about erasing who changed its permissions. Letting the
    // operational knob shorten audit is exactly the move audit exists to expose.
    await http()
      .patch('/security-policy')
      .set(bearer(token))
      .send({ dataRetentionDays: 30 })
      .expect(200);

    await prisma.auditLog.updateMany({
      where: { companyId, action: 'test.action' },
      data: { createdAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000) },
    });

    const before = await prisma.auditLog.count({ where: { companyId } });
    await retention.sweep();
    expect(await prisma.auditLog.count({ where: { companyId } })).toBe(before);
  });

  it('NEVER deletes under a legal hold', async () => {
    // Age everything past even the audit floor.
    await prisma.auditLog.updateMany({
      where: { companyId },
      data: { createdAt: new Date(Date.now() - 800 * 24 * 60 * 60 * 1000) },
    });

    const hold = await http()
      .post('/audit-log/legal-holds')
      .set(bearer(token))
      .send({ reason: 'Pending litigation — do not delete' })
      .expect(201);
    expect(hold.body.releasedAt).toBeNull();

    const held = await prisma.auditLog.count({ where: { companyId } });
    const swept = await retention.sweep();
    expect(swept.companiesHeld).toBeGreaterThanOrEqual(1);
    expect(await prisma.auditLog.count({ where: { companyId } })).toBe(held);

    // Releasing is itself audited, and the hold row is KEPT — that data was
    // held, by whom and for how long, is evidence in its own right.
    await http()
      .post(`/audit-log/legal-holds/${hold.body.id}/release`)
      .set(bearer(token))
      .expect(201);
    const rows = await prisma.legalHold.findMany({ where: { companyId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].releasedAt).not.toBeNull();

    const released = await prisma.auditLog.findFirst({
      where: { companyId, action: 'audit.legal_hold.released' },
    });
    expect(released).not.toBeNull();
  });

  it('deletes past the audit floor once the hold is released', async () => {
    const swept = await retention.sweep();
    expect(swept.deleted).toBeGreaterThan(0);

    // The deletion itself is audited (§4.3 "Retention deletion") and survives,
    // because it is written after the sweep.
    const record = await prisma.auditLog.findFirst({
      where: { companyId, action: 'audit.retention.deleted' },
    });
    expect(record).not.toBeNull();
  });
});
