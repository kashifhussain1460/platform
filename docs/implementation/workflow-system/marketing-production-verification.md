# Marketing AI Employee — Production Verification Report

**Date:** 2026-08-06
**Mode:** Marketing AI Employee Production Verification — verify all 11 marketing areas against doc 28, verify the Postiz "invisible-engine" integration against the resilience/reconciliation architecture, adversarially test the publish path, and confirm a Marketing employee cannot publish when approval is required. No redesign.
**Rules honored:** no rewrites of working modules; fixes only where behavior contradicted canonical; no `any`-hiding, no fake behavior, no disabled checks; relocated (not removed) test coverage. Protected tenant isolation, RBAC, secrets, idempotency, auditability.

## Verification (whole pass)
- **Typecheck** clean · **Lint** clean · **Unit** 345 / 45 suites · **E2E** green (marketing-production, inline-execution/cron, business-lifecycle, assist-agent, workflow-approval, workflow-tool-approval-gate).

## Headline
The **central invariant holds**: a Marketing employee cannot publish (or send to a prospect) without a human approval, on all three surfaces, proven end-to-end. No cross-company brand/social leak. Two defects FIXED — the AI reasoning step is now recommends-only (also fixing an orphaned-run bug), and Postiz reconciliation now runs on serverless. The remaining Postiz risks (publish idempotency; `publish_now` tracking) live in the real executor (untestable offline) and are documented with precise fixes.

---

## FIXED (defects contradicting canonical — fixed + regression-tested)

| # | Defect | Severity | Fix | Regression test |
|---|--------|----------|-----|-----------------|
| M1 | **AI_EMPLOYEE_STEP could publish autonomously AND orphaned the run.** The step ran the full agent tool-loop; `postiz.publish_now` inside it (if granted) could publish, and the HR-pass `forceApprovalForTools` mechanism created a TOOL-kind approval with no `workflowRunId` — deciding it never resumed/cancelled the run, leaving it WAITING forever. | **P1 (correctness) + publish-safety** | AI_EMPLOYEE_STEP now runs with **no tools** (`disableTools: true`) — "recommends only" per doc 28 §0.4 / doc 27 §0.3. It cannot take any action and cannot pause on an un-resumable approval. Side effects are explicit, gated TOOL_ACTION nodes. | `tool-executor.service.spec.ts` + `business-lifecycle.e2e` (HR template AI-step→APPROVAL still completes) |
| M2 | **Postiz reconciliation never ran on serverless.** The marketing-sync sweep is doc 28's stated source of truth (the Postiz webhook is a deliberate no-op), but it was a worker-only BullMQ repeatable, absent from cron/`vercel.json`. On `QUEUE_WORKERS_ENABLED=false`, ScheduledPost stayed `SCHEDULED` forever and stale local state was trusted as external truth. | **P0 (serverless)** | Sweep extracted to an always-provided `MarketingSyncService`; added `/admin/cron/marketing-sync` + `vercel.json` cron (mirrors the P1-4 gmail-poll/connector-reconcile pattern). | `marketing-sync.service.spec.ts` (5 reconciliation cases) + `inline-execution.e2e` (cron route) |

---

## Area verification (11 areas → 11 templates)

| Area | Template | Tier | Public/irreversible action | Gated | Verdict |
|------|----------|------|----------------------------|-------|---------|
| Campaign Planning | mkt.campaign-plan | T1 | gdrive save (internal) | APPROVAL | ✅ |
| Content Generation | mkt.content-generate | T1 | gdrive save (internal) | gated downstream at approval/publish | ✅ |
| Brand Knowledge | (role-scoped KnowledgeDocuments, category MARKETING) | — | none | company+role scoped | ✅ |
| Content Approval | mkt.content-approval | T2/T3 | postiz.schedule_post | APPROVAL **+** highRisk auto-gate | ✅ (double-gated) |
| Social Scheduling | mkt.social-schedule | T2 | postiz.schedule_post | highRisk auto-gate | ✅ |
| Publishing | mkt.social-publish | T2 | postiz.publish_now | highRisk auto-gate; get_post_status→CONDITION before publish (double-post-safe) | ✅ |
| Email Marketing | mkt.email-campaign | T3 | gmail.send_email to list | APPROVAL (content+volume) | ⚠️ suppression/consent trust-the-input (P1) |
| SEO | mkt.seo-content | T2 | none (draft→Drive) | APPROVAL | ✅ (safely omits push_to_cms) |
| Lead | mkt.lead-capture | T2 | gmail.send_email to prospect | APPROVAL immediately upstream | ✅ |
| Campaign Monitoring | mkt.campaign-monitor | T0 | slack internal | read-only | ✅ |
| Analytics | mkt.analytics-report | T0 | slack internal | read-only | ✅ |

(+ mkt.brand-audit MK-11 — internal Slack report; approval is vestigial (no takedown tool), harmless.)
Frozen-17 vocab only, no LOOP → no APPROVAL-in-LOOP — locked by `marketing-workflow-templates.catalog.spec.ts`.

---

## Postiz invisible-engine — failure-scenario results

