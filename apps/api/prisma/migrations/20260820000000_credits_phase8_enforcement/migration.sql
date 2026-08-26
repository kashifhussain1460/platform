-- Credit system Phase 8 (Enforcement) — hand-authored (non-interactive shell),
-- mirrors the established convention (20260807030000_refresh_token_store and
-- every credits-phase migration since). Pure additive DDL: two nullable
-- columns, no backfill required (both null on every existing row means
-- "not yet enrolled" / "pre-Phase-8", which the application code already
-- treats as the safe default).

-- Task 8.3/8.4 — the per-company enforcement canary allowlist.
ALTER TABLE "Company" ADD COLUMN "creditEnforcementEnabledAt" TIMESTAMP(3);

-- Task 8.4 (Q22) — snapshotted engine mode per run.
ALTER TABLE "WorkflowRun" ADD COLUMN "engineMode" TEXT;
