-- Resumable minimal onboarding. Additive (nullable + defaulted arrays) →
-- forward-safe, no backfill (onboardingStep null derives from onboardedAt).
-- Hand-authored (non-interactive shell); ADD COLUMN only → no pgvector impact.
ALTER TABLE "Company" ADD COLUMN "onboardingStep" TEXT;
ALTER TABLE "Company" ADD COLUMN "onboardingRoles" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Company" ADD COLUMN "businessGoals" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
