-- Email verification (OTP). All additive + nullable → forward-safe, no backfill.
-- Hand-authored (non-interactive shell can't run `migrate dev`); only ADD COLUMN,
-- so it cannot touch the pgvector KnowledgeChunk_embedding_idx (the known drift).
ALTER TABLE "User" ADD COLUMN "emailVerifiedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "verificationCodeHash" TEXT;
ALTER TABLE "User" ADD COLUMN "verificationCodeExpiresAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "verificationSentAt" TIMESTAMP(3);
