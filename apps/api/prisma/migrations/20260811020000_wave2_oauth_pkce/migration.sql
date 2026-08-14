-- WAVE 2 §2.5 — OAuth hardening: one-time state + PKCE.
--
-- The flow was stateless (HMAC-signed state only), which makes the state
-- replayable within its TTL and leaves nowhere to hold a PKCE code_verifier.
-- This table gives both: a single-use row keyed by the state's nonce, holding
-- the verifier that never leaves the server.
CREATE TABLE "OAuthAuthorizationRequest" (
    "id" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "userId" TEXT,
    "installedSkillId" TEXT NOT NULL,
    "skillKey" TEXT NOT NULL,
    "codeVerifier" TEXT NOT NULL,
    "returnTo" TEXT,
    "usedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OAuthAuthorizationRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OAuthAuthorizationRequest_nonce_key" ON "OAuthAuthorizationRequest"("nonce");
CREATE INDEX "OAuthAuthorizationRequest_expiresAt_idx" ON "OAuthAuthorizationRequest"("expiresAt");
CREATE INDEX "OAuthAuthorizationRequest_companyId_idx" ON "OAuthAuthorizationRequest"("companyId");
