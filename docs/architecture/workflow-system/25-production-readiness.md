# 25 — Production Readiness (L2)

> **Level:** L2.
> **Extends:** `status/2026-07-12-enterprise-readiness-audit.md` (113 lines) — which predates this
> entire workflow architecture and is therefore stale for it — and the operational sections of
> `architecture/backend/2026-08-01-backend-implementation.md`.
> **Purpose:** the go-live gate for the workflow system specifically. Not a general SaaS checklist.

---

## 1–5. Purpose, scope, dependencies

A workflow run has irreversible side effects — it sends email, moves money, posts publicly. "Mostly
working" is not a viable state. This document is the list that must be green before the state machine
carries a real tenant's automation.

---

## 6. Readiness gates

### G-1 — Correctness
- [ ] Doc 24 §28 acceptance criteria all pass
- [ ] Chaos suite green (5 experiments)
- [ ] e2e green in **both** engine modes
- [ ] No known-flaky suites

### G-2 — Data safety 🔴
- [ ] **G29 fixed** — deleting a workflow cannot erase run history
- [ ] Automated Postgres backups with a **restore actually rehearsed** (an untested backup is not a
      backup)
- [ ] PITR window defined and documented
- [ ] Retention job runs under `/admin/workflow-retention/run-now` (ledger R8)
- [ ] Migration rollback procedure written, including the pgvector index trap

### G-3 — Security
- [ ] G25 gate active in the shipping engine (✅ legacy; must be re-verified after W3)
- [ ] Tenant-isolation suite covers every id-route
- [ ] No secret in any job payload (automated scan)
- [ ] `ENCRYPTION_KEY` from a secret manager, not `.env`
- [ ] Leaked API keys from the 2026-07-12 audit rotated and confirmed revoked
- [ ] SSRF guard covers `HTTP_REQUEST` including post-redirect DNS
- [ ] `DB_QUERY` restricted to the catalog
- [ ] Dependency scan clean (no known criticals)
- [ ] R12 approval-guard loosening signed off or reverted

### G-4 — Reliability
- [ ] `app.enableShutdownHooks()` present so deploys drain (✅ fixed)
- [ ] Rolling deploy verified not to abandon in-flight jobs
- [ ] Reaper recovers orphans < 60s under a kill test
- [ ] All queues in `DLQ_KNOWN_QUEUES` (✅ two were missing, fixed)
- [ ] DLQ has an owner and a documented drain procedure
- [ ] Redis eviction policy `noeviction` where BullMQ lives — an evicted job is silent data loss
- [ ] Behaviour verified when Redis is unavailable

### G-5 — Observability
- [ ] Structured logs with `correlationId` on every runtime line
- [ ] RED metrics per queue and per `nodeType`
- [ ] Alerts live: oldest-job-age > 5 min, outbox lag > 1 min, lease expiries > 10/min, any DLQ arrival
- [ ] Dashboard answers: "is anything stuck?", "what failed and why?", "are we within §0.8?"
- [ ] Tracing run → step → attempt

### G-6 — Performance
- [ ] Every §0.8 target measured under load, not assumed
- [ ] Nightly regression baselines with a 20% failure threshold
- [ ] Prisma connection pooling configured (prerequisite for serverless)
- [ ] Per-tenant fairness cap verified — one tenant cannot starve others

### G-7 — Operability
- [ ] Runbooks: stuck run, DLQ drain, outbox lag, mass lease expiry, bad deploy rollback
- [ ] `WORKFLOW_ENGINE_MODE` flip documented and rehearsed in both directions
- [ ] On-call knows how to cancel a runaway run
- [ ] Cost per run visible before the first big tenant

### G-8 — Compliance
- [ ] G31 AGPL posture resolved for wrapped engines
- [ ] Audit log immutable and hash-chained (doc 10)
- [ ] Data-subject deletion path exists and is audited
- [ ] Retention honours `dataRetentionDays`

---

## 7. Cutover procedure (W3)

```
1. Ship state machine behind WORKFLOW_ENGINE_MODE=legacy_walk (default). No behaviour change.
2. Flip a throwaway tenant → state_machine. Run the full e2e suite against it.
3. Soak 24h. Watch: lease expiries, DLQ arrivals, outbox lag, p95.
4. Flip one low-volume real tenant. Soak 48h.
5. Flip remaining tenants in ascending volume order.
6. Live Kashif Recruiting tenant LAST.
7. Remove the legacy walk only after every tenant has run 7 days clean.
```

**Rollback:** flip the flag back. This is why the legacy walk is not deleted in step 6 — a rollback
that requires a deploy is not a rollback.

## 8. Go / no-go

**No-go if any of these is true:** G-2 or G-3 has an unchecked box; a chaos experiment fails; there is
no rehearsed restore; alerting is not live; the runbooks do not exist.

Everything else is a judgement call. Those five are not.

## 9. Known gaps at time of writing

| Gap | Severity | Status |
|---|---|---|
| No CI | 🔴 | Blocks everything (roadmap W0.5) |
| No backups/restore rehearsal | 🔴 | Open |
| G29 hard delete | 🔴 | Open — needs migration |
| No APM/tracing | 🟠 | Open |
| Leaked keys (2026-07-12 audit) | 🔴 | **Verify rotation** |
| BullMQ concurrency 1 | 🟠 | Addressed by doc 16 §14 |
| No pagination on list endpoints | 🟠 | Open |
| SSO / audit-log sold but not built | 🟠 | Open (enterprise sales risk) |
| G18 guardrail | 🟡 | Needs product decision |

## 10. Definition of Done

- [ ] Every G-1…G-8 box checked or explicitly waived with a named owner and date
- [ ] Cutover rehearsed on a throwaway tenant end to end
- [ ] Rollback rehearsed
- [ ] Go/no-go reviewed by eng + product + security

---

**Next:** `99-l2-readiness-report.md`.
