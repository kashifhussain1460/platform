-- WAVE 4 §4.2/§4.4/§4.5 — the audit event shape, tamper evidence and legal hold.
--
-- The trail was append-only in practice but nothing PROVED it: with no hash
-- chain, an entry edited or deleted directly in the database left no trace, and
-- "append-only" was a convention rather than something a reader could verify.

-- §4.2 — the fields the plan's event shape requires.
ALTER TABLE "AuditLog" ADD COLUMN "seq" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "AuditLog" ADD COLUMN "actorType" TEXT NOT NULL DEFAULT 'USER';
ALTER TABLE "AuditLog" ADD COLUMN "employeeId" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN "workflowId" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN "workflowRunId" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN "correlationId" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN "ip" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN "userAgent" TEXT;

-- §4.4 — the chain.
ALTER TABLE "AuditLog" ADD COLUMN "previousHash" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN "eventHash" TEXT;

-- Backfill existing rows with a gap-free per-company sequence so the unique
-- index below can be created. They keep NULL hashes: they predate the chain and
-- are reported as UNCHAINED by verification rather than being retro-signed,
-- which would fabricate evidence that never existed.
WITH ordered AS (
  SELECT "id",
         ROW_NUMBER() OVER (PARTITION BY "companyId" ORDER BY "createdAt", "id") AS rn
    FROM "AuditLog"
)
UPDATE "AuditLog" a
   SET "seq" = ordered.rn
  FROM ordered
 WHERE a."id" = ordered."id";

CREATE UNIQUE INDEX "AuditLog_companyId_seq_key" ON "AuditLog"("companyId", "seq");
CREATE INDEX "AuditLog_companyId_action_idx" ON "AuditLog"("companyId", "action");
CREATE INDEX "AuditLog_companyId_workflowRunId_idx" ON "AuditLog"("companyId", "workflowRunId");

-- §4.5 — legal hold.
CREATE TABLE "AuditLegalHold" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "placedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedAt" TIMESTAMP(3),

    CONSTRAINT "AuditLegalHold_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AuditLegalHold_companyId_releasedAt_idx" ON "AuditLegalHold"("companyId", "releasedAt");

ALTER TABLE "AuditLegalHold" ADD CONSTRAINT "AuditLegalHold_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
