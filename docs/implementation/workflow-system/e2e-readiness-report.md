# Full Product E2E Readiness Report

**Date:** 2026-08-06
**Mode:** Full-product E2E verification — exercise Orlixa as a real company admin across Journey A (HR) and Journey B (Marketing), verify frontend/backend/database/queue at each stage, cover happy + failure paths, add E2E coverage, no mocking of internal Orlixa APIs.
**Test reality:** the api runs **54 Jest e2e suites against a REAL Postgres + Redis + BullMQ queue**. External skill providers (gmail/slack/postiz/…) are sandboxed via `SKILL_EXECUTOR=mock` — that is the standard, unavoidable boundary, not a mock of any internal Orlixa API. The web app has vitest unit tests (canvas, hooks) and no browser E2E yet.

## What was added this pass (real, verified)
- **`test/journey-hr-e2e.e2e-spec.ts`** — the single from-scratch Journey A story that was missing: create company → hire HR employee → connect a skill → **build a workflow from scratch → save draft → validate → publish (freeze v1) → activate → run → approve → COMPLETED**, plus a **reject → FAILED** failure path and a **cyclic-graph → 400** validation failure, then **reads the audit trail and analytics back through their real APIs**. Asserts real run/DB state at each step. ✅ passes.
- **`test/journey-marketing-reconcile.e2e-spec.ts`** — the missing real-DB reconciliation test: seeds a real `ScheduledPost`, drives the real `/admin/cron/marketing-sync` route, asserts `SCHEDULED → PUBLISHED` (+ a `PublishedPost` row with permalink) and `→ FAILED` on a Postiz error. Only the **external** `PostizClientService` is overridden (via `overrideProvider`); the cron route, `MarketingSyncService`, and Prisma are all real. ✅ passes (2 tests).

Verification: api typecheck clean; the two new suites run green against the live stack (3 tests total). No existing files modified, so no regression to the 54 existing suites.

---

## Journey A — HR admin — stage readiness

| # | Stage | Backend (real-stack) | Happy | Failure | FE | Verdict |
|---|-------|----------------------|:---:|:---:|:---:|---|
| 1 | Create company | auth / onboarding / journey-hr-e2e | ✅ | ✅ casing, multi-tenant, disabled-user | auth+onboarding hooks unit | **Ready** |
| 2 | Hire HR employee | onboarding / employees / journey-hr-e2e | ✅ | ⚠️ no seat/plan-limit reject for an AI employee | deriveEmployees unit | **Ready** (minor gap) |
| 3 | Connect skill | skill-config (install/connect/disconnect), skills, integrations, per-employee | ✅ | ✅ 404/409/invalid-config/OAuth-unconfigured | — | **Ready** |
| 4 | Add knowledge | knowledge, knowledge-role-scoping | ✅ upload→ingest→search + role scope | ✅ invalid category 400 | — | **Ready** (not consumed inside a run — see gaps) |
| 5 | Create workflow | workflows, workflow-lifecycle-publish, journey-hr-e2e | ✅ from scratch | ✅ cyclic/unbounded-loop/inline-secret/DB_QUERY rejected at save | canvas unit | **Ready** |
| 6 | Configure nodes | workflow-p2-nodes, node-disabled, node-position, conditions | ✅ all frozen node types | ✅ read-only-scope/disabled-trigger 400 | canvas unit | **Ready** |
| 7 | Save draft | workflow-versioning, lifecycle-publish, journey-hr-e2e | ✅ PUT /draft overwrite | ✅ ARCHIVED cannot draft | history unit | **Ready** |
| 8 | Validate | (save-time enforcement + publish gate) journey-hr-e2e | ✅ valid publishes | ✅ cyclic → 400 | publishIssues unit | **Ready** (no standalone /validate endpoint — by design) |
| 9 | Publish (freeze) | workflow-versioning, lifecycle-publish, journey-hr-e2e | ✅ immutable v1, idempotent, v2-deprecates-v1 | ✅ ARCHIVED cannot publish | publishIssues unit | **Ready** |
| 10 | Trigger run | workflows, workflow-triggers, run-controls, permissions, journey-hr-e2e | ✅ MANUAL/EVENT/WEBHOOK/SCHEDULE + idempotency | ✅ permission 403, kill-switch, bad token 404, no-steps 400 | runOverlay unit | **Ready** |
| 11 | Human approval | workflow-approval, approval-routing, approval-sla, journey-hr-e2e | ✅ WAITING→approve→resume | ✅ reject→FAILED, SLA expire, already-decided 409 | — | **Ready** |
| 12 | Complete execution | workflows, journey-hr-e2e | ✅ COMPLETED + step statuses | ✅ TERMINATE-fail, reject→FAILED | runOverlay unit | **Ready** |
| 13 | Inspect audit | audit-log, journey-hr-e2e | ✅ workflow.create read back with actor | ✅ MEMBER 403 | — | **Ready** |
| 14 | Inspect analytics | analytics, journey-hr-e2e | ✅ overview/employees/activity | ⚠️ only 401; no RBAC/tenant/empty-state | — | **Ready** (minor gap) |

