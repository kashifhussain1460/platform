# Orlixa — Current System Inventory

**Built:** 2026-09-02
**Commit audited:** `00552e4` (master, working tree clean apart from `.claude/worktrees/`)
**Method:** read from the running system, not from documentation. Route list extracted from the
NestJS boot log of a live API; model list from `schema.prisma`; migration count cross-checked
against `_prisma_migrations` in the live database.

This file is the raw map. Findings and judgements live in
[ORLIXA_FINAL_DEEP_PRODUCTION_AUDIT.md](ORLIXA_FINAL_DEEP_PRODUCTION_AUDIT.md).

---

## 1. Repository shape

```
d:\Vertical AI\                     ← proposal/brand assets (not code)
└── platform\                       ← the product (its own git repo)
    ├── apps\api                    NestJS + Prisma + Postgres + BullMQ
    ├── apps\web                    Next.js App Router
    ├── packages\types              @vaep/types — shared DTOs (built CommonJS)
    ├── packages\config
    ├── e2e\                        Playwright browser suite
    ├── infra\                      docker-compose (postgres/redis/minio/adminer/jaeger/prometheus/grafana)
    ├── poc\workflow-sdk            302 MB dead proof-of-concept (verdict: do not adopt)
    ├── scripts\                     preflight, smoke test, seeds, edge-case scripts
    └── docs\                        142 markdown files
```

## 2. Size

| Area | Lines |
|---|---:|
| `apps/api/src` | 28,824 |
| `apps/api/test` | 25,980 |
| `apps/web/src` | 40,197 |
| `packages/*` | 10,044 |
| `e2e/tests` | 828 |

| Thing | Count |
|---|---:|
| Prisma models | 82 |
| Prisma enums | 40 |
| Migrations on disk / applied in DB | 64 / 64 |
| NestJS modules | 41 (+5 common/config) |
| Controllers | 54 |
| HTTP routes mapped at boot | 217 |
| Queue processors / workers | 15 |
| Cron job endpoints | 18 |
| Web page routes | 48 (26 app, 22 marketing/public) |
| Web feature folders | 22 |

## 3. API modules

`admin` · `analytics` · `approval-routing` · `approvals` · `assist` · `audit` · `auth` ·
`authorization` · `billing` (+ `platform-admin`) · `credits` · `employees` (+ `llm`, `runtime`) ·
`engines/marketing` · `engines/pm` · `engines/support` · `events` (+ `ingestion`, `inbound`,
`reconciliation`) · `handoff` · `health` · `hr` · `knowledge` · `mail` · `marketing` ·
`marketing-workspace` · `marketplace` · `notifications` · `onboarding` · `organization` ·
`product-context` · `retention` · `scheduling` · `skills` (+ `connectors`, `oauth`, `providers`,
`executors`) · `tenant` · `usage` · `users` · `workflow-permissions` · `workflow-runtime` ·
`workflow-templates` · `workflows`

Common: `crypto` (AES-GCM), `observability` (OpenTelemetry + metrics registry + structured
logger), `prisma`, `resilience` (circuit breaker, retry classifier, rate limiter, DLQ), `config`.

## 4. Web page routes

**App (authenticated, 26):** `/dashboard` · `/employees` · `/employees/[id]` · `/skills` ·
`/knowledge` · `/workflows` · `/workflows/new` · `/workflows/[id]` · `/workflows/[id]/runs` ·
`/workflows/[id]/versions` · `/workflows/templates` · `/runs` · `/runs/[runId]` · `/schedules` ·
`/approvals` · `/assist` · `/assist/[sessionId]` · `/marketing` · `/marketing/campaigns/[id]` ·
`/marketplace` · `/billing` · `/billing/usage` · `/team` · `/organization` · `/scheduling` ·
`/admin/health` · `/onboarding`

**Auth (6):** `/login` · `/register` · `/verify-email` · `/forgot-password` ·
`/reset-password` · `/account-locked`

**Public marketing (16):** `/` · `/about` · `/pricing` · `/security` · `/demo` ·
`/contact-sales` · `/automation` · `/ai-employees` (+ `/[slug]`) · `/integrations`
(+ `/[slug]`) · `/careers` (+ `/[slug]`) · `/privacy-policy` · `/terms-of-service`

**Missing entirely:** no HR page, no support-conversation page, no audit page of its own
(audit lives inside `/organization`), no platform-operator console.

## 5. Database model groups

