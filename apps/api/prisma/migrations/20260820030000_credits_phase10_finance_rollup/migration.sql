-- Credit system Phase 10, Task 10.4: nightly finance rollup table.
CREATE TABLE "CreditUsageDailyRollup" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL DEFAULT '',
    "day" TIMESTAMP(3) NOT NULL,
    "creditsGranted" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "creditsConsumed" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "creditsRefunded" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreditUsageDailyRollup_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CreditUsageDailyRollup_day_idx" ON "CreditUsageDailyRollup"("day");

CREATE UNIQUE INDEX "CreditUsageDailyRollup_companyId_employeeId_day_key" ON "CreditUsageDailyRollup"("companyId", "employeeId", "day");
