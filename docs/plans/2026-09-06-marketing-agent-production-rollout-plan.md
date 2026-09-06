# Content & Social Media Agent (AI Marketing Manager) — Production Rollout Execution Plan

**Date:** 2026-09-06
**Scope:** first of the 3 new commercial products approved in the V-AEP proposal (Section 9) —
WhatsApp Sales Agent and Real Estate Lead Agent follow as separate plans.
**Reads together with:** `docs/architecture/postiz-integration-plan.md` (original architecture,
"wrap Postiz as a service") and `docs/implementation/workflow-system/marketing-production-verification.md`
(2026-08-06 correctness verification — offline/mocked). **This document does not re-derive either.**
It exists because both predecessors verified *design* and *code correctness*; neither ever ran
against a live Postiz instance. That is the actual gap this plan closes.

---

## 1. Current status (verified against this codebase, 2026-09-06)

**Code-complete, not deployment-complete.** Every layer of the design in `postiz-integration-plan.md`
is built:

- Backend: `modules/marketing` (controller/service/generation/planning), `modules/engines/marketing`
  (`PostizClientService`, `PostizEngineAdapter`, `MarketingSyncService`+processor, webhook controller)
- Schema: `SocialAccount`, `Campaign`, `ScheduledPost`, `PublishedPost`, `MediaAsset`, `BrandAsset`,
  `MarketingAnalyticsSnapshot` — all `companyId`-scoped
- Frontend: `/marketing` dashboard, `/marketing/campaigns`
- 11 marketing workflow templates (`marketing-workflow-templates.catalog.ts`), all verified against
  doc 28 in the 2026-08-06 pass
- The central invariant — **a Marketing employee cannot publish without human approval** — is proven
  on all three surfaces (TOOL_ACTION, AI_EMPLOYEE_STEP, chat) and regression-tested
- Serverless reconciliation cron is wired (`marketing-sync` fixed 2026-08-06, defect M2)

**The gap:** `infra/docker-compose.yml` has no `postiz` service. `POSTIZ_BASE_URL=http://postiz:3000`
in `.env.example` points at a host that has never existed in any environment. Every test —
including `marketing-production.e2e-spec.ts` — runs against the mock/auto skill executor. **No code
path in this feature has ever executed against a real Postiz instance or a real social account.**
This matters because the 2026-08-06 report's own residual-risk list is explicit that its two open P1s
"live in the real executor (untestable offline)" — they cannot be closed by more code review, only by
running the real thing.

## 2. What's genuinely left

**Correction (2026-09-06, re-verified against current code — the 2026-08-06 report is now one month
stale):** WAVE 3 of the separate CTO gap-closure programme (migration
`20260812000000_wave3_publish_idempotency`, `docs/status/cto-gap-closure-wave3.md`) already closed
four of the six items the 2026-08-06 report listed as open, **before this plan was first drafted**.
Verified directly in code just now:

| Originally listed as open | Actual current state |
|---|---|
| P1 — no publish idempotency | **FIXED** — `ToolIdempotencyService.runIdempotent` claims a row before calling Postiz on `schedule_post`; `publish_now` has its own `ScheduledPost.idempotencyKey` dedupe window (`real-skill-executor.ts:907-1005`) |
| P1 — `publish_now` fire-and-forget, no tracking row | **FIXED** — same WAVE 3 §3.6 change creates a `ScheduledPost` row before publishing |
| P1 — MK-06 email suppression trust-the-input | **FIXED** — real `SuppressionService` (hard block, not a warning; consent vs. suppression modeled separately) |
| P2 — per-company rate limiter vs. Postiz's real instance-wide 90/hr cap | **FIXED** — `PostizClientService` now shares one global `POSTIZ_RESOURCE_KEY` rate budget across every tenant (matches how Postiz is actually deployed), not a per-company one |
| P3 — `Campaign`/`MarketingAnalyticsSnapshot` dead schema | **FIXED** — both wired (`campaign-generation.service.ts`, `campaign-query.service.ts`, `marketing-sync.service.ts`) |
| P3 — `MediaAsset`/`BrandAsset` dead schema | **Still dead** — zero `prisma.mediaAsset.`/`prisma.brandAsset.` calls anywhere in `apps/api/src` |

Genuinely remaining, re-verified today:

| Item | Why it's still open |
|---|---|
| Stand up self-hosted Postiz | Confirmed still absent from `docker-compose.yml`; `POSTIZ_BASE_URL`/`CHATWOOT_BASE_URL`/`PLANE_BASE_URL` all resolve to nothing (also independently confirmed by `ORLIXA_FINAL_DEEP_PRODUCTION_AUDIT_v1_2026-09-02.md` P1-8, still current as of the 2026-09-03 re-audit) |
| **Verify** the already-built idempotency/tracking/suppression/rate-limit code against a **real** Postiz instance | Every one of the WAVE 3 fixes above is tested against the mock executor only — `PostizClientService`'s own doc comments mark the analytics DTOs `IMPLEMENTED_UNVERIFIED` because "no self-hosted instance exists in this dev environment." Nothing in this feature has ever executed against real Postiz. This is now a verification task, not an implementation task. |
| **P2** — brittle `"failed: <status>"` error string classification | Confirmed still true — `postiz-client.service.ts` throws a plain `Error(string)`; `error-classifier.ts`'s `httpStatusOf()` only reads a `.status`/`.statusCode`/`.response.status` property, so it silently falls through to regex keyword-guessing for every Postiz failure |
| `MediaAsset`/`BrandAsset` — decide keep-and-wire vs. drop | Confirmed still zero read/write — decide before GA, don't ship unused tables silently |
| AGPL-3.0 legal review | Not started; top risk in the original architecture plan, still open |
| Cross-tenant isolation — **re-verify against a real shared Postiz org** | Orlixa-side `companyId` scoping already verified (2026-08-06); the third-party-tagging half has never been exercised against a real Postiz `Customer` group, because no real instance exists yet |

