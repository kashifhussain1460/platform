-- P1 Runtime — durable execution state machine.
-- Specs: docs/architecture/workflow-system/05-execution-engine.md (L1),
--        16-workflow-runtime-spec.md (L2), 12-database.md,
--        docs/implementation/workflow-system/database-migration-plan.md (Migrations 04/06/07/08).
--
-- 100% additive: 5 new tables, new columns, new indexes, new enum values.
-- Nothing is dropped, renamed or narrowed. `Workflow.definition` is retained
-- (deprecated, still read by the legacy walk and the rollback path).
--
-- NOTE: `prisma migrate diff` emitted `DROP INDEX "KnowledgeChunk_embedding_idx";`
-- and it has been DELETED ON PURPOSE — the FIFTH consecutive occurrence. Prisma
-- cannot represent the HNSW index on the Unsupported("vector") column, so it
-- reads it as drift every time. Dropping it silently degrades ALL RAG retrieval
-- to a sequential scan with nothing failing loudly.

-- CreateEnum
CREATE TYPE "WorkflowVersionStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'DEPRECATED', 'ARCHIVED');
-- CreateEnum
CREATE TYPE "WorkflowCategory" AS ENUM ('HR', 'RECRUITMENT', 'MARKETING', 'SALES', 'SUPPORT', 'FINANCE', 'OPERATIONS', 'IT', 'COMPLIANCE', 'CUSTOM');
-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.
ALTER TYPE "StepRunStatus" ADD VALUE 'RETRYING';
ALTER TYPE "StepRunStatus" ADD VALUE 'WAITING';
ALTER TYPE "StepRunStatus" ADD VALUE 'COMPENSATED';
-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.
ALTER TYPE "WorkflowRunStatus" ADD VALUE 'CANCELLED';
ALTER TYPE "WorkflowRunStatus" ADD VALUE 'COMPENSATING';
ALTER TYPE "WorkflowRunStatus" ADD VALUE 'TIMED_OUT';
-- DropIndex
-- AlterTable
ALTER TABLE "Workflow" ADD COLUMN     "activeVersionId" TEXT,
ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "category" "WorkflowCategory",
ADD COLUMN     "draftVersionId" TEXT;
-- AlterTable
ALTER TABLE "WorkflowRun" ADD COLUMN     "actingEmployeeId" TEXT,
ADD COLUMN     "deadlineAt" TIMESTAMP(3),
ADD COLUMN     "failureClass" TEXT,
ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "startedByUserId" TEXT,
ADD COLUMN     "workflowVersionId" TEXT;
-- AlterTable
ALTER TABLE "WorkflowStepRun" ADD COLUMN     "attempt" INTEGER NOT NULL DEFAULT 1;
-- CreateTable
CREATE TABLE "WorkflowVersion" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "WorkflowVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "definition" JSONB NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "publishedById" TEXT,
    "changeNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WorkflowVersion_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "WorkflowStepAttempt" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "status" "StepRunStatus" NOT NULL DEFAULT 'PENDING',
    "leaseOwner" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "outcomeUnknown" BOOLEAN NOT NULL DEFAULT false,
    "idempotencyKey" TEXT,
    "error" TEXT,
    "failureClass" TEXT,
    "output" JSONB,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WorkflowStepAttempt_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "WorkflowRunTimer" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "fireAt" TIMESTAMP(3) NOT NULL,
    "firedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WorkflowRunTimer_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "WorkflowJoinState" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "joinNodeId" TEXT NOT NULL,
    "expected" INTEGER NOT NULL,
    "arrived" INTEGER NOT NULL DEFAULT 0,
    "laneOutputs" JSONB,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WorkflowJoinState_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "RunEventOutbox" (
    "id" BIGSERIAL NOT NULL,
    "companyId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RunEventOutbox_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE INDEX "WorkflowVersion_companyId_workflowId_idx" ON "WorkflowVersion"("companyId", "workflowId");
-- CreateIndex
CREATE UNIQUE INDEX "WorkflowVersion_workflowId_version_key" ON "WorkflowVersion"("workflowId", "version");
-- CreateIndex
CREATE INDEX "WorkflowStepAttempt_runId_attempt_idx" ON "WorkflowStepAttempt"("runId", "attempt");
-- CreateIndex
CREATE INDEX "WorkflowStepAttempt_leaseExpiresAt_idx" ON "WorkflowStepAttempt"("leaseExpiresAt");
-- CreateIndex
CREATE UNIQUE INDEX "WorkflowStepAttempt_stepId_attempt_key" ON "WorkflowStepAttempt"("stepId", "attempt");
-- CreateIndex
CREATE INDEX "WorkflowRunTimer_fireAt_idx" ON "WorkflowRunTimer"("fireAt");
-- CreateIndex
CREATE INDEX "WorkflowRunTimer_runId_idx" ON "WorkflowRunTimer"("runId");
-- CreateIndex
CREATE INDEX "WorkflowJoinState_runId_idx" ON "WorkflowJoinState"("runId");
-- CreateIndex
CREATE UNIQUE INDEX "WorkflowJoinState_runId_joinNodeId_key" ON "WorkflowJoinState"("runId", "joinNodeId");
-- CreateIndex
CREATE INDEX "RunEventOutbox_publishedAt_id_idx" ON "RunEventOutbox"("publishedAt", "id");
-- CreateIndex
CREATE INDEX "RunEventOutbox_runId_idx" ON "RunEventOutbox"("runId");
-- CreateIndex
CREATE UNIQUE INDEX "Workflow_activeVersionId_key" ON "Workflow"("activeVersionId");
-- CreateIndex
CREATE UNIQUE INDEX "Workflow_draftVersionId_key" ON "Workflow"("draftVersionId");
-- CreateIndex
CREATE INDEX "WorkflowRun_companyId_workflowId_createdAt_idx" ON "WorkflowRun"("companyId", "workflowId", "createdAt");
-- CreateIndex
CREATE INDEX "WorkflowRun_companyId_workflowVersionId_idx" ON "WorkflowRun"("companyId", "workflowVersionId");
-- CreateIndex
CREATE INDEX "WorkflowRun_status_deadlineAt_idx" ON "WorkflowRun"("status", "deadlineAt");
-- CreateIndex
CREATE UNIQUE INDEX "WorkflowRun_companyId_idempotencyKey_key" ON "WorkflowRun"("companyId", "idempotencyKey");
-- AddForeignKey
ALTER TABLE "Workflow" ADD CONSTRAINT "Workflow_activeVersionId_fkey" FOREIGN KEY ("activeVersionId") REFERENCES "WorkflowVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "Workflow" ADD CONSTRAINT "Workflow_draftVersionId_fkey" FOREIGN KEY ("draftVersionId") REFERENCES "WorkflowVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "WorkflowRun" ADD CONSTRAINT "WorkflowRun_workflowVersionId_fkey" FOREIGN KEY ("workflowVersionId") REFERENCES "WorkflowVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "WorkflowVersion" ADD CONSTRAINT "WorkflowVersion_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "Workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "WorkflowStepAttempt" ADD CONSTRAINT "WorkflowStepAttempt_runId_fkey" FOREIGN KEY ("runId") REFERENCES "WorkflowRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "WorkflowStepAttempt" ADD CONSTRAINT "WorkflowStepAttempt_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "WorkflowStepRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "WorkflowRunTimer" ADD CONSTRAINT "WorkflowRunTimer_runId_fkey" FOREIGN KEY ("runId") REFERENCES "WorkflowRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "WorkflowJoinState" ADD CONSTRAINT "WorkflowJoinState_runId_fkey" FOREIGN KEY ("runId") REFERENCES "WorkflowRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "RunEventOutbox" ADD CONSTRAINT "RunEventOutbox_runId_fkey" FOREIGN KEY ("runId") REFERENCES "WorkflowRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
