import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';

const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

/**
 * Role-based hiring plans (docs/product/2026-09-04-role-based-hiring-plans.md).
 *
 * Every rule below is enforced inside `EmployeesService.create()`'s advisory-
 * locked transaction, so it applies identically to the Hire form, the
 * onboarding wizard and the marketplace. These tests drive the Hire form path
 * and the onboarding pre-flight, and trust the shared choke point for the third.
 *
 *   Free/STARTER  2 roles x 1   Starter/PRO  2 roles x 1   Growth/BUSINESS  2 roles x 2
 */
describeIfDb('Role-based seats (hire limits per plan)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token = '';
  let companyId = '';
  const auth = () => ({ Authorization: `Bearer ${token}` });

  const hire = (role: string, name = `${role} bot`) =>
    request(app.getHttpServer()).post('/employees').set(auth()).send({ name, role });

  const setPlan = (plan: 'STARTER' | 'PRO' | 'BUSINESS' | 'ENTERPRISE') =>
    prisma.subscription.updateMany({ where: { companyId }, data: { plan } });

  const activeEmployees = async () => {
    const list = await request(app.getHttpServer()).get('/employees').set(auth()).expect(200);
    return (list.body as Array<{ id: string; status: string; budgetLimit: number | null }>).filter(
      (e) => e.status === 'ACTIVE',
    );
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

    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        companyName: 'Seats Co',
        name: 'Seats Owner',
        email: `seats_e2e_${Date.now()}@example.com`,
        password: 'password123',
      })
      .expect(201);
    token = res.body.tokens.accessToken;
    companyId = res.body.user.companyId;
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('Free (STARTER): 2 roles x 1', () => {
    let hrId = '';

    it('hires the first HR and stamps the plan ceiling (500 credits = $5)', async () => {
      const res = await hire('HR', 'Hana').expect(201);
      hrId = res.body.id;
      expect(res.body.budgetLimit).toBe(5);
    });

    it('refuses a second HR — one per role', async () => {
      const res = await hire('HR', 'Second HR').expect(403);
      expect(res.body.message).toMatch(/includes 1 Hr employee/i);
      expect(res.body.message).toMatch(/upgrade/i);
    });

    it('hires a second, different role', async () => {
      await hire('MARKETING', 'Mia').expect(201);
    });

    it('refuses a third hire once both seats are taken', async () => {
      const res = await hire('SALES', 'Sam').expect(403);
      expect(res.body.message).toMatch(/seats are taken/i);
    });

    it('a retired employee frees its seat AND its role slot', async () => {
      await request(app.getHttpServer())
        .patch(`/employees/${hrId}`)
        .set(auth())
        .send({ status: 'DISABLED' })
        .expect(200);
      await hire('SALES', 'Sam').expect(201);
    });

    it('exposes the same seat picture on /billing/usage and /product-context', async () => {
      const usage = await request(app.getHttpServer()).get('/billing/usage').set(auth()).expect(200);
      expect(usage.body.seats).toMatchObject({ used: 2, max: 2, rolesUsed: 2, maxRoles: 2, maxPerRole: 1 });
      expect(usage.body.seats.perRole).toEqual(
        expect.arrayContaining([
          { role: 'MARKETING', used: 1, max: 1 },
          { role: 'SALES', used: 1, max: 1 },
        ]),
      );
      const ctx = await request(app.getHttpServer()).get('/product-context').set(auth()).expect(200);
      expect(ctx.body.entitlements.seats).toEqual(usage.body.seats);
      expect(ctx.body.entitlements.creditsPerEmployeePerMonth).toBe(500);
    });
  });

  describe('R5: the plan ceiling caps what a customer may set', () => {
    it('allows lowering an employee ceiling below the plan default', async () => {
      const [emp] = await activeEmployees();
      await request(app.getHttpServer())
        .patch(`/employees/${emp.id}`)
        .set(auth())
        .send({ budgetLimit: 2 })
        .expect(200);
    });

    it('refuses raising it above the plan default, naming the ceiling', async () => {
      const [emp] = await activeEmployees();
      const res = await request(app.getHttpServer())
        .patch(`/employees/${emp.id}`)
        .set(auth())
        .send({ budgetLimit: 50 })
        .expect(400);
      expect(res.body.message).toMatch(/500 credits/);
    });

    it('refuses "unlimited" (null) on a plan that has a ceiling', async () => {
      const [emp] = await activeEmployees();
      await request(app.getHttpServer())
        .patch(`/employees/${emp.id}`)
        .set(auth())
        .send({ budgetLimit: null })
        .expect(400);
    });
  });

  describe('Growth (BUSINESS): 2 roles x 2', () => {
    beforeAll(() => setPlan('BUSINESS'));

    it('now allows a second Marketing (per-role went 1 -> 2)', async () => {
      await hire('MARKETING', 'Mia 2').expect(201);
    });

    it('still refuses a third distinct role, even with a seat free', async () => {
      // Roster: MARKETING x2, SALES x1 -> 3 of 4 seats, 2 of 2 roles.
      const res = await hire('SUPPORT', 'Sue').expect(403);
      expect(res.body.message).toMatch(/includes 2 roles/i);
    });

    it('fills the last seat with an existing role, then refuses', async () => {
      await hire('SALES', 'Sam 2').expect(201);
      const res = await hire('SALES', 'Sam 3').expect(403);
      expect(res.body.message).toMatch(/seats are taken/i);
    });
  });

  describe('Downgrade policy: grandfather + cap ceilings', () => {
    it('downgrading Growth -> Starter keeps every employee, caps ceilings, blocks new hires', async () => {
      expect((await activeEmployees()).length).toBe(4);

      // Mock provider switches immediately.
      await request(app.getHttpServer())
        .post('/billing/subscription')
        .set(auth())
        .send({ plan: 'PRO' })
        .expect(201);

      const after = await activeEmployees();
      expect(after.length).toBe(4); // nobody paused, nobody deleted
      for (const e of after) expect(e.budgetLimit).toBeLessThanOrEqual(5);

      const res = await hire('SALES', 'Over limit').expect(403);
      expect(res.body.message).toMatch(/seats are taken/i);

      const usage = await request(app.getHttpServer()).get('/billing/usage').set(auth()).expect(200);
      expect(usage.body.overEmployeeLimit).toBe(true);
    });
  });

  describe('Onboarding pre-flight: one 422 for the whole selection', () => {
    it('rejects a selection that exceeds the plan without hiring anyone', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/register')
        .send({
          companyName: 'Wizard Co',
          name: 'Wiz Owner',
          email: `seats_wizard_${Date.now()}@example.com`,
          password: 'password123',
        })
        .expect(201);
      const wizToken = res.body.tokens.accessToken as string;
      const wizCompany = res.body.user.companyId as string;

      const complete = await request(app.getHttpServer())
        .post('/onboarding/complete')
        .set({ Authorization: `Bearer ${wizToken}` })
        .send({
          business: { industry: 'Software', size: '1-10' },
          departments: ['HR', 'Marketing', 'Sales'],
          employees: [{ role: 'HR' }, { role: 'MARKETING' }, { role: 'SALES' }],
        })
        .expect(422);
      expect(complete.body.message).toMatch(/cannot hire this selection/i);
      expect(complete.body.problems).toHaveLength(1); // only SALES is over

      const hired = await prisma.aiEmployee.count({ where: { companyId: wizCompany } });
      expect(hired).toBe(0); // nothing partially hired
    });
  });
});
