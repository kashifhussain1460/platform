-- Role-based hiring plans (docs/product/2026-09-04-role-based-hiring-plans.md), rule R5:
-- every employee's monthly credit ceiling (`budgetLimit`, stored in USD) starts at,
-- and may never exceed, the plan's `creditsPerEmployeePerMonth`.
--
-- New hires get the default stamped in `EmployeesService.create()`. This backfills
-- the employees that already exist so a customer's roster is within its plan on
-- day one — otherwise a pre-existing employee with `budgetLimit = NULL` (unlimited)
-- would sit beside a new one capped at $5, and the "up to 500 credits on your plan"
-- hint in Settings would be a lie for half the roster.
--
-- Plan ceilings (500 credits = $5 at the 100-credits-per-dollar peg):
--   STARTER (Free), PRO (Starter), BUSINESS (Growth)  -> $5
--   ENTERPRISE                                          -> none (left untouched)
--
-- Only NULL (unlimited) or ABOVE-ceiling values are changed; anything a customer
-- already set lower is theirs and stays. Idempotent: a second run matches no rows.
-- Archived employees are skipped — they are off the roster and out of the rules.
--
-- No runtime effect until CREDIT_LEDGER_ENABLED + CREDIT_ENFORCEMENT_ENABLED are on
-- (the founder sign-off in docs/product/2026-08-20-credit-economics-decision.md);
-- until then this is the stored intent the UI reads, not a live block.
UPDATE "AiEmployee" e
   SET "budgetLimit" = 5
  FROM "Subscription" s
 WHERE s."companyId" = e."companyId"
   AND s.plan IN ('STARTER', 'PRO', 'BUSINESS')
   AND e."archivedAt" IS NULL
   AND (e."budgetLimit" IS NULL OR e."budgetLimit" > 5);
