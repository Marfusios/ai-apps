#!/bin/bash
# Restore a backup into this environment's database (docs/RUNBOOK.md, "Backups"). Runs in the
# one-shot aviation-restore container (compose.yaml; `pnpm app:restore <file>`) with the
# PostgreSQL client tools of the server's major version, as the migrator login.
#
# - Only into a freshly provisioned database: one that holds no table, sequence or function
#   yet (`pnpm provision:shared` creates it, with the roles, schemas and default privileges).
# - Every object is created by aviation_migrator and so owned by it, as the migrations expect;
#   the dump's grants are applied as they were. The migrator's default privileges (provisioning
#   lets the runtime roles read every table the migrator creates) are cleared first, because
#   pg_dump's grants never revoke them. Both roles would otherwise read tables they must not:
#   aviation_ingest the sign-in, brief, idempotency, quota, lease, trial, Turnstile and abuse
#   tables; aviation_app all of `cases` (the internal event ids too), embedding_cache,
#   quarantine and ingestion_runs. The dump restores the default privileges at its end.
# - One transaction: COMMIT is sent only after pg_restore has produced the whole dump, and the
#   first error stops psql, so a failed restore leaves the database as it was. Skipped: the
#   schema `drizzle`, which provisioning created (its journal table is restored), and the
#   grants on schema `public`, which provisioning sets and only its owner could change.
# - The same transaction ends with after-restore.sql: it records the restore and holds paid
#   operations (server/quota/hold.ts), so the restored database never opens with them allowed;
#   for a backup taken before migration 0020, the migration starts held instead.
#
# - The connection goes through a private libpq service file (libpq-service.sh), never through
#   an argument.
#
# `pnpm worker restore-check` then verifies owners, grants and the left-out tables, and holds
# paid operations again until `pnpm worker restore-reconcile`. Prints no credentials.
set -euo pipefail
: "${DATABASE_MIGRATOR_URL:?DATABASE_MIGRATOR_URL is not set}"
# A plain name (it is also written into the restore record): no path, no quotes.
if [[ $# -ne 1 || ! "$1" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]*\.dump$ ]]; then
  echo "usage: aviation-restore <file>.dump (a file in AVIATION_BACKUP_DIR)" >&2
  exit 2
fi
here=$(dirname "${BASH_SOURCE[0]}")
file="${AVIATION_BACKUP_MOUNT:-/backup}/$1"
if [[ ! -f "$file" ]]; then
  echo "no backup named $1 in AVIATION_BACKUP_DIR" >&2
  exit 2
fi
# shellcheck source=libpq-service.sh
source "$here/libpq-service.sh"
private=$(mktemp -d)
trap 'rm -rf "$private"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
aviation_service_file "$private"
psql=(psql -X -q -v ON_ERROR_STOP=1)

objects=$("${psql[@]}" -tA -c "
  SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname IN ('public', 'drizzle'))
       + (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname IN ('public', 'drizzle'))")
if [[ "$objects" != 0 ]]; then
  echo "the database already holds ${objects} objects: restore only into a freshly provisioned database (RUNBOOK, \"Backups\")" >&2
  exit 2
fi

list="$private/restore.list"
pg_restore --list "$file" | grep -Ev '^[0-9]+; [0-9]+ [0-9]+ (SCHEMA - drizzle|ACL - SCHEMA public) ' > "$list"

{
  echo 'BEGIN;'
  cat <<'SQL'
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT CASE d.defaclobjtype WHEN 'r' THEN 'TABLES' WHEN 'S' THEN 'SEQUENCES' WHEN 'f' THEN 'FUNCTIONS'
             WHEN 'T' THEN 'TYPES' WHEN 'n' THEN 'SCHEMAS' END AS objects,
           n.nspname AS schema,
           CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(x.grantee)) END AS grantee
    FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace, aclexplode(d.defaclacl) x
    WHERE d.defaclrole = current_user::regrole
  LOOP
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I %s REVOKE ALL ON %s FROM %s', current_user,
      CASE WHEN r.schema IS NULL THEN '' ELSE format('IN SCHEMA %I', r.schema) END, r.objects, r.grantee);
  END LOOP;
END $$;
SQL
  pg_restore --no-owner --use-list "$list" --file - "$file" &&
    printf "SET LOCAL aviation.restored_from = '%s';\n" "$1" &&
    cat "$here/after-restore.sql" &&
    echo 'COMMIT;'
} | "${psql[@]}" --output /dev/null
echo "restored $1"
