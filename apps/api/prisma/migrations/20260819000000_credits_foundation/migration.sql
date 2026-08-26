-- Credit system Phase 1 — Foundation
-- docs/architecture/orlixa-ai-credit-usage-billing-plan.md, Part 5 §41 Task 1.1.
--
-- Additive only: every statement below is CREATE TYPE / CREATE TABLE / ADD
-- COLUMN (nullable, or defaulted for NOT NULL columns). Zero DROP, zero
-- ALTER COLUMN TYPE, zero RENAME. Nothing in the running application reads
-- or writes these new tables/columns yet (Task 1.5's CreditsModule ships
-- empty) — this is the longest-soak, lowest-risk phase in the plan.
--
-- Hand-authored (non-interactive shell, same convention as
-- 20260807030000_refresh_token_store and 20260813000000_wave8_legal_hold_scope):
-- `prisma migrate dev` requires an interactive TTY this environment doesn't
-- have. No pgvector impact (this migration never touches KnowledgeChunk).

-- CreateEnum
CREATE TYPE "CreditReservationStatus" AS ENUM ('PENDING', 'SETTLED', 'RELEASED', 'EXPIRED_UNKNOWN');

-- CreateEnum
CREATE TYPE "CreditRefundStatus" AS ENUM ('COMPLETED', 'REJECTED');

-- AlterTable: UsageEvent — closes gap G11 (no workflow-run/step attribution
-- on cost telemetry). Plain columns, no FK (diverges from this model's own
-- Convention-A companyId relation on purpose — see schema.prisma comment).
ALTER TABLE "UsageEvent"
  ADD COLUMN "workflowRunId" TEXT,
  ADD COLUMN "workflowStepRunId" TEXT;

-- AlterTable: Message — real client-supplied dedup key (kill-critic Q3(a)).
ALTER TABLE "Message"
  ADD COLUMN "idempotencyKey" TEXT;
CREATE UNIQUE INDEX "Message_conversationId_idempotencyKey_key" ON "Message"("conversationId", "idempotencyKey");

-- AlterTable: AiEmployee — additive ceilings alongside budgetLimit (EXTEND, never replace).
ALTER TABLE "AiEmployee"
  ADD COLUMN "maxCreditsPerExecution" INTEGER,
  ADD COLUMN "maxCreditsPerTask" INTEGER;

-- AlterTable: SkillExecution — closes the confirmed gap (no cost/creditsUsed/duration ever persisted).
ALTER TABLE "SkillExecution"
  ADD COLUMN "creditsUsed" DECIMAL(18,6),
  ADD COLUMN "durationMs" INTEGER;

-- AlterTable: Workflow — additive workflow-level ceilings, sibling to the existing blockedBySubscription() gate.
ALTER TABLE "Workflow"
  ADD COLUMN "maxCreditsPerRun" INTEGER,
  ADD COLUMN "maxRunsPerPeriod" INTEGER,
  ADD COLUMN "maxRunsPeriodUnit" TEXT;

