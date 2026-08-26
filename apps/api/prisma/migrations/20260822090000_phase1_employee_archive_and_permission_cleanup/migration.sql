-- Phase 1 — Critical Production Safety Fixes.
--
-- 1) AiEmployee.archivedAt — soft delete, mirroring Workflow.archivedAt.
--    DELETE /employees/:id was an unguarded cascading delete that destroyed
--    conversations, messages, memories, feedback, EmployeeSkill grants AND the
--    employee's InstalledSkill rows (their encrypted credentials). It now
--    archives by default; ?hard=true is OWNER-only and dependency-checked.
ALTER TABLE "AiEmployee" ADD COLUMN "archivedAt" TIMESTAMP(3);

-- Partial index: the roster query is `archivedAt IS NULL`, which is the
-- overwhelming majority of rows, so index only the archived ones that list
-- endpoints need to exclude cheaply as the table grows.
CREATE INDEX "AiEmployee_companyId_archivedAt_idx" ON "AiEmployee" ("companyId", "archivedAt");

-- 2) Clear the legacy all-false `permissions` objects.
--
--    Until now `AiEmployee.permissions` was written by the Settings panel and
--    read by nobody. The panel's `toFlags()` helper turned a NULL record into
--    `{sendEmail:false, contactCustomers:false, makePayments:false,
--    accessKnowledge:false}`, so merely OPENING Settings and pressing Save
--    persisted "everything denied" — a state no user chose and no code
--    enforced.
--
--    Phase 1 starts enforcing `false` as DENY. Leaving those rows as-is would
--    revoke email, messaging, support-reply and payment tools from every
--    employee whose settings had ever been saved, the moment this deploys.
--    That is an outage dressed as a security fix.
--
--    So: reset to '{}' (= "not configured" = allowed, preserving exactly
--    today's runtime behaviour) ONLY where every one of the four keys is
--    explicitly false — the precise fingerprint of the default-writing bug.
--    Any employee with a genuine mix of true/false is left untouched, and an
--    admin who really did mean "deny all four" can re-tick them against a
--    panel that now actually enforces the answer.
UPDATE "AiEmployee"
SET "permissions" = '{}'::jsonb
WHERE "permissions" IS NOT NULL
  AND "permissions" @> '{"sendEmail": false, "contactCustomers": false, "makePayments": false, "accessKnowledge": false}'::jsonb;

-- 3) Drop the two approval-rule flags that never had an enforceable meaning.
--
--    `approveOverBudget`: budgetLimit is a HARD BLOCK today (ConflictException
--    in AgentRuntimeService.assertUnderBudget), not an approval trigger, so
--    "require approval over budget" had no existing mechanism to bind to.
--    `approveRefunds`: no refund tool exists anywhere in the skill catalog.
--    Both were checkboxes writing JSON nothing read. Removed rather than given
--    invented semantics.
UPDATE "AiEmployee"
SET "approvalRules" = ("approvalRules" - 'approveOverBudget' - 'approveRefunds')
WHERE "approvalRules" IS NOT NULL
  AND ("approvalRules" ? 'approveOverBudget' OR "approvalRules" ? 'approveRefunds');
