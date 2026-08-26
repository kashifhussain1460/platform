import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';

/**
 * Phase 4 — configuration-driven product experience, end to end.
 *
 * Phase 3 proved the resolver produces the right ANSWER. This proves the
 * product is actually built out of that answer: navigation, dashboard widgets,
 * skill categorisation and the single template system.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

describeIfDb('Phase 4 — configuration-driven experience', () => {
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
        companyName: `Phase4 ${label} ${ts}`,
        name: `${label} owner`,
        email: `p4_${label}_${ts}@example.com`,
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
  const dashboard = (token: string) =>
    http().get('/product-context/dashboard').set(bearer(token)).expect(200);

  /**
   * SIX shared tenants, created once.
   *
   * The first draft registered one company per test and hit a 429 — the auth
   * throttle is 10 signups/minute per IP. That limiter is a real control
   * protecting a real endpoint, and `AUTH_THROTTLE_LIMIT` exists to raise it
   * per-environment, but turning a security control down to accommodate a test
   * that did not need the tenants in the first place is the wrong trade. Six
   * fixtures cover every case and the suite runs faster for it.
   */
  const fixtures: Record<string, { token: string; companyId: string }> = {};
  const hire = (token: string, name: string, role: string) =>
    http().post('/employees').set(bearer(token)).send({ name, role }).expect(201);

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);

    fixtures.hr = await registerCompany('hr');
    await hire(fixtures.hr.token, 'HR Bot', 'HR');

    fixtures.marketing = await registerCompany('mkt');
    await hire(fixtures.marketing.token, 'Marketing Bot', 'MARKETING');

    fixtures.support = await registerCompany('sup');
    await hire(fixtures.support.token, 'Support Bot', 'SUPPORT');

    fixtures.multi = await registerCompany('multi');
    await hire(fixtures.multi.token, 'HR Bot', 'HR');
    await hire(fixtures.multi.token, 'Marketing Bot', 'MARKETING');
    await hire(fixtures.multi.token, 'Support Bot', 'SUPPORT');

    // Deliberately unconfigured — the pre-Phase-2 tenant shape.
    fixtures.bare = await registerCompany('bare');

    // A second tenant with nothing in it, for the isolation check.
    fixtures.other = await registerCompany('other');

    const email = `p4_member_${ts}@example.com`;
    await http()
      .post('/users')
      .set(bearer(fixtures.hr.token))
      .send({ name: 'P4 Member', email, password, role: 'MEMBER' })
      .expect(201);
    const login = await http()
      .post('/auth/login')
      .send({ email, password })
      .expect(201);
    fixtures.member = {
      token: login.body.tokens.accessToken,
      companyId: fixtures.hr.companyId,
    };
  }, 60_000);

  afterAll(async () => {
    if (prisma) {
      await prisma.company.deleteMany({ where: { name: { startsWith: 'Phase4 ' } } });
    }
    await app?.close();
  });

  // ── §1 navigation ────────────────────────────────────────────────────────
  describe('§1 navigation is context-aware', () => {
    it('an HR company is offered Interview scheduling', async () => {
      const res = await context(fixtures.hr.token);
      const areas = res.body.navigation.map((n: { area: string }) => n.area);
      expect(areas).toContain('INTERVIEW_SCHEDULING');
    });

    it('a Marketing company is NOT', async () => {
      const res = await context(fixtures.marketing.token);
      const areas = res.body.navigation.map((n: { area: string }) => n.area);
      expect(areas).not.toContain('INTERVIEW_SCHEDULING');
    });

    it('keeps the admin/settings areas even with no AI Employee at all', async () => {
      // The brief's explicit rule: never hide a required admin area just
      // because nothing has been configured.
      const res = await context(fixtures.bare.token);
      const areas = res.body.navigation.map((n: { area: string }) => n.area);
      expect(areas).toEqual(
        expect.arrayContaining(['BILLING', 'TEAM', 'ORGANIZATION', 'DASHBOARD']),
      );
    });

    it('every nav entry carries a route and a group the shell can render', async () => {
      const res = await context(fixtures.hr.token);
      expect(res.body.navigation.length).toBeGreaterThan(0);
      for (const item of res.body.navigation) {
        expect(item.href.startsWith('/')).toBe(true);
        expect(['PRIMARY', 'AUTOMATION', 'SECONDARY', 'ADMIN']).toContain(item.group);
      }
    });

    it('offers SKILLS to a plain MEMBER — reads are member-open', async () => {
      // Regression guard for the Phase 3 defect this phase fixed: SKILLS was
      // mapped to the ADMIN-floored `skill:connect`, hiding a page members are
      // allowed to read.
      const memberToken = fixtures.member.token;
      const res = await context(memberToken);
      expect(res.body.productAreas).toContain('SKILLS');
      // And the endpoint really does allow them.
      await http().get('/skills/catalog').set(bearer(memberToken)).expect(200);
      // While the mutation stays ADMIN-only.
      await http()
        .post('/skills/install')
        .set(bearer(memberToken))
        .send({ skillKey: 'slack', displayName: 'Slack' })
        .expect(403);
    });
  });

  // ── §2 dashboard ─────────────────────────────────────────────────────────
  describe('§2 dashboard is capability-driven', () => {
    it('a bare company gets the summary widget and a hire prompt', async () => {
      const res = await dashboard(fixtures.bare.token);
      const kinds = res.body.widgets.map((w: { kind: string }) => w.kind);
      expect(kinds).toContain('COMPANY_SUMMARY');
      const summary = res.body.widgets.find(
        (w: { kind: string }) => w.kind === 'COMPANY_SUMMARY',
      );
      expect(summary.setupHint.ctaHref).toBe('/employees');
    });

    it('an HR company gets the HR widget and NOT Marketing or Support', async () => {
      const res = await dashboard(fixtures.hr.token);
      const kinds = res.body.widgets.map((w: { kind: string }) => w.kind);
      expect(kinds).toContain('HR_ACTIVITY');
      expect(kinds).not.toContain('MARKETING_ACTIVITY');
      expect(kinds).not.toContain('SUPPORT_ACTIVITY');
    });

    it('a Marketing company gets the Marketing widget with a connect-account hint', async () => {
      const res = await dashboard(fixtures.marketing.token);
      const marketing = res.body.widgets.find(
        (w: { kind: string }) => w.kind === 'MARKETING_ACTIVITY',
      );
      expect(marketing).toBeTruthy();
      // §5 — the exact empty state the brief describes.
      expect(marketing.setupHint.message).toMatch(/connect a social account/i);
      expect(marketing.setupHint.ctaHref).toBe('/skills');
    });

    it('a Support company gets the Support widget', async () => {
      const res = await dashboard(fixtures.support.token);
      const kinds = res.body.widgets.map((w: { kind: string }) => w.kind);
      expect(kinds).toContain('SUPPORT_ACTIVITY');
      expect(kinds).not.toContain('HR_ACTIVITY');
    });

    it('a multi-department company gets every matching widget', async () => {
      const res = await dashboard(fixtures.multi.token);
      const kinds = res.body.widgets.map((w: { kind: string }) => w.kind);
      expect(kinds).toEqual(
        expect.arrayContaining([
          'COMPANY_SUMMARY',
          'HR_ACTIVITY',
          'MARKETING_ACTIVITY',
          'SUPPORT_ACTIVITY',
          'APPROVALS',
        ]),
      );
    });

    it('every metric is a real number and links somewhere or nowhere honestly', async () => {
      const res = await dashboard(fixtures.multi.token);
      for (const widget of res.body.widgets) {
        for (const metric of widget.metrics) {
          expect(typeof metric.value).toBe('number');
          expect(metric.href === null || metric.href.startsWith('/')).toBe(true);
        }
      }
    });

    it('is deterministic', async () => {
      const a = await dashboard(fixtures.multi.token);
      const b = await dashboard(fixtures.multi.token);
      expect(JSON.stringify(b.body)).toBe(JSON.stringify(a.body));
    });

    it('does not leak another tenant’s counts', async () => {
      // `fixtures.hr` has an employee; `fixtures.other` has none.
      const b = fixtures.other;
      const bDash = await dashboard(b.token);
      const bSummary = bDash.body.widgets.find(
        (w: { kind: string }) => w.kind === 'COMPANY_SUMMARY',
      );
      expect(bDash.body.companyId).toBe(b.companyId);
      expect(
        bSummary.metrics.find((m: { label: string }) => m.label === 'AI Employees').value,
      ).toBe(0);
    });

    it('requires authentication', async () => {
      await http().get('/product-context/dashboard').expect(401);
    });
  });

  // ── §3 skills ────────────────────────────────────────────────────────────
  describe('§3 skills are categorised, never removed', () => {
    it('returns a status for EVERY catalog skill', async () => {
      const token = fixtures.hr.token;
      const catalog = await http()
        .get('/skills/catalog')
        .set(bearer(token))
        .expect(200);
      const res = await context(token);
      expect(res.body.skillStatuses).toHaveLength(catalog.body.length);
    });

    it('an installed-but-unconnected skill reads NEEDS_CONFIGURATION', async () => {
      const token = fixtures.support.token;
      await http()
        .post('/skills/install')
        .set(bearer(token))
        .send({ skillKey: 'gmail', displayName: 'Gmail' })
        .expect(201);

      const res = await context(token);
      const gmail = res.body.skillStatuses.find(
        (s: { skillKey: string }) => s.skillKey === 'gmail',
      );
      expect(gmail.status).toBe('NEEDS_CONFIGURATION');
      expect(gmail.connectionStatus).toBe('NOT_CONNECTED');
    });

    it('keeps an unrecommended skill listed and installable', async () => {
      const token = fixtures.hr.token;
      const res = await context(token);
      const slack = res.body.skillStatuses.find(
        (s: { skillKey: string }) => s.skillKey === 'slack',
      );
      expect(slack).toBeTruthy();
      expect(['AVAILABLE', 'RECOMMENDED']).toContain(slack.status);
      // Still genuinely installable — categorisation is not a gate.
      await http()
        .post('/skills/install')
        .set(bearer(token))
        .send({ skillKey: 'slack', displayName: 'Slack' })
        .expect(201);
    });
  });

  // ── §4 one template system ───────────────────────────────────────────────
  describe('§4 one authoritative template system', () => {
    it('the marketplace no longer serves workflow templates', async () => {
      const res = await http()
        .get('/marketplace')
        .set(bearer(fixtures.hr.token))
        .expect(200);
      expect(res.body.workflows).toBeUndefined();
      // Employee templates stay — they were never duplicated.
      expect(Array.isArray(res.body.employees)).toBe(true);
      expect(res.body.employees.length).toBeGreaterThan(0);
    });

    it('the marketplace workflow-install route is gone', async () => {
      await http()
        .post('/marketplace/workflows/sales-outreach/install')
        .set(bearer(fixtures.hr.token))
        .send({})
        .expect(404);
    });

    it('the DB-backed template system is the one that answers', async () => {
      const res = await http()
        .get('/workflow-templates')
        .set(bearer(fixtures.hr.token))
        .expect(200);
      expect(res.body.length).toBeGreaterThan(0);
    });

    it('the resolver reports readiness against that same system', async () => {
      const ctx = await context(fixtures.hr.token);
      const templates = await http()
        .get('/workflow-templates')
        .set(bearer(fixtures.hr.token))
        .expect(200);
      // Same population, one source of truth.
      expect(ctx.body.availableWorkflowTemplates.length).toBe(templates.body.length);
    });
  });
});
