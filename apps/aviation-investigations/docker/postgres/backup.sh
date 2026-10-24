#!/bin/bash
# Back up this environment's database (docs/RUNBOOK.md, "Backups"). Runs in the one-shot
# aviation-backup container (compose.yaml; `pnpm app:backup`) with the PostgreSQL client
# tools of the server's major version, as the migrator login: the only login that can read
# every table (pg_dump locks each table it dumps, the ones whose rows it leaves out too).
#
# The dump holds every definition but no rows of the tables in server/db/backup.ts
# (BACKUP_EXCLUDED_DATA; tests/unit/backup.test.ts keeps this list equal to it). It is written
# as aviation_<env>-<UTC time>.dump into AVIATION_BACKUP_DIR, mode 0600, under a temporary
# name first, so a file with the final name is always complete. Prints no credentials.
set -euo pipefail
umask 077
: "${DATABASE_MIGRATOR_URL:?DATABASE_MIGRATOR_URL is not set}"
: "${APP_ENV:?APP_ENV is not set}"
if [[ $# -ne 0 ]]; then
  echo "aviation-backup takes no arguments" >&2
  exit 2
fi

name="aviation_${APP_ENV}-$(date -u +%Y-%m-%dT%H%M%SZ).dump"
partial="/backup/.${name}.partial"
trap 'rm -f "$partial"' EXIT
pg_dump --format=custom \
  --exclude-table-data=auth_deletion_confirmations \
  --exclude-table-data=auth_sessions \
  --exclude-table-data=auth_accounts \
  --exclude-table-data=auth_verifications \
  --exclude-table-data=auth_state_uses \
  --exclude-table-data=auth_users \
  --exclude-table-data=brief_steps \
  --exclude-table-data=briefs \
  --exclude-table-data=idempotency \
  --file "$partial" --dbname "$DATABASE_MIGRATOR_URL"
mv "$partial" "/backup/${name}"
trap - EXIT
echo "backup written: ${name}"
