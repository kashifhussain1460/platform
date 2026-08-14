-- WAVE 3 §3.6 — consent + suppression.
--
-- Neither existed. "Suppression/consent enforcement" was listed as a gap in the
-- WAVE 3 doc and is a build, not a fix: there was no model, no list and no
-- enforcement anywhere, so nothing stopped an AI Employee emailing someone who
-- had unsubscribed.
CREATE TABLE "MarketingSuppression" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "source" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MarketingSuppression_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "MarketingSuppression_companyId_channel_address_key"
  ON "MarketingSuppression"("companyId", "channel", "address");
CREATE INDEX "MarketingSuppression_companyId_createdAt_idx"
  ON "MarketingSuppression"("companyId", "createdAt");
ALTER TABLE "MarketingSuppression" ADD CONSTRAINT "MarketingSuppression_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "MarketingConsent" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "evidence" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MarketingConsent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "MarketingConsent_companyId_channel_address_createdAt_idx"
  ON "MarketingConsent"("companyId", "channel", "address", "createdAt");
ALTER TABLE "MarketingConsent" ADD CONSTRAINT "MarketingConsent_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
