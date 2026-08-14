-- WAVE 8 §8.3 — legal hold widened beyond audit.
--
-- The table is NOT renamed (the Prisma model is, via @@map): it holds evidence
-- of what was frozen and when, and a rename buys nothing worth that risk.

-- CreateEnum
CREATE TYPE "LegalHoldScope" AS ENUM ('ALL', 'AUDIT');

-- AlterTable. New holds default to ALL, which is what "legal hold" means to
-- the person asking for one.
ALTER TABLE "AuditLegalHold"
  ADD COLUMN "scope" "LegalHoldScope" NOT NULL DEFAULT 'ALL';

-- Every hold that already exists was placed when the feature was audit-only, so
-- it is backfilled to AUDIT. Silently widening a hold someone placed months ago
-- would change what their system deletes tonight, without anyone deciding to.
UPDATE "AuditLegalHold" SET "scope" = 'AUDIT';
