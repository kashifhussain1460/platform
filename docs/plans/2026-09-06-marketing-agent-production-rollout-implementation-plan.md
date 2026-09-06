# Marketing Agent Production Rollout — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take the already-code-complete "Content & Social Media Agent" (AI Marketing Manager /
Postiz integration) from code-complete to production-verified — deploy the self-hosted Postiz stack
for the first time in any environment, verify every already-built safety mechanism against a real
instance instead of the mock executor, close the one remaining real code gap, and reach a GA
checklist.

**Architecture:** No new subsystem. `modules/marketing` + `modules/engines/marketing` already
implement everything on the Orlixa side (see `docs/architecture/postiz-integration-plan.md`). This
plan adds: one Docker Compose profile that stands up self-hosted Postiz + its required Temporal/
Elasticsearch stack, three new live-instance-gated e2e specs (skipped unless a real Postiz is
configured, mirroring the existing `describeIfDb` convention in `marketing-production.e2e-spec.ts`),
one real code fix (HTTP status propagation in `PostizClientService`), and a set of infra/ops/decision
tasks that cannot be “implemented” as code (AGPL legal sign-off, a schema keep-or-drop call,
production `API_LIMIT` tuning).

**Tech Stack:** NestJS/Prisma (existing `apps/api`), Docker Compose, self-hosted Postiz
(`ghcr.io/gitroomhq/postiz-app:latest`) + Temporal + Elasticsearch (non-prod) / Temporal Cloud (prod),
Jest + Supertest (existing e2e harness).

**Spec:** `docs/plans/2026-09-06-marketing-agent-production-rollout-plan.md` (the design/rollout plan
this implements — read it first; it documents which items were originally thought open and were
found already fixed by WAVE 3 during spec review, and which are genuinely still open).

## Global Constraints

- No refactor of working modules — this plan only touches what the spec's gap list names.
- Every new e2e spec follows the existing `describeIfDb`-style gating pattern
  (`test/marketing-production.e2e-spec.ts`) — skip cleanly when the live instance isn't configured,
  never fail CI by trying to reach a host that doesn't exist.
- `POSTIZ_BASE_URL`/`POSTIZ_API_KEY` stay a single shared value for the whole deployment, never
  per-company (`marketing.constants.ts`'s own documented invariant — do not regress this).
- Follow the existing `infra/docker-compose.yml` `profiles: [...]` convention (see the `observability`
  profile) for the new Postiz stack — do not create a second compose file.
- TypeScript strict, no `any`, no disabled lint rules — matches the rest of `apps/api`.

---

### Task 1: `PostizClientService` errors carry a real HTTP status

**Files:**
- Modify: `apps/api/src/modules/engines/marketing/postiz-client.service.ts`
- Test: `apps/api/src/modules/engines/marketing/postiz-client.service.spec.ts`

**Interfaces:**
- Produces: `PostizApiError` (exported class, `extends Error`, adds a `readonly status: number`
  field) — every method on `PostizClientService` throws this instead of a plain `Error` on a non-2xx
  response. Message text is unchanged (`` `Postiz ${method} failed: ${res.status}` ``), so this is
  additive, not breaking, for any caller currently matching on `.message`.

- [ ] **Step 1: Write the failing test**

Add to `postiz-client.service.spec.ts`, replacing the existing "throws with the response body when
listPosts fails" test's assertion style is kept, add a new test alongside it:

```typescript
import { httpStatusOf } from '../../../common/resilience/error-classifier';
import { PostizApiError } from './postiz-client.service';

// ... inside the existing describe block, after the "throws with the response body" test:

it('throws a PostizApiError whose .status httpStatusOf() can read structurally', async () => {
  const fetchMock = jest.fn().mockResolvedValue({
    ok: false,
    status: 503,
    text: async () => 'temporarily unavailable',
  });
  global.fetch = fetchMock as unknown as typeof fetch;

  let caught: unknown;
  try {
    await service.listPosts();
  } catch (err) {
    caught = err;
  }

  expect(caught).toBeInstanceOf(PostizApiError);
  expect((caught as PostizApiError).status).toBe(503);
  expect(httpStatusOf(caught)).toBe(503);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `apps/api`): `npx jest postiz-client.service.spec.ts -t "PostizApiError"`
Expected: FAIL — `PostizApiError` is not exported from `./postiz-client.service` (import error), or
`caught` is a plain `Error` and `httpStatusOf(caught)` is `null`.

- [ ] **Step 3: Write minimal implementation**

In `postiz-client.service.ts`, add near the top (after the existing DTO interfaces, before the
`@Injectable()` class):

```typescript
/**
 * Thrown by every PostizClientService method on a non-2xx response. Carries
 * `.status` so common/resilience's httpStatusOf() can read it structurally
 * instead of falling through to regex keyword-guessing on the message text —
 * the P2 gap the 2026-08-06 marketing-production-verification.md report flagged
 * and confirmed still open on 2026-09-06.
 */
export class PostizApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'PostizApiError';
  }
}
```

Then replace every one of the six `throw new Error(...)` call sites in this file (in
`getConnectUrl`, `listIntegrations`, `schedulePost`, `listPosts`, `getIntegrationAnalytics`,
`getPostAnalytics`) with `PostizApiError`, e.g. for `listPosts`:

```typescript
  async listPosts(): Promise<PostizPostDto[]> {
    const res = await this.postizFetch(`${this.baseUrl()}/public/v1/posts`, {
      headers: this.headers(),
    });
    if (!res.ok) {
      const text = await res.text();
      this.logger.warn(`Postiz listPosts failed (${res.status}): ${text}`);
      throw new PostizApiError(`Postiz listPosts failed: ${res.status}`, res.status);
    }
    return (await res.json()) as PostizPostDto[];
  }
