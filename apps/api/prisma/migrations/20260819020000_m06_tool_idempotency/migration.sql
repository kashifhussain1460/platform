-- M-06: generic, engine-agnostic tool idempotency primitive.
-- Hand-authored (this environment's non-interactive shell blocks
-- `prisma migrate dev`) from a reviewed `prisma migrate diff` output, with
-- two unrelated lines deliberately dropped — same reasoning as
-- 20260819010000_s13_c06_handoff/migration.sql:
--   1. `DROP INDEX "KnowledgeChunk_embedding_idx"` — pgvector/HNSW false
--      drift (root CLAUDE.md); never apply this.
--   2. `ALTER INDEX "EmployeeCreditPeriodCounter_..." RENAME ...` — belongs
--      to the concurrent, unrelated in-progress credits migration.

-- CreateEnum
CREATE TYPE "ToolIdempotencyStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "ToolIdempotencyRecord" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "skillKey" TEXT NOT NULL,
    "tool" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" "ToolIdempotencyStatus" NOT NULL DEFAULT 'PENDING',
    "resultJson" JSONB,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ToolIdempotencyRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ToolIdempotencyRecord_companyId_skillKey_tool_createdAt_idx" ON "ToolIdempotencyRecord"("companyId", "skillKey", "tool", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ToolIdempotencyRecord_companyId_skillKey_tool_idempotencyKe_key" ON "ToolIdempotencyRecord"("companyId", "skillKey", "tool", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "ToolIdempotencyRecord" ADD CONSTRAINT "ToolIdempotencyRecord_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
