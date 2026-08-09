# Database Migration Plan — Orlixa Workflow System

**Date:** 2026-08-01 · **Status:** plan only — **no migration applied**
**Baseline:** `apps/api/prisma/schema.prisma` — **38 models, 29 migrations applied**
**Target:** `docs/architecture/database/2026-08-01-complete-database-design.md` (57 models) +
`docs/architecture/workflow-system/12-database.md`
**Proposed Prisma source:** `proposed-prisma-changes.prisma` (separate file, this directory)

---

## 0. Headline findings

### 0.1 Every change is additive

19 tables to add, columns to add, indexes to add. **Zero shipped models are absent from the target**,
so there is no `DROP TABLE`, no `DROP COLUMN`, and no type narrowing anywhere in this plan. That is the
single biggest risk reducer available, and it holds without compromise.

The only `DEPRECATE` items are two columns that stay in place, keep working, and are simply no longer
written to.

### 0.2 🔴 A live performance defect found during the diff

**`WorkflowStepRun` has no index on `runId`.** Its only index is `@@index([companyId])`.

Yet `WorkflowsService.getRun()` (`workflows.service.ts:352-355`) does:

```ts
include: { steps: { orderBy: { createdAt: 'asc' } } }
```

which emits `SELECT … FROM "WorkflowStepRun" WHERE "runId" = $1`. This is the **run-log polling
endpoint** — the UI calls it roughly once per second while a run is open. Every poll is a sequential
scan of the highest-volume table in the system, filtered on an unindexed column.

`workflow-engine.service.ts:617` (`completePausedApproval`) has the same problem.

This is not a future concern. It is degrading now and gets worse linearly with run history. **It is
fixed first, in Migration 01, ahead of all feature work** — a two-line change with immediate benefit
and no dependency on anything else in this plan.

### 0.3 Two more missing indexes on hot paths

| Missing | Query that needs it | Where |
|---|---|---|
| `ApprovalRequest(companyId, workflowRunId)` | The G25 gate's "already approved?" lookup, on every gated `TOOL_ACTION` | `workflow-engine.service.ts:594` |
| `WorkflowRun(companyId, status)` | "list active runs"; the reaper's stuck-run sweep | analytics + P1-05 |

### 0.4 The standing pgvector hazard

`prisma migrate dev` emits a spurious `DROP INDEX "KnowledgeChunk_embedding_idx"` because Prisma
cannot model the HNSW index on an `Unsupported("vector")` column. **This has occurred on three
consecutive migrations.**

**Mandatory procedure for every migration below, no exceptions:**
1. Author with `pnpm --filter @vaep/api prisma:migrate:new` (= `migrate dev`)
2. **Open the generated SQL and delete any `DROP INDEX ..._embedding_idx` line**
3. Apply with `pnpm --filter @vaep/api prisma:migrate` (= `migrate deploy`)
4. Verify: `SELECT indexname FROM pg_indexes WHERE indexname = 'KnowledgeChunk_embedding_idx';`

Step 4 is not optional. A silently dropped HNSW index degrades all RAG retrieval to a sequential scan,
and nothing fails loudly when it happens.

---

## 1. Change classification

### 1.1 `Workflow` — ADD COLUMN · ADD INDEX

| Change | Class | Notes |
|---|---|---|
| `activeVersionId`, `draftVersionId` | ADD COLUMN (nullable) | FK to `WorkflowVersion`, `onDelete: SetNull` |
| `versions WorkflowVersion[]` | MODIFY RELATION | Back-relation, additive |
| `category WorkflowCategory?` | ADD COLUMN | Library/marketplace grouping |
| `sourceTemplateId`, `sourceTemplateVersion` | ADD COLUMN | Provenance (doc 19 §6.1) — copy, not a live link |
| `archivedAt DateTime?` | ADD COLUMN | Pairs with `status = ARCHIVED` |
| `definition Json` | **DEPRECATE** | 🔴 **Column stays.** Becomes read-only after backfill; the source of truth moves to `WorkflowVersion.definition`. Never dropped in this plan |
| `@@index([companyId, status])` | ADD INDEX | List-by-status |
| existing columns/indexes | **NO CHANGE** | |

