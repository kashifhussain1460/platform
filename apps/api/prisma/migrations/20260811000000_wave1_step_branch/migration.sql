-- WAVE 1 (gap W1-b) — durable graph traversal needs the routing decision on disk.
--
-- The advance worker may run long after the step that preceded it (reaper
-- re-enqueue, redeploy, Redis flush), so "which edge did this node take?" cannot
-- live in memory or in a job payload. Nullable + no default: an existing step
-- simply has no recorded branch, which the traversal reads as "does not branch"
-- — exactly how every pre-WAVE-1 step behaved.
ALTER TABLE "WorkflowStepRun" ADD COLUMN "branch" TEXT;