| Scenario | Verdict | Notes |
|----------|---------|-------|
| Failed publishing | **PASS** | Client throws on non-2xx → executor ok:false → TOOL_ACTION fails the run cleanly; no partial publish. |
| Duplicate publishing | **RESIDUAL (P1)** | No idempotency key on the Postiz POST and no natural-key uniqueness. Silent machine duplicate is prevented (atomic PENDING claim; single-node re-entry). The only re-publish path is human `retryRun`, which **re-hits the highRisk approval** — so a duplicate requires a fresh human approval, not a machine action. Recommend an idempotency/dedup key on publish. |
| Expired credentials | **RESIDUAL** | Postiz uses one shared API key; a bad key → 401 → ok:false, breaker advances (no infinite retry). Social-token expiry lives inside Postiz and never flips an Orlixa connector status; error classification of `"failed: 401"` is regex-brittle. |
| Platform rejection | **PARTIAL (P1)** | `schedule_post` rows are reconciled to `state==='ERROR'` → FAILED by the sweep. `publish_now` writes no local row → a rejection is invisible on any deployment (see below). |
| Approval rejection | **PASS** | Reject → cancelRun → run FAILED; publish gate pauses before the tool runs. Proven in `marketing-production.e2e`. |
| Content revision | **PARTIAL (safe)** | Modeled as terminal reject, not a revise-and-re-approve loop (doc 28 UX divergence); nothing publishes on reject. |
| Schedule changes | **PASS (skill present)** | `scheduling.reschedule_slot` + Postiz reschedule exist; not exercised by a template today. |
| Webhook duplication | **PASS (by design)** | The Postiz webhook controller is a deliberate signed-nothing no-op (Postiz webhooks are unsigned/no-retry); the sweep is the source of truth — which now runs on serverless (M2). |
| Incorrect external state | **FIXED + P1** | Reconciliation now runs everywhere (M2), so scheduled posts reconcile to Postiz truth. `publish_now` remains untracked (P1 below). |
| Reconciliation | **FIXED (M2)** | Cron-wired for serverless; worker repeatable retained. |
| Rate limiting | **RESIDUAL (P2)** | Per-connector limiter + breaker wrap egress, but the limiter is per-company while Postiz's real cap is instance-wide 90/hr across all tenants — N tenants can collectively exceed it. |

---

## Central invariant + isolation

| Check | Verdict |
|-------|---------|
| Publish via **TOOL_ACTION** (postiz publish/schedule) requires approval | **PASS** — highRisk auto-pause before execute; reject → FAILED (e2e `marketing-production`). |
| Publish via **AI_EMPLOYEE_STEP** agent loop | **PASS** — the step now has no tools (M1); it cannot publish. |
| Publish via **chat** | **PASS** — highRisk → approval gate. |
| Approval **rejection** → nothing publishes | **PASS** — e2e. |
| `EmployeeRole.MARKETING` is a real role (doc 28 says G10 open — **stale**) | **PASS** — enum shipped; knowledge retrieval role-scopes to MARKETING+Shared, never HR/Sales. |
| Brand knowledge company + role scoped; no cross-tenant | **PASS** — KnowledgeDocument category=MARKETING, `WHERE companyId` + category-OR-null. |
| Company isolation of wired models (SocialAccount/ScheduledPost/PublishedPost) | **PASS** — all companyId-scoped; the one id-only lookup is gated by a preceding company-scoped read. |

---

## RESIDUAL RISK / follow-ups (documented, not blocking)

- **P1 — No publish idempotency (duplicate publishing).** Lives in the real Postiz executor + schema (untestable offline). Recommended: an idempotency key on the Postiz publish call and/or a natural-key uniqueness on ScheduledPost/content so a re-drive cannot double-post. Current backstop: every (re-)publish hits the highRisk human approval.
- **P1 — `publish_now` is fire-and-forget (no tracking row).** It creates no ScheduledPost/PublishedPost, so a platform rejection or silent non-delivery is never detected and `get_post_status` can't see it. Recommended: persist a row on publish so the reconciliation sweep covers immediate publishes too.
- **P1 — MK-06 email suppression/consent is trust-the-input.** doc 28 §MK-06 calls suppression "mandatory and non-bypassable"; the template sends to the raw `{{trigger.recipients}}` and trusts a `consentVerified` boolean, with suppression only as an AI-instruction. The APPROVAL on content+volume is the human backstop. Recommended: a workflow-level suppression filter step, or gate the send on a verified suppressed list.
- **P2 — Per-company rate limiter vs Postiz instance-wide 90/hr cap** — correct machinery, wrong scope for one shared Postiz instance.
- **P2 — Brittle Postiz error classification** (`"failed: <status>"` string not parsed by `httpStatusOf`).
- **P3 — Campaign / MediaAsset / BrandAsset / MarketingAnalyticsSnapshot are dead schema (G21)** — zero read/write; brand "assets" as a first-class isolatable entity don't exist (brand knowledge lives as role-tagged KnowledgeDocuments).
- **P4 — No content-revision loop; MK-11 vestigial approval; doc 28 §0.1/G10 is stale** (MARKETING role is shipped).

---

## Can Marketing go to production?
**Yes for the publish-safety posture.** Nothing addressed to the public is autonomous — publishing and prospect emails are gated on every surface, a rejection publishes nothing, the AI reasoning step can no longer act on its own, and Postiz reconciliation now runs on the documented serverless shape. Cross-company isolation and role-scoped brand knowledge hold. The residual items are Postiz-integration hardening (publish idempotency + `publish_now` tracking — both in the real executor, needing live-Postiz verification) and doc-conformance follow-ups (email suppression, rate-limit scope) — all P1/P2, none allowing an unapproved public post or a cross-tenant leak.