```

Apply the identical `throw new PostizApiError(\`Postiz <method> failed: ${res.status}\`, res.status)`
substitution to the other five call sites, keeping each method's own message text unchanged (only
the error class + added `status` argument change).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest postiz-client.service.spec.ts -v`
Expected: PASS, including the existing `'throws with the response body when listPosts fails'` test
(its `.rejects.toThrow('Postiz listPosts failed: 500')` string assertion still matches, since
`PostizApiError`'s message text is unchanged).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/engines/marketing/postiz-client.service.ts apps/api/src/modules/engines/marketing/postiz-client.service.spec.ts
git commit -m "fix(marketing): PostizClientService errors carry a real HTTP status"
```

---

### Task 2: Self-hosted Postiz stack in Docker Compose (non-prod, `postiz` profile)

**Files:**
- Modify: `infra/docker-compose.yml`
- Create: `infra/postiz/dynamicconfig/development-sql.yaml` (Temporal's required dynamic-config file
  — copy verbatim from Temporal's own `auto-setup` image documentation; a minimal working file is
  provided in Step 1 below)

**Interfaces:**
- Produces: a `postiz` container reachable at `http://localhost:5432... ` — no, reachable at
  `http://postiz:3000` from other containers on the `vaep` compose network, and
  `http://localhost:5433postiz` is not used — the host port is `5555` (chosen to avoid the existing
  `5433`/`6380`/`8080`/`9000`/`9001`/`3001`/`9090` bindings already in this file). Consumed by Task 3.

- [ ] **Step 1: Create the Temporal dynamic-config file**

```bash
mkdir -p "infra/postiz/dynamicconfig"
```

Write `infra/postiz/dynamicconfig/development-sql.yaml`:

```yaml
frontend.enableClientVersionCheck:
  - value: true
    constraints: {}
history.persistenceMaxQPS:
  - value: 3000
    constraints: {}
frontend.persistenceMaxQPS:
  - value: 3000
    constraints: {}
system.advancedVisibilityWritingMode:
  - value: "on"
    constraints: {}
```

- [ ] **Step 2: Add the `postiz` profile to `infra/docker-compose.yml`**

Insert a new profile-gated block, following the exact pattern the existing `observability` profile
uses (named volumes, `profiles: ["postiz"]`, `${VAR:-default}` env), right before the `volumes:`
section at the end of the file:

