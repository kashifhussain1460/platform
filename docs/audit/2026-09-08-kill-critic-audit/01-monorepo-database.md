# Cluster 1 — Monorepo + Database + Mock/Dead Table Audit

Source: Explore agent research pass, 2026-09-08. Evidence hierarchy: executable code > schema > docs. All paths relative to `d:/Vertical AI/platform` unless noted.

---

## A. Monorepo + Module Inventory

Confirmed by reading `apps/api/src/app.module.ts:1-104` in full.

### A.1 Backend modules (`apps/api/src/modules/*`)

Every module directory under `modules/*` **is** reachable from `AppModule` — either directly in the `imports:` array (`app.module.ts:46-92`) or transitively through another imported module. **No orphan module directories found.**

| Module | Purpose | In `app.module.ts`? | Consumers (who imports it) | Worker/queue/cron |
|---|---|---|---|---|
| admin | Cron dispatch (`/admin/cron/:job`), DLQ, metrics, `platform-sweeps` queue for jobs with no dedicated driver | Direct (`app.module.ts:91`) | — (top-level) | `platform-sweeps.processor.ts` (BullMQ) + `cron.controller.ts` (Vercel Cron HTTP) |
| analytics | KPI/dashboard aggregation | Direct (`:80`) | — | none |
| approval-routing | Pure resolver: routing rule → assignee (leaf, Prisma-only) | **Not direct** | `workflows.module.ts:3,72`, `handoff.module.ts:2,14`, `approvals.module.ts:4,31` | none |
| approvals | Approval Center (TOOL/WORKFLOW kinds), SLA sweep | Direct (`:79`) | — | `approvals/sla/approval-sla.processor.ts` (queue) |
| assist | Conversational workflow-builder agent (AI Assist) | Direct (`:85`) | — | none (SSE-based, `assist/sse/`) |
| audit | Hash-chained `AuditLog`, legal hold, retention | Direct (`:61`) | — | none apparent (retention sweep is a service, not a `@Processor`) |
| auth | Register/login/refresh/OTP | Direct (`:63`) | — | none |
| authorization | Global policy/guard layer (RBAC + security policy) | Direct (`:60`) | — | none |
| billing | Subscriptions, Stripe webhooks, plans | Direct (`:81`) | imports `NotificationsModule`, `CreditsModule`, `PlatformAdminModule` (`billing.module.ts:4,47`) | none |
| credits | Credit ledger/reservation/balance/reconciliation | Direct (`:82`) | — | `credit-reservation-sweep.processor.ts` (queue) |
| employees | `AiEmployee` CRUD + agent runtime | Direct (`:67`) | — | none |
| engines/marketing, engines/support, engines/pm | Postiz/Chatwoot/Plane integration adapters | Direct — `MarketingModule`(`:72`), `SupportModule`(`:74`), `PmModule`(`:75`) | — | `engines/marketing/marketing-sync.processor.ts` (queue) |
| engines/whatsapp | Twilio WhatsApp connector | **Not direct** | `skills.module.ts:33,128` | none |
| events | Connector webhook ingestion → CanonicalEvent → `fireEvent` | Direct (`:78`) | — | `event-normalize.processor.ts`, `imap-inbound.processor.ts`, `gmail-inbound.processor.ts`, `connector-reconcile.processor.ts` (all queue) |
| handoff | AI→human conversation escalation | Direct (`:69`) | imports `ApprovalRoutingModule`, `NotificationsModule` (`handoff.module.ts:2-3,14`) | none |
| health | `/health` | Direct (`:48`) | — | none |
| hr | Staff records (roster/leave/reviews/onboarding/attendance), PII encryption | Direct (`:88`) | — | `hr-retention.processor.ts` (queue) |
| knowledge | RAG upload/ingest/search (pgvector) | Direct (`:66`) | — | `knowledge/ingestion/ingestion.processor.ts` (queue) |
| leads | WhatsApp-sourced lead capture/qualification | Direct (`:89`) | — | none |
| mail | OTP/notification email sending | **Not direct** | `auth.module.ts:10,20`, `notifications.module.ts:2,13` | none |
| marketing (workspace) | Marketing-employee campaign planning/generation | Direct as `MarketingWorkspaceModule` (`:73`) | — | `marketing/generation/campaign-generation.processor.ts` (queue) |
| marketplace | Code-catalog install (employees/workflows/skills) | Direct (`:83`) | — | none |
| notifications | Thin notification fork (wraps `MailModule`) | **Not direct** | `billing.module.ts`, `workflows.module.ts`, `handoff.module.ts`, `onboarding.module.ts`, `approvals.module.ts`, `users.module.ts` | none |
| onboarding | Registration wizard, employee hiring flow | Direct (`:68`) | imports `EmployeesModule`, `NotificationsModule`, `CreditsModule`, `BillingModule` (`onboarding.module.ts:4,18`) | none |
| organization | Departments/Teams/SecurityPolicy | Direct (`:86`) | — | none |
| product-context | Role-scoped dashboard composition/capability resolution | Direct (`:87`) | — | none |
| retention | Data retention sweep | Direct (`:90`) | — | none apparent (`data-retention.service.ts` is a plain service; invoked via `/admin/cron` per CLAUDE.md) |
| scheduling | Interview-slot pool (bulk hiring) | Direct (`:70`) | — | none |
| skills | Skill catalog/install/execution, OAuth, executors | Direct (`:71`) | imports `WhatsappModule` (`:33,128`) | `skills/connectors/connector-health.processor.ts` (queue) |
| tenant | Company profile CRUD | Direct (`:65`) | — | none |
| usage | LLM `UsageEvent` cost tracking | Direct (`:62`) | — | none |
| users | Team/RBAC management (`/team`) | Direct (`:64`) | imports `AuthModule`, `NotificationsModule` (`users.module.ts:3,14`) | none |
| workflow-permissions | Per-workflow VIEW/EDIT/RUN/etc grants (leaf, Prisma-only) | **Not direct** | `workflows.module.ts:5,74` | none |
| workflow-runtime | Durable state-machine engine (P1) | Direct (`:77`) | — | `node-attempt.processor.ts`, `run-advance.processor.ts`, `timer.processor.ts`, `reaper.service.ts` (all queue) |
| workflow-templates | First-party + tenant-authored workflow blueprints | Direct (`:84`) | — | none |
| workflows | Workflow CRUD, versions, legacy engine | Direct (`:76`) | imports `ApprovalRoutingModule`, `NotificationsModule`, `WorkflowPermissionsModule` (`workflows.module.ts:3-5,72-76`) | `workflows/engine/workflow.processor.ts` (queue, `legacy_walk` mode) |