### 1.2 `WorkflowVersion` — ADD TABLE

New. Immutable once `PUBLISHED` (ADR-002) — enforced in the service layer, since Postgres has no
"immutable row" primitive. A trigger was considered and rejected: it would block legitimate admin
repair and is invisible to developers reading the Prisma schema.

Unique: `@@unique([workflowId, version])`. Index: `@@index([companyId, workflowId])`.

### 1.3 `WorkflowRun` — ADD COLUMN · ADD INDEX · ADD CONSTRAINT

| Change | Class | Notes |
|---|---|---|
| `workflowVersionId String?` | ADD COLUMN | 🔴 Nullable **on purpose** — pre-existing runs have no version. Never backfilled to a guess |
| `idempotencyKey String?` | ADD COLUMN | |
| `@@unique([companyId, idempotencyKey])` | ADD CONSTRAINT | Partial — nullable keys don't collide in Postgres |
| `deadlineAt DateTime?` | ADD COLUMN | Run-level timeout (`TIMED_OUT`) |
| `failureClass String?` | ADD COLUMN | 🔴 **String, not an enum** — matches `RunFailureClass` but app-validated, so adding a class needs no migration |
| `actingEmployeeId`, `startedByUserId` | ADD COLUMN | Attribution (doc 09) |
| `attempts`, `timers`, `joins`, `outbox` | MODIFY RELATION | Back-relations |
| `@@index([companyId, status])` | ADD INDEX | 🔴 §0.3 |
| `@@index([status, deadlineAt])` | ADD INDEX | Reaper — deliberately **not** tenant-prefixed (§4.2) |
| `@@index([companyId, workflowId, createdAt])` | ADD INDEX | "recent runs of workflow X" |
| `@@index([companyId, workflowVersionId])` | ADD INDEX | |
| existing columns | **NO CHANGE** | `resumeNodeId`, `context`, `dryRun`, `correlationId` all keep current semantics |

### 1.4 `WorkflowStepRun` — ADD INDEX · ADD COLUMN

| Change | Class | Notes |
|---|---|---|
| `@@index([runId])` | ADD INDEX | 🔴🔴 **§0.2 — the live defect. Ship first.** |
| `@@index([runId, status])` | ADD INDEX | Timeline + `completePausedApproval` |
| `attempt Int @default(1)` | ADD COLUMN | Current attempt number |
| `attempts WorkflowStepAttempt[]` | MODIFY RELATION | |
| `type String` | **NO CHANGE** | 🔴 Deliberately stays `String`, not the `NodeType` enum — adding a node type must not require a migration. Validated in the app |
| `status StepRunStatus` | ADD ENUM VALUE | `RETRYING`, `WAITING`, `COMPENSATED` — additive |

### 1.5 Node execution — ADD TABLE ×3

`WorkflowStepAttempt` · `WorkflowRunTimer` · `WorkflowJoinState`.

`WorkflowStepAttempt` is the **highest-volume table in the system** (§4.3): one row per attempt,
targeting 10M/day. Its indexes are chosen for exactly two queries — attempt history for a run, and
the reaper's expired-lease sweep — and nothing else, because every extra index is a write cost paid
10M times a day.

Lease claim needs `@@index([leaseExpiresAt])` filtered to `RUNNING`; a partial index is used (§4.4).

### 1.6 `ApprovalRequest` — ADD INDEX · ADD CONSTRAINT

| Change | Class | Notes |
|---|---|---|
| `@@index([companyId, workflowRunId])` | ADD INDEX | 🔴 §0.3 — G25 gate lookup |
| FK `workflowRunId → WorkflowRun` | ADD CONSTRAINT | 🔴 **Currently there is NO foreign key** — an orphaned approval can point at a deleted run. `onDelete: Cascade` |
| `nodeId String?` | ADD COLUMN | Which node opened it (the G25 gate currently encodes this in `description` as `[node:x]` — a string hack that works but should not persist) |
| `slaDueAt`, `escalatedAt` | ADD COLUMN | Doc 08 routing/SLA |
| existing columns | **NO CHANGE** | |

