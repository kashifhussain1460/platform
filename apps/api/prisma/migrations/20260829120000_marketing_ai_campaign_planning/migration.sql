-- Marketing AI Employee — campaign planning, content items, creative variants.
--
-- Implements the End-to-End Architecture doc §64/§65/§66: a campaign plans a
-- calendar of CONTENT ITEMS, each of which carries 5-6 CREATIVE VARIANTS. A
-- content item is deliberately NOT a platform publication (§18) — that
-- separation is what later allows per-platform adaptation and independent
-- per-platform failure.

-- --------------------------------------------------------------------------
-- Enums
-- --------------------------------------------------------------------------

CREATE TYPE "CampaignStatus" AS ENUM (
  'DRAFT', 'ANALYZING', 'PLANNING', 'GENERATING', 'MEDIA_GENERATING',
  'QUALITY_CHECK', 'READY_FOR_REVIEW', 'PARTIALLY_APPROVED', 'APPROVED',
  'SCHEDULED', 'PUBLISHING', 'ACTIVE', 'PAUSED', 'COMPLETED', 'FAILED',
  'CANCELLED'
);

CREATE TYPE "ContentItemStatus" AS ENUM (
  'DRAFT', 'GENERATING', 'READY_FOR_REVIEW', 'EDIT_REQUIRED', 'APPROVED',
  'SCHEDULED', 'PUBLISHING', 'PUBLISHED', 'FAILED', 'CANCELLED'
);

CREATE TYPE "CreativeVariantStatus" AS ENUM (
  'GENERATING', 'READY', 'SELECTED', 'REJECTED', 'REGENERATING', 'ARCHIVED'
);

-- --------------------------------------------------------------------------
-- Campaign: widen for planning, and convert `status` from TEXT to the enum.
--
-- The existing column is TEXT with a default of 'ACTIVE'. The only writers are
-- the campaigns API, whose DTO restricts input to ACTIVE/PAUSED/COMPLETED —
-- all three are members of the new enum, so the USING cast below is total for
-- every row that can exist. PAUSED is in the enum FOR THIS REASON: it is not in
-- the specification's list, but dropping a state the shipped product already
-- writes would fail this migration on real data.
--
-- The default is dropped before the cast and re-added after: Postgres will not
-- cast a column that still carries a TEXT default.
-- --------------------------------------------------------------------------

ALTER TABLE "Campaign" ALTER COLUMN "status" DROP DEFAULT;

ALTER TABLE "Campaign"
  ALTER COLUMN "status" TYPE "CampaignStatus"
  USING ("status"::"CampaignStatus");

-- New campaigns start as DRAFT and move through the §76 state machine.
-- Existing rows keep whatever they had (ACTIVE for everything created so far).
ALTER TABLE "Campaign" ALTER COLUMN "status" SET DEFAULT 'DRAFT';

ALTER TABLE "Campaign"
  ADD COLUMN "brief"                TEXT,
  ADD COLUMN "objective"            TEXT,
  ADD COLUMN "description"          TEXT,
  ADD COLUMN "createdByUserId"      TEXT,
  ADD COLUMN "startDate"            TIMESTAMP(3),
  ADD COLUMN "endDate"              TIMESTAMP(3),
  ADD COLUMN "timezone"             TEXT NOT NULL DEFAULT 'UTC',
  ADD COLUMN "postsPerDayMin"       INTEGER,
  ADD COLUMN "postsPerDayMax"       INTEGER,
  ADD COLUMN "platforms"            TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "contentPillars"       TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "approvalRequired"     BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "generationError"      TEXT,
  ADD COLUMN "generationStartedAt"  TIMESTAMP(3),
  ADD COLUMN "generationFinishedAt" TIMESTAMP(3),
  ADD COLUMN "updatedAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX "Campaign_companyId_status_idx" ON "Campaign"("companyId", "status");

-- --------------------------------------------------------------------------
-- ContentItem
-- --------------------------------------------------------------------------

CREATE TABLE "ContentItem" (
  "id"                TEXT NOT NULL,
  "companyId"         TEXT NOT NULL,
  "campaignId"        TEXT NOT NULL,
  "dayNumber"         INTEGER NOT NULL,
  "sequence"          INTEGER NOT NULL,
  "objective"         TEXT NOT NULL,
  "contentType"       TEXT NOT NULL,
  "scheduledAt"       TIMESTAMP(3),
  "timezone"          TEXT NOT NULL DEFAULT 'UTC',
  "currentVersion"    INTEGER NOT NULL DEFAULT 1,
  "selectedVariantId" TEXT,
  "status"            "ContentItemStatus" NOT NULL DEFAULT 'DRAFT',
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ContentItem_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ContentItem_companyId_idx" ON "ContentItem"("companyId");
CREATE INDEX "ContentItem_campaignId_dayNumber_sequence_idx"
  ON "ContentItem"("campaignId", "dayNumber", "sequence");
CREATE INDEX "ContentItem_companyId_status_idx" ON "ContentItem"("companyId", "status");

ALTER TABLE "ContentItem"
  ADD CONSTRAINT "ContentItem_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ContentItem"
  ADD CONSTRAINT "ContentItem_campaignId_fkey"
  FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- --------------------------------------------------------------------------
-- CreativeVariant
-- --------------------------------------------------------------------------

CREATE TABLE "CreativeVariant" (
  "id"                   TEXT NOT NULL,
  "companyId"            TEXT NOT NULL,
  "contentItemId"        TEXT NOT NULL,
  "variantNumber"        INTEGER NOT NULL,
  "version"              INTEGER NOT NULL DEFAULT 1,
  "hook"                 TEXT NOT NULL,
  "caption"              TEXT NOT NULL,
  "cta"                  TEXT NOT NULL,
  "hashtags"             TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "contentAngle"         TEXT NOT NULL,
  "mediaBrief"           TEXT,
  "recommended"          BOOLEAN NOT NULL DEFAULT false,
  "recommendationReason" TEXT,
  "status"               "CreativeVariantStatus" NOT NULL DEFAULT 'GENERATING',
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"            TIMESTAMP(3) NOT NULL,

  CONSTRAINT "CreativeVariant_pkey" PRIMARY KEY ("id")
);

-- Regenerating a content item bumps its version rather than overwriting, so
-- the same variantNumber may legitimately exist once PER VERSION. That is what
-- makes the §93 audit trail ("what did version 2 actually say?") answerable.
CREATE UNIQUE INDEX "CreativeVariant_contentItemId_variantNumber_version_key"
  ON "CreativeVariant"("contentItemId", "variantNumber", "version");
CREATE INDEX "CreativeVariant_companyId_idx" ON "CreativeVariant"("companyId");
CREATE INDEX "CreativeVariant_contentItemId_status_idx"
  ON "CreativeVariant"("contentItemId", "status");

ALTER TABLE "CreativeVariant"
  ADD CONSTRAINT "CreativeVariant_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CreativeVariant"
  ADD CONSTRAINT "CreativeVariant_contentItemId_fkey"
  FOREIGN KEY ("contentItemId") REFERENCES "ContentItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