| Group | Models |
|---|---|
| Tenant & identity | `Company` `User` `RefreshToken` `PasswordResetToken` `Department` `Team` `SecurityPolicy` `PlatformOperator` |
| AI Employee | `AiEmployee` `Conversation` `Message` `EmployeeMemory` `EmployeeFeedback` `EmployeeSkill` `EmployeeCreditPeriodCounter` |
| Knowledge | `KnowledgeDocument` `KnowledgeChunk` (pgvector 384, HNSW) |
| Skills & connectors | `InstalledSkill` `SkillExecution` `OAuthAuthorizationRequest` `ToolIdempotencyRecord` |
| Workflow authoring | `Workflow` `WorkflowVersion` `WorkflowTemplate` `WorkflowVariable` `WorkflowSecretRef` `WorkflowPermission` |
| Workflow execution | `WorkflowRun` `WorkflowStepRun` `WorkflowStepAttempt` `WorkflowRunTimer` `WorkflowJoinState` `RunEventOutbox` |
| Approvals | `ApprovalRequest` |
| Events | `RawEvent` `CanonicalEvent` `ProcessedWebhookEvent` |
| Credits & billing | `Subscription` `CompanyCreditBalance` `CreditLedger` `CreditLot` `CreditLotConsumption` `CreditReservation` `CreditPack` `CreditRefund` `CreditUsageDailyRollup` `ModelCostRate` `ToolCostRate` `EnterpriseCreditAgreement` `ProviderInvoice` `ReconciliationRun` `ReconciliationDiscrepancy` `UsageEvent` |
| HR domain | `StaffMember` `LeaveRequest` `StaffDocument` `PerformanceReview` `OnboardingTask` `AttendanceRecord` `InterviewSlot` |
| Marketing domain | `Campaign` `ContentItem` `CreativeVariant` `ScheduledPost` `PublishedPost` `SocialAccount` `BrandAsset` `MediaAsset` `MarketingAnalyticsSnapshot` `MarketingConsent` `MarketingSuppression` |
| Support / PM engines | `SupportConversation` `SupportMessage` `HandoffRequest` `ChatwootAccount` `PlaneWorkspace` `PlaneProject` `TrackedIssue` |
| AI Assist | `AssistSession` `AssistMessage` |
| Governance | `AuditLog` `LegalHold` |

## 6. Workers and queues

| Processor | Purpose |
|---|---|
| `workflow.processor` | legacy graph-walk run execution |
| `run-advance.processor` | durable engine — decide next node |
| `node-attempt.processor` | durable engine — perform one effect |
| `timer.processor` | durable engine — WAIT/timer resume |
| `ingestion.processor` | knowledge extract → chunk → embed |
| `event-normalize.processor` | RawEvent → CanonicalEvent |
| `gmail-inbound.processor` | Gmail polling |
| `imap-inbound.processor` | IMAP polling |
| `connector-reconcile.processor` | connector drift reconciliation |
| `connector-health.processor` | connector health probe |
| `approval-sla.processor` | approval breach → escalate / timeout |
| `credit-reservation-sweep.processor` | release leaked credit holds |
| `hr-retention.processor` | prune HR satellite records |
| `marketing-sync.processor` | Postiz/social sync |
| `campaign-generation.processor` | AI campaign planning state machine |

## 7. Cron endpoints (`/admin/cron/:job`, shared-secret auth)

`campaign-generation` · `workflow-schedules` · `workflow-watchdog` · `approval-sla` ·
`hr-retention` · `audit-retention` · `data-retention` · `alerts` · `gmail-poll` ·
`connector-reconcile` · `marketing-sync` · `marketing-analytics` · `imap-poll` ·
`credit-reservation-sweep` · `subscription-credit-renewal` ·
`enterprise-credit-agreement-renewal` · `credit-reconciliation` · `credit-finance-rollup`

All 18 schedules are defined in `apps/api/vercel.crons.json` — a **sidecar file Vercel does not
read**. `apps/api/vercel.json` has no `crons` key.

## 8. External integrations (skill catalog, 15 skills)

| Skill | Real executor coverage |
|---|---|
| `slack` | PARTIAL — `send_message` only |
| `email` (SMTP/IMAP) | PARTIAL — `send_email` only |
| `gmail` | PARTIAL — `send_email` only |
| `calendar` | PARTIAL — `create_event` only |
| `gdrive` | REAL — 5 tools |
| `http` | REAL |
| `scheduling` | PARTIAL — `claim_slot`, `reschedule_slot` |
| `postiz` | REAL — 5 tools (engine not deployed) |
| `chatwoot` | REAL — 4 tools (engine not deployed) |
| `plane` | REAL — 3 tools (engine not deployed) |
| `marketing` | PARTIAL — `check_consent` only |
| `stripe` | **NONE** |
| `github` | **NONE** |
| `hubspot` | **NONE** |
| `jira` | **NONE** |

