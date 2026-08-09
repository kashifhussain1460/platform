
DROP INDEX "WorkflowTemplate_companyId_idx";

DROP INDEX "WorkflowTemplate_key_version_key";

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowTemplate_companyId_key_version_key" ON "WorkflowTemplate"("companyId", "key", "version");

