# ⚠️ POC ONLY — NOT PRODUCTION — NOT THE DEFAULT RUNTIME

Isolated proof of concept evaluating the **Vercel Workflow SDK** (`workflow` v4.8.2) as a possible
durable execution layer for Orlixa.

**Nothing here is imported by `apps/api`, `apps/web` or `packages/*`.** This directory is not part
of the pnpm workspace (`pnpm-workspace.yaml` globs `apps/*`, `packages/*`, `e2e`), so it has its
own `package-lock.json` and its own `node_modules`. It touches no Orlixa schema, no Orlixa
database and no Orlixa execution path.

**Read the findings, not the code:** [`docs/status/workflow-sdk-poc-report.md`](../../docs/status/workflow-sdk-poc-report.md).
Verdict: 🟡 YELLOW, 61/100, **do not adopt** for now.

## What it is

A minimal NestJS 10 app (the same framework and CommonJS module format as `apps/api`) running the
Workflow SDK against `@workflow/world-postgres`, plus a mock Orlixa boundary — authorization,
approvals, a skill executor and a stateful mock provider — so the POC can tell the difference
between "the runtime never issued a duplicate call" and "the runtime issued one and the provider
absorbed it".

## Running it

Needs the repo's local Postgres (docker compose, port 5433) and a throwaway database:

```sql
CREATE ROLE wfpoc LOGIN PASSWORD 'wfpoc';
CREATE DATABASE workflow_poc OWNER wfpoc;
```

```bash
npm install
WORKFLOW_POSTGRES_URL="postgres://wfpoc:wfpoc@localhost:5433/workflow_poc" \
  npx --package=@workflow/world-postgres bootstrap
npm run build

node scripts/run-poc.mjs      # POC-01 … POC-11 — really kills and restarts the server
node scripts/run-poc08b.mjs   # POC-08b — rebuilds the code while a run is suspended
```

Results land in `evidence/`. The driver owns the server process, so "crash recovery" means an
actual `taskkill /F` (and in POC-05, a step calling `process.exit(137)` on itself).

## Ground rules the POC follows

- No result is asserted from memory. Every check reads back the append-only `evidence/ledger.jsonl`,
  the provider's own state file, or the SDK's run API.
- Failures are injected for real; retries are counted in a file so a process restart cannot reset
  them.
- Anything that could not be tested is marked **NOT VERIFIED**, never PASS. That applies to Vercel
  deployment (§13 of the report) and to POC-05b, which is a measurement rather than a pass/fail.

## Cleanup

```bash
docker exec vaep-postgres-1 psql -U vaep -d vaep -c "DROP DATABASE workflow_poc;" -c "DROP ROLE wfpoc;"
rm -rf node_modules dist .swc .swcrc evidence/*.json evidence/*.jsonl evidence/*.log
```
