-- CreateEnum
CREATE TYPE "WorkflowPermissionSubjectType" AS ENUM ('USER', 'ROLE', 'DEPARTMENT', 'TEAM', 'EMPLOYEE');

-- CreateEnum
CREATE TYPE "WorkflowPermissionAction" AS ENUM ('VIEW', 'EDIT_GRAPH', 'UPDATE', 'PUBLISH', 'RUN', 'DELETE', 'MANAGE_PERMISSIONS');


-- AlterTable
ALTER TABLE "Workflow" ADD COLUMN     "ownerUserId" TEXT;

-- CreateTable
CREATE TABLE "WorkflowPermission" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "subjectType" "WorkflowPermissionSubjectType" NOT NULL,
    "subjectId" TEXT NOT NULL,
    "action" "WorkflowPermissionAction" NOT NULL,
    "grantedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkflowPermission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WorkflowPermission_companyId_workflowId_idx" ON "WorkflowPermission"("companyId", "workflowId");

-- CreateIndex
CREATE INDEX "WorkflowPermission_companyId_subjectType_subjectId_idx" ON "WorkflowPermission"("companyId", "subjectType", "subjectId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowPermission_workflowId_subjectType_subjectId_action_key" ON "WorkflowPermission"("workflowId", "subjectType", "subjectId", "action");

-- AddForeignKey
ALTER TABLE "WorkflowPermission" ADD CONSTRAINT "WorkflowPermission_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowPermission" ADD CONSTRAINT "WorkflowPermission_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "Workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

