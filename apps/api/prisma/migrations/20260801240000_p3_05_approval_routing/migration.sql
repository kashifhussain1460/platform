-- CreateEnum
CREATE TYPE "ApproverRuleType" AS ENUM ('USER', 'ROLE', 'DEPARTMENT', 'TEAM', 'EMPLOYEE_MANAGER', 'ANY_ADMIN');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ApprovalStatus" ADD VALUE 'ESCALATED';
ALTER TYPE "ApprovalStatus" ADD VALUE 'EXPIRED';


-- AlterTable
ALTER TABLE "AiEmployee" ADD COLUMN     "managerUserId" TEXT;

-- AlterTable
ALTER TABLE "ApprovalRequest" ADD COLUMN     "approverRuleType" "ApproverRuleType",
ADD COLUMN     "approverRuleValue" TEXT,
ADD COLUMN     "assigneeUserId" TEXT,
ADD COLUMN     "autoDecided" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "chainId" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "dueAt" TIMESTAMP(3),
ADD COLUMN     "escalatedToId" TEXT,
ADD COLUMN     "escalationTier" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "level" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "routingSnapshot" JSONB,
ADD COLUMN     "slaMinutes" INTEGER,
ADD COLUMN     "timeoutPolicy" TEXT;

-- AlterTable
ALTER TABLE "SecurityPolicy" ADD COLUMN     "defaultApprovalSlaMinutes" INTEGER;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "departmentId" TEXT,
ADD COLUMN     "managerUserId" TEXT,
ADD COLUMN     "teamId" TEXT;

-- CreateIndex
CREATE INDEX "ApprovalRequest_companyId_chainId_idx" ON "ApprovalRequest"("companyId", "chainId");

-- CreateIndex
CREATE INDEX "ApprovalRequest_companyId_assigneeUserId_status_idx" ON "ApprovalRequest"("companyId", "assigneeUserId", "status");

-- CreateIndex
CREATE INDEX "ApprovalRequest_status_dueAt_idx" ON "ApprovalRequest"("status", "dueAt");

-- CreateIndex
CREATE INDEX "User_companyId_departmentId_idx" ON "User"("companyId", "departmentId");

-- CreateIndex
CREATE INDEX "User_companyId_teamId_idx" ON "User"("companyId", "teamId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_managerUserId_fkey" FOREIGN KEY ("managerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiEmployee" ADD CONSTRAINT "AiEmployee_managerUserId_fkey" FOREIGN KEY ("managerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- P3-05 §8.1.10: backfill chainId = id for pre-existing rows (new rows set it explicitly).
UPDATE "ApprovalRequest" SET "chainId" = "id" WHERE "chainId" = '';