**Orphan check result:** zero module directories exist without a consumer. `approval-routing`, `workflow-permissions`, `notifications`, `mail`, and `engines/whatsapp` are the five modules NOT listed directly in `AppModule.imports` — each was traced to a real importing module above (Grep evidence: `apps/api/src/modules/workflows/workflows.module.ts:3-5,72-76`, `apps/api/src/modules/handoff/handoff.module.ts:2-3,14`, `apps/api/src/modules/approvals/approvals.module.ts:4-5,31-32`, `apps/api/src/modules/billing/billing.module.ts:4,47`, `apps/api/src/modules/onboarding/onboarding.module.ts:4,18`, `apps/api/src/modules/users/users.module.ts:3,14`, `apps/api/src/modules/auth/auth.module.ts:10,20`, `apps/api/src/modules/notifications/notifications.module.ts:2,13`, `apps/api/src/modules/skills/skills.module.ts:33,128`).

### A.2 Frontend (`apps/web/src/app/(app)/*` and `apps/web/src/features/*`)

Route groups under `app/(app)`: admin, approvals, assist, billing, dashboard, employees, hr, knowledge, leads, marketing, marketplace, onboarding, organization, runs, schedules, scheduling, skills, team, workflows.

Feature dirs under `features/*`: admin, analytics, approvals, assist, auth, billing, employees, events, handoffs, hr, knowledge, leads, marketing, marketplace, onboarding, organization, product-context, runs, schedules, scheduling, skills, tenant, users, whatsapp, workflows.