```yaml
  # ── Marketing engine (Postiz) ───────────────────────────────────────────────
  # Self-hosted per docs/architecture/postiz-analysis.md §26 — Postiz's own
  # production docker-compose.yaml requires Postgres + Redis + a full Temporal
  # cluster (Temporal server + its own dedicated Postgres + Elasticsearch); none
  # of that is optional, publish-scheduling runs on Temporal workflows. Opt-in,
  # same reasoning as the observability profile:
  #   docker compose -f infra/docker-compose.yml --profile postiz up -d
  postiz-postgres:
    image: postgres:17-alpine
    profiles: ["postiz"]
    restart: unless-stopped
    environment:
      POSTGRES_USER: postiz
      POSTGRES_PASSWORD: postiz
      POSTGRES_DB: postiz
    volumes:
      - postizpgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postiz -d postiz"]
      interval: 10s
      timeout: 5s
      retries: 5

  postiz-redis:
    image: redis:7-alpine
    profiles: ["postiz"]
    restart: unless-stopped

  temporal-postgres:
    image: postgres:16-alpine
    profiles: ["postiz"]
    restart: unless-stopped
    environment:
      POSTGRES_USER: temporal
      POSTGRES_PASSWORD: temporal
    volumes:
      - temporalpgdata:/var/lib/postgresql/data

  elasticsearch:
    image: elasticsearch:7.17.27
    profiles: ["postiz"]
    restart: unless-stopped
    environment:
      discovery.type: single-node
      xpack.security.enabled: "false"
      ES_JAVA_OPTS: "-Xms256m -Xmx256m"

  temporal:
    image: temporalio/auto-setup:1.24
    profiles: ["postiz"]
    restart: unless-stopped
    depends_on:
      - temporal-postgres
      - elasticsearch
    environment:
      DB: postgres12
      DB_PORT: 5432
      POSTGRES_USER: temporal
      POSTGRES_PWD: temporal
      POSTGRES_SEEDS: temporal-postgres
      ENABLE_ES: "true"
      ES_SEEDS: elasticsearch
      ES_VERSION: v7
      DYNAMIC_CONFIG_FILE_PATH: config/dynamicconfig/development-sql.yaml
    volumes:
      - ./postiz/dynamicconfig:/etc/temporal/config/dynamicconfig

  postiz:
    image: ghcr.io/gitroomhq/postiz-app:latest
    profiles: ["postiz"]
    restart: unless-stopped
    depends_on:
      - postiz-postgres
      - postiz-redis
      - temporal
    environment:
      DATABASE_URL: postgresql://postiz:postiz@postiz-postgres:5432/postiz
      REDIS_URL: redis://postiz-redis:6379
      JWT_SECRET: ${POSTIZ_JWT_SECRET:-dev-only-change-me}
      FRONTEND_URL: http://localhost:5555
      NEXT_PUBLIC_BACKEND_URL: http://localhost:5555/api
      BACKEND_INTERNAL_URL: http://localhost:3000
      TEMPORAL_ADDRESS: temporal:7233
      IS_GENERAL: "true"
      DISABLE_REGISTRATION: "false"
      STORAGE_PROVIDER: local
      UPLOAD_DIRECTORY: /uploads
      NEXT_PUBLIC_UPLOAD_DIRECTORY: /uploads
    ports:
      - "5555:3000"
    volumes:
      - postizuploads:/uploads
```

Add the three new volumes to the existing `volumes:` block at the end of the file:

```yaml
  postizpgdata:
  temporalpgdata:
  postizuploads:
```

- [ ] **Step 3: Validate the compose file syntax**

Run: `docker compose -f infra/docker-compose.yml --profile postiz config --quiet`
Expected: no output, exit code 0 (a YAML/schema error would print to stderr and exit non-zero).

- [ ] **Step 4: Bring the stack up and verify health**

Run: `docker compose -f infra/docker-compose.yml --profile postiz up -d`
Then: `docker compose -f infra/docker-compose.yml --profile postiz ps`
Expected: `postiz-postgres` and `temporal-postgres` show `(healthy)`; `postiz` shows `Up`. Then:
`curl -sf http://localhost:5555/api/health` (or open `http://localhost:5555` in a browser) —
Expected: Postiz's own login/setup screen loads, proving the app container itself booted against its
DB + Temporal successfully.

- [ ] **Step 5: Commit**

```bash
git add infra/docker-compose.yml infra/postiz/dynamicconfig/development-sql.yaml
git commit -m "infra: add opt-in self-hosted Postiz stack (postiz compose profile)"
```

---

### Task 3: Wire non-prod Orlixa at the live Postiz instance and prove the core loop manually

**Files:**
- Modify: `apps/api/.env` (local/non-prod only — never commit real values; `.env.example` at
  `apps/api/.env.example:207-209` already documents the two variable names, no change needed there)

