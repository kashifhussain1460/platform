import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';

/**
 * Phase 2 — Organization and Department Foundation, end to end.
 *
 * The fixture is the exact tree the phase brief describes:
 *
 *   Company
 *   ├── Marketing   (scopes: MARKETING)
 *   │   ├── Marketing admin (user)
 *   │   └── Marketing AI Employee
 *   └── HR          (scopes: HR)
 *       ├── HR admin (user)
 *       └── HR AI Employee
 *
 * Everything here was previously unreachable through the product, not missing
 * from the backend: the wizard sent `departments: []`, `Department.scopes` had
 * no input, `User.departmentId` had no input, and delete was a bare
 * `prisma.department.delete()` whose `SetNull` cascade silently promoted every
 * member to company-wide access.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

describeIfDb('Phase 2 — organization + department foundation', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const ts = Date.now();
  const password = 'password123';

  const http = () => request(app.getHttpServer());
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

  /** Register a fresh company and return its owner token + companyId. */
  const registerCompany = async (label: string) => {
    const email = `p2_${label}_${ts}@example.com`;
    const res = await http()
      .post('/auth/register')
      .send({
        companyName: `Phase2 ${label} ${ts}`,
        name: `${label} owner`,
        email,
        password,
      })
      .expect(201);
    // BUSINESS: the fixture needs more than STARTER's 2 AI-employee seats.
    await prisma.subscription.updateMany({
      where: { companyId: res.body.user.companyId },
      data: { plan: 'BUSINESS' },
    });
    return {
      token: res.body.tokens.accessToken as string,
      companyId: res.body.user.companyId as string,
    };
  };

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.company.deleteMany({
        where: { name: { startsWith: `Phase2 ` } },
      });
    }
    await app?.close();
  });

  // ── §2 Onboarding creates real departments ──────────────────────────────
  describe('§2 onboarding creates real departments', () => {
    let token = '';
    let companyId = '';

    beforeAll(async () => {
      ({ token, companyId } = await registerCompany('onboard'));
    });

    it('starts with no departments', async () => {
      const res = await http().get('/onboarding/status').set(bearer(token)).expect(200);
      expect(res.body.departments).toEqual([]);
    });

    it('persists departments at its own step, so a refresh keeps them', async () => {
      await http()
        .patch('/onboarding/departments')
        .set(bearer(token))
        .send({ departments: ['Marketing', 'HR', 'Customer Success'] })
        .expect(200);

      // Read them back from the DEPARTMENT TABLE, not from a wizard draft.
      const rows = await prisma.department.findMany({
        where: { companyId },
        select: { name: true, scopes: true },
        orderBy: { name: 'asc' },
      });
      expect(rows.map((r) => r.name).sort()).toEqual([
        'Customer Success',
        'HR',
        'Marketing',
      ]);
    });

    it('creates them UNRESTRICTED — a new department denies nobody', async () => {
      const rows = await prisma.department.findMany({ where: { companyId } });
      expect(rows.every((r) => r.scopes.length === 0)).toBe(true);
    });

    it('reports the real rows in onboarding status', async () => {
      const res = await http().get('/onboarding/status').set(bearer(token)).expect(200);
      expect(res.body.departments.sort()).toEqual([
        'Customer Success',
        'HR',
        'Marketing',
      ]);
      expect(res.body.step).toBe('DEPARTMENTS');
    });

    it('never creates an empty placeholder department', async () => {
      await http()
        .patch('/onboarding/departments')
        .set(bearer(token))
        .send({ departments: ['', '   ', 'Finance'] })
        .expect(200);
      const rows = await prisma.department.findMany({ where: { companyId } });
      expect(rows.every((r) => r.name.trim().length > 0)).toBe(true);
      expect(rows.map((r) => r.name)).toContain('Finance');
    });

    it('is idempotent — resubmitting the same list creates nothing new', async () => {
      const before = await prisma.department.count({ where: { companyId } });
      await http()
        .patch('/onboarding/departments')
        .set(bearer(token))
        .send({ departments: ['Marketing', 'marketing', 'HR'] })
        .expect(200);
      expect(await prisma.department.count({ where: { companyId } })).toBe(before);
    });

    it('completing onboarding keeps them and does not duplicate', async () => {
      const before = await prisma.department.count({ where: { companyId } });
      await http()
        .post('/onboarding/complete')
        .set(bearer(token))
        .send({
          business: { industry: 'Technology', size: '11-50' },
          departments: ['Marketing', 'HR', 'Customer Success', 'Finance'],
          employees: [{ role: 'HR' }],
        })
        .expect(201);
      expect(await prisma.department.count({ where: { companyId } })).toBe(before);
    });

    it('leaves an EXISTING company with no departments perfectly usable', async () => {
      // Back-compat: every tenant onboarded before this phase has zero rows,
      // and zero departments must keep meaning "nobody is restricted".
      const legacy = await registerCompany('legacy');
      await http()
        .post('/onboarding/complete')
        .set(bearer(legacy.token))
        .send({
          business: { industry: 'Technology', size: '1-10' },
          departments: [],
          employees: [{ role: 'HR' }],
        })
        .expect(201);
      expect(await prisma.department.count({ where: { companyId: legacy.companyId } })).toBe(0);
      await http().get('/employees').set(bearer(legacy.token)).expect(200);
    });
  });

  // ── §3-§6 The Marketing / HR matrix ─────────────────────────────────────
  describe('§6 department-scoped authorization', () => {
    let ownerToken = '';
    let companyId = '';
    let hrDeptId = '';
    let mktDeptId = '';
    let hrAdminToken = '';
    let mktAdminToken = '';
    let plainAdminToken = '';
    let hrEmployeeId = '';
    let mktEmployeeId = '';

    /** Create an ADMIN and place them in a department THROUGH THE API. */
    const makeAdminIn = async (label: string, departmentId: string | null) => {
      const email = `p2_${label}_${ts}@example.com`;
      const created = await http()
        .post('/users')
        .set(bearer(ownerToken))
        .send({ name: `${label} admin`, email, password, role: 'ADMIN' })
        .expect(201);
      if (departmentId) {
        // The placement path that had no UI and therefore never ran in
        // production. Exercised over HTTP on purpose.
        const patched = await http()
          .patch(`/users/${created.body.id}`)
          .set(bearer(ownerToken))
          .send({ departmentId })
          .expect(200);
        expect(patched.body.departmentId).toBe(departmentId);
      }
      const login = await http()
        .post('/auth/login')
        .send({ email, password })
        .expect(201);
      return login.body.tokens.accessToken as string;
    };

    beforeAll(async () => {
      ({ token: ownerToken, companyId } = await registerCompany('matrix'));

      const hr = await http()
        .post('/departments')
        .set(bearer(ownerToken))
        .send({ name: 'HR', scopes: ['HR'] })
        .expect(201);
      hrDeptId = hr.body.id;
      const mkt = await http()
        .post('/departments')
        .set(bearer(ownerToken))
        .send({ name: 'Marketing', scopes: ['MARKETING'] })
        .expect(201);
      mktDeptId = mkt.body.id;

      const hrEmp = await http()
        .post('/employees')
        .set(bearer(ownerToken))
        .send({ name: 'HR Bot', role: 'HR' })
        .expect(201);
      hrEmployeeId = hrEmp.body.id;
      const mktEmp = await http()
        .post('/employees')
        .set(bearer(ownerToken))
        .send({ name: 'Marketing Bot', role: 'MARKETING' })
        .expect(201);
      mktEmployeeId = mktEmp.body.id;

      hrAdminToken = await makeAdminIn('hradmin', hrDeptId);
      mktAdminToken = await makeAdminIn('mktadmin', mktDeptId);
      plainAdminToken = await makeAdminIn('plainadmin', null);
    });

    it('the API sets scopes, so isolation is reachable without touching the DB', async () => {
      const res = await http().get('/departments').set(bearer(ownerToken)).expect(200);
      const hr = (res.body as { id: string; scopes: string[] }[]).find(
        (d) => d.id === hrDeptId,
      );
      expect(hr?.scopes).toEqual(['HR']);
    });

    it('HR admin sees the HR employee and NOT the Marketing one', async () => {
      const res = await http().get('/employees').set(bearer(hrAdminToken)).expect(200);
      const ids = (res.body as { id: string }[]).map((e) => e.id);
      expect(ids).toContain(hrEmployeeId);
      expect(ids).not.toContain(mktEmployeeId);
    });

    it('Marketing admin sees the Marketing employee and NOT the HR one', async () => {
      const res = await http().get('/employees').set(bearer(mktAdminToken)).expect(200);
      const ids = (res.body as { id: string }[]).map((e) => e.id);
      expect(ids).toContain(mktEmployeeId);
      expect(ids).not.toContain(hrEmployeeId);
    });

    it('reading the other department’s employee directly is 403, not just hidden', async () => {
      // Filtering a list is presentation. This is the part that has to hold.
      await http().get(`/employees/${mktEmployeeId}`).set(bearer(hrAdminToken)).expect(403);
      await http().get(`/employees/${hrEmployeeId}`).set(bearer(mktAdminToken)).expect(403);
    });

    it('each admin can still read their OWN department’s employee', async () => {
      await http().get(`/employees/${hrEmployeeId}`).set(bearer(hrAdminToken)).expect(200);
      await http().get(`/employees/${mktEmployeeId}`).set(bearer(mktAdminToken)).expect(200);
    });

    it('the OWNER is never department-scoped', async () => {
      const res = await http().get('/employees').set(bearer(ownerToken)).expect(200);
      const ids = (res.body as { id: string }[]).map((e) => e.id);
      expect(ids).toEqual(expect.arrayContaining([hrEmployeeId, mktEmployeeId]));
    });

    it('an admin in NO department is unrestricted (the pre-existing default)', async () => {
      const res = await http().get('/employees').set(bearer(plainAdminToken)).expect(200);
      const ids = (res.body as { id: string }[]).map((e) => e.id);
      expect(ids).toEqual(expect.arrayContaining([hrEmployeeId, mktEmployeeId]));
    });

    it('clearing a department’s scopes restores company-wide access', async () => {
      await http()
        .patch(`/departments/${hrDeptId}`)
        .set(bearer(ownerToken))
        .send({ scopes: [] })
        .expect(200);
      const res = await http().get('/employees').set(bearer(hrAdminToken)).expect(200);
      const ids = (res.body as { id: string }[]).map((e) => e.id);
      expect(ids).toContain(mktEmployeeId);

      // Put it back for the deletion tests below.
      await http()
        .patch(`/departments/${hrDeptId}`)
        .set(bearer(ownerToken))
        .send({ scopes: ['HR'] })
        .expect(200);
    });

    it('removing a user from a department restores company-wide access', async () => {
      const users = await http().get('/users').set(bearer(ownerToken)).expect(200);
      const hrAdmin = (users.body as { id: string; email: string }[]).find((u) =>
        u.email.startsWith(`p2_hradmin_`),
      );
      await http()
        .patch(`/users/${hrAdmin?.id}`)
        .set(bearer(ownerToken))
        .send({ departmentId: null })
        .expect(200);

      const res = await http().get('/employees').set(bearer(hrAdminToken)).expect(200);
      expect((res.body as { id: string }[]).map((e) => e.id)).toContain(mktEmployeeId);

      await http()
        .patch(`/users/${hrAdmin?.id}`)
        .set(bearer(ownerToken))
        .send({ departmentId: hrDeptId })
        .expect(200);
    });

    // ── §4 cross-tenant ───────────────────────────────────────────────────
    it('cannot place a user in ANOTHER tenant’s department', async () => {
      const other = await registerCompany('othertenant');
      const foreign = await http()
        .post('/departments')
        .set(bearer(other.token))
        .send({ name: 'Foreign', scopes: ['HR'] })
        .expect(201);

      const users = await http().get('/users').set(bearer(ownerToken)).expect(200);
      const someone = (users.body as { id: string }[])[0];
      await http()
        .patch(`/users/${someone.id}`)
        .set(bearer(ownerToken))
        .send({ departmentId: foreign.body.id })
        .expect(404);
    });

    it('cannot read, rename or delete another tenant’s department', async () => {
      const other = await registerCompany('othertenant2');
      const foreign = await http()
        .post('/departments')
        .set(bearer(other.token))
        .send({ name: 'Foreign2' })
        .expect(201);

      await http()
        .get(`/departments/${foreign.body.id}/dependencies`)
        .set(bearer(ownerToken))
        .expect(404);
      await http()
        .patch(`/departments/${foreign.body.id}`)
        .set(bearer(ownerToken))
        .send({ name: 'Hijacked' })
        .expect(404);
      await http()
        .delete(`/departments/${foreign.body.id}`)
        .set(bearer(ownerToken))
        .expect(404);

      // And the list never leaks it.
      const list = await http().get('/departments').set(bearer(ownerToken)).expect(200);
      expect((list.body as { id: string }[]).map((d) => d.id)).not.toContain(
        foreign.body.id,
      );
    });

    it('cannot reassign into another tenant’s department during a delete', async () => {
      const other = await registerCompany('othertenant3');
      const foreign = await http()
        .post('/departments')
        .set(bearer(other.token))
        .send({ name: 'Foreign3' })
        .expect(201);
      const throwaway = await http()
        .post('/departments')
        .set(bearer(ownerToken))
        .send({ name: `Throwaway ${ts}` })
        .expect(201);

      await http()
        .delete(`/departments/${throwaway.body.id}?reassignTo=${foreign.body.id}`)
        .set(bearer(ownerToken))
        .expect(404);
      // Still ours, still there.
      expect(
        await prisma.department.count({ where: { id: throwaway.body.id, companyId } }),
      ).toBe(1);
    });

    // ── §5 safe deletion ──────────────────────────────────────────────────
    describe('§5 safe deletion', () => {
      it('reports who would be affected before anything is destroyed', async () => {
        const res = await http()
          .get(`/departments/${hrDeptId}/dependencies`)
          .set(bearer(ownerToken))
          .expect(200);
        expect(res.body.members.length).toBe(1);
        expect(res.body.scopes).toEqual(['HR']);
        expect(res.body.wouldWidenAccess).toBe(true);
      });

      it('REFUSES to delete a department that still has members', async () => {
        const res = await http()
          .delete(`/departments/${hrDeptId}`)
          .set(bearer(ownerToken))
          .expect(409);
        expect(res.body.message).toContain('member');
        // Nothing changed.
        expect(await prisma.department.count({ where: { id: hrDeptId } })).toBe(1);
      });

      it('deletes an EMPTY department freely — there is nobody to widen', async () => {
        const empty = await http()
          .post('/departments')
          .set(bearer(ownerToken))
          .send({ name: `Empty ${ts}` })
          .expect(201);
        await http()
          .delete(`/departments/${empty.body.id}`)
          .set(bearer(ownerToken))
          .expect(204);
        expect(await prisma.department.count({ where: { id: empty.body.id } })).toBe(0);
      });

      it('reassignTo moves the members instead of un-scoping them', async () => {
        const doomed = await http()
          .post('/departments')
          .set(bearer(ownerToken))
          .send({ name: `Doomed ${ts}`, scopes: ['SALES'] })
          .expect(201);
        const token = await makeAdminIn('doomedadmin', doomed.body.id);
        expect(token).toBeTruthy();

        await http()
          .delete(`/departments/${doomed.body.id}?reassignTo=${mktDeptId}`)
          .set(bearer(ownerToken))
          .expect(204);

        expect(await prisma.department.count({ where: { id: doomed.body.id } })).toBe(0);
        // The member landed in Marketing — still scoped, not company-wide.
        const moved = await prisma.user.findFirst({
          where: { companyId, email: `p2_doomedadmin_${ts}@example.com` },
          select: { departmentId: true },
        });
        expect(moved?.departmentId).toBe(mktDeptId);

        // And the authorization consequence really moved with them.
        const res = await http().get('/employees').set(bearer(token)).expect(200);
        const ids = (res.body as { id: string }[]).map((e) => e.id);
        expect(ids).toContain(mktEmployeeId);
        expect(ids).not.toContain(hrEmployeeId);
      });

      it('rejects reassigning a department to itself', async () => {
        await http()
          .delete(`/departments/${hrDeptId}?reassignTo=${hrDeptId}`)
          .set(bearer(ownerToken))
          .expect(400);
      });

      it('force=true widens access, and SAYS SO in the audit trail', async () => {
        const forced = await http()
          .post('/departments')
          .set(bearer(ownerToken))
          .send({ name: `Forced ${ts}`, scopes: ['SALES'] })
          .expect(201);
        const token = await makeAdminIn('forcedadmin', forced.body.id);

        await http()
          .delete(`/departments/${forced.body.id}?force=true`)
          .set(bearer(ownerToken))
          .expect(204);

        const audit = await prisma.auditLog.findFirst({
          where: { companyId, action: 'department.deleted', entityId: forced.body.id },
        });
        expect(audit).not.toBeNull();
        expect((audit?.metadata as Record<string, unknown>)?.accessWidened).toBe(true);

        // The widening is real — that is precisely why it had to be explicit.
        const res = await http().get('/employees').set(bearer(token)).expect(200);
        const ids = (res.body as { id: string }[]).map((e) => e.id);
        expect(ids).toEqual(expect.arrayContaining([hrEmployeeId, mktEmployeeId]));
      });

      it('unassigns teams rather than deleting them', async () => {
        const dept = await http()
          .post('/departments')
          .set(bearer(ownerToken))
          .send({ name: `WithTeam ${ts}` })
          .expect(201);
        const team = await http()
          .post('/teams')
          .set(bearer(ownerToken))
          .send({ name: `Team ${ts}`, departmentId: dept.body.id })
          .expect(201);

        await http()
          .delete(`/departments/${dept.body.id}`)
          .set(bearer(ownerToken))
          .expect(204);

        const survived = await prisma.team.findUnique({ where: { id: team.body.id } });
        expect(survived).not.toBeNull();
        expect(survived?.departmentId).toBeNull();
      });

      it('a MEMBER cannot delete a department', async () => {
        const email = `p2_member_${ts}@example.com`;
        await http()
          .post('/users')
          .set(bearer(ownerToken))
          .send({ name: 'P2 Member', email, password, role: 'MEMBER' })
          .expect(201);
        const login = await http()
          .post('/auth/login')
          .send({ email, password })
          .expect(201);
        await http()
          .delete(`/departments/${mktDeptId}`)
          .set(bearer(login.body.tokens.accessToken))
          .expect(403);
      });
    });

    // ── §3 management surface ─────────────────────────────────────────────
    it('the list carries member and team counts for the management screen', async () => {
      const res = await http().get('/departments').set(bearer(ownerToken)).expect(200);
      const mkt = (
        res.body as { id: string; memberCount: number; teamCount: number }[]
      ).find((d) => d.id === mktDeptId);
      expect(typeof mkt?.memberCount).toBe('number');
      expect(mkt?.memberCount).toBeGreaterThanOrEqual(1);
    });
  });
});