Notable asymmetries (not deep-traced into routing, flagged for follow-up): `features/analytics`, `features/events`, `features/handoffs`, `features/tenant`, `features/whatsapp`, `features/users` have **no same-named top-level route folder** under `app/(app)/*` — presumably consumed as sub-panels of other pages (`team`→users, `dashboard`→analytics/product-context, employee pages→whatsapp/handoffs) rather than orphaned; not independently verified per-import-site (effort budget), treat as a lead not a finding.

---

## B. Database Complete Snapshot

Source: full read of `apps/api/prisma/schema.prisma` (2872 lines).

### Auth / Tenant
- **Company** (`:261-348`) — the tenant. Every domain table carries `companyId`. Nullable-but-load-bearing: `onboardedAt` (drives onboarding gating), `creditEnforcementEnabledAt` (per-company credit canary), `postizCustomerGroupId` (marketing tenancy bridge — null blocks account import by design).
- **User** (`:559-603`) — `@@unique([companyId, email])`. `departmentId`/`teamId`/`managerUserId` (all `SetNull`) feed approval routing.
- **PasswordResetToken** / **RefreshToken** (`:609-636`) — token-hash stores, `Cascade` on `User` delete.
- **Department** / **Team** (`:1609-1651`) — `Team.departmentId` is `SetNull`. `Department.scopes: String[]` (default `[]`) — an authorization gap-closer that ships inert (empty = unrestricted).
- **SecurityPolicy** (`:1653-1666`) — 1:1 per company; most fields (`mfaRequired`, `sessionTimeoutMinutes`, `allowedEmailDomains` beyond registration) documented in the schema itself as stored-only/enforcement-TODO (`:1607`) — not independently re-verified this pass.
- **PlatformOperator** (`:479-485`) — separate identity axis, no relation to `Company`/`User` (confirmed active, see §C).

### AI Employee runtime
- **AiEmployee** (`:687-744`) — soft-delete via `archivedAt` (hard delete is OWNER-gated, `:723-729`). `maxCreditsPerExecution`/`maxCreditsPerTask` explicitly commented **"inert until [credit enforcement] phase"** (`:709-713`) — matches the credit-flag finding in §C.
- **Conversation** (`:746-758`) — `@@index([companyId])` only; no index on `employeeId` (index gap candidate).
- **Message** (`:760-779`) — `idempotencyKey` nullable, `@@unique([conversationId, idempotencyKey])` (partial-unique by NULL semantics).
- **EmployeeMemory** (`:781-794`) — `@@index([companyId])` only, no `employeeId` index despite being filtered by employee (index gap candidate).
- **EmployeeFeedback** (`:799-813`) — 👍/👎 + correction, feeds `EmployeeMemory` (source=`FEEDBACK`).

### Skills
- **InstalledSkill** (`:821-861`) — `@@unique([companyId, skillKey, employeeId])`, `employeeId` nullable = company-wide connection. `credentials Json?` encrypted at rest.
- **EmployeeSkill** (`:863-875`) — join table, `@@unique([employeeId, installedSkillId])`.
- **SkillExecution** (`:877-897`) — audit log of tool calls. `@@index([companyId])` only — no `employeeId` index (index gap candidate).

### Knowledge / RAG
- **KnowledgeDocument** (`:643-663`) — `category EmployeeRole?` nullable = shared/company-wide (load-bearing null).
- **KnowledgeChunk** (`:665-681`) — `embedding Unsupported("vector(384)")?`, HNSW index outside Prisma's model (raw SQL migration). `@@index([companyId])` only.

### Workflow
- **Workflow** (`:905-981`) — dual-track versioning: legacy `definition Json` (still read under `WORKFLOW_ENGINE_MODE=legacy_walk`) alongside `activeVersionId`/`draftVersionId` → `WorkflowVersion`. `ownerUserId` nullable (pre-P3-06 rows). `isAssistScratch` (throwaway drafts).
- **WorkflowVersion** (`:2321-2344`) — immutable-once-PUBLISHED is **service-layer enforced only, not DB-enforced** (comment `:2315-2317` — service check itself not independently re-verified).
- **WorkflowRun** (`:983-1080`) — `actingEmployeeId` explicitly documented **"was a dead column until 2026-09-03"** (`:1030-1034`) — now real FK + index (`@@index([companyId, actingEmployeeId, createdAt])`, `:1079`).
- **WorkflowStepRun** (`:1082-1122`) — comment documents a real prior perf bug: `runId` had no index despite being polled ~1/s per open run; now `@@index([runId])` + `@@index([runId, status])`.
- **WorkflowStepAttempt**, **WorkflowRunTimer**, **WorkflowJoinState**, **RunEventOutbox**, **WorkflowVariable**, **WorkflowSecretRef** (`:2349-2502`) — durable-engine internals.
- **WorkflowTemplate** (`:2645-2675`) — `companyId` nullable = first-party (seeded on boot) vs tenant-authored.
- **WorkflowPermission** (`:2685-2703`) — see §C, backend-complete/no-frontend finding.

