-- Credit system Phase 10, Task 10.3: reconciliation schema.
CREATE TABLE "ReconciliationRun" (
    "id" TEXT NOT NULL,
    "dateUtc" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'RUNNING',

    CONSTRAINT "ReconciliationRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ReconciliationRun_dateUtc_idx" ON "ReconciliationRun"("dateUtc");

CREATE TABLE "ReconciliationDiscrepancy" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "leg" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReconciliationDiscrepancy_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ReconciliationDiscrepancy_runId_idx" ON "ReconciliationDiscrepancy"("runId");

ALTER TABLE "ReconciliationDiscrepancy" ADD CONSTRAINT "ReconciliationDiscrepancy_runId_fkey"
    FOREIGN KEY ("runId") REFERENCES "ReconciliationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ProviderInvoice" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "amountUsd" DECIMAL(12,2) NOT NULL,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderInvoice_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ProviderInvoice_provider_periodStart_idx" ON "ProviderInvoice"("provider", "periodStart");
