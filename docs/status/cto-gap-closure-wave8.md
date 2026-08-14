# WAVE 8 — Chaos + DR + Retention

Status record for `orlixa-cto-master-gap-closure-plan(1).md` WAVE 8.
Date: 2026-08-13.

The rule this wave is judged by is the plan's own: *"A backup is not
operationally proven until restoration is tested."* Everything below is
recorded from something that was actually run, or is marked as not done.

---

## Gate

| Gate item | Status | Evidence |
| --- | --- | --- |
| Backup restore tested | ✅ | `infra/backup/verify.sh` run against the live database — 14 critical tables matched exactly (§1) |
| RPO defined | ✅ (with a caveat stated) | `docs/ops/disaster-recovery.md` §1 — 24h on dumps alone; 5min needs provider PITR, **not enabled** |
| RTO defined | ✅ | 1 hour, from a **measured** 4s restore + verification overhead |
| Workflow recovery tested | ✅ | Real process kill mid-run; run resumed and executed exactly once (§3) |
| Retention tested | ✅ | `data-retention.e2e-spec.ts` — 10/10 pass |
| Legal hold tested | ✅ | Hold blocks the sweep; release lets it proceed; scope respected |
| Object storage recovery tested | ✅ | 664 objects captured + count-verified by `verify.sh` |

**§8.1 is not fully closed:** LLM timeout has no test. See §4.

---

## 1. §8.2 Backup / Restore — DONE, proven

New: `infra/backup/{backup.sh,restore.sh,verify.sh}`, `docs/ops/disaster-recovery.md`.

Nothing existed before this wave — no backup script, no restore path, no RPO or
RTO. The gap was recorded as a P0 in the 2026-07-12 enterprise-readiness audit
and was still open.

`verify.sh` takes a real backup, restores it into a throwaway database, and
compares it table by table. Actual output:

```
--- 3. compare restored data against source ---
TABLE                            SOURCE     RESTORED   RESULT
Company                            4258         4258   ok
User                               4130         4130   ok
Workflow                           4176         4176   ok
WorkflowVersion                    4215         4215   ok
WorkflowRun                        7618         7618   ok
WorkflowStepRun                   16355        16355   ok
WorkflowStepAttempt                1165         1165   ok
ApprovalRequest                    1378         1378   ok
AuditLog                          10578        10578   ok
KnowledgeDocument                   555          555   ok
KnowledgeChunk                      405          405   ok
EmployeeMemory                     1143         1143   ok
StaffMember                         303          303   ok
InstalledSkill                     1715         1715   ok

--- 4. workflow state recovered? ---
step runs orphaned from their run: 0  ok
runs restored still in flight (recoverable by the reaper): 156

--- 5. object storage ---
objects captured: 664  ok

 VERIFIED — backup is restorable
 measured: backup 2s, restore 4s
```

Points worth stating plainly:

- **Both stores are backed up.** A database-only backup restores a system full
  of `storageKey` values pointing at files that no longer exist — it looks
  healthy until someone opens a document. `verify.sh` counts objects for exactly
  this reason.
- **`ENCRYPTION_KEY` is not in the backup and must be kept separately.** HR
  special-category PII and connector credentials are stored as ciphertext.
  Losing the key is equivalent to losing the data, and no database backup can
  save you from it.
- **Dumps are gitignored** (`infra/backup/artifacts/`). The first run produced a
  5 MB file containing every tenant's data; it was not ignored, and now is.
- **The 5-minute RPO is not real yet.** It requires WAL archiving/PITR on the
  managed instance, which this repository does not enable. The doc says so, and
  says not to quote it to a customer until it has been rehearsed.

---

## 2. §8.3 Retention — DONE

New: `modules/retention/` (`DataRetentionService`, `RetentionController`),
migration `20260813000000_wave8_legal_hold_scope`, cron `data-retention`
(nightly 04:00 in `vercel.json`).

### What the plan asked for, and where it now lives

