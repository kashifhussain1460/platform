#!/usr/bin/env bash
#
# WAVE 8 §8.2 — take a restorable backup of everything a tenant's data lives in.
#
# Two stores, both required: Postgres holds the records, object storage holds the
# bytes those records point at (knowledge uploads, HR documents, media, audit
# archives). A "backup" of only one of them restores a database full of
# storageKeys pointing at files that no longer exist — which looks like success
# until someone opens a document.
#
# Usage:
#   infra/backup/backup.sh                     # -> infra/backup/artifacts/<stamp>/
#   BACKUP_DIR=/mnt/backups infra/backup/backup.sh
#
# Env (all optional; defaults match infra/docker-compose.yml):
#   DATABASE_URL     postgres connection string (preferred; overrides the parts below)
#   PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE
#   STORAGE_DIR      local object-storage root (STORAGE_PROVIDER=local)
#   S3_ENDPOINT S3_BUCKET AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY  (STORAGE_PROVIDER=s3)
#   BACKUP_DIR       where to write (default infra/backup/artifacts)
#
# Exit codes: 0 ok, non-zero = the backup is NOT usable. Never exits 0 on a
# partial backup — a backup you cannot trust is worse than none, because it
# stops you looking for a real one.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$here/../.." && pwd)"

# --- resolve connection -------------------------------------------------------
# DATABASE_URL wins so this uses the SAME string the app does. A backup taken
# against a different database than the one serving traffic is the classic
# "we had backups" post-mortem.
if [[ -n "${DATABASE_URL:-}" ]]; then
  conn="$DATABASE_URL"
else
  conn="postgresql://${PGUSER:-vaep}:${PGPASSWORD:-vaep}@${PGHOST:-localhost}:${PGPORT:-5433}/${PGDATABASE:-vaep}"
fi
# Strip query params (?schema=public) — libpq rejects Prisma's.
conn_clean="${conn%%\?*}"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
out_root="${BACKUP_DIR:-$here/artifacts}"
out="$out_root/$stamp"
mkdir -p "$out"

echo "==> backup $stamp -> $out"

# --- 1. Postgres --------------------------------------------------------------
# Custom format (-Fc): compressed, and restorable selectively with pg_restore,
# which matters when the recovery you need is one table rather than the world.
# --no-owner/--no-acl so a restore into a differently-named role works; role
# grants are environment config, not tenant data.
echo "==> pg_dump"
if ! pg_dump --format=custom --no-owner --no-acl --file="$out/postgres.dump" "$conn_clean"; then
  echo "!! pg_dump FAILED — backup is not usable" >&2
  exit 1
fi

# The migration state, in plain text. On restore you must know which schema
# version the dump corresponds to, or you risk running migrations that have
# already been applied.
psql "$conn_clean" -At -c \
  'select migration_name from "_prisma_migrations" where finished_at is not null order by finished_at desc limit 1' \
  > "$out/schema-version.txt" 2>/dev/null || echo "unknown" > "$out/schema-version.txt"

# --- 2. Object storage --------------------------------------------------------
echo "==> object storage"
storage_mode="none"
if [[ -n "${S3_BUCKET:-}" ]]; then
  storage_mode="s3"
  # `aws s3 sync` rather than a tarball: incremental, and restorable one prefix
  # at a time. Requires the aws CLI on the backup host.
  aws ${S3_ENDPOINT:+--endpoint-url "$S3_ENDPOINT"} s3 sync "s3://$S3_BUCKET" "$out/objects/" --quiet
elif [[ -d "${STORAGE_DIR:-$repo_root/apps/api/.storage}" ]]; then
  storage_mode="local"
  src="${STORAGE_DIR:-$repo_root/apps/api/.storage}"
  mkdir -p "$out/objects"
  cp -r "$src/." "$out/objects/" 2>/dev/null || true
else
  echo "   (no object store configured — recording that fact rather than pretending)"
fi

# --- 3. Manifest --------------------------------------------------------------
# Written LAST and on purpose: its presence is the signal that every previous
# step finished. A directory without a manifest is a partial backup, and the
# restore script refuses it.
db_bytes=$(wc -c < "$out/postgres.dump" | tr -d ' ')
obj_count=$(find "$out/objects" -type f 2>/dev/null | wc -l | tr -d ' ')
cat > "$out/manifest.json" <<JSON
{
  "takenAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "stamp": "$stamp",
  "database": {
    "file": "postgres.dump",
    "format": "custom",
    "bytes": $db_bytes,
    "schemaVersion": "$(cat "$out/schema-version.txt")"
  },
  "objectStorage": {
    "mode": "$storage_mode",
    "fileCount": $obj_count
  },
  "complete": true
}
JSON

echo "==> done: db=${db_bytes}B objects=${obj_count} (${storage_mode})"
echo "$out"
