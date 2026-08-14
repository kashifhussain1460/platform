-- WAVE 3 §3.6 — publish idempotency for the Postiz engine.
--
-- `postiz.publish_now` wrote no local row: it called Postiz and returned the
-- provider id. A retried TOOL_ACTION published the same content to the same
-- social account again — a real, public, irreversible duplicate post. Tracking
-- the publish locally with an idempotency key makes the retry a no-op, and also
-- puts publish_now results where reconciliation can see them at all.
ALTER TABLE "ScheduledPost" ADD COLUMN "idempotencyKey" TEXT;

-- Partial by nature: NULL keys never collide in Postgres, so existing scheduled
-- posts (which have none) are unaffected.
CREATE UNIQUE INDEX "ScheduledPost_companyId_idempotencyKey_key"
  ON "ScheduledPost"("companyId", "idempotencyKey");