| Class | Before | Now |
| --- | --- | --- |
| workflow runs | ❌ nothing | ✅ terminal runs only, archived first |
| step attempts | ❌ | ✅ (cascade, counted before delete) |
| outbox | ❌ | ✅ |
| audit | ✅ `AuditRetentionService` | unchanged — own 365-day floor |
| knowledge | ❌ | ✅ rows **and** their files |
| memory | ❌ | ✅ |
| HR data | ✅ `HrRetentionService` | unchanged |
| attachments | ❌ | ✅ blob deleted with its row |
| provider snapshots | ❌ | ✅ RawEvent + CanonicalEvent |
| conversations / skill executions | ❌ | ✅ (beyond the plan's list) |

Supported operations: normal deletion (nightly cron), **legal hold**, archive
(NDJSON to object storage before runs are deleted), manual deletion
(`POST /retention/run-now`), scheduled deletion, **preview**
(`GET /retention/preview`, deletes nothing), and audit evidence
(`data.retention.deleted` with per-class counts).

### Three rules the service will not bend

1. **A legal hold stops everything**, checked before any cutoff arithmetic.
2. **In-flight runs are never deleted** — deleting a `WAITING` run destroys a
   live approval and strands whoever was waiting on it.
3. **A row and its bytes go together** — deleting a `KnowledgeDocument` while
   its upload stays in the bucket means the data was not deleted, which is the
   only thing an erasure request actually checks.

### Legal hold widened beyond audit

`AuditLegalHold` → `LegalHold` with a `scope` (`ALL` | `AUDIT`). A hold that
froze the audit trail while the nightly sweep deleted the workflow runs and
documents under dispute was a legal hold in name only. The table is **not**
renamed (`@@map`), and **existing holds are backfilled to `AUDIT`** so nothing
someone placed months ago silently changes what their system deletes tonight.
New holds default to `ALL`.

### Test result — actually run

```
PASS test/data-retention.e2e-spec.ts (7.655 s)
  √ deletes an expired terminal run, its steps and its outbox rows
  √ ARCHIVES a run before deleting it
  √ NEVER deletes an in-flight run, however old
  √ deletes an expired document AND the file behind it
  √ sweeps memory, conversations, skill executions and provider snapshots
  √ records the deletion in the audit trail
  √ a legal hold stops the sweep entirely
  √ an AUDIT-scoped hold does not freeze operational data
  √ preview reports what WOULD go, and deletes nothing
  √ a company with no retention policy is never swept
Tests: 10 passed
```

### A real hazard found while writing these tests

The first version of the suite called the cross-tenant `sweep()`. Against the
shared development database — **44 tenants with a retention policy, 7,696
workflow runs** — that would have deleted other tenants' data. It hung for ten
minutes before being stopped; row counts confirmed it had not yet reached the
delete stage (KnowledgeDocument 555, EmployeeMemory 1143, AuditLog 10578, all
unchanged against the backup baseline). The test now drives `runForCompany`
against its own fixture and the reason is written into the test.

---

## 3. §8.1 Chaos — MOSTLY DONE (1 gap)

New: `test/chaos.e2e-spec.ts` (9 tests), `docs/ops/chaos-drills.md`.

```
PASS test/chaos.e2e-spec.ts (8.126 s)
  √ worker crash: the attempt is failed as OUTCOME UNKNOWN, never silently retried
  √ a live lease is left alone
  √ no phantom success: a crashed run never reports COMPLETED
  √ no tenant leak: the reaper does not touch another company
  √ duplicate queue job: the same idempotency key produces ONE run
  √ a DIFFERENT key still starts its own run
  √ no approval bypass: a breached approval does not self-approve
  √ API restart: a WAITING run survives the process going away
  √ no secret leak: a failure message does not carry credentials
Tests: 9 passed
```

### The real process-kill drill (recorded)

Not a mock. The API on :4000 was killed with `taskkill /F` while run
`cmsqgjs5d0039fuicrlx62qrm` was `WAITING` on an approval:

```
after crash + restart:  WAITING   (state survived in Postgres)
after approving:        COMPLETED
  trigger                    TRIGGER           COMPLETED  attempt=1
  approval-0d7b72b9          APPROVAL          COMPLETED  attempt=1
  ai_employee_step-0f485f23  AI_EMPLOYEE_STEP  COMPLETED  attempt=1
AI step executed exactly once: True
```

### Coverage of the fourteen scenarios

Ten are automated, three are drills with documented commands (Redis restart, DB
connection loss, deployment-during-workflow — these need the infrastructure to
actually be taken away, and an in-process mock of "Redis went away" proves
nothing about a real outage), and **one is not covered at all**.

### ⚠️ Gap: LLM timeout (#10)

There is no test for a model provider that hangs. The abort seam exists, but
"would work" is not evidence — and an `AI_EMPLOYEE_STEP` is both the
longest-running node type and the one most exposed to a third party's latency.
**§8.1 should not be reported as fully closed until this exists.**

---

## 4. What this wave did NOT do

Stated so the next wave does not inherit a false picture:

- **PITR / WAL archiving is not enabled.** The 5-minute RPO is aspirational.
- **No off-site backup copy.** `backup.sh` writes locally; production must sync
  to a different failure domain, and that is deployment configuration.
- **No automated restore rehearsal in CI.** `verify.sh` exists and passes, but
  nothing runs it on a schedule yet. An untested backup decays silently.
- **Backup retention vs erasure requests.** A backup is a copy of personal data.
  An erasure request is not complete until the backups holding that data age
  out. Documented in the DR doc; no tooling enforces it.
- **LLM timeout chaos test** (above).