> The `[node:x]`-in-description trick I shipped with the G25 fix is honest but ugly. `nodeId` replaces
> it. The migration keeps parsing `description` as a fallback until backfill completes, so no
> in-flight approval breaks.

### 1.7 Variables — ADD TABLE ×2

`WorkflowVariable` (values, mutable, keyed to `Workflow`) and `WorkflowSecretRef`.

🔴 **Declared variables live in `WorkflowVersion.definition` JSON (versioned, immutable); stored
values live in `WorkflowVariable` rows (mutable, keyed to the Workflow).** Conflating these was a real
error caught in review — a `variables` relation was declared on `WorkflowVersion` with no other side,
which would have failed `prisma validate`. Do not reintroduce it.

🔴 `WorkflowSecretRef` stores a **reference**, never a value. Secrets resolve at execution through the
connector layer.

### 1.8 Events — ADD TABLE

`RunEventOutbox`. `BigInt @id @default(autoincrement())` — `seq` ordering comes from the database, not
the workers. Index `@@index([publishedAt, id])` serves the relay's only query (unpublished, in order).

`RawEvent` / `CanonicalEvent`: **NO CHANGE.**

### 1.9 Audit — ADD TABLE · DEPRECATE

`AuditEvent` (hash-chained) is added **alongside** `AuditLog`. `AuditLog` is **DEPRECATE, not dropped**
— it holds real history that must remain queryable. Dual-write during transition; cut reads over only
after parity is proven; the table stays indefinitely.

### 1.10 Analytics — ADD TABLE ×3

`WorkflowMetricDaily`, `NodeMetricDaily`, `EmployeeMetricDaily`. Rollups, not hot-path. Unique on
`(companyId, <dimension>, day)` so the rollup job is idempotent and re-runnable.

### 1.11 HR domain — ADD TABLE ×6

`StaffMember`, `LeaveRequest`, `StaffDocument`, `PerformanceReview`, `OnboardingTask`,
`AttendanceRecord`. Independent of the runtime work; can migrate in parallel.

🔴 Special-category PII (passport numbers, sick-leave reasons). Encrypted at rest via the existing
`CryptoService`; never logged; excluded from LLM prompts.

### 1.12 Enums — ADD VALUE (all additive)

| Enum | Add |
|---|---|
| `WorkflowStatus` | `ARCHIVED` |
| `WorkflowRunStatus` | `CANCELLED`, `COMPENSATING`, `TIMED_OUT` |
| `StepRunStatus` | `RETRYING`, `WAITING`, `COMPENSATED` |
| `EmployeeRole` | `MARKETING` (**G10**) |
| new | `WorkflowVersionStatus`, `WorkflowCategory` |

Postgres `ALTER TYPE … ADD VALUE` is non-destructive and non-blocking. **It cannot be run inside a
transaction block in older Postgres** — see §5.3.

🔴 **Open decision D4:** the schema already contains **both** spellings —
`SlotStatus.CANCELLED` (double L) and `SubscriptionStatus.CANCELED` (single L). Adding
`WorkflowRunStatus.CANCELLED` locks both in permanently. Settle the convention **before** Migration 05;
afterwards it needs a data migration.

---

## 2. Migration sequence

Twelve migrations, ordered so each is independently deployable and rollback-safe. **No migration
depends on application code shipping first.**