## 3. Execution phases

**Phase A — Non-production Postiz instance**

**Decision (2026-09-06):** self-hosted Postiz requires Postgres + Redis + a full Temporal cluster
(Temporal server + its own dedicated Postgres + Elasticsearch — not optional, publish-scheduling runs
on Temporal workflows). Non-prod runs the **full self-hosted stack** in Docker Compose (simplest to
stand up, no external account needed). **Production runs Temporal Cloud** instead of self-hosting
Temporal+Elasticsearch (`TEMPORAL_ADDRESS`/`TEMPORAL_TLS`/`TEMPORAL_API_KEY`/`TEMPORAL_NAMESPACE`,
natively supported by Postiz) — Postiz app + its own Postgres + Redis stay self-hosted either way;
only the heaviest, hardest-to-operate piece (Temporal server + Elasticsearch) is offloaded in prod.
This keeps non-prod fully local/free while avoiding running Elasticsearch in production.

1. Add a `postiz` service to a non-prod Docker Compose file (own Postgres + full self-hosted Temporal
   stack incl. Elasticsearch, per the decision above; do not touch the shared Orlixa
   `infra/docker-compose.yml` used for local dev until this is proven).
2. Get the **vanilla, unmodified** public API working manually: connect one real test social account
   via `GET /public/v1/social/:integration`, schedule a post via `POST /public/v1/posts`, confirm it
   actually publishes, pull `GET /public/v1/analytics/*` back.
3. Point a non-prod Orlixa deployment's `POSTIZ_BASE_URL`/`POSTIZ_API_KEY` at it; re-run the 7 existing
   marketing e2e specs against the live instance instead of the mock executor.

**Phase B — Verify the already-built WAVE 3 fixes against the real instance (not re-implement)**
4. Run a live `schedule_post` twice with the same idempotency key against the Phase A instance —
   confirm `ToolIdempotencyService` dedupes and Postiz never receives a second call.
5. Run a live `publish_now` — confirm the `ScheduledPost` tracking row is created and a real Postiz
   rejection surfaces through `get_post_status` instead of vanishing.
6. Send to one real suppressed test address — confirm `SuppressionService`'s hard block holds against
   a live send path, not just the unit-tested mock path.
7. Fix the P2 error-classification gap for real (genuinely unfixed, confirmed in code today): make
   `PostizClientService`'s thrown errors carry a `.status` so `error-classifier.ts`'s `httpStatusOf()`
   can read it structurally instead of falling through to regex keyword-guessing.

**Phase C — Compliance & capacity**
8. AGPL-3.0 legal review (parallel-track, can start immediately — does not block A/B).
9. Set `API_LIMIT` on the self-hosted instance for expected combined volume — the shared
   `POSTIZ_RESOURCE_KEY` budget (already fixed to be global, not per-company) needs its ceiling tuned
   to real projected traffic before GA.

**Phase D — Isolation re-verification on the real thing**
10. With the live non-prod instance from Phase A, write and run an explicit test: two Orlixa companies,
    two connected accounts, confirm company A's `schedule_post` call can never resolve to company B's
    Postiz `Customer`/integration. This is the item the 2026-08-06 report could not test offline.

**Phase E — Decide the dead schema, then GA**
11. Decide `MediaAsset`/`BrandAsset` (the two still-genuinely-dead tables — `Campaign` and
    `MarketingAnalyticsSnapshot` are already wired, confirmed above): wire them into the
    generation/planning flow or formally drop them — don't carry unused tables into GA silently.
12. Production Docker/infra: promote to a real production deployment — Postiz app + its own Postgres +
    Redis self-hosted, but pointed at **Temporal Cloud** (not self-hosted Temporal/Elasticsearch) per
    the Phase A decision; monitoring on the 3 marketing queues (`marketing-publish-dispatch`,
    `marketing-reconcile`, `marketing-analytics-sync`) + DLQ.
13. GA checklist sign-off: legal (8) done, Phase B+D closed, monitoring live → open to customers.

## 4. Open decisions needing a call before/during implementation

- Customer-tagging patch (small additive Postiz endpoint) vs. session-bridge workaround — architecture
  plan Phase 3, needed before Phase A step 2 can tag a connected account to the right company.
- Keep or drop the dead `MediaAsset`/`BrandAsset` schema (§3.11).
- Who owns the AGPL legal review and its timeline (blocks Phase C/E, not A/B).

## 5. Definition of done

Self-hosted Postiz deployed and reachable; every already-built WAVE 3 fix (idempotency, publish
tracking, suppression, rate-limit scope) verified against that real instance, not just the mock
executor; the P2 error-classification gap closed; isolation proven against a real shared Postiz org;
`MediaAsset`/`BrandAsset` resolved one way or the other; AGPL sign-off obtained; production infra live
with monitoring — at that point Section 9 of the proposal can call the Content & Social Media Agent
production-ready rather than code-complete.
