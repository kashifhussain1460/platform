# Deployment runbook

How code and schema reach production, why it is shaped this way, and what to do
when it breaks.

---

## 1. What went wrong, and what this prevents

On **2026-08-28** a customer-visible 404 on `POST /auth/resend-verification` was
traced to `platform-api` serving code from **27 July — 32 days stale**. The
investigation found five separate problems, and they share one property:
**nothing failed loudly.**

| Problem | Why nobody noticed |
|---|---|
| `platform-api` stopped deploying | No failed builds — the Git trigger simply stopped firing. Every dashboard was green. |
| `MAIL_ENABLED` unset in production | `MailService.generateOtp()` silently returns the fixed dev code, so **every OTP was `123456`** — a live auth bypass, created by an absent value. |
| `WORKFLOW_EXECUTION_MODE` unset | With `QUEUE_WORKERS_ENABLED=false` there is no consumer and no inline execution, so every workflow run sat `PENDING` for ever (gap G40). |
| `CRON_SECRET` unset | Unset *disables* `/admin/cron/*` by design, so all 17 scheduled jobs never ran. |
| Preview shared Production's `DATABASE_URL` | Preview builds ran `prisma migrate deploy` against the production database. |

The pipeline below exists to convert each of those silences into a red build.

---

## 2. The pipeline

`.github/workflows/deploy.yml`, on push to `master` or manual dispatch:

```
preflight ─┐
quality  ──┼─→ migrate ─→ deploy-api ─→ deploy-web ─→ smoke
test     ──┘
```

| Job | Blocks on | Prevents |
|---|---|---|
| `preflight` | Missing/contradictory production config | The `123456` OTP class of bug |
| `quality` | Lint or typecheck failure (both apps) | Deploying code that does not compile cleanly |
| `test` | Unit + e2e + web tests on this exact commit | Shipping a regression |
| `migrate` | `prisma migrate deploy` against production | Code deploying ahead of its schema |
| `deploy-api` / `deploy-web` | Vercel build/deploy failure | — |
| `smoke` | A route answering 404 on the live host | **The 32-day bug** |

### One workflow per push

