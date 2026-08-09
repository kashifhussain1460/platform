-- CreateEnum
CREATE TYPE "AssistSessionStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'EXHAUSTED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "AssistMessageRole" AS ENUM ('USER', 'ASSISTANT', 'QUESTION', 'ANSWER', 'CONNECTION', 'TEST', 'SYSTEM');

-- NOTE: `prisma migrate diff` emitted `DROP INDEX "KnowledgeChunk_embedding_idx"`
-- here and it was REMOVED BY HAND. Prisma's schema cannot represent the HNSW
-- index on the `Unsupported("vector")` column, so every generated migration
-- tries to drop it. Dropping it would silently destroy vector-search
-- performance. See the pgvector gotcha in platform/CLAUDE.md.

-- AlterTable
ALTER TABLE "Workflow" ADD COLUMN     "assistSessionId" TEXT,
ADD COLUMN     "isAssistScratch" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "AssistSession" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" "AssistSessionStatus" NOT NULL DEFAULT 'ACTIVE',
    "draftDefinition" JSONB,
    "draftVersion" INTEGER NOT NULL DEFAULT 0,
    "targetWorkflowId" TEXT,
    "createdWorkflowId" TEXT,
    "originRunId" TEXT,
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssistSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssistMessage" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "role" "AssistMessageRole" NOT NULL,
    "content" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssistMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AssistSession_companyId_userId_updatedAt_idx" ON "AssistSession"("companyId", "userId", "updatedAt");

-- CreateIndex
CREATE INDEX "AssistSession_companyId_status_idx" ON "AssistSession"("companyId", "status");

-- CreateIndex
CREATE INDEX "AssistMessage_sessionId_createdAt_idx" ON "AssistMessage"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "AssistMessage_companyId_idx" ON "AssistMessage"("companyId");

-- AddForeignKey
ALTER TABLE "AssistSession" ADD CONSTRAINT "AssistSession_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssistMessage" ADD CONSTRAINT "AssistMessage_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AssistSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

