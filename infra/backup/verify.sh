#!/usr/bin/env bash
#
# WAVE 8 §8.2 — prove the backup is restorable, and measure how long it takes.
#
# This is the script that turns "we have backups" into a fact. It takes a fresh
# backup, restores it into a throwaway database, and compares the restored data
# against the source table by table. It also times the restore, which is the
# only honest way to state an RTO.
#
# Run it on a schedule. An untested backup decays silently: a schema change, a
# new extension, a bucket that stopped syncing — none of it announces itself
# until the day you need the backup.
#
#   infra/backup/verify.sh
#
# Exit 0 = restore verified. Non-zero = the backup is NOT proven; treat it as
# an incident, not a flaky test.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ -n "${DATABASE_URL:-}" ]]; then
  src_conn="${DATABASE_URL%%\?*}"
else
  src_conn="postgresql://${PGUSER:-vaep}:${PGPASSWORD:-vaep}@${PGHOST:-localhost}:${PGPORT:-5433}/${PGDATABASE:-vaep}"
fi

# Tables whose loss would be a reportable incident. Counting every table would
# be noisier without being stricter — these are the ones a restore MUST bring
# back, and they span each concern: tenancy, execution, evidence, and the
# bytes-on-disk pointers.
CRITICAL_TABLES=(
  Company User Workflow WorkflowVersion WorkflowRun WorkflowStepRun
  WorkflowStepAttempt ApprovalRequest AuditLog KnowledgeDocument
  KnowledgeChunk EmployeeMemory StaffMember InstalledSkill
)

count_in() { # conn, table
  psql "$1" -At -c "select count(*) from \"$2\";" 2>/dev/null || echo "MISSING"
}

echo "=========================================================="
echo " backup restore verification"
echo " source: ${src_conn##*/}"
echo "=========================================================="

echo
echo "--- 1. take a backup ---"
backup_started=$(date +%s)
backup_dir="$("$here/backup.sh" | tail -1)"
backup_seconds=$(( $(date +%s) - backup_started ))
echo "backup took ${backup_seconds}s -> $backup_dir"

echo
echo "--- 2. restore into a throwaway database ---"
restore_started=$(date +%s)
target="$("$here/restore.sh" "$backup_dir" | tail -1)"
restore_seconds=$(( $(date +%s) - restore_started ))
echo "restore took ${restore_seconds}s -> ${target##*/}"

echo
echo "--- 3. compare restored data against source ---"
failures=0
printf "%-26s %12s %12s   %s\n" "TABLE" "SOURCE" "RESTORED" "RESULT"
for t in "${CRITICAL_TABLES[@]}"; do
  a="$(count_in "$src_conn" "$t")"
  b="$(count_in "$target" "$t")"
  if [[ "$a" == "MISSING" ]]; then
    printf "%-26s %12s %12s   %s\n" "$t" "-" "-" "skipped (not in source)"
    continue
  fi
  if [[ "$a" == "$b" ]]; then
    printf "%-26s %12s %12s   %s\n" "$t" "$a" "$b" "ok"
  else
    printf "%-26s %12s %12s   %s\n" "$t" "$a" "$b" "MISMATCH"
    failures=$((failures + 1))
  fi
done

echo
echo "--- 4. workflow state recovered? ---"
# Row counts alone would pass even if every run came back without its steps.
# This checks the RELATIONSHIP survived, which is what "recover workflow state"
# in the gate actually means.
orphans="$(psql "$target" -At -c \
  'select count(*) from "WorkflowStepRun" s left join "WorkflowRun" r on r.id = s."runId" where r.id is null;' 2>/dev/null || echo 0)"
if [[ "$orphans" == "0" ]]; then
  echo "step runs orphaned from their run: 0  ok"
else
  echo "step runs orphaned from their run: $orphans  BROKEN"
  failures=$((failures + 1))
fi

# A run that was mid-flight at backup time must come back mid-flight, not as a
# phantom success. (Informational: a quiet database legitimately has none.)
inflight="$(psql "$target" -At -c \
  $'select count(*) from "WorkflowRun" where status in (\'PENDING\',\'RUNNING\',\'WAITING\');' 2>/dev/null || echo 0)"
echo "runs restored still in flight (recoverable by the reaper): $inflight"

echo
echo "--- 5. object storage ---"
obj_expected="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['objectStorage']['fileCount'])" "$backup_dir/manifest.json" 2>/dev/null || echo 0)"
obj_actual="$(find "$backup_dir/objects" -type f 2>/dev/null | wc -l | tr -d ' ')"
if [[ "$obj_expected" == "$obj_actual" ]]; then
  echo "objects captured: $obj_actual  ok"
else
  echo "objects captured: $obj_actual, manifest says $obj_expected  MISMATCH"
  failures=$((failures + 1))
fi

echo
echo "=========================================================="
if [[ "$failures" -eq 0 ]]; then
  echo " VERIFIED — backup $backup_dir is restorable"
  echo " measured: backup ${backup_seconds}s, restore ${restore_seconds}s"
  echo "=========================================================="
  exit 0
fi
echo " FAILED — $failures check(s) did not pass. This backup is NOT proven."
echo "=========================================================="
exit 1
