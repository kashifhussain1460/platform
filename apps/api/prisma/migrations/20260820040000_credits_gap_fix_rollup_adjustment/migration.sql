-- Gap fix: CreditUsageDailyRollup was silently dropping ADJUSTMENT ledger
-- entries (Task 10.2's manual adjustments never appeared in Task 10.4's
-- finance reporting).
ALTER TABLE "CreditUsageDailyRollup" ADD COLUMN "creditsAdjusted" DECIMAL(18,6) NOT NULL DEFAULT 0;