### Approvals
- **ApprovalRequest** (`:1130-1192`) — dual-kind (`TOOL`/`WORKFLOW`). Routing/chain columns nullable — `null approverRuleType` = legacy-unrouted fallback to OWNER/ADMIN. `@@index([status, dueAt])` deliberately not tenant-prefixed for the cross-tenant SLA sweep.

### Billing / Credits
- **Subscription** (`:1201-1223`) — `lastAppliedEventId`/`lastAppliedEventCreatedAt` guard against out-of-order webhook replays.
- **CreditLedger** (`:1247-1311`) — insert-only ledger, `@@unique([companyId, idempotencyKey])` anti-double-charge constraint.
- **CreditLot** / **CreditLotConsumption** (`:1317-1353`) — per-grant shrinking-pool model.
- **CompanyCreditBalance** (`:1358-1372`) — materialized cache, can legitimately go negative (documented).
- **CreditReservation** (`:1380-1414`) — reserve→execute→settle hold, `leaseExpiresAt` for reaper cleanup.
- **CreditRefund**, **ProcessedWebhookEvent**, **ModelCostRate**, **ToolCostRate**, **CreditPack**, **EnterpriseCreditAgreement**, **EmployeeCreditPeriodCounter** (`:1420-1601`) — the schema comments (`:1225-1242`) call this domain **"deliberately INERT in Phase 1"** — **this is stale/wrong**, see §C.
- **ReconciliationRun**, **ReconciliationDiscrepancy**, **ProviderInvoice**, **CreditUsageDailyRollup** (`:490-557`) — confirmed active in §C.

### HR
- **StaffMember** (`:2522-2551`) — only model with a formal `Company` relation; 5 satellites carry a plain `companyId`. Several 🔒 fields are application-layer encrypted, not DB-enforced.

### Marketing
- **SocialAccount, Campaign, ContentItem, CreativeVariant, ScheduledPost, PublishedPost, MediaAsset, BrandAsset, MarketingAnalyticsSnapshot** (`:1781-2071`) — Postiz-backed; `ScheduledPost.idempotencyKey` closes a documented real duplicate-publish bug.
- **MarketingSuppression, MarketingConsent** (`:2831-2872`) — deliberately separate models.

### Support / PM / Lead / WhatsApp
- **ChatwootAccount, SupportConversation, SupportMessage, HandoffRequest** (`:2073-2230`) — `SupportConversation` has a hardened `@@unique([companyId, chatwootConversationId])` closing a documented TOCTOU race.
- **PlaneWorkspace, PlaneProject, TrackedIssue** (`:2264-2305`).
- **Lead** (`:2125-2144`) — `@@unique([companyId, source, phone])`; `source` enum currently has only `WHATSAPP`.
- **WhatsAppAccount** (`:2106-2123`) — `employeeId` nullable = company-wide.

### Audit / Legal / Idempotency
- **AuditLog** (`:355-401`) — hash-chained (`previousHash`/`eventHash`), `@@unique([companyId, seq])`. No FK to `User` (survives user deletion, by design).
- **LegalHold** (`:426-441`, mapped table `AuditLegalHold`).
- **ToolIdempotencyRecord** (`:2245-2262`) — generic dedup primitive, confirmed single writer, zero frontend surface (by design — internal guard).
- **OAuthAuthorizationRequest** (`:2795-2816`) — one-time PKCE state row, closes a documented replay vulnerability.

---