| # | Name | Class | Risk | Blocking? |
|---|---|---|---|---|
| **01** | `add_hotpath_indexes` | ADD INDEX | 🟢 none | 🔴 **ship immediately** |
| **02** | `add_marketing_role` | ADD ENUM VALUE | 🟢 none | Unblocks 11 workflows (G10) |
| **03** | `add_workflow_archived_status` | ADD ENUM VALUE | 🟢 none | G29 prerequisite |
| **04** | `add_workflow_versions` | ADD TABLE + COLUMN | 🟡 low | |
| **05** | `backfill_workflow_v1` | **DATA MIGRATION** | 🟠 medium | Rehearse on a copy |
| **06** | `add_run_execution_columns` | ADD COLUMN + INDEX + CONSTRAINT | 🟡 low | |
| **07** | `add_node_execution_tables` | ADD TABLE ×3 | 🟡 low | |
| **08** | `add_outbox` | ADD TABLE | 🟢 none | |
| **09** | `add_approval_fk_and_index` | ADD INDEX + CONSTRAINT | 🟠 medium | FK validation scans |
| **10** | `add_variables_and_templates` | ADD TABLE ×3 | 🟢 none | |
| **11** | `add_audit_and_analytics` | ADD TABLE ×4 | 🟢 none | |
| **12** | `add_hr_domain` | ADD TABLE ×6 | 🟢 none | Parallelisable |

### 2.1 Migration 01 — ship this week, independent of everything

```sql
-- 🔴 The live defect. getRun() polls this ~1/s per open run with no index.
CREATE INDEX CONCURRENTLY "WorkflowStepRun_runId_idx"        ON "WorkflowStepRun"("runId");
CREATE INDEX CONCURRENTLY "WorkflowStepRun_runId_status_idx" ON "WorkflowStepRun"("runId","status");
CREATE INDEX CONCURRENTLY "WorkflowRun_companyId_status_idx" ON "WorkflowRun"("companyId","status");
CREATE INDEX CONCURRENTLY "ApprovalRequest_companyId_workflowRunId_idx"
  ON "ApprovalRequest"("companyId","workflowRunId");
```

Pure benefit, no schema change, no application change, instantly rollback-able (`DROP INDEX`).

🔴 **`CREATE INDEX CONCURRENTLY` cannot run inside a transaction, and Prisma wraps each migration file
in one.** Two options — recommend (a):

- **(a) Out-of-band, recommended.** Apply via `psql` during a maintenance window, then add a
  no-op-if-exists Prisma migration so the schema history stays honest. `CONCURRENTLY` does not take a
  write lock, so it is safe on a live table.
- (b) Plain `CREATE INDEX` inside a normal Prisma migration — simpler, but takes an `ACCESS EXCLUSIVE`
  lock. On a large `WorkflowStepRun` that is a write outage. Acceptable only on a small table.

### 2.2 Migration 05 — the only real data migration

Backfill each `Workflow.definition` into a `WorkflowVersion` v1 `PUBLISHED`, then point
`activeVersionId` at it.

```
FOR EACH workflow w WHERE NOT EXISTS (SELECT 1 FROM WorkflowVersion WHERE workflowId = w.id):
    INSERT WorkflowVersion(workflowId, companyId, version=1,
                           status='PUBLISHED', definition=w.definition, createdAt=w.createdAt)
    UPDATE Workflow SET activeVersionId = <new id> WHERE id = w.id
```

**Properties that make it safe:**
- **Idempotent** — the `NOT EXISTS` guard means re-running is a no-op.
- **Batched** — 500 workflows per transaction, so a failure rolls back one batch, not the estate.
- **Non-destructive** — `Workflow.definition` is left untouched and still readable.
- **Reversible** — rollback is `DELETE FROM "WorkflowVersion"` + `SET activeVersionId = NULL`.
- **Backwards compatible** — the old engine keeps reading `definition` throughout.

**Rehearse on a restored production copy and diff the row counts before running for real.**

### 2.3 Migration 09 — the one with a real locking risk

Adding `FOREIGN KEY (workflowRunId) REFERENCES "WorkflowRun"(id)` validates every existing row.

```sql
-- Step 1: add without validating — takes only a brief lock.
ALTER TABLE "ApprovalRequest"
  ADD CONSTRAINT "ApprovalRequest_workflowRunId_fkey"
  FOREIGN KEY ("workflowRunId") REFERENCES "WorkflowRun"("id") ON DELETE CASCADE NOT VALID;

-- Step 2: validate separately — takes only SHARE UPDATE EXCLUSIVE, does not block writes.
ALTER TABLE "ApprovalRequest" VALIDATE CONSTRAINT "ApprovalRequest_workflowRunId_fkey";
```