## Journey B — Marketing admin — stage readiness

| # | Stage | Backend (real-stack) | Happy | Failure | Verdict |
|---|-------|----------------------|:---:|:---:|---|
| 1 | Hire MARKETING employee | p0-foundation, business-lifecycle, marketplace, contract | ✅ role persists, not CUSTOM | n/a | **Ready** |
| 2 | Connect Postiz | engines-marketing (SocialAccount + chat list_connected_accounts) | ⚠️ schema + chat only | ❌ no connect/OAuth e2e | **Partial** (external OAuth) |
| 3 | Brand knowledge | p0-foundation (MARKETING category scope) | ✅ scoped, not leaked to HR | partial | **Ready** (retrieval-as-source not asserted for MARKETING specifically) |
| 4 | Create marketing workflow | business-lifecycle, workflow-templates | ✅ | n/a | **Ready** |
| 5 | Generate content (AI step) | business-lifecycle; tool-executor unit (recommends-only) | ✅ | ✅ no-tools boundary | **Ready** |
| 6 | Request approval | business-lifecycle, workflow-tool-approval-gate | ✅ | — | **Ready** |
| 7 | Approve | business-lifecycle, workflow-tool-approval-gate | ✅ exec-once after approve | — | **Ready** |
| 8 | Schedule (`schedule_post` highRisk) | engines-marketing (flag), generic gate (stripe) | ⚠️ flag + transitive | ❌ not exercised e2e for schedule_post specifically | **Partial** |
| 9 | Publish (`publish_now` highRisk) | marketing-production | ✅ auto-pause WAITING, no publish | ✅ reject → FAILED, still no publish | **Ready** |
| 10 | Receive external status | — (Postiz webhook is a deliberate no-op) | n/a by design | n/a | **By design** (sweep is source of truth) |
| 11 | Reconcile | **journey-marketing-reconcile (new, real DB)** + marketing-sync unit + cron-route e2e | ✅ SCHEDULED→PUBLISHED (+PublishedPost) | ✅ ERROR→FAILED | **Ready** |
| 12 | Inspect execution | business-lifecycle, tool-approval-gate, inline-execution | ✅ steps + status | — | **Ready** |

State verified per stage: **frontend** (vitest unit on canvas/hooks/publishIssues), **backend** (real HTTP), **database** (Prisma row assertions — run status, AuditLog, PublishedPost, version rows), **queue** (SCHEDULE repeatable registered/removed in `workflow-triggers`; concurrent-execute-once in `workflows`; cron sweeps in `inline-execution`).

---

## Residual gaps (ranked) — genuine, not faked