## C. Mock/Unused/Dead Database Table Audit

Methodology: grepped `apps/api/src` for `\b(prisma|tx)\.<model>\.\w+\(`, excluding `*.spec.ts` from the "real flow" determination, cross-checked `apps/web/src` for consumption.

**Tooling gotcha:** a narrow first-pass regex returned zero matches for `ReconciliationRun`/`ReconciliationDiscrepancy`/`ProviderInvoice`/`CreditUsageDailyRollup`/`PlatformOperator`, which would have wrongly classified 5 tables UNUSED. A broader second pass found them all actively used. **Any future dead-table sweep in this repo should always re-run a "no matches" result with a more permissive pattern before concluding UNUSED** — the failure mode here is under-reporting usage, not over-reporting.

| Table | Classification | Evidence |
|---|---|---|
| Company | ACTIVE | `auth.service.ts` (register), `tenant.service.ts`, `onboarding.service.ts`. Frontend: `/companies/current`. |
| User | ACTIVE | `auth.service.ts`, `users.service.ts`, `jwt.strategy.ts`, `authorization.service.ts` (12 files). Frontend: `/team`. |
| AiEmployee | ACTIVE | 27 files incl. `employees.service.ts`, `agent-runtime.service.ts`, `workflow-engine.service.ts`. Frontend: `features/employees/api.ts:17-45`. |
| InstalledSkill | ACTIVE | 23 files incl. `skills.service.ts`, `whatsapp-accounts.service.ts`, `assist-read-tools.ts`, `approval-gate.service.ts`. Frontend: `features/skills`. |
| EmployeeSkill | ACTIVE | `skills.service.ts` (single-purpose join table, expected). |
| KnowledgeDocument | ACTIVE | `knowledge.service.ts`, `ingestion.processor.ts`. Frontend: `features/knowledge/api.ts`. |
| KnowledgeChunk | ACTIVE | Written by `ingestion.processor.ts`, read via raw SQL in `knowledge.service.ts` + `retrieve.handler.ts` + `data-retention.service.ts`. |
| EmployeeMemory | ACTIVE | `memory.service.ts`, `learning.service.ts`, `workflows/engine/nodes/memory.handlers.ts`. Frontend: `features/employees/api.ts:104-125`. |
| Workflow | ACTIVE | 13 files incl. `workflows.service.ts`, `cron.controller.ts`, `assist.service.ts`. Frontend: `features/workflows/api.ts`. |
| WorkflowVersion | ACTIVE (narrow) | Only `workflows/workflow-version.service.ts` — but that's its entire responsibility, not a red flag. |
| WorkflowRun | ACTIVE | 13 files incl. `run-advance.processor.ts`, `reaper.service.ts`, `credit-reconciliation.service.ts`. Frontend: `/runs`. |
| WorkflowStepRun | ACTIVE (narrow) | `assist-test-tool.ts`, `workflow-engine.service.ts`, `run-advance.processor.ts` — matches "per-node audit row" purpose. |
| ApprovalRequest | ACTIVE | `approval.service.ts`, `workflow-engine.service.ts`, `approval-gate.service.ts`, `approval-sla.service.ts`. Frontend: `/approvals`. |
| CreditLedger | **ACTIVE but feature-flag-gated in production** | Written by `credit-ledger.service.ts`, `credit-refund.service.ts`, `credit-reconciliation.service.ts`. Grant/enforcement paths gated by `CREDIT_GRANTS_ENABLED`/`CREDIT_ENFORCEMENT_ENABLED` (`common/config/credit-config.ts:29,72`), both default false — so a default deployment has this table empty-but-valid, not dead. **Contradicts schema's own "deliberately INERT" comment — comment is stale.** |
| UsageEvent | ACTIVE | Single writer `usage.service.ts` (by design). |
| Lead | ACTIVE | `leads.service.ts`, `whatsapp-webhook.controller.ts`. Frontend: `features/leads/api.ts`, `LeadsList.tsx`. |
| WhatsAppAccount | ACTIVE | `whatsapp-webhook.controller.ts`, `whatsapp-engine.adapter.ts`, `whatsapp-accounts.service.ts`. Frontend: `features/whatsapp/api.ts`. |
| ToolIdempotencyRecord | ACTIVE, backend-only by design | Single writer `common/idempotency/tool-idempotency.service.ts`. Zero frontend references (correct — internal guard, not a defect). |
| **WorkflowPermission** | **PARTIALLY USED — backend-complete, no frontend surface** | Full CRUD in `workflow-permissions.service.ts` + `.controller.ts`, enforced at enqueue. Grepped `apps/web/src` for `workflow-permissions\|WorkflowPermission\|/permissions` — **zero matches**. Real gap: RUN-gating security feature is live server-side, no UI to grant/revoke. |
| WorkflowTemplate | ACTIVE | `product-context.service.ts`, `workflow-templates.service.ts`, `assist-read-tools.ts`. Frontend: `/marketplace` + template browsing. |

