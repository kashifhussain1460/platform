import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';

/**
 * Phase 3 — `GET /product-context`, end to end.
 *
 * The A–H relevance matrix is covered exhaustively against the PURE resolver in
 * `capability-resolver.spec.ts`. This suite proves the half that a pure
 * function cannot: that the real rows load correctly, that the real
 * `AuthorizationService` is genuinely in the path (not merely imported), and
 * that one tenant's configuration can never leak into another's answer.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

describeIfDb('Phase 3 — product context / capability resolution', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const ts = Date.now();
  const password = 'password123';
  const http = () => request(app.getHttpServer());
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

  const registerCompany = async (label: string, plan = 'BUSINESS') => {
    const res = await http()
      .post('/auth/register')
      .send({
        companyName: `Phase3 ${label} ${ts}`,
        name: `${label} owner`,
        email: `p3_${label}_${ts}@example.com`,
        password,
      })
      .expect(201);
    await prisma.subscription.updateMany({
      where: { companyId: res.body.user.companyId },
      data: { plan: plan as never },
    });
    return {
      token: res.body.tokens.accessToken as string,
      companyId: res.body.user.companyId as string,
    };
  };

  const context = (token: string) =>
    http().get('/product-context').set(bearer(token)).expect(200);

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
      await prisma.company.deleteMany({ where: { name: { startsWith: 'Phase3 ' } } });
    }
    await app?.close();
  });

  describe('requires authentication', () => {
    it('rejects an anonymous request', async () => {
      await http().get('/product-context').expect(401);
    });
  });

  describe('an HR-focused company', () => {
    let token = '';
    let companyId = '';

    beforeAll(async () => {
      ({ token, companyId } = await registerCompany('hrco'));
      await http()
        .patch('/onboarding/company')
        .set(bearer(token))
        .send({
          name: `Phase3 hrco ${ts}`,
          industry: 'Professional Services',
          size: '11-50',
        })
        .expect(200);
      await http()
        .patch('/onboarding/ai-employees')
        .set(bearer(token))
        .send({ roles: ['HR'] })
        .expect(200);
      await http()
        .patch('/onboarding/goals')
        .set(bearer(token))
        .send({ goals: ['Recruitment', 'Interview Scheduling'] })
        .expect(200);
      await http()
        .patch('/onboarding/departments')
        .set(bearer(token))
        .send({ departments: ['HR', 'Recruitment'] })
        .expect(200);
      await http()
        .post('/employees')
        .set(bearer(token))
        .send({ name: 'HR Bot', role: 'HR' })
        .expect(201);
    });

    it('echoes the real persisted configuration', async () => {
      const res = await context(token);
      expect(res.body.companyId).toBe(companyId);
      expect(res.body.configuration).toMatchObject({
        industry: 'Professional Services',
        size: '11-50',
        isMinimallyConfigured: false,
      });
      expect(res.body.configuration.businessGoals).toEqual(
        expect.arrayContaining(['Recruitment', 'Interview Scheduling']),
      );
      expect(res.body.configuration.departments).toEqual(
        expect.arrayContaining(['HR', 'Recruitment']),
      );
      expect(res.body.configuration.hiredEmployeeRoles).toEqual(['HR']);
    });

    it('unlocks interview scheduling because an HR employee is hired', async () => {
      const res = await context(token);
      expect(res.body.productAreas).toContain('INTERVIEW_SCHEDULING');
      expect(res.body.areaReasons.INTERVIEW_SCHEDULING).toBe('HIRED_EMPLOYEE');
    });

    it('recommends skills, each with a stated reason', async () => {
      const res = await context(token);
      expect(res.body.recommendedSkills.length).toBeGreaterThan(0);
      for (const rec of res.body.recommendedSkills) {
        expect(rec.because).toBeTruthy();
        // Never suggest an integration that cannot perform a real action.
        expect(rec.executionSupport).not.toBe('SIMULATED');
      }
    });

    it('returns navigation entries matching the resolved areas exactly', async () => {
      const res = await context(token);
      expect(res.body.navigation.map((n: { area: string }) => n.area)).toEqual(
        res.body.productAreas,
      );
    });

    it('is deterministic across repeated calls', async () => {
      const a = await context(token);
      const b = await context(token);
      expect(JSON.stringify(b.body)).toBe(JSON.stringify(a.body));
    });

    it('reflects an installed skill by dropping it from recommendations', async () => {
      const before = await context(token);
      const suggested = before.body.recommendedSkills[0];
      expect(suggested).toBeTruthy();

      await http()
        .post('/skills/install')
        .set(bearer(token))
        .send({ skillKey: suggested.skillKey, displayName: suggested.name })
        .expect(201);

      const after = await context(token);
      expect(after.body.relevantSkills).toContain(suggested.skillKey);
      expect(
        after.body.recommendedSkills.some(
          (r: { skillKey: string }) => r.skillKey === suggested.skillKey,
        ),
      ).toBe(false);
    });
  });

  describe('a marketing-focused company gets a DIFFERENT answer', () => {
    it('does not unlock interview scheduling', async () => {
      const { token } = await registerCompany('mktco');
      await http()
        .post('/employees')
        .set(bearer(token))
        .send({ name: 'Marketing Bot', role: 'MARKETING' })
        .expect(201);

      const res = await context(token);
      expect(res.body.productAreas).not.toContain('INTERVIEW_SCHEDULING');
      expect(res.body.dashboardCapabilities).toContain('EMPLOYEE_MARKETING');
    });
  });

  describe('a minimally configured company', () => {
    it('keeps the WHOLE product — existing tenants are not locked out', async () => {
      // This is the shape of every tenant that onboarded before Phase 2.
      const { token } = await registerCompany('bareco');
      const res = await context(token);
      expect(res.body.configuration.isMinimallyConfigured).toBe(true);
      expect(res.body.productAreas).toEqual(
        expect.arrayContaining([
          'DASHBOARD',
          'EMPLOYEES',
          'SKILLS',
          'WORKFLOWS',
          'INTERVIEW_SCHEDULING',
        ]),
      );
      expect(res.body.areaReasons.INTERVIEW_SCHEDULING).toBe('NO_CONFIGURATION');
    });
  });

  describe('plan entitlement', () => {
    it('STARTER does not get AI Assist, and is told what would unlock it', async () => {
      const { token } = await registerCompany('starterco', 'STARTER');
      await http()
        .post('/employees')
        .set(bearer(token))
        .send({ name: 'HR Bot', role: 'HR' })
        .expect(201);

      const res = await context(token);
      expect(res.body.productAreas).not.toContain('ASSIST');
      expect(res.body.entitlements.lockedAreas).toEqual([
        { area: 'ASSIST', requiresPlan: 'BUSINESS' },
      ]);
    });

    it('agrees with the server-side @RequirePlan guard', async () => {
      // The resolver must not disagree with the thing that actually enforces —
      // that mismatch is the bug it exists to prevent.
      const { token } = await registerCompany('starterco2', 'STARTER');
      const res = await context(token);
      expect(res.body.productAreas).not.toContain('ASSIST');
      await http().get('/assist/sessions').set(bearer(token)).expect(403);
    });

    it('BUSINESS gets it, and the guard agrees', async () => {
      const { token } = await registerCompany('bizco', 'BUSINESS');
      await http()
        .post('/employees')
        .set(bearer(token))
        .send({ name: 'HR Bot', role: 'HR' })
        .expect(201);

      const res = await context(token);
      expect(res.body.productAreas).toContain('ASSIST');
      await http().get('/assist/sessions').set(bearer(token)).expect(200);
    });
  });

  describe('authorization is genuinely in the path', () => {
    let ownerToken = '';
    let companyId = '';
    let memberToken = '';
    let hrAdminToken = '';
    let hrEmployeeId = '';
    let mktEmployeeId = '';

    beforeAll(async () => {
      ({ token: ownerToken, companyId } = await registerCompany('authzco'));

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

      const makeUser = async (label: string, role: string, departmentId?: string) => {
        const email = `p3_${label}_${ts}@example.com`;
        const created = await http()
          .post('/users')
          .set(bearer(ownerToken))
          .send({ name: label, email, password, role })
          .expect(201);
        if (departmentId) {
          await http()
            .patch(`/users/${created.body.id}`)
            .set(bearer(ownerToken))
            .send({ departmentId })
            .expect(200);
        }
        const login = await http()
          .post('/auth/login')
          .send({ email, password })
          .expect(201);
        return login.body.tokens.accessToken as string;
      };

      memberToken = await makeUser('member', 'MEMBER');

      const dept = await http()
        .post('/departments')
        .set(bearer(ownerToken))
        .send({ name: 'HR', scopes: ['HR'] })
        .expect(201);
      hrAdminToken = await makeUser('hradmin', 'ADMIN', dept.body.id);
    });

    it('an OWNER is offered the admin areas', async () => {
      const res = await context(ownerToken);
      expect(res.body.productAreas).toEqual(
        expect.arrayContaining(['ORGANIZATION', 'ADMIN_HEALTH']),
      );
      expect(res.body.relevantEmployeeIds).toEqual(
        expect.arrayContaining([hrEmployeeId, mktEmployeeId]),
      );
    });

    it('a MEMBER is not', async () => {
      const res = await context(memberToken);
      expect(res.body.productAreas).not.toContain('ORGANIZATION');
      expect(res.body.productAreas).not.toContain('ADMIN_HEALTH');
      // SKILLS is deliberately still offered. This assertion used to require
      // the opposite, pinning a Phase 3 defect: the area was mapped to the
      // ADMIN-floored `skill:connect`, which hid a page members are allowed to
      // read (`GET /skills/catalog` carries no permission decorator at all).
      // Managing a connection is still ADMIN-only, enforced on the mutation.
      expect(res.body.productAreas).toContain('SKILLS');
    });

    it('a department-scoped admin only gets their own employees', async () => {
      // The real `AuthorizationService.filter` running inside the resolver —
      // not a reimplementation of it.
      const res = await context(hrAdminToken);
      expect(res.body.relevantEmployeeIds).toContain(hrEmployeeId);
      expect(res.body.relevantEmployeeIds).not.toContain(mktEmployeeId);
    });

    it('agrees with GET /employees for the same user', async () => {
      const roster = await http().get('/employees').set(bearer(hrAdminToken)).expect(200);
      const res = await context(hrAdminToken);
      expect([...res.body.relevantEmployeeIds].sort()).toEqual(
        (roster.body as { id: string }[]).map((e) => e.id).sort(),
      );
    });

    it('never returns another tenant’s configuration', async () => {
      const other = await registerCompany('leakco');
      await http()
        .patch('/onboarding/departments')
        .set(bearer(other.token))
        .send({ departments: ['Leaky Department'] })
        .expect(200);

      const mine = await context(ownerToken);
      expect(mine.body.companyId).toBe(companyId);
      expect(mine.body.configuration.departments).not.toContain('Leaky Department');

      const theirs = await context(other.token);
      expect(theirs.body.companyId).toBe(other.companyId);
      expect(theirs.body.relevantEmployeeIds).not.toContain(hrEmployeeId);
    });
  });

  describe('workflow templates', () => {
    it('reports readiness and names what is missing', async () => {
      const { token } = await registerCompany('tplco');
      const res = await context(token);
      expect(Array.isArray(res.body.availableWorkflowTemplates)).toBe(true);
      // The seeded first-party catalog requires hired roles this company has
      // none of, so it must say so rather than silently offering an install
      // that 422s.
      const notReady = res.body.availableWorkflowTemplates.filter(
        (t: { ready: boolean }) => !t.ready,
      );
      if (notReady.length > 0) {
        expect(
          notReady[0].missingSkills.length + notReady[0].missingEmployeeRoles.length,
        ).toBeGreaterThan(0);
      }
    });
  });
});