1. **P2 — Browser (Playwright) E2E not executed.** No browser-level test drives the real web UI → api → DB. A ready-to-run harness is in the appendix; it was **authored, not executed**, because a true browser run needs web (:3200) + api (:4000) + infra all live plus a one-time browser download — not runnable/verifiable in this non-interactive session. Do **not** report it as passing until run.
2. **P2 — `postiz.schedule_post` highRisk gate not exercised e2e** (only the catalog flag + the generic gate via stripe/publish_now). Add a schedule_post variant of the marketing-production gate test.
3. **P3 — Knowledge is never consumed inside a run.** Upload/ingest/search + chat retrieval are covered; no RETRIEVE-node test asserts a run grounding on a KB doc (hard to assert deterministically with hash embeddings).
4. **P3 — Analytics failure coverage thin** (401 only; no RBAC/tenant-isolation/empty-state).
5. **P3 — AI-employee hire failure paths** (seat/plan-limit/invalid-role) not asserted.
6. **P2 — "Connect Postiz" has no connect/OAuth e2e** (external OAuth boundary).

## Documented real-executor residuals (NOT test gaps — require live Postiz, per marketing-production-verification.md)
`publish_now` is fire-and-forget (no local row → immediate-publish rejection invisible); no publish idempotency; expired/shared-key handling + brittle error classification; per-company vs Postiz instance-wide rate cap. These live in the real Postiz executor and cannot be exercised under `SKILL_EXECUTOR=mock` — a mock test would be theatre, so none was written.

---

## Verdict
**Both journeys are E2E-ready at the backend/database/queue layer**, now including the two previously-missing spines (from-scratch HR build→run→audit→analytics; real-DB Postiz reconciliation), with happy and failure paths. **Frontend is unit-covered but has no browser E2E yet** — that is the single open readiness item, with a ready-to-run Playwright harness below.

---

## Appendix — Playwright harness (drop-in, then run)

Setup (one-time): `pnpm --filter @vaep/web add -D @playwright/test && pnpm --filter @vaep/web exec playwright install chromium`. Run with infra + api up (`pnpm --filter @vaep/api start` on :4000) via `pnpm --filter @vaep/web exec playwright test`.

**`apps/web/playwright.config.ts`**
```ts
import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  use: { baseURL: 'http://localhost:3200', trace: 'on-first-retry' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // Starts the real web app; the api (:4000) + infra must already be running —
  // NO internal Orlixa API is mocked, only external skill providers are sandboxed
  // by the api's SKILL_EXECUTOR=mock env.
  webServer: { command: 'pnpm build && pnpm start', url: 'http://localhost:3200', reuseExistingServer: true, timeout: 120_000 },
});
```

**`apps/web/e2e/journey-a-hr.pw.spec.ts`** (critical journey; register → build → publish → run → approve → complete)
```ts
import { expect, test } from '@playwright/test';
test('HR admin builds, publishes, runs and approves a workflow', async ({ page }) => {
  const email = `pw_${Date.now()}@ex.com`;
  await page.goto('/register');
  await page.getByLabel(/company/i).fill('PW Co');
  await page.getByLabel(/^name/i).fill('Owner');
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).fill('password123');
  await page.getByRole('button', { name: /create|register|sign up/i }).click();
  await page.waitForURL(/dashboard|onboarding/);
  // Open the AI Assist landing and start a build (real /assist → /workflows/generate).
  await page.goto('/assist');
  await page.getByLabel(/describe the workflow/i)
    .fill('When HR gets a new hire, summarise it and ask a manager to approve before notifying Slack.');
  await page.getByRole('button', { name: /generate/i }).click();
  await page.waitForURL(/\/assist\//);
  // The staged rail should appear and the canvas should populate as it builds.
  await expect(page.getByRole('navigation', { name: /build progress/i })).toBeVisible();
  // (Continue: accept → open builder → publish → run → approve, asserting statuses.)
});
```
Note: selectors above are indicative and must be reconciled with the shipped DOM/`aria-label`s before the spec is green — that reconciliation is part of executing this harness, which this pass did not run.