### Credit-system tables flagged "inert" by schema comments — verified independently active

| Table | Classification | Evidence |
|---|---|---|
| CreditReservation | ACTIVE | `credit-reservation.service.ts:114,153,246,250,300,418,426,451`, `credit-reservation-sweep.service.ts`, `reaper.service.ts`. |
| CompanyCreditBalance | ACTIVE | `credit-balance.service.ts` + one-off migration scripts (`scripts/verify-credit-migration.ts`, `scripts/backfill-credit-balances.ts`, not product-flow). |
| CreditLot / CreditLotConsumption | ACTIVE | `credit-refund.service.ts` (consumption); lot-tracking in `credit-reservation.service.ts`'s settle path (moderate confidence, not independently re-grepped for `.create` on CreditLot itself). |
| ModelCostRate / ToolCostRate | ACTIVE | `credit-rate-admin.service.ts` — single-owner admin table. |
| CreditPack | ACTIVE | `billing.service.ts`, `billing/credit-packs.ts`. |
| EnterpriseCreditAgreement | ACTIVE | `credits/enterprise-credit-agreement.service.ts`. |
| EmployeeCreditPeriodCounter | ACTIVE | `credits/credit-limits.service.ts`. |
| ProcessedWebhookEvent | ACTIVE | `billing.service.ts:267` — Stripe-webhook dedup. |
| ReconciliationRun / ReconciliationDiscrepancy / ProviderInvoice | ACTIVE | `credit-reconciliation.service.ts:50,59,77,82,129`. |
| CreditUsageDailyRollup | ACTIVE | `credit-rollup.service.ts:96,131`, read by `finance-reporting.controller.ts` (single reader confirmed, not independently re-verified for a second). |
| PlatformOperator | ACTIVE | `platform-admin.guard.ts:46`, `platform-admin-auth.service.ts:35` — separate JWT-secret identity axis, live auth path. |

**Net finding for the whole credit domain:** despite `schema.prisma:1225-1242` explicitly claiming these tables are inert, **all 14 have real, non-test writers today**. The domain is correctly described as **feature-flag-dormant by default**, not "genuinely unused" — but the schema comment is factually wrong and should not be trusted as a proxy for implementation status.

---

## Top 5 most surprising / severe findings

1. **The credit-system schema comments are stale and contradict the actual code.** `schema.prisma:1225-1242` says the 14 credit tables are "deliberately INERT... nothing reads or writes them yet," but grep evidence shows real writers for all 14. They're dormant only because `CREDIT_GRANTS_ENABLED`/`CREDIT_ENFORCEMENT_ENABLED` default `false` — not because the code doesn't exist.
2. **`WorkflowPermission` (the RUN-gating security feature) is fully implemented server-side with zero frontend surface** — confirmed via an empty grep across all of `apps/web/src` — a company can only manage this via raw API calls today.
3. **`WorkflowRun.actingEmployeeId`** was, by the schema's own admission, **"a dead column until 2026-09-03"** — a real historical example of a column that looked complete in the schema while being fully dead in practice (now fixed).
4. **The first-pass grep methodology produced 5 false "UNUSED" results** that were all actually ACTIVE — future dead-table sweeps in this repo should always double-check a "no matches" result with a broader pattern.
5. **`WorkflowStepRun.runId` had no index** despite being polled ~1/s per open run — a documented real production performance bug (sequential scan of the highest-volume table), since fixed.