-- AlterTable: WorkflowRun — per-run rollup + override ceiling (§14.2/§20).
-- `engineMode` (kill-critic Q22's legacy-engine re-billing guard) is a
-- deliberate Phase 8 addition, NOT included here.
ALTER TABLE "WorkflowRun"
  ADD COLUMN "creditLimit" DECIMAL(18,6),
  ADD COLUMN "totalCreditsCharged" DECIMAL(18,6) NOT NULL DEFAULT 0;

-- AlterTable: WorkflowStepRun — per-node charge; null = not a cost-bearing node type.
ALTER TABLE "WorkflowStepRun"
  ADD COLUMN "creditsCharged" DECIMAL(18,6);

-- AlterTable: Subscription — kill-critic Q16 fix (out-of-order webhook redelivery guard).
ALTER TABLE "Subscription"
  ADD COLUMN "lastAppliedEventId" TEXT,
  ADD COLUMN "lastAppliedEventCreatedAt" TIMESTAMP(3);

-- CreateTable: CreditLedger — the single, insert-only, immutable source of
-- truth for every credit-affecting event, company-wide.
CREATE TABLE "CreditLedger" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "employeeId" TEXT,
  "workflowId" TEXT,
  "workflowRunId" TEXT,
  "workflowStepRunId" TEXT,
  "conversationId" TEXT,
  "executionId" TEXT,
  "reservationId" TEXT,
  "packId" TEXT,
  "enterpriseAgreementId" TEXT,
  "lotId" TEXT,
  "creditType" TEXT NOT NULL DEFAULT 'PLATFORM',
  "transactionType" TEXT NOT NULL,
  "grantKind" TEXT,
  "amount" DECIMAL(18,6) NOT NULL,
  "balanceBefore" DECIMAL(18,6) NOT NULL,
  "balanceAfter" DECIMAL(18,6) NOT NULL,
  "reversesLedgerEntryId" TEXT,
  "modelCostRateId" TEXT,
  "toolCostRateId" TEXT,
  "reason" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CreditLedger_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CreditLedger_companyId_idempotencyKey_key" ON "CreditLedger"("companyId", "idempotencyKey");
CREATE INDEX "CreditLedger_companyId_createdAt_idx" ON "CreditLedger"("companyId", "createdAt");
CREATE INDEX "CreditLedger_companyId_employeeId_createdAt_idx" ON "CreditLedger"("companyId", "employeeId", "createdAt");
CREATE INDEX "CreditLedger_companyId_workflowRunId_idx" ON "CreditLedger"("companyId", "workflowRunId");
CREATE INDEX "CreditLedger_companyId_transactionType_createdAt_idx" ON "CreditLedger"("companyId", "transactionType", "createdAt");
CREATE INDEX "CreditLedger_reservationId_idx" ON "CreditLedger"("reservationId");
ALTER TABLE "CreditLedger" ADD CONSTRAINT "CreditLedger_reversesLedgerEntryId_fkey"
  FOREIGN KEY ("reversesLedgerEntryId") REFERENCES "CreditLedger"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable: CreditLot — each individual grant ("batch") as its own shrinking pool (kill-critic Q9).
CREATE TABLE "CreditLot" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "originLedgerEntryId" TEXT NOT NULL,
  "grantKind" TEXT NOT NULL,
  "grantedAmount" DECIMAL(18,6) NOT NULL,
  "remaining" DECIMAL(18,6) NOT NULL,
  "expiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CreditLot_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CreditLot_originLedgerEntryId_key" ON "CreditLot"("originLedgerEntryId");
CREATE INDEX "CreditLot_companyId_expiresAt_idx" ON "CreditLot"("companyId", "expiresAt");
CREATE INDEX "CreditLot_companyId_createdAt_idx" ON "CreditLot"("companyId", "createdAt");

-- CreateTable: CreditLotConsumption — makes CreditLot.remaining atomically-correct and auditable.
CREATE TABLE "CreditLotConsumption" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "lotId" TEXT NOT NULL,
  "consumingLedgerEntryId" TEXT NOT NULL,
  "amountDrawn" DECIMAL(18,6) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CreditLotConsumption_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CreditLotConsumption_lotId_consumingLedgerEntryId_key" ON "CreditLotConsumption"("lotId", "consumingLedgerEntryId");
CREATE INDEX "CreditLotConsumption_lotId_idx" ON "CreditLotConsumption"("lotId");
CREATE INDEX "CreditLotConsumption_companyId_consumingLedgerEntryId_idx" ON "CreditLotConsumption"("companyId", "consumingLedgerEntryId");

-- CreateTable: CompanyCreditBalance — fast-read cache of spendable balance + Layer-1 hard stop (§45). Convention A.
CREATE TABLE "CompanyCreditBalance" (
  "companyId" TEXT NOT NULL,
  "balance" DECIMAL(18,6) NOT NULL,
  "reservedBalance" DECIMAL(18,6) NOT NULL DEFAULT 0,
  "lastReconciledAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CompanyCreditBalance_pkey" PRIMARY KEY ("companyId")
);
ALTER TABLE "CompanyCreditBalance" ADD CONSTRAINT "CompanyCreditBalance_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable: CreditReservation — the Reserve→Execute→Settle hold record (§10, hardened per kill-critic Q2/Q3/Q8).
CREATE TABLE "CreditReservation" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "employeeId" TEXT,
  "workflowRunId" TEXT,
  "workflowStepRunId" TEXT,
  "conversationId" TEXT,
  "executionId" TEXT,
  "resourceType" TEXT NOT NULL,
  "status" "CreditReservationStatus" NOT NULL DEFAULT 'PENDING',
  "estimatedCredits" DECIMAL(18,6) NOT NULL,
  "actualCredits" DECIMAL(18,6),
  "idempotencyKey" TEXT NOT NULL,
  "leaseExpiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "settledAt" TIMESTAMP(3),
  "releasedAt" TIMESTAMP(3),
  CONSTRAINT "CreditReservation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CreditReservation_companyId_idempotencyKey_key" ON "CreditReservation"("companyId", "idempotencyKey");
CREATE INDEX "CreditReservation_companyId_status_idx" ON "CreditReservation"("companyId", "status");
CREATE INDEX "CreditReservation_workflowRunId_idx" ON "CreditReservation"("workflowRunId");
CREATE INDEX "CreditReservation_workflowStepRunId_idx" ON "CreditReservation"("workflowStepRunId");
CREATE INDEX "CreditReservation_status_leaseExpiresAt_idx" ON "CreditReservation"("status", "leaseExpiresAt");

-- CreateTable: CreditRefund — resolves kill-critic Q10's dedup-and-authorization hedge.
CREATE TABLE "CreditRefund" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "originalLedgerEntryId" TEXT NOT NULL,
  "externalRefundId" TEXT NOT NULL,
  "amount" DECIMAL(18,6) NOT NULL,
  "resultingLedgerEntryId" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "initiatedBy" TEXT NOT NULL,
  "status" "CreditRefundStatus" NOT NULL DEFAULT 'COMPLETED',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CreditRefund_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CreditRefund_companyId_externalRefundId_key" ON "CreditRefund"("companyId", "externalRefundId");
CREATE INDEX "CreditRefund_companyId_originalLedgerEntryId_idx" ON "CreditRefund"("companyId", "originalLedgerEntryId");

-- CreateTable: ProcessedWebhookEvent — Stripe webhook replay/redelivery dedup (kill-critic Q5/Q6). Confirmed NOT FOUND before this.
CREATE TABLE "ProcessedWebhookEvent" (
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "externalEventId" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "companyId" TEXT,
  "payload" JSONB NOT NULL,
  "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProcessedWebhookEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ProcessedWebhookEvent_provider_externalEventId_key" ON "ProcessedWebhookEvent"("provider", "externalEventId");
CREATE INDEX "ProcessedWebhookEvent_companyId_processedAt_idx" ON "ProcessedWebhookEvent"("companyId", "processedAt");
CREATE INDEX "ProcessedWebhookEvent_eventType_processedAt_idx" ON "ProcessedWebhookEvent"("eventType", "processedAt");

-- CreateTable: ModelCostRate — versioned per-(provider, model) LLM cost rate (kill-critic Q18).
CREATE TABLE "ModelCostRate" (
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "promptRatePer1MUsd" DECIMAL(12,6) NOT NULL,
  "completionRatePer1MUsd" DECIMAL(12,6) NOT NULL,
  "creditsPerUsd" DECIMAL(12,6) NOT NULL,
  "effectiveFrom" TIMESTAMP(3) NOT NULL,
  "effectiveTo" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ModelCostRate_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ModelCostRate_provider_model_effectiveFrom_key" ON "ModelCostRate"("provider", "model", "effectiveFrom");
CREATE INDEX "ModelCostRate_provider_model_effectiveTo_idx" ON "ModelCostRate"("provider", "model", "effectiveTo");

-- CreateTable: ToolCostRate — sibling of ModelCostRate for tool/skill-call cost (§14.1).
CREATE TABLE "ToolCostRate" (
  "id" TEXT NOT NULL,
  "skillKey" TEXT NOT NULL,
  "tool" TEXT NOT NULL,
  "creditsPerCall" DECIMAL(12,6) NOT NULL,
  "effectiveFrom" TIMESTAMP(3) NOT NULL,
  "effectiveTo" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ToolCostRate_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ToolCostRate_skillKey_tool_effectiveFrom_key" ON "ToolCostRate"("skillKey", "tool", "effectiveFrom");
CREATE INDEX "ToolCostRate_skillKey_tool_effectiveTo_idx" ON "ToolCostRate"("skillKey", "tool", "effectiveTo");

-- CreateTable: CreditPack — a DB table (deliberate deviation from a TS catalog file — kill-critic Q19/Q20).
CREATE TABLE "CreditPack" (
  "id" TEXT NOT NULL,
  "packKey" TEXT NOT NULL,
  "displayName" TEXT NOT NULL,
  "creditAmount" DECIMAL(18,6) NOT NULL,
  "bonusPercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
  "priceUsd" DECIMAL(12,2) NOT NULL,
  "stripePriceId" TEXT,
  "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "effectiveTo" TIMESTAMP(3),
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CreditPack_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CreditPack_packKey_effectiveFrom_key" ON "CreditPack"("packKey", "effectiveFrom");
CREATE INDEX "CreditPack_packKey_effectiveTo_idx" ON "CreditPack"("packKey", "effectiveTo");
CREATE UNIQUE INDEX "CreditPack_stripePriceId_key" ON "CreditPack"("stripePriceId");

-- CreateTable: EnterpriseCreditAgreement — durable record of negotiated deal terms (kill-critic Q20). Convention A.
CREATE TABLE "EnterpriseCreditAgreement" (
  "companyId" TEXT NOT NULL,
  "includedCreditsPerPeriod" DECIMAL(18,6) NOT NULL,
  "periodMonths" INTEGER NOT NULL DEFAULT 1,
  "dealReference" TEXT NOT NULL,
  "approvedByUserId" TEXT NOT NULL,
  "startsAt" TIMESTAMP(3) NOT NULL,
  "endsAt" TIMESTAMP(3),
  "active" BOOLEAN NOT NULL DEFAULT true,
  "lastGrantedPeriodStart" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EnterpriseCreditAgreement_pkey" PRIMARY KEY ("companyId")
);
CREATE INDEX "EnterpriseCreditAgreement_active_endsAt_idx" ON "EnterpriseCreditAgreement"("active", "endsAt");
ALTER TABLE "EnterpriseCreditAgreement" ADD CONSTRAINT "EnterpriseCreditAgreement_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable: EmployeeCreditPeriodCounter — atomic counter closing kill-critic Q13 (budgetLimit's check-then-act race).
CREATE TABLE "EmployeeCreditPeriodCounter" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "employeeId" TEXT NOT NULL,
  "periodStart" TIMESTAMP(3) NOT NULL,
  "periodEnd" TIMESTAMP(3) NOT NULL,
  "spent" DECIMAL(18,6) NOT NULL DEFAULT 0,
  "budgetLimitSnapshot" INTEGER,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EmployeeCreditPeriodCounter_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "EmployeeCreditPeriodCounter_employeeId_periodStart_key" ON "EmployeeCreditPeriodCounter"("employeeId", "periodStart");
CREATE INDEX "EmployeeCreditPeriodCounter_companyId_employeeId_periodSta_idx" ON "EmployeeCreditPeriodCounter"("companyId", "employeeId", "periodStart");
CREATE INDEX "EmployeeCreditPeriodCounter_companyId_periodStart_idx" ON "EmployeeCreditPeriodCounter"("companyId", "periodStart");
