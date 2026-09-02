-- WorkflowRun.actingEmployeeId: from dead column to the platform's primary link.
--
-- The column has existed since the durable-runtime migration. The 2026-09-02
-- audit found it had exactly ONE reference in the repository — the line that
-- declares it — while the PRD's headline claim was that every run is attributed
-- to an AI Employee. This migration gives it a foreign key, an index, and the
-- history it never had.
--
-- Hand-written rather than generated: `prisma migrate dev` cannot represent the
-- HNSW index on KnowledgeChunk.embedding (Unsupported("vector")) and offers to
-- DROP it as drift. See platform/CLAUDE.md.

-- 1. The lookup the employee detail page and per-employee KPI table need.
--    Without it, "everything this employee did" is a full scan of the tenant's
--    entire run history, once per employee card.
CREATE INDEX "WorkflowRun_companyId_actingEmployeeId_createdAt_idx"
  ON "WorkflowRun"("companyId", "actingEmployeeId", "createdAt");

-- 2. Backfill, BEFORE the constraint exists.
--
--    Deliberately ordered this way: the join to "AiEmployee" below is what
--    guarantees only live, same-tenant ids are written, so running the backfill
--    first cannot leave a row that then fails to satisfy the new constraint.
--
--    The rule matches `actingEmployeeIdForGraph` in
--    src/modules/workflows/engine/employee-references.ts exactly — the employee
--    of the FIRST employee-bearing node in definition order — so a historical
--    run and a new run are attributed by the same rule. WITH ORDINALITY is what
--    makes "first" mean the array's own order rather than whatever order
--    Postgres happens to unnest in.
WITH graph AS (
  SELECT
    r.id                                        AS run_id,
    r."companyId"                               AS company_id,
    COALESCE(v.definition, w.definition)        AS def
  FROM "WorkflowRun" r
  JOIN "Workflow" w ON w.id = r."workflowId"
  -- The pinned version when the run has one, the legacy column otherwise: the
  -- same fallback the engine itself uses, so attribution can never describe a
  -- graph other than the one that actually ran.
  LEFT JOIN "WorkflowVersion" v ON v.id = r."workflowVersionId"
  WHERE r."actingEmployeeId" IS NULL
    -- Guards the lateral below: jsonb_array_elements errors on a non-array, and
    -- a graph this cannot read must yield "no employee", never a failed migration.
    AND jsonb_typeof(COALESCE(v.definition, w.definition) -> 'nodes') = 'array'
),
candidates AS (
  SELECT
    g.run_id,
    g.company_id,
    n.ordinality                                AS pos,
    n.value -> 'config' ->> 'employeeId'        AS employee_id
  FROM graph g
  CROSS JOIN LATERAL
    jsonb_array_elements(g.def -> 'nodes') WITH ORDINALITY AS n(value, ordinality)
),
picked AS (
  SELECT DISTINCT ON (c.run_id)
    c.run_id,
    c.employee_id
  FROM candidates c
  -- Same tenant AND still exists. An employee hard-deleted since the run
  -- happened simply leaves that run unattributed, which is honest.
  JOIN "AiEmployee" e
    ON e.id = c.employee_id
   AND e."companyId" = c.company_id
  WHERE c.employee_id IS NOT NULL
    AND c.employee_id <> ''
    -- A `{{template}}` placeholder resolves at execution time from run context.
    -- It is not an id and must never be stored as a foreign key.
    AND c.employee_id NOT LIKE '%{{%'
  ORDER BY c.run_id, c.pos
)
UPDATE "WorkflowRun" r
   SET "actingEmployeeId" = p.employee_id
  FROM picked p
 WHERE r.id = p.run_id;

-- 3. The constraint.
--
--    SET NULL, not CASCADE: a run's history must survive the hard deletion of
--    the employee that performed it. Deleting an AI Employee already archives by
--    default and a hard delete is OWNER-only and blocked on live dependencies —
--    but if one does happen, the audit trail loses a name, not a record.
ALTER TABLE "WorkflowRun"
  ADD CONSTRAINT "WorkflowRun_actingEmployeeId_fkey"
  FOREIGN KEY ("actingEmployeeId") REFERENCES "AiEmployee"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