**Interfaces:**
- Consumes: the `postiz` container from Task 2, reachable at `http://localhost:5555` from the host
  (where `apps/api` runs in dev per `platform/CLAUDE.md`'s "Run locally" section) — note this differs
  from the in-container hostname `postiz:3000` `.env.example` documents, because `apps/api` runs on
  the host, not inside the compose network, in local dev.

- [ ] **Step 1: Complete Postiz's own first-run setup**

Open `http://localhost:5555`, complete the one-time admin registration screen Postiz's own app
presents (this is Postiz's own onboarding, not Orlixa's — expected, see the architecture plan's
"Postiz's own UI is never customer-facing" note, which applies to the *Orlixa customer*, not to this
one-time infra setup step). From Postiz's own settings, generate an API key.

- [ ] **Step 2: Point Orlixa's non-prod `.env` at it**

In `apps/api/.env`:
```
POSTIZ_BASE_URL=http://localhost:5555
POSTIZ_API_KEY=<the key generated in Step 1>
```
Restart `apps/api` (`pnpm dev` inside `apps/api`, per the existing GOTCHA in `platform/CLAUDE.md` about
`turbo` stripping env vars when run from the repo root).

- [ ] **Step 3: Manually prove the connect → schedule → publish → analytics round trip**

Using the running Orlixa API (curl or the `/marketing` frontend, whichever is faster to hand):
1. Trigger `postiz.start_connect_account` (or `GET /marketing/social-accounts/:provider/connect` if
   exposed at that route — check `marketing.controller.ts` for the exact path) for one real test
   social account you control. Complete the real provider OAuth consent screen.
2. Confirm a `SocialAccount` row appears with `status: CONNECTED` (`GET /marketing/social-accounts`).
3. Schedule a real post ~2 minutes in the future via the employee chat or workflow trigger, confirm it
   actually appears on the real social platform at the scheduled time.
4. Call `postiz.get_post_status` / `GET /marketing/analytics/:socialAccountId` and confirm real,
   non-placeholder analytics numbers come back (this is the exact IMPLEMENTED_UNVERIFIED path
   `postiz-client.service.ts`'s own doc comment flags — this step is what turns it VERIFIED).

Expected: all four sub-steps succeed against the real provider and real Postiz instance. Record the
actual result (pass/fail per sub-step) in a short note added to
`docs/implementation/workflow-system/marketing-production-verification.md` as a new dated section —
do not edit the existing 2026-08-06 findings, append a new one.

- [ ] **Step 4: Commit the verification note**

```bash
git add docs/implementation/workflow-system/marketing-production-verification.md
git commit -m "docs(marketing): record first real-Postiz manual verification pass"
```

---

### Task 4: Re-run the existing marketing e2e suite against the live instance

**Files:**
- None modified — this task runs existing specs with different env, and fixes anything they surface.

- [ ] **Step 1: Run the full marketing e2e set with the live Postiz env**

From `apps/api`, with `.env`'s `POSTIZ_BASE_URL`/`POSTIZ_API_KEY` from Task 3 still set, and
`SKILL_EXECUTOR=real` (not `mock`) so the real skill executor path is exercised:

```bash
SKILL_EXECUTOR=real LLM_PROVIDER=mock EMBEDDINGS_PROVIDER=hash STORAGE_PROVIDER=local BILLING_PROVIDER=mock ENCRYPTION_KEY=<64 hex> WORKFLOW_ENGINE_MODE=state_machine \
  npx jest --config ./test/jest-e2e.json --forceExit \
  engines-marketing journey-marketing-reconcile marketing-campaign-generation marketing-consent marketing-email-campaign-consent marketing-production marketing-workspace
```

Expected: all 7 suites still pass. If any fail specifically on a Postiz call (not on unrelated
`SKILL_EXECUTOR=real` fallout from other skills the same suite happens to exercise), that is a real
defect this task fixes before moving on — the point of this task is that these suites have never run
against anything but the mock executor before.

- [ ] **Step 2: If any suite fails against the live instance, fix and re-run**

Any fix here is scoped to whatever the live run actually surfaces (cannot be pre-written — the whole
premise of Phase B/this task is that these code paths have never executed against a real instance).
Follow the existing `superpowers:systematic-debugging` skill for any failure investigation.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "test(marketing): verify existing e2e suite against real Postiz (first time)"
```
(Skip this commit if Step 1 passed with zero code changes — nothing to commit.)

---

### Task 5: Live-gated idempotency verification test

**Files:**
- Create: `apps/api/test/marketing-live-idempotency.e2e-spec.ts`

**Interfaces:**
- Consumes: `POSTIZ_LIVE_TEST=true` env flag (new — this task defines it) gating the whole suite,
  mirroring `hasDb`/`describeIfDb` in `marketing-production.e2e-spec.ts`.

- [ ] **Step 1: Write the test**

Calls `SKILL_EXECUTOR_TOKEN`'s DI-resolved executor directly (the same object the workflow engine's
TOOL_ACTION node and the chat tool-calling loop both call through) — this is deterministic and avoids
routing through the LLM chat loop, while still exercising the REAL `PostizClientService` +
`PrismaService` + `ToolIdempotencyService` wiring exactly as production does (`skills.module.ts`'s
`makeReal()` factory), because the whole `AppModule` is booted with `SKILL_EXECUTOR=real`.

```typescript
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { SKILL_EXECUTOR_TOKEN, type SkillExecutor } from '../src/modules/skills/executors/skill-executor';

/**
 * Live-Postiz gated — only runs when POSTIZ_LIVE_TEST=true AND a real
 * POSTIZ_BASE_URL/POSTIZ_API_KEY are configured (Task 2/3 of
 * docs/plans/2026-09-06-marketing-agent-production-rollout-implementation-plan.md).
 * Proves the WAVE 3 idempotency fix (ToolIdempotencyService on schedule_post,
 * ScheduledPost.idempotencyKey on publish_now) against the REAL Postiz API,
 * not the mock executor every other marketing e2e spec uses.
 */
const isLive = process.env.POSTIZ_LIVE_TEST === 'true' && Boolean(process.env.POSTIZ_API_KEY);
const describeIfLive = isLive ? describe : describe.skip;

describeIfLive('Marketing live verification — publish idempotency against real Postiz', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let executor: SkillExecutor;
  let companyId = '';
  let socialAccountId = '';

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    executor = app.get<SkillExecutor>(SKILL_EXECUTOR_TOKEN);

    // Requires a company + a CONNECTED SocialAccount created by Task 3's
    // manual step (account connection is a real OAuth popup, not
    // automatable here) — reads the first one found rather than registering
    // a fresh company, since the account must already be OAuth-connected.
    const account = await prisma.socialAccount.findFirst({ where: { status: 'CONNECTED' } });
    if (!account) {
      throw new Error(
        'No CONNECTED SocialAccount found — connect one manually first (Task 3, Step 3.1) before running this test.',
      );
    }
    socialAccountId = account.id;
    companyId = account.companyId;
  });

  afterAll(async () => {
    await app.close();
  });

  it('a retried schedule_post with the same args does not create a second ScheduledPost', async () => {
    const publishAt = new Date(Date.now() + 5 * 60_000).toISOString();
    const content = `Idempotency test post ${Date.now()}`;
    const ctx = { companyId };

    const first = await executor.execute('postiz', 'schedule_post', { socialAccountId, content, publishAt }, ctx);
    const second = await executor.execute('postiz', 'schedule_post', { socialAccountId, content, publishAt }, ctx);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect((second.result as { scheduledPostId?: string })?.scheduledPostId).toBe(
      (first.result as { scheduledPostId?: string })?.scheduledPostId,
    );

    const rows = await prisma.scheduledPost.findMany({ where: { companyId, content } });
    expect(rows).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it unconfigured, confirm it skips cleanly**

Run: `npx jest marketing-live-idempotency --config ./test/jest-e2e.json`
Expected: `1 skipped` — proves the gate itself works before ever touching a live instance.

- [ ] **Step 3: Run it against the live instance from Task 2/3**

Run: `POSTIZ_LIVE_TEST=true POSTIZ_BASE_URL=http://localhost:5555 POSTIZ_API_KEY=<key> ... npx jest marketing-live-idempotency --config ./test/jest-e2e.json`
Expected: PASS. If it fails, this is the first real evidence the WAVE 3 idempotency fix has ever been
checked against a real Postiz — treat a failure here as a genuine defect, not a test bug, and fix
`postiz-client.service.ts`/`real-skill-executor.ts`'s `postizSchedulePost` accordingly.

- [ ] **Step 4: Commit**

```bash
git add apps/api/test/marketing-live-idempotency.e2e-spec.ts
git commit -m "test(marketing): add live-Postiz-gated idempotency verification"
```

---

### Task 6: Live-gated cross-tenant isolation verification test

**Files:**
- Create: `apps/api/test/marketing-live-isolation.e2e-spec.ts`

**Interfaces:**
- Consumes: same `POSTIZ_LIVE_TEST` gate as Task 5.

- [ ] **Step 1: Write the test**

Same direct-executor-call pattern as Task 5 (see its rationale) — two companies, cross the
`socialAccountId`, confirm the lookup fails rather than silently succeeding against the wrong tenant.

```typescript
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { SKILL_EXECUTOR_TOKEN, type SkillExecutor } from '../src/modules/skills/executors/skill-executor';

/**
 * Live-Postiz gated (see marketing-live-idempotency.e2e-spec.ts for the gate
 * rationale). Proves the ONE thing postiz-integration-plan.md Phase 9 flags as
 * the top security risk of the shared-Postiz-org design: company A's
 * schedule_post call can never resolve to company B's connected account, even
 * though both companies' integrations live in the SAME Postiz org tagged only
 * by Customer/group id. This has never been tested against a real Postiz
 * Customer group before — companyId-scoping on Orlixa's OWN tables was
 * verified 2026-08-06, but the third-party-tagging half was not (no live
 * instance existed). Requires Task 8 (customer-tagging) to be implemented
 * first, or every account lands in the same untagged bucket and this test
 * cannot distinguish "isolated" from "not tagged yet."
 */
const isLive = process.env.POSTIZ_LIVE_TEST === 'true' && Boolean(process.env.POSTIZ_API_KEY);
const describeIfLive = isLive ? describe : describe.skip;

describeIfLive('Marketing live verification — cross-tenant isolation against real Postiz', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let executor: SkillExecutor;
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

  const registerCompany = async (label: string) => {
    const ts = Date.now();
    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        email: `${label}-${ts}@test.com`,
        password: 'Passw0rd!23',
        companyName: `${label} ${ts}`,
      })
      .expect(201);
    return { token: res.body.accessToken as string, companyId: res.body.company.id as string };
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
    executor = app.get<SkillExecutor>(SKILL_EXECUTOR_TOKEN);
  });

  afterAll(async () => {
    await app.close();
  });

  it("company A cannot schedule a post against company B's SocialAccount id", async () => {
    const a = await registerCompany('isolation-a');
    const b = await registerCompany('isolation-b');

    const bAccount = await prisma.socialAccount.findFirst({
      where: { companyId: b.companyId, status: 'CONNECTED' },
    });
    if (!bAccount) {
      throw new Error(
        "Company B needs a CONNECTED SocialAccount for this test — connect one manually first, company id: " +
          b.companyId,
      );
    }

    const result = await executor.execute(
      'postiz',
      'schedule_post',
      {
        socialAccountId: bAccount.id,
        content: 'cross-tenant isolation probe',
        publishAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      },
      { companyId: a.companyId },
    );

    // real-skill-executor.ts's postizSchedulePost already scopes the
    // SocialAccount lookup by companyId (`findFirst({ where: { id, companyId }})`)
    // — this must return ok:false "not found", never succeed against B's account.
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not found/i);
  });
});
```

- [ ] **Step 2: Run it unconfigured, confirm it skips cleanly**

Run: `npx jest marketing-live-isolation --config ./test/jest-e2e.json`
Expected: `1 skipped`.

- [ ] **Step 3: Run it against the live instance**

Same env as Task 5, Step 3. Expected: PASS. A failure here is the single highest-severity finding this
whole plan could produce (a real cross-tenant leak through the shared Postiz org) — stop and escalate
rather than patching silently, per this codebase's own "fail loudly" convention.

- [ ] **Step 4: Commit**

```bash
git add apps/api/test/marketing-live-isolation.e2e-spec.ts
git commit -m "test(marketing): add live-Postiz-gated cross-tenant isolation verification"
```

---

### Task 7: AGPL-3.0 legal review (escalation, not code)

**Files:** none — this task produces a decision, not a diff.

- [ ] **Step 1: Package the review request**

Send `docs/architecture/postiz-integration-plan.md`'s "AGPL-3.0 licensing" subsection (Phase 9) to
whoever owns legal sign-off, with the specific question the doc already frames: is running an
**unmodified** self-hosted Postiz instance, called only via its own public API, from a separate
proprietary backend (Orlixa) acceptable for a paid product without triggering AGPL §13's
network-copyleft obligations? Also flag the live open question: if the Customer-tagging patch
(Task 8 below) is built, does that change the answer (the doc says it does — "modified version"
analysis would then apply to at least that patch).

- [ ] **Step 2: Record the outcome**

Once a decision comes back, append it (dated) to `docs/architecture/postiz-integration-plan.md`'s
"Open items needing a decision" section (item 1). Do not proceed to Task 11 (production promotion)
until this is recorded as resolved.

---

### Task 8: Customer-tagging connect-time patch — decide and implement

**Files:**
- Decision: additive Postiz-side patch vs. session-bridge workaround (architecture plan Phase 3).
- If patch chosen — Modify: the self-hosted Postiz fork (outside this repo; track the change in
  `infra/postiz/README.md`, create this file if the patch path is chosen).
- If session-bridge chosen — Create: `apps/api/src/modules/engines/marketing/postiz-session-bridge.service.ts`

**Interfaces:**
- Produces: whichever path is chosen must let a newly-connected Postiz `Integration` get tagged to
  the right Orlixa company's Postiz `Customer` id at connect time — required before Task 3, Step 3.1
  can be trusted for more than one company (Task 3 with a single test company doesn't need this yet;
  Task 6's two-company isolation test does).

- [ ] **Step 1: Make the call**

Per the architecture plan's own recommendation: prefer the small additive public-API endpoint patch
(cleaner, versioned) over the session-bridge workaround (depends on an unversioned internal Postiz
route) — unless Task 7's AGPL review comes back specifically warning against *any* Postiz source
modification, in which case use the session-bridge workaround instead. Record which was chosen and
why in `docs/architecture/postiz-integration-plan.md`'s "Open items" section (item 5).

- [ ] **Step 2: Implement the chosen path**

This step cannot be pre-written — it depends on Step 1's outcome and, for the patch path, on reading
Postiz's actual `integrations.controller.ts` `PUT /:id/group` implementation at patch time (not
knowable until that file is checked out). Follow `superpowers:systematic-debugging` /
`superpowers:test-driven-development` for whichever path is chosen, with the same
`companyId`-scoping discipline the rest of `apps/api` uses.

- [ ] **Step 3: Verify with Task 6's isolation test**

Once implemented, Task 6's cross-tenant isolation test (which needs two distinct companies each with
their own tagged Postiz Customer) is the acceptance test for this task. Re-run it; it must pass.

---

### Task 9: `MediaAsset`/`BrandAsset` — decide keep-and-wire vs. drop

**Files:** none until the decision is made.

- [ ] **Step 1: Get a product decision**

These two tables have zero reads/writes anywhere in `apps/api/src` (confirmed 2026-09-06 — `Campaign`
and `MarketingAnalyticsSnapshot`, listed alongside them in the original 2026-08-06 report, are now
both wired and are NOT part of this decision). Options: (a) wire them into
`modules/marketing/generation`/`planning` as originally designed (brand logo/palette/font storage,
media library for drafts before Postiz upload), or (b) drop them from the schema before GA. This is a
scope call, not an engineering one — escalate to whoever owns the product decision for this plan.

- [ ] **Step 2a: If "wire" — scope as a separate follow-up plan**

Do not fold this into the current rollout plan; it's a real feature addition (Brand Settings UI +
Media Library UI per `postiz-integration-plan.md` Phase 8), sized similarly to the rest of Phase 8's
frontend work. Write a new plan via `superpowers:writing-plans` when scoped.

- [ ] **Step 2b: If "drop" — write the migration**

```bash
cd apps/api && pnpm run prisma:migrate:new --name drop_unused_media_brand_asset_tables
```
Remove the `MediaAsset` and `BrandAsset` models (and their relation fields on `Company` if any) from
`prisma/schema.prisma` first, then generate. Per `platform/CLAUDE.md`'s pgvector GOTCHA, review the
generated SQL before applying — this migration only drops two genuinely empty tables, so no data-loss
review is needed beyond confirming the generated `DROP TABLE` statements target exactly these two.
Apply with `pnpm --filter @vaep/api run prisma:migrate`.

---

### Task 10: Tune `API_LIMIT` for production capacity

**Files:**
- Modify: production Postiz deployment env (outside this repo — infra/ops, tracked wherever
  production secrets are managed, e.g. the hosting platform's env-var UI)

- [ ] **Step 1: Estimate expected combined publish volume**

Across all Orlixa companies expected to use the Marketing agent in the first 90 days post-GA, estimate
peak posts-scheduled-per-hour. `POSTIZ_RATE_LIMIT = 90` (`marketing.constants.ts:19`) is Orlixa's
own client-side budget matching Postiz's *default* 90/hr cap — if the estimate exceeds that, raise
Postiz's own `API_LIMIT` env var on the production instance AND update `POSTIZ_RATE_LIMIT` in
`marketing.constants.ts` to match (they must stay equal — Orlixa's client-side limiter exists so
Orlixa fails fast/queues rather than Postiz itself rate-limiting mid-request).

- [ ] **Step 2: If raised, update the constant and add a regression test**

If `POSTIZ_RATE_LIMIT` changes, update `marketing.constants.ts:19` and confirm
`postiz-client.service.spec.ts`'s existing rate-limit tests (if any assert the literal `90`) are
updated to match — grep for `POSTIZ_RATE_LIMIT` usage in specs first.

---

### Task 11: Production Postiz deployment (Temporal Cloud, not self-hosted Temporal)

**Files:**
- Modify: production infra config (outside this repo, per this deployment's existing pattern — see
  `platform/CLAUDE.md`'s Vercel/env-var conventions for where production env is actually set)

- [ ] **Step 1: Provision Temporal Cloud**

Per the 2026-09-06 decision recorded in `docs/plans/2026-09-06-marketing-agent-production-rollout-plan.md`
§3 Phase A: production does not self-host Temporal/Elasticsearch (Task 2's stack is non-prod only).
Provision a Temporal Cloud namespace; obtain `TEMPORAL_ADDRESS`, `TEMPORAL_TLS` cert/key,
`TEMPORAL_API_KEY`, `TEMPORAL_NAMESPACE`.

- [ ] **Step 2: Deploy Postiz app + its own Postgres + Redis to production infra**

Self-hosted (per the architecture plan's "wrap as a service" recommendation — not Temporal-adjacent,
these three stay self-hosted regardless of the Temporal Cloud choice). Point `TEMPORAL_ADDRESS` etc.
from Step 1 instead of a local `temporal:7233`.

- [ ] **Step 3: Point production `POSTIZ_BASE_URL`/`POSTIZ_API_KEY` at it**

Set in production env config (never committed to this repo). Restart/redeploy `apps/api`.

- [ ] **Step 4: Wire monitoring on the 3 marketing queues + DLQ**

`marketing-publish-dispatch`, `marketing-reconcile`, `marketing-analytics-sync` — confirm these are
visible in whatever queue-monitoring the rest of `apps/api`'s BullMQ queues already use (check
`common/resilience`'s `RESILIENT_JOB_OPTIONS`/DLQ wiring for the existing pattern to extend, per
`platform/CLAUDE.md`'s reference to `/admin/dlq`).

---

### Task 12: GA checklist sign-off

**Files:**
- Modify: `docs/plans/2026-09-06-marketing-agent-production-rollout-plan.md` (append a dated "GA
  sign-off" section at the end, do not rewrite the existing content)

- [ ] **Step 1: Confirm every gate is closed**

- [ ] Task 1 (error classification) merged
- [ ] Task 2-4 (non-prod live instance + existing suite re-verified) passed
- [ ] Task 5, 6 (live idempotency + isolation tests) both PASS against the live instance
- [ ] Task 7 (AGPL) resolved
- [ ] Task 8 (customer-tagging) implemented and verified
- [ ] Task 9 (MediaAsset/BrandAsset) decided (either follow-up plan scoped, or migration applied)
- [ ] Task 10 (capacity) estimated and `API_LIMIT`/`POSTIZ_RATE_LIMIT` aligned
- [ ] Task 11 (production deployment) live

- [ ] **Step 2: Append the sign-off note and commit**

```bash
git add docs/plans/2026-09-06-marketing-agent-production-rollout-plan.md
git commit -m "docs(marketing): GA sign-off — Content & Social Media Agent production-ready"
```

## Self-review notes (spec coverage)

- Spec §3 Phase A → Tasks 2, 3. Phase B → Tasks 1 (the genuinely-open P2), 4, 5, 6 (verification of
  the already-fixed WAVE 3 items, reframed from "implement" to "verify live" per the corrected spec).
  Phase C → Tasks 7, 10. Phase D → Task 6. Phase E → Tasks 8 (customer-tagging, moved earlier since
  Task 6 depends on it), 9, 11, 12.
- The spec's §4 "open decisions" (customer-tagging path, MediaAsset/BrandAsset, AGPL owner) map 1:1
  to Tasks 8, 9, 7 — each is a decision checkpoint task, not a blind implementation, since none of the
  three can be resolved by this plan alone.
- Task 8 is placed before Task 6 needs it (two-company isolation requires per-company Customer
  tagging to be meaningful) — call this out explicitly to whoever executes: **do Task 8 before Task
  6's live run**, even though they're numbered in spec-phase order above.
