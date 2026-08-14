#!/usr/bin/env bash
#
# WAVE 8 §8.2 — restore a backup into a target database.
#
# The plan's rule: "A backup is not operationally proven until restoration is
# tested." So this exists to be RUN, regularly, not to be read. `verify.sh`
# drives it against a throwaway database and checks the result.
#
# Usage:
#   infra/backup/restore.sh <backup-dir> [target-database-url]
#
# With no target, it restores into a database named `<current>_restore` on the
# same server — never over the source. Restoring onto production by fat-finger
# is a bigger outage than whatever you were recovering from, so the destructive
# path requires you to name the target explicitly AND set RESTORE_FORCE=1.
set -euo pipefail

backup_dir="${1:-}"
target="${2:-}"

if [[ -z "$backup_dir" || ! -d "$backup_dir" ]]; then
  echo "usage: restore.sh <backup-dir> [target-database-url]" >&2
  exit 2
fi

# A manifest is written last by backup.sh, so its absence means the backup did
# not finish. Restoring a partial dump silently gives you a database that is
# subtly missing rows — the failure mode this check exists to prevent.
if [[ ! -f "$backup_dir/manifest.json" ]]; then
  echo "!! $backup_dir has no manifest.json — incomplete backup, refusing" >&2
  exit 1
fi
if [[ ! -f "$backup_dir/postgres.dump" ]]; then
  echo "!! $backup_dir has no postgres.dump — refusing" >&2
  exit 1
fi

if [[ -n "${DATABASE_URL:-}" ]]; then
  src_conn="${DATABASE_URL%%\?*}"
else
  src_conn="postgresql://${PGUSER:-vaep}:${PGPASSWORD:-vaep}@${PGHOST:-localhost}:${PGPORT:-5433}/${PGDATABASE:-vaep}"
fi

if [[ -z "$target" ]]; then
  base_db="$(basename "${src_conn}")"
  target="${src_conn%/*}/${base_db}_restore"
  echo "==> no target given; restoring into ${base_db}_restore (source untouched)"
else
  target="${target%%\?*}"
  same_db="$([[ "$target" == "$src_conn" ]] && echo yes || echo no)"
  if [[ "$same_db" == "yes" && "${RESTORE_FORCE:-}" != "1" ]]; then
    echo "!! target is the SOURCE database. Set RESTORE_FORCE=1 if you really mean it." >&2
    exit 1
  fi
fi

target_db="$(basename "$target")"
admin_conn="${target%/*}/postgres"

echo "==> restoring $backup_dir -> $target_db"

# --- 1. Recreate the target database -----------------------------------------
# DROP then CREATE: pg_restore into a database with existing objects produces a
# confusing half-merge. A restore must land on a clean slate or it is not a
# restore.
psql "$admin_conn" -v ON_ERROR_STOP=1 -q -c \
  "select pg_terminate_backend(pid) from pg_stat_activity where datname = '$target_db' and pid <> pg_backend_pid();" >/dev/null 2>&1 || true
psql "$admin_conn" -v ON_ERROR_STOP=1 -q -c "drop database if exists \"$target_db\";"
psql "$admin_conn" -v ON_ERROR_STOP=1 -q -c "create database \"$target_db\";"

# pgvector lives in the dump as `CREATE EXTENSION`, but the extension must be
# installable on the target — a plain postgres image cannot restore this backup
# at all. Failing here, loudly, beats discovering it during an incident.
psql "$target" -v ON_ERROR_STOP=1 -q -c "create extension if not exists vector;" || {
  echo "!! target server has no pgvector extension — this backup cannot be restored here" >&2
  exit 1
}

# --- 2. Restore ---------------------------------------------------------------
# --no-owner/--no-acl to match the dump. Not --exit-on-error: pg_restore reports
# benign errors for objects that already exist (the vector extension we just
# created), so the real check is the verification below, not the exit code.
pg_restore --no-owner --no-acl --dbname="$target" "$backup_dir/postgres.dump" 2> "$backup_dir/restore.stderr" || true

# --- 3. Object storage --------------------------------------------------------
if [[ -d "$backup_dir/objects" ]]; then
  dest="${RESTORE_STORAGE_DIR:-}"
  if [[ -n "${S3_BUCKET:-}" && -z "$dest" ]]; then
    aws ${S3_ENDPOINT:+--endpoint-url "$S3_ENDPOINT"} s3 sync "$backup_dir/objects/" "s3://$S3_BUCKET" --quiet
    echo "==> objects restored to s3://$S3_BUCKET"
  elif [[ -n "$dest" ]]; then
    mkdir -p "$dest"
    cp -r "$backup_dir/objects/." "$dest/"
    echo "==> objects restored to $dest"
  else
    echo "==> objects present in backup but no restore target set (RESTORE_STORAGE_DIR / S3_BUCKET) — skipped"
  fi
fi

echo "==> restored into $target_db"
echo "$target"
