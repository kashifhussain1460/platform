-- P0 Foundation migration.
--   * G10 — EmployeeRole.MARKETING  (unblocks the Marketing AI Employee + its 11 workflows)
--   * G29 — WorkflowStatus.ARCHIVED (lets DELETE /workflows/:id become a soft delete)
--   * Migration 01 hot-path indexes from docs/implementation/workflow-system/database-migration-plan.md
--
-- 100% additive: no DROP TABLE, no DROP COLUMN, no type narrowing.
--
-- NOTE: `prisma migrate diff` emitted `DROP INDEX "KnowledgeChunk_embedding_idx";`
-- here and it has been DELETED ON PURPOSE. Prisma cannot represent the HNSW index
-- on the Unsupported("vector") column, so it sees it as drift on every migration
-- (this is the 4th consecutive occurrence). Dropping it silently degrades all RAG
-- retrieval to a sequential scan with nothing failing loudly.

-- AlterEnum
ALTER TYPE "EmployeeRole" ADD VALUE 'MARKETING';

-- AlterEnum
ALTER TYPE "WorkflowStatus" ADD VALUE 'ARCHIVED';

-- CreateIndex
-- LIVE DEFECT: WorkflowsService.getRun() polls via `include: { steps }` (~1/s per
-- open run), emitting WHERE "runId" = $1. Only companyId was indexed, so every
-- poll sequentially scanned the highest-volume table in the system.
CREATE INDEX "WorkflowStepRun_runId_idx" ON "WorkflowStepRun"("runId");

-- CreateIndex
CREATE INDEX "WorkflowStepRun_runId_status_idx" ON "WorkflowStepRun"("runId", "status");

-- CreateIndex
CREATE INDEX "WorkflowRun_companyId_status_idx" ON "WorkflowRun"("companyId", "status");

-- CreateIndex
-- The G25 approval gate checks "already approved?" on every gated TOOL_ACTION.
CREATE INDEX "ApprovalRequest_companyId_workflowRunId_idx" ON "ApprovalRequest"("companyId", "workflowRunId");