The `NOT VALID` → `VALIDATE` split is what keeps this online. A single `ADD CONSTRAINT` would hold a
lock for the whole scan.

🔴 **Check for orphans first** — if any exist, step 2 fails:

```sql
SELECT count(*) FROM "ApprovalRequest" a
 WHERE a."workflowRunId" IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM "WorkflowRun" r WHERE r.id = a."workflowRunId");
```

Non-zero means G29's hard delete already destroyed runs while leaving their approvals behind. Those
rows must be nulled or archived before validating — and that count is itself useful evidence of the
damage G29 has done.

---

## 3. Backwards compatibility

The **expand → migrate → contract** pattern, with contract deferred indefinitely.

| Guarantee | How |
|---|---|
| Existing workflows keep running | `Workflow.definition` untouched; legacy engine reads it unchanged |
| Existing runs keep resolving | `workflowVersionId` nullable; null = pre-versioning, handled explicitly |
| Existing API responses unchanged | All new columns are additive and optional in DTOs |
| Old clients keep working | No column removed, no type narrowed, no field renamed |
| Rollback needs no data loss | Every migration's down is `DROP` of new objects only |

**Nothing in this plan requires application code to deploy first.** Migrations 01–12 can all be applied
to the current running system without a code change. That decoupling is deliberate: it means a
migration failure is never entangled with a deploy failure.

---

## 4. Indexes and high-volume strategy

### 4.1 Execution-query indexes

| Query | Index |
|---|---|
| Steps for a run (polling) | `WorkflowStepRun(runId)` 🔴 |
| Timeline | `WorkflowStepRun(runId, status)` |
| Attempts for a run | `WorkflowStepAttempt(runId, attempt)` |
| Reaper: expired leases | `WorkflowStepAttempt(leaseExpiresAt)` partial `WHERE status='RUNNING'` |
| Reaper: overdue runs | `WorkflowRun(status, deadlineAt)` |
| Active runs per tenant | `WorkflowRun(companyId, status)` |
| Recent runs of a workflow | `WorkflowRun(companyId, workflowId, createdAt)` |
| Due timers | `WorkflowRunTimer(fireAt)` partial `WHERE firedAt IS NULL` |
| Outbox relay | `RunEventOutbox(publishedAt, id)` |
| G25 gate | `ApprovalRequest(companyId, workflowRunId)` |

### 4.2 Tenant-safe indexing

**Rule: every index serving an API query leads with `companyId`.** It is the highest-selectivity
predicate and it makes cross-tenant scans structurally unattractive.

**Two deliberate exceptions**, both background sweeps that are correctly cross-tenant:
`WorkflowRun(status, deadlineAt)` and `WorkflowStepAttempt(leaseExpiresAt)`. Prefixing these with
`companyId` would force the reaper into a per-tenant loop. **The queries using them must still filter
by the row's own `companyId` after loading** (doc 16 §20) — the index is cross-tenant; the
authorisation is not.

### 4.3 High-volume tables

| Table | Est. volume | Strategy |
|---|---|---|
| `WorkflowStepAttempt` | **10M/day** | Minimal indexes; monthly `RANGE` partition on `createdAt`; retention drops whole partitions |
| `WorkflowStepRun` | ~2M/day | Index `runId`; partition when > 100M rows |
| `RunEventOutbox` | ~5M/day | **Delete after publish + 24h** — a queue, not a log |
| `WorkflowRun` | ~500k/day | Partition on `createdAt` when > 50M |
| `AuditEvent` | ~1M/day | Append-only; archive to cold storage, never delete |

**Partitioning is deliberately deferred, not designed in now.** Prisma does not model partitioned
tables, so it needs raw SQL and a migration-history workaround. Introducing that complexity before the
volume exists would cost more than it saves. The trigger to act is `WorkflowStepAttempt` > 100M rows —
monitor row count monthly.

