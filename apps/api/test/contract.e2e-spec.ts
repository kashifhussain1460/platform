import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import {
  aiEmployeeDtoSchema,
  approvalRequestDtoSchema,
  auditLogDtoSchema,
  companyDtoSchema,
  knowledgeDocumentDtoSchema,
  userDtoSchema,
  workflowDtoSchema,
  workflowRunDtoSchema,
} from '@vaep/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';

/**
 * P0-04 — API/type contract tests.
 *
 * `@vaep/types` is the contract between `apps/api` and `apps/web`, but until
 * now nothing checked that the API actually RETURNS what its published type
 * claims: all 40 pre-existing zod schemas validate request bodies only. A field
 * renamed on the server stayed invisible until the frontend broke at runtime.
 *
 * Each case below hits a real endpoint and parses the real response with
 * `<dto>Schema.strict()`. `.strict()` matters: it fails on UNDECLARED keys too,
 * so a field the API adds without publishing it in `@vaep/types` is caught, not
 * just a field it drops.
 *
 * The schemas themselves cannot drift from the DTO interfaces — each is paired
 * with a compile-time `Expect<Equal<z.infer<...>, Dto>>` assertion in
 * `packages/types/src/response-schemas.ts`, so `tsc` fails if they diverge.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

/**
 * Minimal structural shape of a zod schema, declared locally rather than
 * importing `ZodType` — that would make `zod` a direct dependency of
 * `apps/api` purely for tests. The schemas arrive fully built from
 * `@vaep/types`, so only `safeParse` is needed here.
 */
interface SchemaIssue {
  path: Array<string | number>;
  message: string;
}
interface ParsableSchema {
  safeParse(
    value: unknown,
  ):
    | { success: true }
    | { success: false; error: { issues: SchemaIssue[] } };
}

/** Parse and, on failure, report the exact offending path(s). */
function expectMatches(
  schema: ParsableSchema,
  payload: unknown,
  label: string,
): void {
  const result = schema.safeParse(payload);
  if (!result.success) {
    const issues = result.error.issues
      .map((i: SchemaIssue) => `  • ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(
      `${label} does not match its published @vaep/types contract:\n${issues}\n` +
        `Received: ${JSON.stringify(payload, null, 2).slice(0, 1200)}`,
    );
  }
}

describeIfDb('API ⇄ @vaep/types contract (P0-04)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const stamp = Date.now();
  let token = '';
  let companyId = '';
  let workflowId = '';
  let employeeId = '';

  const auth = () => ({ Authorization: `Bearer ${token}` });

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
      .send({
        companyName: `Contract Co ${stamp}`,
        name: 'Contract Owner',
        email: `contract_${stamp}@example.com`,
        password: 'password123',
      })
      .expect(201);
    token = reg.body.tokens.accessToken;
    companyId = reg.body.company.id;

    const wf = await request(app.getHttpServer())
      .post('/workflows')
      .set(auth())
      .send({
        name: 'Contract workflow',
        definition: {
          nodes: [
            { id: 'n1', type: 'TRIGGER', config: {} },
            { id: 'n2', type: 'NOTIFY', config: { message: 'hi' } },
          ],
          edges: [{ from: 'n1', to: 'n2' }],
        },
      })
      .expect(201);
    workflowId = wf.body.id;

    const emp = await request(app.getHttpServer())
      .post('/employees')
      .set(auth())
      .send({ name: 'Contract Employee', role: 'MARKETING' })
      .expect(201);
    employeeId = emp.body.id;
  });

  afterAll(async () => {
    await app?.close();
  });

  // There is no GET on /companies — PATCH is the only route that returns a
  // CompanyDto, so the contract is asserted on its response.
  it('PATCH /companies/current matches CompanyDto', async () => {
    const res = await request(app.getHttpServer())
      .patch('/companies/current')
      .set(auth())
      .send({ industry: 'Software' })
      .expect(200);
    expectMatches(companyDtoSchema.strict(), res.body, 'CompanyDto');
    expect(res.body.industry).toBe('Software');
  });

  it('GET /users matches UserDto[]', async () => {
    const res = await request(app.getHttpServer())
      .get('/users')
      .set(auth())
      .expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    for (const row of res.body) {
      expectMatches(userDtoSchema.strict(), row, 'UserDto');
    }
  });

  it('GET /employees/:id matches AiEmployeeDto (incl. the MARKETING role)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/employees/${employeeId}`)
      .set(auth())
      .expect(200);
    expectMatches(aiEmployeeDtoSchema.strict(), res.body, 'AiEmployeeDto');
    expect(res.body.role).toBe('MARKETING');
  });

  it('GET /workflows/:id matches WorkflowDto', async () => {
    const res = await request(app.getHttpServer())
      .get(`/workflows/${workflowId}`)
      .set(auth())
      .expect(200);
    expectMatches(workflowDtoSchema.strict(), res.body, 'WorkflowDto');
  });

  it('GET /workflows/runs/:runId matches WorkflowRunDto (with nested steps)', async () => {
    const run = await prisma.workflowRun.create({
      data: {
        companyId,
        workflowId,
        status: 'COMPLETED',
        source: 'MANUAL',
      },
    });
    await prisma.workflowStepRun.create({
      data: {
        companyId,
        runId: run.id,
        nodeId: 'n1',
        type: 'TRIGGER',
        status: 'COMPLETED',
      },
    });

    const res = await request(app.getHttpServer())
      .get(`/workflows/runs/${run.id}`)
      .set(auth())
      .expect(200);
    expectMatches(workflowRunDtoSchema.strict(), res.body, 'WorkflowRunDto');
    // Nested steps must be present and typed — the run log polls this shape.
    expect(res.body.steps).toHaveLength(1);
  });

  it('GET /knowledge/documents matches KnowledgeDocumentDto[]', async () => {
    await prisma.knowledgeDocument.create({
      data: {
        companyId,
        filename: 'contract.txt',
        mimeType: 'text/plain',
        sizeBytes: 5,
        storageKey: `contract/${stamp}.txt`,
        status: 'READY',
      },
    });

    const res = await request(app.getHttpServer())
      .get('/knowledge/documents')
      .set(auth())
      .expect(200);
    for (const row of res.body) {
      expectMatches(
        knowledgeDocumentDtoSchema.strict(),
        row,
        'KnowledgeDocumentDto',
      );
    }
  });

  it('GET /approvals matches ApprovalRequestDto[]', async () => {
    await prisma.approvalRequest.create({
      data: {
        companyId,
        kind: 'TOOL',
        skillKey: 'slack',
        tool: 'send_message',
        args: { channel: '#general' },
        status: 'PENDING',
      },
    });

    const res = await request(app.getHttpServer())
      .get('/approvals')
      .set(auth())
      .expect(200);
    expect(res.body.length).toBeGreaterThan(0);
    for (const row of res.body) {
      expectMatches(
        approvalRequestDtoSchema.strict(),
        row,
        'ApprovalRequestDto',
      );
    }
  });

  it('GET /audit-log matches AuditLogDto[]', async () => {
    const res = await request(app.getHttpServer())
      .get('/audit-log')
      .set(auth())
      .expect(200);
    expect(res.body.length).toBeGreaterThan(0);
    for (const row of res.body) {
      expectMatches(auditLogDtoSchema.strict(), row, 'AuditLogDto');
    }
  });
});
