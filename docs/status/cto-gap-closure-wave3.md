# CTO Gap Closure — WAVE 3: Approval + Canonical Events (P0/P1)

**Date:** 2026-08-12
**Authority:** `docs/implementation/workflow-system/orlixa-cto-master-gap-closure-plan(1).md` §WAVE 3
**Predecessors:** WAVE 0 baseline · WAVE 1 durable execution · WAVE 2 authorization

---

## 1. What changed, in one sentence

Every external event now enters through **one** pipeline — verify → RawEvent → dedup →
CanonicalEvent → trigger → durable run — instead of two engines writing straight into their own
tables; Plane gained the inbound half it never had; and `postiz.publish_now` stopped being able to
post twice.

---

## 2. §3.2/§3.3 — one canonical pipeline, two signature schemes

The connector edge (`POST /connectors/:id/webhook`) already implemented the full pipeline. The
engines did not use it.

New leaf `CanonicalIngestModule` / `CanonicalIngestService.ingestVerified()` holds the part that is
identical for every provider:

```
RawEvent (append-only) → dedup on sha256(signed body) → normalize job
       → CanonicalEvent → tenant resolution → trigger matching → durable run
```

**Signature verification deliberately stays with each engine.** The plan warns not to assume Plane
signs like Chatwoot, and it doesn't: Chatwoot HMACs `timestamp.body` into `x-chatwoot-signature`,
Plane HMACs the raw body into `x-plane-signature` with no timestamp. A shared verifier would have
to guess, and a signature check that guesses is not a signature check.

Dedup is keyed on a hash of the **signed body**, never a delivery-id header — the HMAC covers the
body but not the header, so an attacker replaying one captured valid request with a mutated header
would defeat header-based dedup and mint a fresh run, with real side effects, every time.

### A module cycle this exposed

Importing `EventsModule` into `SupportModule` closed
`Skills → Support → Events → Skills` (Events needs Skills for connector credentials; Skills needs
Support for the shared Chatwoot client). Nest refused to instantiate, and **every events and
approvals e2e suite failed at module construction rather than at an assertion** — a failure mode
worth recognising quickly. Fixed by forking the ingest into a leaf module depending on neither,
the same shape as WAVE 1's `EngineModeModule`.

---

## 3. §3.4 — Chatwoot: KEEP + REFACTOR

Before: HMAC verified, then `SupportConversation` / `SupportMessage` written directly. **No
RawEvent, no dedup, no CanonicalEvent, no workflow trigger, no audit.**

Two consequences, both live:

1. **Redelivery duplicated data.** Every webhook provider retries on timeout; each retry appended
   the same customer message again, for ever.
2. **No workflow could react to support at all.** There was no event for an EVENT trigger to match,
   so the entire support surface was invisible to automation.

Now: verify → `ingestVerified` → **if deduped, stop** → local state → audit. The dedup guard sits
*before* the local write, so the unique `(connectorId, bodyHash)` row is what arbitrates concurrent
duplicates.

The controller enriches the stored payload with two facts a pure mapper cannot derive — the
resolved conversation id and whether this is the conversation's first message. That is what
separates `NEW_TICKET` from `TICKET_REPLIED`.

**Outgoing messages are deliberately not events.** They are our own side effects coming back, and
mapping them is how a support workflow ends up replying to itself in a loop — real messages, to a
real customer, indefinitely.

---

## 4. §3.5 — Plane: the missing half

Plane had a client that could push work out and **nothing that could come back**. No controller, no
module, no route. So no workflow could ever react to an issue being created or moved.

Added `PmWebhookController` (`POST /engines/pm/webhook`) + `PmModule`:

- verifies `x-plane-signature` against the per-workspace encrypted secret, over the **literal
  received bytes** (re-serialising changes key order and whitespace, and the HMAC would never
  match — pinned by a test, not left to a comment);
- resolves the tenant from the `PlaneWorkspace` row, never from the payload;
- ingests through the shared pipeline, with the same dedup guard;
- audits the delivery.

New canonical types `NEW_PROJECT_ISSUE` / `PROJECT_ISSUE_UPDATED` — deliberately **not** reusing
`NEW_JIRA_ISSUE`, so a workflow triggering on "a Jira issue was created" does not start firing for
Plane the day Plane is connected.

The Plane dedupe key carries the action and the update timestamp, so an *update* never dedupes
against the *create* of the same issue, nor two different updates against each other, while the
same update redelivered stays one event.

---

## 5. §3.6 — Postiz `publish_now` could post twice

`postiz.schedule_post` created a `ScheduledPost`. `postiz.publish_now` created **nothing** — it
called Postiz and returned the provider id. So:

- a retried `TOOL_ACTION` published the same content to the same social account again — public and
  irreversible;
- reconciliation could not see it (the sync walks `ScheduledPost` rows);
- nothing tied the publish to the run that caused it.

This is not theoretical: the first-party marketing templates use `publish_now` behind the highRisk
auto-gate, and WAVE 1's retry work makes retries more likely, not less.

Now the intent is recorded **before** the provider call and completed after it, keyed by
`idempotencyKey` (migration `20260812000000_wave3_publish_idempotency`, partial-unique per
company). A crash mid-call leaves a visible non-`PUBLISHED` row an operator can reconcile, rather
than a post that exists at the provider and nowhere else.