`api-ci`, `web-ci` and `browser-e2e` run on **pull requests and manual dispatch
only**. They used to run on push as well, so a single deployable commit ran the
API e2e suite three times (twice via api-ci's engine matrix, once via deploy).

Because this repo pushes straight to `master`, `deploy.yml` therefore has to
carry the lint and typecheck those files used to provide — hence the `quality`
job. Removing them without it would have meant deploying with neither.

Not run on a master push, by choice: the deprecated `legacy_walk` engine leg
(`continue-on-error`, knowingly red on approval RESUME, so it never gated
anything) and the Playwright browser suite. Both run on any PR and via
*Run workflow*.

### Why GitHub Actions deploys, not Vercel

Vercel's Git integration deploys the moment a commit lands — it cannot wait for
CI, and it cannot sequence a database migration before a code deploy. Moving the
deploy into Actions is what buys the ordering guarantee.

Vercel's own auto-deploy for `master` is therefore **off** in both
`apps/api/vercel.json` and `apps/web/vercel.json`
(`git.deploymentEnabled.master: false`). If it were left on, every push would
produce two production deployments racing each other, one of them ungated.

### Why migrations left the Vercel build

They used to run inside `buildCommand`. That coupling means a schema failure
fails the *build*, and a failed build makes Vercel **keep serving the previous
deployment** — the site stays up and the problem is invisible. As a separate
job, a migration failure stops the pipeline and reports.

---

## 3. One-time setup

**Order matters.** The `vercel.json` changes disable Vercel's auto-deploy, so if
they land before the secrets exist, *nothing deploys at all*. Do steps 1–2 first.

### 1. GitHub secrets — Settings → Secrets and variables → Actions

| Secret | Value |
|---|---|
| `VERCEL_TOKEN` | Vercel → Account Settings → Tokens, scoped to the `orlixaio` team |
| `VERCEL_ORG_ID` | the `orlixaio` team id — `npx vercel teams ls --json`, or copy it from `.vercel/project.json` after any `vercel link` |
| `VERCEL_PROJECT_ID_API` | `prj_WPdMaDrAuWV59v26HnmPg2JVMjjl` |
| `VERCEL_PROJECT_ID_WEB` | `prj_rwBiJASjGWv8yPC6N9xQ0wMkYsiK` |
| `PRODUCTION_DATABASE_URL` | Neon **unpooled/direct** URL — migrations must not go through the pooler |

Variables (not secrets):

| Variable | Value |
|---|---|
| `PRODUCTION_API_URL` | `https://api.orlixa.io` |

### 2. Vercel environment variables on `platform-api`

Set for **Production**:

| Variable | Value | Why |
|---|---|---|
| `WORKFLOW_EXECUTION_MODE` | `inline` | No worker runs on Vercel; without this no workflow ever executes |
| `CRON_SECRET` | a strong random string | Unset disables all 17 cron routes |
| `MAIL_ENABLED` | `true` | **Security.** Otherwise every OTP is `123456` |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `MAIL_FROM` | your provider | Required once mail is enabled |
| `NODE_ENV` | `production` | Turns on the strict half of the preflight |

Verify locally before deploying:

```bash
npx vercel env pull apps/api/.vercel/.env.production.local \
  --environment=production --scope orlixa1 --project platform-api
node -e "
const fs=require('fs'),cp=require('child_process');const env={...process.env};
for(const l of fs.readFileSync('apps/api/.vercel/.env.production.local','utf8').split(/\r?\n/)){
  const m=l.match(/^([A-Z0-9_]+)=(.*)\$/); if(m) env[m[1]]=m[2].trim().replace(/^\"|\"\$/g,'');
}
process.exit(cp.spawnSync(process.execPath,['scripts/preflight-env.mjs'],{env,stdio:'inherit'}).status);
"
rm -rf apps/api/.vercel   # it holds cleartext secrets
```

> **`vercel env pull` hides Sensitive values.** It writes the literal string
> `[SENSITIVE]` instead of the value — currently for 28 of 61 variables. The
> preflight therefore checks **presence** for those and says so in a `NOTE`
> line; it cannot check their contents.
>
> This is worth knowing because it is genuinely misleading: `[SENSITIVE]` is 11
> characters, so a naive length check on `ENCRYPTION_KEY` reports a
> "wrong-length key that would throw at boot" — a convincing, entirely false
> alarm. Acting on it would mean rotating a live key and making every stored
> credential undecryptable. **Never conclude a secret is malformed from a
> pulled env file.** Read it in the Vercel dashboard.
>
> Do not "fix" this by unmarking variables as Sensitive.

Note that sourcing the file with `set -a; . file` mangles quoted values (a
`DATABASE_URL` comes through without its protocol). Parse it as shown above.

### 3. Give Preview its own database

Preview currently reuses Production's `DATABASE_URL`, so a branch deploy reads
and writes **live customer data**. Create a Neon branch and override
`DATABASE_URL` for the Preview environment only.

Removing migrations from the build defused the worst version of this (a preview
build can no longer migrate production), but the shared-data hazard remains.

### 4. Merge

Once 1–3 are done, merge the pipeline. The first push to `master` runs it.

---

## 4. Routine deploys

Push to `master`. That is the whole procedure.

Watch the run. If `smoke` is green, the code you pushed is genuinely live —
that is the claim the old setup could never make.

**Redeploying without a code change** (e.g. after fixing an env var): Actions →
Deploy → Run workflow. Tick `skip_migrations` only when the schema is unchanged.

---

## 5. Rehearse on a Neon branch

Do this for any large or backfilling migration batch. CI proves migrations run
against an *empty* database; it cannot prove they behave against real data
volumes or existing rows that violate a new constraint.

```bash
# 1. Branch production (copy-on-write, seconds, no impact on prod)
npx neonctl branches create --name migration-rehearsal --parent production

# 2. Point at the branch and apply
export DATABASE_URL="<branch connection string>"
cd apps/api && pnpm exec prisma migrate deploy

# 3. Check it landed cleanly, then throw the branch away
pnpm exec prisma migrate status
npx neonctl branches delete migration-rehearsal
```

Only then run the real deploy.

---

## 6. When something breaks

### Smoke test fails with 404s

The deployment did not take, or took partially. **The running build is not the
code you think it is.** Check the `deploy-api` job actually succeeded, then:

```bash
API_BASE_URL=https://api.orlixa.io node scripts/smoke-test.mjs
```

A 404 on a route that exists in `master` means stale code — exactly the original
bug. Re-run the workflow; if it recurs, check Vercel for a project-level setting
overriding the deployment.

### Preflight fails

Read the message — each one names the consequence, not just the missing key. Fix
it in the Vercel dashboard, then re-run via `workflow_dispatch`. Do **not**
bypass it: every check in that script corresponds to a real production incident.

### Migration fails

The pipeline stops before deploying, so **code and schema stay consistent** —
the old code is still running against the old schema. Nothing is broken for
users. Fix the migration, push again.

If it failed *part way*, Prisma marks it failed and refuses further migrations
until resolved. Rehearse the fix on a Neon branch, then use
`prisma migrate resolve`. Neon's point-in-time restore is the backstop.

### Emergency: bypass the pipeline

Only when the pipeline itself is broken and production is down:

```bash
npx vercel --prod --cwd apps/api --scope orlixa1
```

This skips every gate — no tests, no config check, no migration ordering, no
smoke test. It is how the project ended up 32 days stale. Open an issue the same
day.

---

## 7. Scheduled jobs are currently OFF

All 17 cron definitions live in **`apps/api/vercel.crons.json`**, a sidecar
file Vercel never reads. They are preserved in version control but not
registered.

They are NOT a commented-out key inside `vercel.json`, because that file
validates against a **closed schema** (`additionalProperties: false`):
`vercel deploy` rejects any unrecognised top-level property —

```
Error: Invalid vercel.json - should NOT have additional property `//crons`.
```

— and JSON has no comment syntax. Note that **`vercel build` does not enforce
this**, so a stray key builds cleanly and only fails at deploy. `pnpm --filter
@vaep/api run test:unit` now guards against it.

**Why:** the Vercel account is on the **Hobby** plan, which rejects any cron
running more than once per day. Nine of the seventeen are sub-daily, so the
deploy fails outright:

```
Error: Hobby accounts are limited to daily cron jobs.
This cron expression (* * * * *) would run more than once per day.
```

This is not a regression from the deployment pipeline. The last successful
production deploy (27 July) had **zero** crons in `vercel.json`; every one was
added during the four weeks that never shipped.

**What is switched off while they stay disabled.** With
`WORKFLOW_EXECUTION_MODE=inline` there is no BullMQ worker, so these routes ARE
the scheduler. Until they run again:

| Job | Frequency | Consequence of it not running |
|---|---|---|
| `workflow-schedules` | every min | No scheduled workflow ever fires |
| `gmail-poll`, `imap-poll` | every min | No inbound email is picked up |
| `workflow-watchdog` | 5 min | A stuck run is never reaped |
| `approval-sla` | 5 min | Approvals never escalate or time out |
| `connector-reconcile` | 5 min | A dead connector is never marked disconnected |
| `marketing-sync` | 10 min | Scheduled posts never reconcile to PUBLISHED |
| `credit-reservation-sweep` | 5 min | Credit reservations are never released |
| `alerts` | 15 min | Nobody is paged |
| 8 daily jobs | daily | Retention, credit renewal, reconciliation, rollups all stop |

Request/response traffic — signup, login, chat, the UI — is unaffected.

### Re-enabling

**Option A — Vercel Pro (~$20/month).** Move the `crons` array from
`vercel.crons.json` into `vercel.json` under the key `crons`, then redeploy.
Move it, do not copy it — `cron-schedule-coverage.spec.ts` asserts the list
exists in exactly one place.

**Option B — external scheduler (free).** The routes were designed for this:
`/admin/cron/:job` authenticates with a shared secret, sent as `X-Cron-Secret`
or `Authorization: Bearer`. Point cron-job.org or Upstash QStash at each path
with the `CRON_SECRET` value, keeping the schedules listed in
`vercel.crons.json`. Costs nothing; 17 endpoints to configure and watch outside
Vercel.

**Option C — run a worker.** Deploy `main.ts` as one always-on process with
`QUEUE_WORKERS_ENABLED` unset and set `WORKFLOW_EXECUTION_MODE=queue`. The
BullMQ repeatables then drive this work and the cron routes are unnecessary.
Biggest change, but it is the shape the durable engine was designed for.

Unverified: Hobby may also cap the *number* of cron jobs, not just frequency.
If Option A is taken and a count error appears, that is why.

## 8. Things to know

- **`@vaep/types` is a built CommonJS package.** Anything that typechecks or
  lints the API must run `pnpm --filter @vaep/types build` first, or it fails
  with unresolved-import errors.
- **A guarded route returns 401, not 404.** That is why the smoke test treats
  401/403 as a pass — it proves the route is registered without needing
  credentials.
- **Beware parameterised routes when adding smoke checks.** `GET /workflows/runs`
  looks alive on *any* build because `@Get(':id')` matches it with `id="runs"`
  and the guard answers 401 first. During the 2026-08-28 investigation that
  false positive briefly made a 4-week-old deployment look current. Only add
  paths that no `:param` route can shadow.
- **`legacy_walk` is expected to fail** on approval RESUME. `api-ci.yml` runs it
  for visibility with `continue-on-error`; the deploy pipeline runs only the
  durable engine.