Verify-before-connect adapters exist for 5 providers only: `gmail`, `calendar`, `gdrive`,
`slack`, `smtp`.

## 9. Feature flags and provider switches

| Variable | Default | Effect when default |
|---|---|---|
| `LLM_PROVIDER` | `mock` | offline deterministic model |
| `LLM_MODEL` | `gpt-5.6-terra` / `claude-sonnet-5` | per provider |
| `SKILL_EXECUTOR` | `mock` | every tool sandboxed; refuses to boot on `mock` in production |
| `BILLING_PROVIDER` | `mock` | no Stripe |
| `EMBEDDINGS_PROVIDER` | `hash` | offline embeddings |
| `STORAGE_PROVIDER` | `local` | local disk |
| `MAIL_ENABLED` | **`false`** | **every OTP is the fixed `123456`** |
| `WORKFLOW_EXECUTION_MODE` | `queue` | production sets `inline` |
| `WORKFLOW_ENGINE_MODE` | `state_machine` | **forced to `legacy_walk` whenever execution is inline** |
| `QUEUE_WORKERS_ENABLED` | on | production sets `false` |
| `CREDIT_LEDGER_ENABLED` | **`false`** | no reservation, no ledger entry, no debit |
| `CREDIT_GRANTS_ENABLED` | **`false`** | no free signup credits |
| `CREDIT_PAYG_ENABLED` | **`false`** | credit purchase returns "not available" |
| `CREDIT_ENFORCEMENT_ENABLED` | **`false`** | nothing is ever blocked for lack of credits |
| `CRON_SECRET` | unset | **unset disables every `/admin/cron/*` route** |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset | tracing inert |
| `NEXT_PUBLIC_SIMPLIFIED_WORKFLOW_UX` | on | Describe → Review → Publish → Runs |
| `AUTH_THROTTLE_LIMIT` | 10/min/IP | |

## 10. Execution entry points for a workflow run

| Entry point | Path |
|---|---|
| Manual | `POST /workflows/:id/run` |
| Schedule | BullMQ repeatable (queue mode) **or** `/admin/cron/workflow-schedules` (inline mode) |
| Webhook | `POST /workflows/webhooks/:token` (public, no JWT) |
| Event | `fireEvent` from `CanonicalEvent` normalisation |
| Retry | `POST /workflows/runs/:id/retry` (starts a fresh run) |
| Assist dry-run | scratch workflow created by AI Assist |

Two engines can execute any of these: the legacy graph-walk and the durable state machine.

## 11. Test assets

| Suite | Command | Result observed 2026-09-02 |
|---|---|---|
| API unit | `pnpm --filter @vaep/api run test:unit --maxWorkers=2` | **103 suites / 1015 tests pass**, 13 s |
| API e2e (durable) | `WORKFLOW_ENGINE_MODE=state_machine npx jest -c test/jest-e2e.json --forceExit` | **101 suites / 745 tests pass**, 207 s |
| API e2e (legacy) | `WORKFLOW_ENGINE_MODE=legacy_walk …` | **744 pass / 1 fail**, 194 s (flaky cross-tenant sweep test) |
| Browser E2E | `cd e2e && npx playwright test` | **8 / 8 pass**, 66 s |
| Web unit | `pnpm --filter @vaep/web test` | not run this session |

Provider env must be pinned per run (`LLM_PROVIDER=mock` etc.). Running the e2e suite without
pinning produces 78 failures that are purely configuration, not product defects.

## 12. CI / deployment

| Workflow | Purpose |
|---|---|
| `api-ci.yml` | unit + e2e, matrix over both engine modes |
| `web-ci.yml` | lint, typecheck, web unit |
| `browser-e2e.yml` | Playwright against a real stack |
| `deploy.yml` | preflight config gate → tests → migrations → deploy → smoke test |

`scripts/preflight-env.mjs` is the production config gate. It hard-fails on
`MAIL_ENABLED != true`, `DEV_OTP_CODE` set, mock providers, missing `CRON_SECRET`, and the
`QUEUE_WORKERS_ENABLED`/`WORKFLOW_EXECUTION_MODE` mismatch. It does **not** check any credit
flag and does **not** check that crons are registered.
