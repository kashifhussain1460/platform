# Disaster recovery — backup, restore, RPO/RTO

WAVE 8 §8.2. This is an operational document: it is meant to be followed under
pressure, by someone who did not write it, at 3am.

Scripts live in `infra/backup/`:

| Script | What it does |
| --- | --- |
| `backup.sh` | Takes a restorable backup (Postgres + object storage) into a timestamped directory. |
| `restore.sh` | Restores a backup directory into a target database. Refuses partial backups. |
| `verify.sh` | Takes a backup, restores it to a throwaway database, and compares it against the source. **This is the one that must run on a schedule.** |

---

## 1. Objectives

| | Target | Basis |
| --- | --- | --- |
| **RPO** (max data loss) | **24 hours** on the nightly dump alone; **5 minutes** once PITR/WAL archiving is enabled on the managed instance | A nightly logical dump can only ever recover to the moment it was taken. |
| **RTO** (max time to serve traffic again) | **1 hour** | Measured restore is minutes (see below); the hour is dominated by decision-making, DNS/config, and verification — not by the restore itself. |

### Honest statement of where we are

The RPO above is **two numbers on purpose**, because only one of them is true today:

- **24h is what `backup.sh` alone gives you.** It is a logical dump. If it runs
  at 02:00 and the database is lost at 01:59, you lose a day.
- **5 minutes requires continuous WAL archiving / point-in-time recovery**,
  which is a property of the *hosting* (RDS/Cloud SQL/Neon automated backups),
  not of these scripts. It is **not enabled by this repository** and must be
  turned on in the provider console before the 5-minute figure may be quoted to
  a customer.

Do not put the 5-minute number in a contract until PITR is on and a
point-in-time restore has been rehearsed.

### Measured, not estimated

From an actual `verify.sh` run against the development database
(4,258 companies · 7,618 workflow runs · 16,355 step runs · 10,578 audit rows ·
5.0 MB compressed dump · 664 stored objects):

```
backup    2s
restore   4s
```

Both scale with data volume, not tenant count. Re-run `verify.sh` after any
significant growth and update this table — an RTO quoted from a dataset ten
times smaller than production is a guess wearing a number's clothes.

---

## 2. What is backed up

Two stores, and **both are required**:

1. **Postgres** — every record, via `pg_dump --format=custom`.
2. **Object storage** — the bytes those records point at: knowledge uploads,
   HR documents (`StaffDocument.storageKey`), media assets, and archived audit
   batches.

Restoring only the database gives you a system full of `storageKey` values
pointing at files that no longer exist. It looks healthy until someone opens a
document. `verify.sh` checks the object count for exactly this reason.

**Encryption note.** PII columns (HR special-category data, connector
credentials) are encrypted at rest with `ENCRYPTION_KEY` and the dump contains
the *ciphertext*. A restore is therefore useless without that key — so
`ENCRYPTION_KEY` must be backed up separately, in the secret manager, and
rotated with a documented re-encryption step. **Losing the key is equivalent to
losing the data**, and no database backup can save you from it.

---

## 3. Runbook — restore into a fresh environment

```bash
# 0. Get the key first. Without ENCRYPTION_KEY the restored data is unreadable.
#    Confirm you have it BEFORE you start restoring anything.

# 1. Pick the backup. Newest directory with a manifest.json is the newest
#    COMPLETE one — directories without a manifest did not finish.
ls -1 infra/backup/artifacts/

# 2. Restore the database (into a new name; never over a live one).
DATABASE_URL="postgresql://user:pass@host:5432/newdb" \
  infra/backup/restore.sh infra/backup/artifacts/<stamp> "postgresql://user:pass@host:5432/newdb"

# 3. Restore the objects.
RESTORE_STORAGE_DIR=/srv/vaep-storage \
  infra/backup/restore.sh infra/backup/artifacts/<stamp>
#    ...or for S3/MinIO: S3_BUCKET=vaep S3_ENDPOINT=https://... infra/backup/restore.sh <dir>

# 4. Point the app at it and start ONE instance with workers enabled.
#    QUEUE_WORKERS_ENABLED must be true somewhere, or nothing drains the queue.

# 5. Recover workflow state — see §4.

# 6. Verify before taking traffic:
curl -s "$API/health"
curl -s "$API/audit-log/verify" -H "Authorization: Bearer <owner token>"
#    -> {"valid":true}. The audit chain is hash-linked, so this proves the
#       restored evidence trail was not silently truncated.
```

---

## 4. Recovering workflow state

A restore lands mid-flight runs exactly as they were: `PENDING`, `RUNNING` or
`WAITING`. That is correct — and it is also why the system does **not**
automatically re-run them.

- **`WAITING` runs** (parked on an approval or a timer) resume by themselves
  when the approval is decided or the timer fires. Nothing to do.
- **`RUNNING` runs** were interrupted. Their lease is stale, and the **reaper**
  (`workflow-runtime/reaper.service.ts`, every 60s) reclaims them. Restart the
  workers and it happens on its own.
- **`PENDING` runs** never started. The queue is *not* in the database backup
  (Redis is a separate store and is deliberately treated as disposable), so
  their jobs are gone. The **watchdog** (`/admin/cron/workflow-watchdog`) marks
  runs stuck past the ceiling as `FAILED` rather than silently re-running them.

**Why failure rather than replay:** a workflow step may have already sent the
email, posted the message or charged the card. Replaying it would produce a
duplicate side effect, which the WAVE 8 invariants forbid. The system therefore
surfaces the interrupted run for a human decision instead of guessing. Re-run
deliberately from the UI when the side effects are known to be safe.

`verify.sh` prints the in-flight count for this reason: after a real restore it
tells you how many runs need attention.

---

## 5. What is NOT recovered

State this plainly to anyone asking "are we covered":

| Not in the backup | Consequence | Mitigation |
| --- | --- | --- |
| **Redis** (BullMQ queue, rate limiters, circuit breakers) | Queued-but-unstarted jobs are lost | Watchdog fails them visibly; schedules re-register on activate |
| **`ENCRYPTION_KEY`** | Encrypted PII and credentials unreadable | Back it up in the secret manager, separately |
| **OAuth provider state** | Connectors may need re-authorisation | Connector health marks them `DISCONNECTED` |
| **Point-in-time (sub-24h)** | Up to 24h loss | Enable provider PITR — see §1 |

---

## 6. Schedule

| Job | Cadence | Why |
| --- | --- | --- |
| `backup.sh` | nightly | The RPO floor. |
| `verify.sh` | weekly | An untested backup decays silently — a schema change, a new extension, or a bucket that stopped syncing announces itself only when you need the backup. Treat a red run as an incident. |
| Full restore rehearsal into a scratch environment | quarterly | The runbook above is only true if someone has followed it recently. |

Retention of the backups themselves: keep 7 daily, 4 weekly, 12 monthly. Note
that a backup is a copy of personal data — it inherits the same deletion
obligations as production, so an erasure request is not complete until the
backups holding that data have aged out. Record that in the erasure response.
