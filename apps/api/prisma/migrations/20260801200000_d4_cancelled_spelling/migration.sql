-- Decision D4 (settled 2026-08-01): standardise on the DOUBLE-L `CANCELLED`.
--
-- The schema previously carried BOTH spellings — SlotStatus.CANCELLED and
-- WorkflowRunStatus.CANCELLED (double L) versus SubscriptionStatus.CANCELED
-- (single L). Two spellings for one concept is a permanent trap: every author
-- has to remember which table uses which.
--
-- Postgres cannot DROP an enum value, so `CANCELED` necessarily remains in the
-- type. It is backfilled to `CANCELLED` here and never written again — the
-- schema marks it @deprecated and `isCancelledSubscription()` in @vaep/types
-- accepts both so no caller has to know.
--
-- NOTE: `prisma migrate diff` emitted `DROP INDEX "KnowledgeChunk_embedding_idx";`
-- and it has been DELETED ON PURPOSE — the SEVENTH consecutive occurrence.
-- Prisma cannot represent the HNSW index on the Unsupported("vector") column.

-- AlterEnum
ALTER TYPE "SubscriptionStatus" ADD VALUE 'CANCELLED';