**Documented trade:** the key is content-derived (`sha256(socialAccountId + content)`, 24-hour
window) because `ExecutorContext` carries no run/step correlation to key on. An *intentional*
re-post of byte-identical content to the same account inside the window is therefore treated as a
duplicate. Publishing the same thing twice by accident is both likelier and more damaging, and the
window bounds the surprise. Threading run correlation into `ExecutorContext` would remove the
trade — noted in §7.

---

## 6. §3.1 — approval routing: already met, verified not assumed

Shipped in P3-05 and re-verified here (8 e2e tests green):

| Plan target | Implementation |
|---|---|
| `assignedToUserId?` / `assignedToTeamId?` / `assignedToDepartmentId?` | one normalised `(approverRuleType, approverRuleValue)` pair — USER / ROLE / DEPARTMENT / TEAM / EMPLOYEE_MANAGER / ANY_ADMIN — which is strictly more general than three nullable columns |
| `fallbackRole` | the unrouted fallback (OWNER/ADMIN) plus `ANY_ADMIN` as an escalation tier |
| SLA | `slaMinutes` / `dueAt` / `timeoutPolicy` + the 5-minute sweep |
| escalation chain | `chainId` / `level` / `escalationTier` / `escalatedToId` |

"Never silently bypass approval because an approver is unavailable" holds: a USER-routed request is
decidable only by that user — there is no admin override — and the sanctioned answer to
unavailability is an SLA escalation chain reaching `ANY_ADMIN`.

---

## 7. WAVE 3 gate

| Gate item | Status | Evidence |
|---|---|---|
| Chatwoot inbound events use canonical event pipeline | ✅ | `support-webhook.controller.spec.ts` — ingest called with provider `chatwoot`, before the local write |
| Plane inbound events implemented and verified | ✅ | `pm-webhook.controller.spec.ts` — 7 tests (signed / forged / missing / unknown workspace / duplicate / literal-bytes) |
| Postiz publish actions are tracked | ✅ | `real-skill-executor.spec.ts` — intent row before the call, `PUBLISHED` + provider id after |
| Duplicate external events are safe | ✅ | dedup guard tested on both engines; a duplicate Chatwoot delivery writes no second `SupportMessage` |
| Approval routing works for person/team/department | ✅ | `approval-routing.e2e-spec.ts` (4) + `approval-sla.e2e-spec.ts` (4) |
| Event-to-workflow transitions are durable | ✅ | canonical → `fireEvent` → `enqueueRun` → WAVE 1 durable dispatch; `event-ingestion.e2e-spec.ts` proves the chain |

### Test results (2026-08-12)

| Check | Result |
|---|---|
| `pnpm -w run typecheck` | **PASS** — 5/5 packages |
| Unit | **PASS — 459 tests, 56 suites** (was 437/54 after WAVE 2; +11 mapper, +7 Plane, +3 Chatwoot, +1 publish dedup) |
| Targeted e2e (events, approvals, support) | **19/20** — the 1 failure is the pre-existing `engines-support` chat-loop test |

Full regression: §9.

---

## 8. Honestly NOT done in this wave

- **§3.6 reconciliation, consent/suppression, provider failure recovery.** Only the tracking +
  idempotency half of Postiz is done. There is no suppression list and no consent model at all, so
  "suppression/consent enforcement" is a build, not a fix. Provider failure now leaves a `FAILED`
  row but nothing sweeps it.
- **Run correlation in `ExecutorContext`.** Would let publish idempotency key on the attempt rather
  than the content, removing the trade in §5, and would give every tool call audit correlation.
- **Plane outbound provisioning** still throws `NOT YET IMPLEMENTED` — it needs a live Plane
  instance to verify the session-based sequence against. Unchanged by this wave; the inbound half
  does not depend on it.
- **Chatwoot signature replay window.** The body-hash dedup makes an identical replay harmless, but
  no timestamp/nonce window bounds capture-replay of distinct-but-stale bodies. Carried over from
  the connector edge, where it is already noted as a follow-up.
- **No browser E2E.** Per WAVE 7's rule, none is claimed.

---

## 9. Full e2e regression

Run against the final WAVE 3 code:

```
Test Suites: 3 failed, 64 passed, 67 total
Tests:       6 failed, 402 passed, 408 total
```

**Zero regressions** — byte-identical to the WAVE 2 result: the same 6 tests in the same 3
pre-existing suites (`analytics` 3, `auth-email-verification` 2, `e2e/engines-support` 1). The e2e
count is unchanged because WAVE 3's own tests are all unit tests: the engine webhooks are pure
controller logic over a signature, a dedup guard and a mapper, and every one of those is testable
without Postgres, Redis or a live provider. Choosing that deliberately is why WAVE 3 added 22 tests
that run in under a second rather than 22 that need infrastructure.

The one caveat worth stating: `engines-support`'s failure is in the **chat tool-calling loop**, not
the webhook, and it predates this wave — but it does mean the Support engine has a red test that
should be triaged before Chatwoot is relied on in production.

---

## WAVE 3 gate: **PASSED with the §8 exceptions recorded.** WAVE 4 (Audit) may begin.
