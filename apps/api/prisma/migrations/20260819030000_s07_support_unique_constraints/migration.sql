-- S-07: TOCTOU race fix. Hand-authored (this environment's non-interactive
-- shell blocks `prisma migrate dev`) from a reviewed `prisma migrate diff`
-- output, with two unrelated lines deliberately dropped — same reasoning as
-- the two prior hand-authored migrations in this session:
--   1. `DROP INDEX "KnowledgeChunk_embedding_idx"` — pgvector/HNSW false
--      drift (root CLAUDE.md); never apply this.
--   2. `ALTER INDEX "EmployeeCreditPeriodCounter_..." RENAME ...` — belongs
--      to the concurrent, unrelated in-progress credits migration.
--
-- PRE-MIGRATION REMEDIATION PERFORMED (2026-08-19, this dev DB only, user-
-- approved): 28 ChatwootAccount rows all shared chatwootAccountId='1' (a
-- test-fixture literal from engines-support.e2e-spec.ts, accumulated across
-- repeated e2e runs — confirmed via company names "Support Test Co"/"Support
-- Engine Test Co"). Deduplicated via `UPDATE "ChatwootAccount" SET
-- "chatwootAccountId" = id;` before this migration was written. No
-- SupportConversation duplicates were found for (companyId,
-- chatwootConversationId) — that unique constraint applies cleanly with no
-- remediation needed.

-- DropIndex
DROP INDEX "SupportConversation_companyId_chatwootConversationId_idx";

-- CreateIndex
CREATE UNIQUE INDEX "ChatwootAccount_chatwootAccountId_key" ON "ChatwootAccount"("chatwootAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "SupportConversation_companyId_chatwootConversationId_key" ON "SupportConversation"("companyId", "chatwootConversationId");