**`RunEventOutbox` deletion is not optional.** At 5M rows/day an unpruned outbox becomes the largest
table in the database within a month, and its relay query degrades with it.

### 4.4 Partial indexes

```sql
CREATE INDEX "WorkflowStepAttempt_lease_idx"
  ON "WorkflowStepAttempt"("leaseExpiresAt") WHERE "status" = 'RUNNING';
CREATE INDEX "WorkflowRunTimer_due_idx"
  ON "WorkflowRunTimer"("fireAt") WHERE "firedAt" IS NULL;
```

Both target a tiny hot subset of a huge table. Prisma cannot express partial indexes — they go in as
raw SQL inside the migration, and **must be re-added by hand if the table is ever recreated.**

### 4.5 Retention

| Data | Retain | Mechanism |
|---|---|---|
| `RunEventOutbox` (published) | 24h | Hard delete, hourly |
| `WorkflowStepAttempt` | per `SecurityPolicy.dataRetentionDays` | Drop partition |
| `WorkflowStepRun` / `WorkflowRun` | same | Batched delete, then partitions |
| `AuditEvent` | ≥ 7 years | Archive, **never delete** |
| HR documents | per jurisdiction | Policy-driven; legal-hold aware |

🔴 Retention must respect **legal hold**. A deletion job that ignores an active dispute destroys
evidence. Gate every retention sweep on a hold check before it is enabled.

---

## 5. Rollback

### 5.1 Per-migration

| # | Rollback | Data loss |
|---|---|---|
| 01 | `DROP INDEX` | none |
| 02, 03 | 🔴 **enum values cannot be dropped** — see §5.3 | none (unused value is inert) |
| 04, 07, 08, 10, 11, 12 | `DROP TABLE` / `DROP COLUMN` | only new data |
| 05 | `DELETE FROM "WorkflowVersion"` + null `activeVersionId` | none — `definition` intact |
| 06 | `DROP COLUMN` / `DROP INDEX` | only new columns |
| 09 | `DROP CONSTRAINT` | none |

### 5.2 Ordering

Roll back in **strict reverse** (12 → 01). Dropping `WorkflowVersion` before nulling
`Workflow.activeVersionId` fails on the FK.

### 5.3 🔴 Postgres enum values cannot be removed

`ALTER TYPE … DROP VALUE` does not exist. Once `MARKETING` or `ARCHIVED` is added it is permanent
short of recreating the type and rewriting every dependent column.

**Consequences, both accepted:**
- Enum migrations (02, 03) are **effectively irreversible**. They are also **harmless** — an unused
  value costs nothing.
- Because they are irreversible, **D4 (`CANCELLED`/`CANCELED`) must be settled before Migration 05.**

`ALTER TYPE … ADD VALUE` also cannot run inside a transaction block on Postgres < 12. Verify the
server version; if affected, apply enum migrations standalone.

### 5.4 Full-restore path

For anything worse than a single-migration rollback: PITR restore to immediately before the migration
started.

🔴 **This path is currently unavailable — there are no rehearsed backups** (doc 25, gate G-2).
**Rehearse a restore before Migration 05**, the only migration that writes data. Migrations 01–04 are
safe without it; 05 onward are not.

---

## 6. Pre-flight checklist (every migration)

- [ ] Rehearsed on a restored production copy
- [ ] Generated SQL reviewed line by line
- [ ] **`DROP INDEX ..._embedding_idx` removed** (§0.4)
- [ ] Rollback SQL written and tested
- [ ] Lock impact assessed (`NOT VALID` / `CONCURRENTLY` where needed)
- [ ] Row counts recorded before and after
- [ ] `prisma validate` passes
- [ ] Post-apply: HNSW index still present

## 7. Recommended immediate action

**Apply Migration 01 now, on its own.**

It fixes a live sequential scan on a polling endpoint, requires no application change, has no
dependency on any other work in this plan, and rolls back with `DROP INDEX`. It is the cheapest
performance win available in the codebase.

Then Migration 02 (G10) — one enum value that unblocks eleven production workflows.

**Do not start Migration 05 until a backup restore has been rehearsed.**
