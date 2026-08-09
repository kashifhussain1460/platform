
-- AlterTable
ALTER TABLE "Workflow" ADD COLUMN     "installIdempotencyKey" TEXT,
ADD COLUMN     "sourceTemplateId" TEXT,
ADD COLUMN     "sourceTemplateVersion" INTEGER;

-- CreateTable
CREATE TABLE "WorkflowTemplate" (
    "id" TEXT NOT NULL,
    "companyId" TEXT,
    "key" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" "WorkflowCategory" NOT NULL,
    "definition" JSONB NOT NULL,
    "parameters" JSONB NOT NULL,
    "requires" JSONB NOT NULL,
    "status" "WorkflowVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkflowTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WorkflowTemplate_category_status_idx" ON "WorkflowTemplate"("category", "status");

-- CreateIndex
CREATE INDEX "WorkflowTemplate_companyId_idx" ON "WorkflowTemplate"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowTemplate_key_version_key" ON "WorkflowTemplate"("key", "version");

-- CreateIndex
CREATE UNIQUE INDEX "Workflow_companyId_installIdempotencyKey_key" ON "Workflow"("companyId", "installIdempotencyKey");

-- AddForeignKey
ALTER TABLE "WorkflowTemplate" ADD CONSTRAINT "WorkflowTemplate_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

