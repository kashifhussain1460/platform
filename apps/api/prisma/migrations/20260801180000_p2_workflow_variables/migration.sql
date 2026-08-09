-- P2-01 — workflow variable storage.
--   * WorkflowVariable   : a variable's stored VALUE (keyed to the workflow,
--                          not a version — values are mutable and outlive one version)
--   * WorkflowSecretRef  : a REFERENCE to a connector credential field. The
--                          secret itself is never stored here or in node config.
--
-- Additive only: 2 new tables + their indexes.
--
-- NOTE: `prisma migrate diff` emitted `DROP INDEX "KnowledgeChunk_embedding_idx";`
-- and it has been DELETED ON PURPOSE — the SIXTH consecutive occurrence. Prisma
-- cannot represent the HNSW index on the Unsupported("vector") column, so it
-- reads it as drift every time. Dropping it silently degrades ALL RAG retrieval
-- to a sequential scan with nothing failing loudly.

-- DropIndex
-- CreateTable
CREATE TABLE "WorkflowVariable" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "value" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WorkflowVariable_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "WorkflowSecretRef" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "installedSkillId" TEXT NOT NULL,
    "fieldName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WorkflowSecretRef_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE INDEX "WorkflowVariable_companyId_workflowId_idx" ON "WorkflowVariable"("companyId", "workflowId");
-- CreateIndex
CREATE UNIQUE INDEX "WorkflowVariable_workflowId_scope_key_key" ON "WorkflowVariable"("workflowId", "scope", "key");
-- CreateIndex
CREATE INDEX "WorkflowSecretRef_companyId_workflowId_idx" ON "WorkflowSecretRef"("companyId", "workflowId");
-- CreateIndex
CREATE UNIQUE INDEX "WorkflowSecretRef_workflowId_key_key" ON "WorkflowSecretRef"("workflowId", "key");
-- AddForeignKey
ALTER TABLE "WorkflowVariable" ADD CONSTRAINT "WorkflowVariable_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "Workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "WorkflowSecretRef" ADD CONSTRAINT "WorkflowSecretRef_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "Workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "WorkflowSecretRef" ADD CONSTRAINT "WorkflowSecretRef_installedSkillId_fkey" FOREIGN KEY ("installedSkillId") REFERENCES "InstalledSkill"("id") ON DELETE CASCADE ON UPDATE CASCADE;
