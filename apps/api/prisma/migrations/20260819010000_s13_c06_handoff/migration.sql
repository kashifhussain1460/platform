-- S-13/C-06: shared Human Handoff mechanism.
-- Hand-authored (not `prisma migrate dev`, which is non-interactive-blocked
-- in this environment) from a reviewed `prisma migrate diff` output, with two
-- unrelated lines deliberately dropped:
--   1. `DROP INDEX "KnowledgeChunk_embedding_idx"` — the documented pgvector/
--      HNSW false-drift gotcha (root CLAUDE.md); Prisma cannot represent the
--      Unsupported("vector") column's real index, never apply this.
--   2. `ALTER INDEX "EmployeeCreditPeriodCounter_..." RENAME ...` — belongs to
--      a concurrent, unrelated in-progress migration (credits work), not
--      this change; must not be bundled in here.

-- CreateEnum
CREATE TYPE "HandoffStatus" AS ENUM ('PENDING', 'RESOLVED', 'CANCELLED');

-- AlterEnum
ALTER TYPE "SupportConversationStatus" ADD VALUE 'ESCALATED';

-- CreateTable
CREATE TABLE "HandoffRequest" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "HandoffStatus" NOT NULL DEFAULT 'PENDING',
    "approverRuleType" "ApproverRuleType",
    "approverRuleValue" TEXT,
    "assigneeUserId" TEXT,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HandoffRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HandoffRequest_companyId_status_idx" ON "HandoffRequest"("companyId", "status");

-- CreateIndex
CREATE INDEX "HandoffRequest_conversationId_idx" ON "HandoffRequest"("conversationId");

-- AddForeignKey
ALTER TABLE "HandoffRequest" ADD CONSTRAINT "HandoffRequest_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HandoffRequest" ADD CONSTRAINT "HandoffRequest_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "SupportConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
