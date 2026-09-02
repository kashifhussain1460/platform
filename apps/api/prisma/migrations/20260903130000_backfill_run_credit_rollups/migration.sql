-- Backfill the run/step credit rollups and the ledger's workflow attribution.
--
-- Three columns that were fully plumbed — column, DTO, mapper, and a rendered
-- UI — with nothing writing them:
--
--   WorkflowRun.totalCreditsCharged   incremented only inside a branch that
--                                     early-returns on the default creditLimit
--                                     = NULL, so it stayed 0 for every run
--   WorkflowStepRun.creditsCharged    no writer anywhere in the repository
--   CreditLedger.workflowId           no caller ever passed it
--
-- The 2026-09-02 audit watched a run debit a real credit against a real balance
-- (1000 -> 999) while `RunCreditPanel` told the customer "Credits 0 - No
-- billable steps in this run yet", and `/billing/usage` showed "-" in its
-- Workflow column for spend it could have attributed exactly.
--
-- The writers are fixed in code (CreditReservationService.rollUpSpendOntoRun and
-- CreditLedgerService.resolveWorkflowId). This migration repairs the history,
-- because a customer reconciling last month's bill should not have to know which
-- release they were on.
--
-- The CreditLedger is the source of truth here, not a recomputation: these sums
-- come from the DEBIT rows that actually moved the balance.

-- 1. Per-run actual spend.
--
--    `creditLimit IS NULL` mirrors the guard in `rollUpSpendOntoRun`: a run WITH
--    a cap has its counter maintained at RESERVATION time by
--    CreditLimitsService (it must reserve against the ceiling before spending),
--    so overwriting it with settled actuals would understate what the cap has
--    already committed.
--
--    `totalCreditsCharged = 0` keeps this safe to re-run and stops it touching
--    any run a fixed build has already accounted for.
UPDATE "WorkflowRun" r
   SET "totalCreditsCharged" = agg.total
  FROM (
        SELECT "workflowRunId" AS run_id,
               SUM(ABS(amount)) AS total
          FROM "CreditLedger"
         WHERE "workflowRunId" IS NOT NULL
           AND "transactionType" = 'DEBIT'
         GROUP BY "workflowRunId"
       ) agg
 WHERE r.id = agg.run_id
   AND r."creditLimit" IS NULL
   AND r."totalCreditsCharged" = 0;

-- 2. Per-step actual spend.
--
--    Only where it is still NULL. NULL is meaningful on this column — it is how
--    a control-flow node (WAIT, CONDITION, TRIGGER) that never reserves is
--    distinguished from a cost-bearing node that happened to cost nothing, and
--    `RunCreditPanel` reads exactly that distinction to decide which steps to
--    list. Steps with no DEBIT are left NULL on purpose.
UPDATE "WorkflowStepRun" s
   SET "creditsCharged" = agg.total
  FROM (
        SELECT "workflowStepRunId" AS step_id,
               SUM(ABS(amount)) AS total
          FROM "CreditLedger"
         WHERE "workflowStepRunId" IS NOT NULL
           AND "transactionType" = 'DEBIT'
         GROUP BY "workflowStepRunId"
       ) agg
 WHERE s.id = agg.step_id
   AND s."creditsCharged" IS NULL;

-- 3. Which workflow each spend belongs to.
--
--    Every transaction type, not just DEBIT: a RESERVATION and its RELEASE are
--    part of the same automation's story, and a billing table that attributed
--    the debit but not the hold would be harder to read than one that attributed
--    neither.
UPDATE "CreditLedger" l
   SET "workflowId" = r."workflowId"
  FROM "WorkflowRun" r
 WHERE l."workflowRunId" = r.id
   AND l."workflowId" IS NULL;
