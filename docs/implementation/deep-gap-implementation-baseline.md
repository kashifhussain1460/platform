# Deep Gap Implementation Baseline — AI Marketing + AI Support + Shared Core

**Status: BASELINE ONLY. No code has been modified to produce this document.** Per the governing instructions, this
document exists to be reviewed and explicitly approved before any implementation begins.

**Source audit:** `platform/docs/architecture/ai-marketing-support-core-gap-analysis.md` (2026-08-19), treated as a
baseline gap map, not unquestionable truth. Every finding below was independently re-verified against the current
repository (branch `master`, HEAD `8f78eea`) via direct code reads and four parallel design/verification passes —
none of the original findings were accepted without a fresh file:line citation.

---

## 1. Current Repository State

**Git:** `platform` is its own repo (`d:\Vertical AI\platform`), branch `master`, ahead of `origin/master` by 9
commits (all local-only, unpushed — a separate matter from the deployment gap below). Working tree has 7 modified +
26 untracked files, all belonging to an unrelated in-flight marketing-website redesign plus this session's own new
docs — nothing touching the engines/support/marketing/skills code this baseline concerns.

**Branches:** `master`, `deployment`, `master-backup`, `v2`, plus a stale worktree branch. `deployment` is a **strict
ancestor** of `master` (`git merge-base deployment master` = `deployment`'s own tip — no divergence, just staleness).

**The concrete, re-verified form of the governance finding (see §3 for how this revises the source audit's C-15):**

| | `deployment` (what Vercel's `apps/api/vercel.json` `migrate deploy` actually builds) | `master` (HEAD) |
|---|---|---|
| Last commit | `3e7fa5c`, 2026-07-25 13:07 IST | `8f78eea`, 2026-08-19 00:50 IST |
| Commits behind | — | **15 commits**, **25 days** |
| Migrations | **29** | **52** — 23 migrations never promoted |
| Has `modules/engines/marketing`? | Yes (added 2026-07-20, before the freeze) | Yes |
| Has `modules/engines/support`? | Yes (added 2026-07-20, before the freeze) | Yes |
| Has WAVE 3 publish idempotency, the NOTIFY real-send fix, Chatwoot's canonical-pipeline wiring, MARKETING role, 22 workflow templates, approval routing/SLA, workflow permissions? | **No** — all landed in commits dated 2026-08-01 through 2026-08-14 | Yes |

**CI (re-verified, corrects a stale assumption from the prior CTO audit this baseline's own source document cited):**
`.github/workflows/api-ci.yml` runs lint, typecheck, and a `test` job on a `[state_machine, legacy_walk]` matrix
(`state_machine` must pass; `legacy_walk` runs with `continue-on-error: true`, documented in-file as "a deprecated
escape hatch on its way out"). `.github/workflows/browser-e2e.yml` **actually executes** 3 real Playwright specs
(`01-auth-journey`, `02-security-journey`, `03-golden-journey`) against a real Postgres+Redis+Next.js+Nest stack on
every push/PR to `main`/`master`. **Neither workflow builds or deploys to the `deployment` branch or to Vercel** —
CI validates `master`; nothing promotes `master` to `deployment`.

**Skill/database current-state spot checks (re-verified, not assumed from the audit):**
- `ChatwootAccount.chatwootAccountId: String` — **no `@@unique`** (schema.prisma:1307). `SupportConversation` —
  `@@index([companyId, chatwootConversationId])`, **not `@@unique`** (schema.prisma:1336). Confirmed exactly as the
  source audit described.
- `chatwoot.reply_to_conversation` / `chatwoot.resolve_conversation` (catalog.ts:717-738) carry **no `highRisk`
  field**, unlike `postiz.schedule_post`/`publish_now` (catalog.ts:653/667, both `highRisk:true`).
- `PostizClientService` / `ChatwootClientService` — every method is a raw `fetch()`, zero references to
  `CircuitBreakerRegistry`/`RateLimiter` anywhere in either file.
- `DataRetentionService`'s swept-class list (data-retention.service.ts:16-55) has no `SupportConversation`/
  `SupportMessage`/`ChatwootAccount` entries.
- `UsageService.totalsForCompany()` (usage.service.ts:99-116) **already exists** and is company-scoped — it is
  simply never called by anything that enforces a limit. This is a materially better starting point than the source
  audit implied ("no company-wide budget ceiling exists" is true as a *control*, but the *aggregation query* needed
  to build one is already there).

---

## 2. Audit Findings Verified (all re-confirmed true against current code, independent of the source document)

| ID | Finding | Re-verification method | Confirmed? |
|---|---|---|---|
| S-01 | Confidence/grounding computed, never enforced | Traced `ValidationService.validate()` → `ai-employee-step.handler.ts` → confirmed `context[outputKey]` only carries the plain draft string, `.validation` never leaves the `WorkflowStepRun.output` column; confirmed both `approval-gate.service.ts` (durable) and `workflow-engine.service.ts` (legacy) call only `toolRequiresApproval`, neither reads `context` | **TRUE**, in both engines |
| S-04 | Automated replies bypass approval by default | Confirmed `catalog.ts` has no `highRisk` on either Chatwoot tool; confirmed `EXTERNAL_ACTION_TOOLS` is consumed only by `tool-executor.service.ts:68` (chat path, `forceApprovalForExternalActions`-gated), never by either workflow gate | **TRUE** |
| S-06 | No sensitive-scenario handling | Repeated the source audit's grep independently across `apps/api/src/modules/employees` and `.../engines/support` — zero real hits (one unrelated knowledge-retrieval fixture string) | **TRUE** |
| S-13/C-06 | No human handoff mechanism | Grepped `escalat|handoff|takeover` — all 16 hits are the unrelated Approval-SLA escalation feature; confirmed `SupportConversationStatus` has no `ESCALATED` value; confirmed `AiEmployee.status` is company-wide only | **TRUE** |
| M-06 | `schedule_post` has no idempotency, `publish_now` does | Read both methods in `real-skill-executor.ts` line-for-line; confirmed `publish_now`'s exact record-before-effect pattern and `schedule_post`'s complete absence of one | **TRUE** |
| C-07 | Resilience layer not wired into engine clients | Read all 119 lines of `postiz-client.service.ts` and all of `chatwoot-client.service.ts` — zero breaker/limiter references; confirmed `MarketingSyncService.sweep()` calls the client directly, bypassing even `SkillsService`'s partial wrap | **TRUE — and worse than stated** (see §4) |
| S-02 | `resolve_conversation` fake success | Confirmed the method's own comment admits no live Chatwoot call exists; confirmed no resolve/toggle method exists anywhere in `ChatwootClientService` | **TRUE** |
| S-07 | TOCTOU race, missing unique constraints | Read current schema directly — confirmed exactly as described | **TRUE — and the `chatwootAccountId` half is more severe than stated** (see §4) |
| C-09 | No company-wide budget ceiling | Confirmed `assertUnderBudget` checks only `employee.budgetLimit`; confirmed no `Company`/`Subscription` spend field exists | **TRUE** |
| S-09 | Support PII absent from retention sweep | Confirmed the exact swept-class enumeration excludes all 3 Support models | **TRUE** |
| M-08 | Email consent is trust-the-input | Confirmed the template's `CONDITION` reads `{{trigger.consentVerified}}`; confirmed `SuppressionService.latestConsent()` already exists, DB-backed, and is simply never called from the workflow path | **TRUE** (and easier to fix than implied — the query already exists) |
| M-10 | No marketing analytics capability | Confirmed `PostizClientService` implements exactly 4 methods, none analytics; confirmed `MarketingAnalyticsSnapshot` has zero read/write sites | **TRUE** |
| M-07/C-10 | Rate limit scoped per-company vs Postiz's real instance-wide cap | Confirmed `RateLimiter` is already fully generic (any string key); confirmed the only caller uses a per-`installedSkillId` (i.e. per-company) key with a default budget far looser than Postiz's real 90/hr | **TRUE** |

---

## 3. Findings No Longer Applicable / Revised

1. **C-15, as originally framed ("Waves 1-9 hardening work exists only on one developer's disk, not on any deployed
   branch") — MODIFY.** This is now **stale in its literal form**: the work IS committed, to `master`, verified by
   direct `git log`/`git ls-tree` reads (§1 table). The **correct, current diagnosis** is narrower and more
   actionable: `master` has never been promoted to `deployment` (the branch Vercel actually builds), which is 15
   commits / 23 migrations / 25 days behind. The risk is a **missing release-promotion step**, not lost work. This
   changes the recommended fix from "reconcile branches, recover lost work" (nothing is lost) to "merge/fast-forward
   `deployment` to `master`'s tip, then establish a promotion gate so this gap can't silently reopen." Given a
   `deployment` branch fast-forward is a real production-deploy action (push to a branch Vercel builds from, applying
   23 unreviewed-in-production migrations at once), **this action requires separate, explicit sign-off beyond this
   baseline document** — it is out of scope for a "baseline creation" pass per the governing rules, and is flagged
   as an open decision in §11.

2. **"No browser E2E exists anywhere" (a framing carried over from the source audit's own citation of an even
   earlier document) — MODIFY.** Browser E2E **does** exist and **does** run in CI (`browser-e2e.yml`, 3 real specs,
   real stack, real assertions) — this was true confusion inherited from a stale prior-generation document, now
   corrected. What remains **true and unrevised**: none of the 3 existing specs drives a Marketing or Support
   journey specifically (confirmed by the test-infra recon pass) — that gap (M-15/S-11's Phase 6/7 work) stands.

3. **M-13 ("Marketing PII absent from retention sweep," as applied to `MarketingConsent`/`MarketingSuppression`
   specifically) — INVALIDATE.** Re-analysis shows this is actively harmful advice, not merely unnecessary: these
   two models are the *evidentiary record* of consent state (what someone agreed to or withdrew, and when). A
   time-based sweep would silently re-enable contacting someone who opted out and destroy the compliance record a
   dispute would need — the same reasoning that already, correctly, keeps `AuditLog` out of ordinary retention
   sweeps. **Replaced with:** (a) a documented, deliberate exclusion (one code comment, no migration, no new logic);
   (b) a **separately scoped, lower-priority DEFER** for a genuine GDPR erasure-by-address endpoint, which is a
   different capability (explicit request-driven deletion, not time-based aging) that doesn't exist today and isn't
   solved by extending `DataRetentionService`.

4. **M-07/C-10, as a standalone `SkillsService`-level fix — MODIFY (merge into C-07).** Two independent design
   passes proposed two different implementation sites for the same underlying fix (a global Postiz rate-limit key):
   one inside `SkillsService.runGuardedEgress` (a new `if (skillKey === 'postiz')` branch), one inside a new
   `ResilientClientBase.guardedFetch()` that `PostizClientService` itself extends (C-07's fix). Building both would
   create exactly the "duplicate resilience system" the governing rules forbid, and the `SkillsService`-level version
   would also miss `MarketingSyncService.sweep()`'s direct, unwrapped calls (same reason C-07 must live in the
   client, not the call site). **Resolution: M-07/C-10 is not a separate code change — it is a configuration detail
   of C-07's fix** (set `guardedFetch`'s rate-limit budget for the `'engine:postiz'` resource key to 90/hour,
   globally, instead of the per-connector default). This eliminates a whole implementation task, not just tidies one.

---

## 4. New Gaps Discovered During This Verification Pass

1. **C-07 is broader than the source audit stated.** `SkillsService.runGuardedEgress`'s existing partial wrap is
   keyed on `installedSkillId`, which resolves to `null` for a workflow `TOOL_ACTION` with no prior `/skills/install`
   context (confirmed live in `marketing-production.e2e-spec.ts`, which runs `postiz.publish_now` this way) — meaning
   **the primary TOOL_ACTION execution path**, not just the reconciliation sweep, can run completely unwrapped. This
   raises confidence that the fix must live in the client (as designed), not in tuning `SkillsService`'s connector-id
   resolution, since any future direct caller would repeat the bypass.
2. **S-07's `chatwootAccountId` half is a cross-tenant leak vector, not just a data-quality bug.** `chatwootAccountId`
   is the webhook's own authentication lookup key. Since provisioning is manual (S-10, unimplemented), a copy-paste
   mistake during hand-provisioning is a realistic way two companies could end up with the same external id — and if
   the `webhookSecret` were copied alongside it, one company's live customer messages could be authenticated and
   attributed to a different company's conversation rows. This strengthens (does not just restate) the case for
   `@@unique`, independent of the conversation-splitting race.
3. **A residual, non-blocking race remains after the S-07 fix.** `enrichForMapping`'s `isFirstMessage` classification
   (support-webhook.controller.ts:172-187) is a best-effort read that can still misclassify two truly concurrent
   first messages as two `NEW_TICKET` events (double-firing a workflow) even once the `SupportConversation` unique
   constraint guarantees only one row survives. Recommend a P2 follow-up (derive `isFirstMessage` from the upsert's
   own conflict outcome) — explicitly out of scope for the P1 fix itself, called out here so it isn't lost.
4. **Existing tests currently assert the wrong (soon-to-be-fixed) behavior** and will need updating in the same
   change, not just extending: (a) any chat-path spec asserting `reply_to_conversation`/`resolve_conversation`
   execute immediately (no approval) will start failing correctly once S-04 ships and must be updated to expect
   `pendingApproval:true`; (b) `real-skill-executor.spec.ts`'s current assertion that `resolve_conversation` updates
   the local mirror must flip to asserting it does **not**, once S-02 ships. Calling this out explicitly so it isn't
   mistaken for a regression introduced by this work.
5. **`UsageService.totalsForCompany()` already exists**, better positioning C-09 as an extension than the source
   audit's framing implied — no new aggregation query needs to be designed, only a call site and a cap field.
6. **`SuppressionService.latestConsent()` already exists and is already tested**, similarly better-positioning M-08 —
   the fix is wiring, not new consent-lookup logic.

---

## 5. P0 / P1 / P2 Classification (final, post-verification)

### P0 — block Support from being customer-facing; fix before anything else
| ID | Decision | One-line reason |
|---|---|---|
| C-15 (revised) | **ACTION REQUIRED, not a code fix** | `deployment` branch 25 days / 23 migrations behind `master`; requires an explicit, separately-approved promotion, not baseline-phase code work |
| S-04 | **FIX** | 2-line catalog change closes both engines' gate paths at once (reuses `toolRequiresApproval`) |
| S-01 | **FIX** | Additive context-threading + one new pure predicate; no new approval mechanism |
| S-06 | **FIX** | New `SensitiveScenarioService` (keyword + 1 bounded LLM call), feeds the existing validation/gate signal from S-01 |
| S-13/C-06 | **FIX** | New `HandoffModule`, reuses `ApprovalRoutingService`'s resolver in full — no second routing system |

### P1 — external-action safety, cost control, retention, marketing completeness
| ID | Decision | One-line reason |
|---|---|---|
| M-06 | **FIX** | New generic `ToolIdempotencyRecord`/`ToolIdempotencyService` (not Postiz-specific); `schedule_post` and (recommended, same pass) `chatwoot.reply_to_conversation` both adopt it |
| C-07 | **FIX** | New `ResilientClientBase`; Postiz uses one global resource key (single shared instance), Chatwoot uses one per-`ChatwootAccount` key (per-tenant instance) — reasoned from each provider's actual deployment shape, not copy-pasted |
| S-02 | **MODIFY** | Immediate: honest `NOT_IMPLEMENTED` response (no more fake success). True `FIX` (a real `toggleStatus` call) is deferred pending either a source-grounded read of Chatwoot's controller or a live instance — matches this codebase's own existing discipline (`provisionAccount`'s stub) |
| S-07 | **FIX** | `@@unique` on both flagged shapes + upsert-on-conflict controller logic; requires a pre-migration dedup pass (§9) |
| C-09 | **FIX** | Extends `UsageService`/`assertUnderBudget`/`SkillsService.runTool` — no new billing engine |
| S-09 | **FIX** | Extends `DataRetentionService`'s existing pattern; `ChatwootAccount` itself is explicitly never pruned |
| M-08 | **FIX** | Wires the already-existing `SuppressionService.latestConsent()` into the template via a new read-only tool |
| M-10 | **FIX**, labelled `IMPLEMENTED_UNVERIFIED` until tested against a real Postiz instance | New client methods + a new low-frequency snapshot cadence, deliberately not folded into the existing 10-min sweep (would blow the very rate cap C-07 just fixed) |
| M-07/C-10 | **Absorbed into C-07** | See §3 item 4 — not a separate task |

### P2 (acknowledged, explicitly deferred past this baseline's scope — not implemented now, per Rule 19)
- Precise per-node validation-source wiring for S-01 (vs. the scan-based approach shipped now)
- `enrichForMapping`'s residual `isFirstMessage` race (finding 3 above)
- Dedicated `SensitiveScenarioFlag` model for compliance reporting (S-06's audit-log path ships first; the table is an optional follow-on, not blocking)
- GDPR erasure-by-address endpoint (replaces the invalidated M-13 framing)
- Role-scoped universal consent enforcement inside `SkillsService.runTool` (M-08's Option B, deliberately not built now)
- Support/Marketing operational frontend UI (Phase 6 in the source audit — explicitly after backend safety, per Rule 19's "no scope creep")
- Support workflow templates (must not exist before S-04/S-01/S-06 ship, or they'd industrialize the current unsafe default)

---

## 6. Dependency Graph

```text
C-15 (governance)  ─── independent, but should land BEFORE any of the below are considered
                        "production-relevant" — a fix on master means nothing until deployment
                        catches up. Does not block starting P0 code work.

S-04 (catalog highRisk flag) ──┐
                                ├──▶ shares the same two gate files (approval-gate.service.ts,
S-01 (context threading +      │     workflow-engine.service.ts) — do in the SAME change/PR to
      gate predicate)   ───────┘     avoid two people editing the same conditional twice
        │
        ▼
S-06 (SensitiveScenarioService) ── REUSES S-01's context signal mechanism (`__validation:<nodeId>`)
        │                          — cannot ship its "force approval" behavior before S-01 exists
        ▼
S-13/C-06 (HandoffModule) ── independent of S-01/S-04/S-06's mechanics, BUT S-06's escalation
                              target (route to a human, not just "require approval") is only
                              fully realized once HandoffService exists — ship Handoff so S-06's
                              second half (escalate, not just gate) has somewhere to route to

M-06 (idempotency) ── independent of all Support P0 work; touches real-skill-executor.ts (different
                       methods than S-02) — safe to parallelize with the Support P0 track

C-07 (resilience wiring) ── independent; ABSORBS M-07/C-10 as a config value, not a separate task.
                             Should land before M-10 (new analytics calls should not add MORE
                             unwrapped Postiz traffic while the wrap is still missing)

S-02 (honest NOT_IMPLEMENTED) ── fully independent, smallest possible change, no dependency on
                                  anything else — can ship immediately, any time

S-07 (TOCTOU + unique constraints) ── independent of the other Support P0s; DOES require the
                                       pre-migration dedup script to run first in any environment
                                       with existing data (dev/QA has a live tenant per project
                                       memory — this is not hypothetical)

C-09 (company budget) ── independent
S-09 (retention)       ── independent
M-08 (consent wiring)  ── independent
M-10 (analytics)       ── SHOULD follow C-07 (see above); otherwise independent
```

**No circular dependencies identified.** The only hard sequencing constraints are: S-04+S-01 together, S-06 after
S-01, Handoff before S-06's escalation path is "complete" (though S-06's approval-forcing half can ship on its own
first), and M-10 after C-07.

---

## 7. Implementation Order (proposed; matches and refines the source audit's Phase 0-2 sequencing, not a
   re-derivation)

1. **S-02** (fake resolve → honest failure) — smallest, zero-dependency, ships in isolation as a trust-building first
   PR: removes a live "silent success" defect with no design risk.
2. **S-04 + S-01 together** (one PR: catalog flag + context-threading + shared gate predicate) — closes the two most
   dangerous automated-reply gaps in one reviewable change.
3. **S-06** (SensitiveScenarioService, wired to S-01's signal) — depends on step 2 landing.
4. **S-13/C-06** (HandoffModule) — can start in parallel with step 3 (different files/module), but S-06's escalation
   routing to a human is only "done" once this lands; ship Handoff's core (escalate/route/resolve) before treating
   S-06 as fully closed, not just its approval-forcing half.
5. **C-07** (ResilientClientBase, absorbing M-07/C-10's config) — independent track, can run in parallel with 2-4.
6. **M-06** (generic idempotency ledger, applied to `schedule_post` and `chatwoot.reply_to_conversation`) —
   independent track, can run in parallel with 2-5; recommend landing after C-07 only because both touch
   `real-skill-executor.ts` and `postiz-client.service.ts`/`chatwoot-client.service.ts` — sequencing avoids two
   simultaneous structural changes to the same files.
7. **S-07** (unique constraints + upsert) — independent; schedule after running the pre-migration dedup queries
   against any environment with real data (§9).
8. **C-09** (company budget ceiling) — independent, any time after step 2 (reuses no P0 code).
9. **S-09** (retention extension) — independent, any time.
10. **M-08** (consent tool + template rewire) — independent, any time; low risk since it only touches one workflow
    template plus one new read-only tool.
11. **M-10** (analytics) — after C-07 (step 5), labelled `IMPLEMENTED_UNVERIFIED` until a real-Postiz-instance pass.

This order front-loads every P0 and defers every "completeness" item (M-08, M-10) behind the safety work, matching
Rule 19's "no scope creep" instruction.

---

## 8. Files Likely to Change

| File | Change | Gap(s) |
|---|---|---|
| `apps/api/src/modules/skills/catalog.ts` | Add `highRisk: true` to 2 Chatwoot tools; add new `marketing` skill entry (`check_consent`) | S-04, M-08 |
| `apps/api/src/modules/skills/tool-approval-policy.ts` | Add `contextHasUnresolvedValidationConcern()` | S-01 |
| `apps/api/src/modules/workflows/engine/approval-gate.service.ts` | Extend gate condition (durable engine) | S-01 |
| `apps/api/src/modules/workflows/engine/workflow-engine.service.ts` | Extend gate condition (legacy engine); thread `__validation:<nodeId>` into context | S-01 |
| `apps/api/src/modules/employees/runtime/ai-employee-step.handler.ts` | No change expected beyond what already writes `.output` — verify during implementation | S-01 |
| `apps/api/src/modules/employees/runtime/sensitive-scenario.service.ts` *(new)* + `.spec.ts` | New layered classifier | S-06 |
| `apps/api/src/modules/employees/runtime/agent-runtime.service.ts` | Invoke `SensitiveScenarioService`; call `HandoffService.escalate` on trigger | S-06, S-13 |
| `apps/api/src/modules/employees/runtime/validation.service.ts` | Accept/merge sensitive-category signal | S-06 |
| `packages/types` | Extend `MessageValidationDto` (or sibling field) — mind the "cast is not a conversion" lesson on any exhaustive switch | S-06 |
| `apps/api/src/modules/handoff/` *(new module: `.module.ts`, `.service.ts`, `.controller.ts`, `.spec.ts`)* | New `HandoffService`/`HandoffModule`, reuses `ApprovalRoutingService` | S-13/C-06 |
| `apps/api/src/modules/skills/executors/real-skill-executor.ts` | `chatwootReplyToConversation` (ESCALATED guard); `chatwootResolveConversation` (honest failure); `postizSchedulePost` (idempotency); inject `ToolIdempotencyService`, `SuppressionService` | S-13, S-02, M-06, M-08 |
| `apps/api/src/common/idempotency/tool-idempotency.service.ts` *(new)* + `.spec.ts` | Generic, engine-agnostic idempotency primitive | M-06 |
| `apps/api/src/common/resilience/resilient-client.base.ts` *(new)* + `.spec.ts` | Shared `guardedFetch()` base class | C-07, M-07/C-10 |
| `apps/api/src/modules/engines/marketing/postiz-client.service.ts` | Extend `ResilientClientBase`; wrap 4 fetch calls with global resource key; add `getIntegrationAnalytics`/`getPostAnalytics` | C-07, M-10 |
| `apps/api/src/modules/engines/support/chatwoot-client.service.ts` | Extend `ResilientClientBase`; wrap `sendReply` with per-`chatwootAccountId` key | C-07 |
| `apps/api/src/modules/engines/marketing/marketing-sync.service.ts` | New `snapshotAnalytics()` method (separate from `sweep()`, lower cadence) | M-10 |
| `apps/api/src/modules/engines/marketing/marketing.constants.ts` | Add global-rate-limit constants (absorbs M-07/C-10) | C-07 |
| `apps/api/src/modules/skills/skills.service.ts` | Add `SELF_WRAPPED_SKILL_KEYS` gate (skip `runGuardedEgress` for postiz/chatwoot); record tool cost via `UsageService` | C-07, C-09 |
| `apps/api/src/modules/engines/support/support-webhook.controller.ts` | `findFirst`→`findUnique` (account lookup); `findFirst`+branch → `upsert` (conversation) | S-07 |
| `apps/api/src/modules/usage/usage.service.ts` | Add `totalCostForCompany()` wrapper; extend `RecordUsageParams` with `costUsdOverride` | C-09 |
| `apps/api/src/modules/usage/tool-cost-rates.ts` *(new)* | Illustrative per-tool cost table | C-09 |
| `apps/api/src/modules/employees/runtime/agent-runtime.service.ts` | Extend `assertUnderBudget` with company-level check | C-09 |
| `apps/api/src/modules/retention/data-retention.service.ts` | Add Support models to sweep; add doc-comment excluding `MarketingConsent`/`MarketingSuppression`/connector-account rows | S-09, M-13 |
| `apps/api/src/modules/workflow-templates/marketing-workflow-templates.catalog.ts` + `.catalog.spec.ts` | Rewire `mkt.email-campaign`'s consent gate to a `TOOL_ACTION` | M-08 |
| `apps/api/prisma/schema.prisma` | See §9 | S-13, M-06, S-07, C-09 |
| Various `*.spec.ts` / `*.e2e-spec.ts` | Update tests currently asserting soon-to-be-wrong behavior (finding 4, §4) | S-04, S-02 |

---

## 9. Database Migrations Required

| # | Change | Gap | Data-safety notes |
|---|---|---|---|
| 1 | `SupportConversationStatus` enum: add `ESCALATED` | S-13/C-06 | Additive enum value; zero risk |
| 2 | New `HandoffStatus` enum + `HandoffRequest` model (FK → `SupportConversation`, `Company`) | S-13/C-06 | New table; zero risk to existing data |
| 3 | New `ToolIdempotencyRecord` model (`@@unique([companyId, skillKey, tool, idempotencyKey])`) | M-06 | New table; zero risk |
| 4 | `ChatwootAccount.chatwootAccountId` → add `@@unique` | S-07 | **Requires pre-migration check:** `SELECT "chatwootAccountId", array_agg("companyId") FROM "ChatwootAccount" GROUP BY 1 HAVING COUNT(*) > 1;` — any hit must be manually resolved (confirm rightful owner, delete/reassign the other) before the migration can apply |
| 5 | `SupportConversation` — convert `@@index([companyId, chatwootConversationId])` to `@@unique` | S-07 | **Requires pre-migration check:** `SELECT "companyId", "chatwootConversationId", array_agg(id) FROM "SupportConversation" GROUP BY 1,2 HAVING COUNT(*) > 1;` — any hit requires reassigning `SupportMessage.conversationId` to a canonical row before deleting duplicates |
| 6 | `Company.monthlySpendCapUsd Float?` | C-09 | Additive nullable column; zero risk, null = unlimited (matches `AiEmployee.budgetLimit`'s convention) |
| 7 | Optional (P2, not required for the P1 fix): `SensitiveScenarioFlag` model + 2 enums | S-06 | Purely additive; may be deferred to ship the audit-log-only version first |

**Standing project gotcha, reconfirmed applicable:** every one of these migrations must be authored via
`prisma:migrate:new` and its generated SQL read by hand before `prisma:migrate` applies it, per this repo's own
documented pgvector/HNSW-index false-drift gotcha (root `CLAUDE.md`) — **no CI migration-lint step exists** (confirmed
by the test-infra recon pass), so this remains a manual discipline, not an automated gate, for every migration above.

**Environments with real data that the two dedup checks (#4, #5) must run against before merging:** at minimum the
dev/QA environment referenced in project memory as having a live tenant. This baseline does not run those queries —
they require DB access this planning pass does not have — and is flagged as a pre-implementation action item, not
assumed clean.

---

## 10. Tests Required

All new tests must follow the repo's established conventions (confirmed by direct recon, not assumed):
`describeIfDb` gating on `process.env.DATABASE_URL`; `Test.createTestingModule({imports:[AppModule]}).compile()` +
real HTTP via `supertest`; `overrideProvider(SKILL_EXECUTOR_TOKEN)` when a test must reach real executor code
regardless of ambient `SKILL_EXECUTOR`; resilience unit tests pass `null` for the Redis client (in-memory-fallback
path, no `ioredis-mock`); **every new/changed behavior must pass under `pnpm test` (`state_machine`)**, and should
also be run under `WORKFLOW_ENGINE_MODE=legacy_walk pnpm test` for anything touching the two gate files (S-01/S-04),
since this repo's own CI treats a `legacy_walk` failure as reportable, not blocking, but its own history (5 gaps
hidden in a durable-only run, per `api-ci.yml`'s comments) is the explicit reason both are still checked.

| Gap | Test file (new unless noted) | Scenario |
|---|---|---|
| S-02 | `real-skill-executor.spec.ts` (update existing case) | `resolve_conversation` returns `ok:false`/`NOT_IMPLEMENTED`; `SupportConversation.status` unchanged in DB |
| S-04 | `engines-support.e2e-spec.ts` (extend) | EVENT-triggered workflow, no APPROVAL node, no approvalRules → run reaches `WAITING` with a PENDING `ApprovalRequest`; `ChatwootClientService.sendReply` NOT called until approved |
| S-04 | Existing chat-path spec(s) (update) | Immediate-execution assertions flip to `pendingApproval:true` |
| S-01 | `engines-support.e2e-spec.ts` (extend) | Low-confidence AI_EMPLOYEE_STEP draft → downstream TOOL_ACTION reply pauses for approval even though the tool itself isn't `highRisk`-flagged for this reason |
| S-01 | `tool-approval-policy.spec.ts` (new) | Unit coverage of `contextHasUnresolvedValidationConcern` |
| S-06 | `sensitive-scenario.service.spec.ts` (new) | Keyword-stage cases (refund/legal/PII/identity/deletion/security) offline; one LLM-stage-only paraphrase case (mock LLM) |
| S-06 | `engines-support.e2e-spec.ts` (extend) | A refund+legal-threat message forces an approval pause even with high raw confidence |
| S-13/C-06 | `handoff.service.spec.ts` (new) | Confirms `HandoffService` delegates to `ApprovalRoutingService.resolveInitial`/`canDecide`, does not reimplement resolution |
| S-13/C-06 | `handoff.e2e-spec.ts` (new) | Full lifecycle: escalate → `SupportConversation.status='ESCALATED'` → a new inbound webhook message does NOT trigger a new AI reply (zero new `SkillExecution` rows) → routed assignee resolves via new endpoint → status returns to `OPEN` |
| S-13/C-06 | `engines-support.e2e-spec.ts` (extend) | Direct attempt at `chatwoot.reply_to_conversation` against an `ESCALATED` conversation returns `ok:false` (defense-in-depth, independent of trigger suppression) |
| M-06 | `marketing-production.e2e-spec.ts` (extend) | Same `schedule_post` TOOL_ACTION run twice (simulated retry) → exactly ONE `ScheduledPost` row, ONE `postizClient.schedulePost()` call |
| M-06 | `tool-idempotency.service.spec.ts` (new) | Concurrent same-key calls → one `effect()` runs; `FAILED` prior record allows retry; `COMPLETED` outside window allows a fresh attempt |
| C-07 | `resilient-client.base.spec.ts` (new) | `guardedFetch` trips/recovers correctly; uses the passed `resourceKey` verbatim |
| C-07 | `marketing-sync.service.spec.ts` (extend) | 5 consecutive `listPosts()` failures → 6th sweep call short-circuits (`CircuitOpenError`) without calling `fetch` — proves the sweep path, not just TOOL_ACTION, is now protected |
| C-07 | New Chatwoot-equivalent test | Two companies' `ChatwootClientService` calls — one company's tripped breaker does NOT affect the other's `resourceKey` |
| M-07/C-10 (via C-07) | Extend the `resilient-client.base.spec.ts` or a dedicated case | Global Postiz resource key enforces the 90/hr budget across two different companies' calls combined, even though neither individually approaches its own bucket |
| S-07 | `support-webhook.controller.spec.ts` (extend) | Two concurrent `applyPayload`-equivalent calls for the same new `(companyId, chatwootConversationId)` → exactly ONE `SupportConversation` row; inserting two `ChatwootAccount` rows with the same `chatwootAccountId` for different companies → second throws `P2002` |
| C-09 | `company-budget-cap.e2e-spec.ts` (new) | Company `monthlySpendCapUsd` exceeded via `usage.record()` calls → chat call on an employee with a null *own* budget still gets `409 Conflict` |
| C-09 | `skills.service.spec.ts` (extend) | Costed tool call invokes `usage.record` with the right `costUsdOverride` |
| S-09 | Retention spec (existing file, extend) | `RESOLVED` conversation older than the policy window (+messages) is pruned; `OPEN` conversation and the `ChatwootAccount` row are untouched; `preview()`/dry-run reports matching counts without deleting |
| M-08 | `marketing-consent.e2e-spec.ts` or new `marketing-email-campaign-consent.e2e-spec.ts` | `mkt.email-campaign` run for an address with no `MarketingConsent` row reaches a blocked/failed terminal state despite a trigger claiming `consentVerified:true`; after `recordConsent(GRANTED)`, the same run proceeds |
| M-10 | `postiz-client.service.spec.ts` (extend) | New analytics methods — correct URL/headers, mocked `fetch` |
| M-10 | `marketing-analytics.e2e-spec.ts` (new) | `snapshotAnalytics()` writes a `MarketingAnalyticsSnapshot` row from a mocked (`overrideProvider`) Postiz response; chat/workflow-level test that `postiz.get_post_analytics` surfaces the mocked shape via the LLM tool-call path |

**"Tests are part of implementation" (governing Rule 16) — restated for this baseline:** none of the above count as
done merely because the file exists; each must actually be run (`pnpm test` at minimum, both engine modes for the
gate-touching ones) and its result recorded in the phase-completion report this baseline's governing instructions
require, with exact command + result, not "tested" as an unverified claim.

---

## 11. Risks

1. **The `deployment` branch promotion (C-15) is the single highest-leverage, highest-blast-radius action in this
   entire plan and is explicitly NOT included in the implementation scope below** — fast-forwarding 15 commits / 23
   migrations onto a branch Vercel builds and deploys automatically is a production deploy, not a baseline-phase
   code change, and needs its own explicit go/no-go decision, ideally with a migration dry-run against a staging
   copy of the `deployment`-era schema first (§9's dedup checks are a prerequisite for two of those 23 migrations
   specifically, S-07's).
2. **S-04's behavior change is real and user-visible, not just internally corrective.** Flagging the two Chatwoot
   tools `highRisk:true` means the *interactive chat path* (an operator manually replying to a customer via chat)
   will now also pause for approval, where today it doesn't (unless `approvalRules` already forced it). This is the
   intended fix, but it changes existing UX and must be communicated, not silently shipped as "just a bug fix."
3. **S-07's migrations require a real, human-executed data-remediation step before they can apply**, in any
   environment with existing rows (confirmed a live QA tenant exists per project memory) — this is not a
   zero-touch migration and must not be scheduled as if it were.
4. **S-01's scan-based (not per-node-precise) approach to context-threading fails safe but can over-trigger** in a
   future complex/parallel Support workflow graph (a stray unrelated low-confidence draft elsewhere in the graph
   could force an unnecessary approval). Acceptable today (no Support templates exist yet to have this problem, per
   S-14 correctly remaining deferred) but should be revisited before Support workflow templates are ever authored.
5. **M-10's analytics numbers must not be presented to customers as real until a `REAL_PROVIDER_VERIFIED` pass runs
   against an actual Postiz instance.** The DTOs are built from documented, not source-verified, response shapes.
6. **S-02's honest-failure fix, by itself, does not restore the "resolve" capability** — it converts a lie into a
   correctly-reported gap. Until the real `toggleStatus` call is added (deferred, pending source-grounding or a live
   instance), any customer-facing claim that "AI Support can resolve tickets" remains false and should not be made.
7. **C-07's differing resource-key strategy (global for Postiz, per-company for Chatwoot) is a judgment call reasoned
   from each provider's current deployment shape** (one shared Postiz instance vs. one Chatwoot account per tenant).
   If Postiz's per-company `Customer`/group isolation (M-12, still open, out of this baseline's scope) is ever built,
   this key strategy should be revisited — it is currently correct for the system as it exists, not a permanent
   architectural assumption.
8. **Sequencing risk:** items 2, 3, and 4 in §7 (S-04+S-01, then S-06, then Handoff) all touch
   `agent-runtime.service.ts`/`workflow-engine.service.ts`/`approval-gate.service.ts` in overlapping ways across
   three separate changes — recommend one engineer/session owning all of Phase 1 (P0s) end-to-end rather than
   parallelizing across people, to avoid merge conflicts in the gate-condition logic specifically.

---

## 12. Rollback Strategy

- **Catalog/policy-only changes (S-04, most of S-01, S-02's honest-failure version, M-08's template rewire, C-07's
  `SELF_WRAPPED_SKILL_KEYS` gate)** — no schema involved; rollback is a plain code revert, safe at any time, no data
  implications.
- **New-table migrations (`HandoffRequest`, `ToolIdempotencyRecord`, optional `SensitiveScenarioFlag`)** — additive
  only; rollback is `DROP TABLE`/revert migration with zero risk to any other data, since nothing else references
  these tables yet.
- **`Company.monthlySpendCapUsd`** — additive nullable column; rollback is a plain column drop, no risk (defaults to
  "unlimited" behavior when absent, matching current behavior exactly).
- **S-07's constraint migrations (#4, #5 in §9)** — the only migrations with a genuine forward-then-back
  consideration: rollback is `DROP CONSTRAINT` + recreate the prior plain index, which is safe and non-destructive
  in either direction (no data is dropped by either the forward or backward migration) — but the **remediation
  step** run before the forward migration (reassigning `SupportMessage.conversationId` off deleted duplicate
  `SupportConversation` rows) is not automatically reversible, since the duplicate rows are deleted, not archived.
  Recommend the remediation script **archive** (not hard-delete) any `SupportConversation` row it merges away, as a
  precaution, even though the design above didn't originally specify this — flagging it here as a rollback-safety
  addition to make before running remediation in any environment with real data.
- **Retention sweep extension (S-09)** — this is the one change category where "rollback" doesn't fully apply once
  executed: pruned `SupportMessage`/`SupportConversation` rows are genuinely deleted, by design (that's the point of
  retention). The safety net is the sweep's existing `preview()`/dry-run contract — **every environment's first run
  after this change must use `preview()` and have a human confirm the counts before the first live run**, not trust
  the code review alone.
- **Governance (deployment branch promotion, out of this baseline's implementation scope)** — if pursued later,
  rollback is `git revert`/redeploy the prior `deployment` tip, but the 23 migrations it would apply are forward-only
  at the database level per Prisma's model; a staging rehearsal is the real safety net, not a code-level rollback.

---

**STOP. This is the baseline only. No implementation has begun. Awaiting explicit approval before proceeding to
Phase 1 (§7, items 1-2: S-02, then S-04+S-01).**
