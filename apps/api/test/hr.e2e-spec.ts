import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';

// HR staff-records e2e (Wave P3-01): needs a live Postgres + Redis. Skipped when
// DATABASE_URL is unset so it never blocks the build. Run with:
//   LLM_PROVIDER=mock EMBEDDINGS_PROVIDER=hash STORAGE_PROVIDER=local \
//   BILLING_PROVIDER=mock SKILL_EXECUTOR=mock ENCRYPTION_KEY=<64hex> \
//   DATABASE_URL=... REDIS_URL=... JWT_ACCESS_SECRET=... JWT_REFRESH_SECRET=...
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

const DAY_MS = 24 * 60 * 60 * 1000;

describeIfDb('HR e2e — staff records, PII-at-rest, retention (P3-01)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const ts = Date.now();
  const password = 'password123';
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  let ownerToken = '';
  let memberToken = '';
  // A second tenant to prove isolation + 0-retention survival.
  let otherToken = '';

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);

    const reg = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ companyName: 'HR E2E Co', name: 'HR Owner', email: `hr_owner_${ts}@example.com`, password })
      .expect(201);
    ownerToken = reg.body.tokens.accessToken;

    const other = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ companyName: 'Other Co', name: 'Other Owner', email: `hr_other_${ts}@example.com`, password })
      .expect(201);
    otherToken = other.body.tokens.accessToken;

    // A MEMBER of the first company (HR is OWNER/ADMIN only — even reads).
    const memberEmail = `hr_member_${ts}@example.com`;
    await request(app.getHttpServer())
      .post('/users')
      .set(bearer(ownerToken))
      .send({ email: memberEmail, name: 'HR Member', role: 'MEMBER', password })
      .expect(201);
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: memberEmail, password })
      .expect(201);
    memberToken = login.body.tokens.accessToken;
  });

  afterAll(async () => {
    await app?.close();
  });

  const createStaff = (token: string, overrides: Record<string, unknown> = {}) =>
    request(app.getHttpServer())
      .post('/hr/staff')
      .set(bearer(token))
      .send({ fullName: 'Jane Doe', workEmail: 'jane@acme.com', ...overrides });

  it('staff CRUD + personal PII is CIPHERTEXT at rest, PLAINTEXT via API', async () => {
    const created = await createStaff(ownerToken, {
      personalEmail: 'jane.personal@home.com',
      phone: '+15551234567',
      employeeCode: `E-${ts}`,
    }).expect(201);
    const id = created.body.id;
    // API returns decrypted plaintext.
    expect(created.body.personalEmail).toBe('jane.personal@home.com');
    expect(created.body.phone).toBe('+15551234567');

    // DB stores ciphertext for the PII fields; workEmail stays plaintext.
    const raw = await prisma.staffMember.findUniqueOrThrow({ where: { id } });
    expect(raw.personalEmail).toMatch(/^v1:/);
    expect(raw.phone).toMatch(/^v1:/);
    expect(raw.workEmail).toBe('jane@acme.com');

    // get + list return plaintext.
    const got = await request(app.getHttpServer())
      .get(`/hr/staff/${id}`)
      .set(bearer(ownerToken))
      .expect(200);
    expect(got.body.personalEmail).toBe('jane.personal@home.com');

    const patched = await request(app.getHttpServer())
      .patch(`/hr/staff/${id}`)
      .set(bearer(ownerToken))
      .send({ jobTitle: 'Engineer', personalEmail: null })
      .expect(200);
    expect(patched.body.jobTitle).toBe('Engineer');
    expect(patched.body.personalEmail).toBeNull();

    await request(app.getHttpServer())
      .delete(`/hr/staff/${id}`)
      .set(bearer(ownerToken))
      .expect(204);
    await request(app.getHttpServer())
      .get(`/hr/staff/${id}`)
      .set(bearer(ownerToken))
      .expect(404);
  });

  it('duplicate employeeCode within a company → 409', async () => {
    const code = `DUP-${ts}`;
    await createStaff(ownerToken, { employeeCode: code }).expect(201);
    await createStaff(ownerToken, { employeeCode: code }).expect(409);
  });

  it('leave request: special-category reason is encrypted at rest; decide flips status', async () => {
    const staff = await createStaff(ownerToken, { employeeCode: `L-${ts}` }).expect(201);
    const leave = await request(app.getHttpServer())
      .post('/hr/leave')
      .set(bearer(ownerToken))
      .send({
        staffId: staff.body.id,
        leaveType: 'SICK',
        startDate: '2026-09-01T00:00:00.000Z',
        endDate: '2026-09-03T00:00:00.000Z',
        days: 3,
        reason: 'Back surgery recovery',
      })
      .expect(201);
    expect(leave.body.reason).toBe('Back surgery recovery');
    expect(leave.body.status).toBe('PENDING');

    const raw = await prisma.leaveRequest.findUniqueOrThrow({ where: { id: leave.body.id } });
    expect(raw.reason).toMatch(/^v1:/);

    const decided = await request(app.getHttpServer())
      .post(`/hr/leave/${leave.body.id}/decide`)
      .set(bearer(ownerToken))
      .send({ status: 'APPROVED' })
      .expect(201);
    expect(decided.body.status).toBe('APPROVED');
    expect(decided.body.decidedAt).toBeTruthy();

    // A second decision on a non-PENDING request → 400.
    await request(app.getHttpServer())
      .post(`/hr/leave/${leave.body.id}/decide`)
      .set(bearer(ownerToken))
      .send({ status: 'REJECTED' })
      .expect(400);
  });

  it('leave validation: endDate before startDate → 400', async () => {
    const staff = await createStaff(ownerToken, { employeeCode: `LV-${ts}` }).expect(201);
    await request(app.getHttpServer())
      .post('/hr/leave')
      .set(bearer(ownerToken))
      .send({
        staffId: staff.body.id,
        leaveType: 'ANNUAL',
        startDate: '2026-09-10T00:00:00.000Z',
        endDate: '2026-09-01T00:00:00.000Z',
        days: 1,
      })
      .expect(400);
  });

  it('documents: fileName encrypted at rest; create / list / delete', async () => {
    const staff = await createStaff(ownerToken, { employeeCode: `D-${ts}` }).expect(201);
    const doc = await request(app.getHttpServer())
      .post('/hr/documents')
      .set(bearer(ownerToken))
      .send({
        staffId: staff.body.id,
        docType: 'ID',
        storageKey: `hr/${staff.body.id}/passport.pdf`,
        fileName: 'jane-passport.pdf',
        mimeType: 'application/pdf',
      })
      .expect(201);
    expect(doc.body.fileName).toBe('jane-passport.pdf');
    const raw = await prisma.staffDocument.findUniqueOrThrow({ where: { id: doc.body.id } });
    expect(raw.fileName).toMatch(/^v1:/);
    expect(raw.storageKey).toBe(`hr/${staff.body.id}/passport.pdf`); // storage key not encrypted

    const list = await request(app.getHttpServer())
      .get(`/hr/documents?staffId=${staff.body.id}`)
      .set(bearer(ownerToken))
      .expect(200);
    expect(list.body[0].fileName).toBe('jane-passport.pdf');

    await request(app.getHttpServer())
      .delete(`/hr/documents/${doc.body.id}`)
      .set(bearer(ownerToken))
      .expect(204);
  });

  it('performance review: aiDraft encrypted at rest; update patches it', async () => {
    const staff = await createStaff(ownerToken, { employeeCode: `PR-${ts}` }).expect(201);
    const review = await request(app.getHttpServer())
      .post('/hr/reviews')
      .set(bearer(ownerToken))
      .send({
        staffId: staff.body.id,
        periodStart: '2026-01-01T00:00:00.000Z',
        periodEnd: '2026-06-30T00:00:00.000Z',
        aiDraft: 'Strong performer, exceeds expectations.',
      })
      .expect(201);
    expect(review.body.aiDraft).toBe('Strong performer, exceeds expectations.');
    const raw = await prisma.performanceReview.findUniqueOrThrow({ where: { id: review.body.id } });
    expect(raw.aiDraft).toMatch(/^v1:/);

    const updated = await request(app.getHttpServer())
      .patch(`/hr/reviews/${review.body.id}`)
      .set(bearer(ownerToken))
      .send({ finalReview: 'Confirmed. Promote next cycle.', rating: 5, status: 'SHARED' })
      .expect(200);
    expect(updated.body.finalReview).toBe('Confirmed. Promote next cycle.');
    expect(updated.body.rating).toBe(5);
    expect(updated.body.status).toBe('SHARED');
  });

  it('attendance: record + duplicate (staffId,date) → 409; onboarding: create + complete', async () => {
    const staff = await createStaff(ownerToken, { employeeCode: `A-${ts}` }).expect(201);
    await request(app.getHttpServer())
      .post('/hr/attendance')
      .set(bearer(ownerToken))
      .send({ staffId: staff.body.id, date: '2026-08-01T00:00:00.000Z', status: 'PRESENT' })
      .expect(201);
    await request(app.getHttpServer())
      .post('/hr/attendance')
      .set(bearer(ownerToken))
      .send({ staffId: staff.body.id, date: '2026-08-01T00:00:00.000Z', status: 'LATE' })
      .expect(409);
    const att = await request(app.getHttpServer())
      .get(`/hr/attendance?staffId=${staff.body.id}`)
      .set(bearer(ownerToken))
      .expect(200);
    expect(att.body).toHaveLength(1);

    const task = await request(app.getHttpServer())
      .post('/hr/onboarding-tasks')
      .set(bearer(ownerToken))
      .send({ staffId: staff.body.id, title: 'Sign contract', ownerType: 'HUMAN' })
      .expect(201);
    expect(task.body.completedAt).toBeNull();
    const done = await request(app.getHttpServer())
      .post(`/hr/onboarding-tasks/${task.body.id}/complete`)
      .set(bearer(ownerToken))
      .expect(201);
    expect(done.body.completedAt).toBeTruthy();
  });

  it('retention honours dataRetentionDays (old purged, recent kept, 0-retention tenant survives)', async () => {
    // Company A opts into 30-day retention.
    await request(app.getHttpServer())
      .patch('/security-policy')
      .set(bearer(ownerToken))
      .send({ dataRetentionDays: 30 })
      .expect(200);

    const staffA = await createStaff(ownerToken, { employeeCode: `RET-${ts}` }).expect(201);
    const mkLeave = (token: string, staffId: string) =>
      request(app.getHttpServer())
        .post('/hr/leave')
        .set(bearer(token))
        .send({
          staffId,
          leaveType: 'ANNUAL',
          startDate: '2026-01-01T00:00:00.000Z',
          endDate: '2026-01-02T00:00:00.000Z',
          days: 1,
        })
        .expect(201);

    const oldLeave = await mkLeave(ownerToken, staffA.body.id);
    const newLeave = await mkLeave(ownerToken, staffA.body.id);
    // Backdate the "old" one 90 days (createdAt is not @updatedAt → writable).
    await prisma.leaveRequest.update({
      where: { id: oldLeave.body.id },
      data: { createdAt: new Date(Date.now() - 90 * DAY_MS) },
    });

    // Company B keeps default retention (0 = keep forever) with its own old record.
    const staffB = await createStaff(otherToken, { employeeCode: `RETB-${ts}` }).expect(201);
    const oldLeaveB = await mkLeave(otherToken, staffB.body.id);
    await prisma.leaveRequest.update({
      where: { id: oldLeaveB.body.id },
      data: { createdAt: new Date(Date.now() - 90 * DAY_MS) },
    });

    const result = await request(app.getHttpServer())
      .post('/hr/admin/retention/run-now')
      .set(bearer(ownerToken))
      .expect(200);
    expect(result.body.deleted.leaveRequests).toBeGreaterThanOrEqual(1);
    expect(result.body.companiesProcessed).toBeGreaterThanOrEqual(1);

    // A's old leave purged, recent kept.
    expect(await prisma.leaveRequest.findUnique({ where: { id: oldLeave.body.id } })).toBeNull();
    expect(await prisma.leaveRequest.findUnique({ where: { id: newLeave.body.id } })).not.toBeNull();
    // B (0-retention) old leave survives.
    expect(await prisma.leaveRequest.findUnique({ where: { id: oldLeaveB.body.id } })).not.toBeNull();
  });

  it('tenant isolation: another company gets 404 on our staff id', async () => {
    const mine = await createStaff(ownerToken, { employeeCode: `ISO-${ts}` }).expect(201);
    await request(app.getHttpServer())
      .get(`/hr/staff/${mine.body.id}`)
      .set(bearer(otherToken))
      .expect(404);
    await request(app.getHttpServer())
      .patch(`/hr/staff/${mine.body.id}`)
      .set(bearer(otherToken))
      .send({ jobTitle: 'Hacked' })
      .expect(404);
  });

  it('RBAC: HR is OWNER/ADMIN only — a MEMBER is 403 even on reads', async () => {
    await request(app.getHttpServer())
      .get('/hr/staff')
      .set(bearer(memberToken))
      .expect(403);
    await request(app.getHttpServer())
      .post('/hr/staff')
      .set(bearer(memberToken))
      .send({ fullName: 'Nope' })
      .expect(403);
  });

  it('rejects HR routes without a token (401)', async () => {
    await request(app.getHttpServer()).get('/hr/staff').expect(401);
    await request(app.getHttpServer()).post('/hr/leave').send({}).expect(401);
  });
});
