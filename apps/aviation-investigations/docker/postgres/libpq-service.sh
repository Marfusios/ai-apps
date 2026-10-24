# Sourced by backup.sh and restore.sh (docs/RUNBOOK.md, "Backups"): connect without any
# credential in a process's arguments, which every local user can read.
#
# aviation_service_file <private dir> turns DATABASE_MIGRATOR_URL
# (postgres[ql]://user:password@host[:port]/database[?keyword=value&...], percent-encoded)
# into a libpq service file in that directory (mode 0600), exports PGSERVICEFILE and
# PGSERVICE so libpq reads it, and unsets DATABASE_MIGRATOR_URL. The caller removes the
# directory on exit. No value is printed.

aviation_pct_decode() {
  # A backslash would become a printf escape; a URL percent-encodes it.
  if [[ $1 == *\\* ]]; then return 1; fi
  printf '%b' "${1//%/\\x}"
}

aviation_service_file() {
  local dir=$1
  local re='^postgres(ql)?://([^:@/?#]+)(:([^@/?#]*))?@([^:/?#]+|\[[^]/?#]+\])(:([0-9]+))?/([^/?#]+)(\?([^#]*))?$'
  if [[ ! ${DATABASE_MIGRATOR_URL:-} =~ $re ]]; then
    echo "DATABASE_MIGRATOR_URL is not a postgres://user:password@host[:port]/database URL" >&2
    return 2
  fi
  local user password host port dbname query
  user=$(aviation_pct_decode "${BASH_REMATCH[2]}") || return 2
  password=$(aviation_pct_decode "${BASH_REMATCH[4]}") || return 2
  host=${BASH_REMATCH[5]}
  host=${host#[}
  host=${host%]}
  port=${BASH_REMATCH[7]:-5432}
  dbname=$(aviation_pct_decode "${BASH_REMATCH[8]}") || return 2
  query=${BASH_REMATCH[10]}
  local lines=("[aviation]" "host=$host" "port=$port" "dbname=$dbname" "user=$user")
  [[ -n $password ]] && lines+=("password=$password")
  local pair key value
  if [[ -n $query ]]; then
    local -a pairs
    IFS='&' read -r -a pairs <<< "$query"
    for pair in "${pairs[@]}"; do
      [[ -z $pair ]] && continue
      key=$(aviation_pct_decode "${pair%%=*}") || return 2
      value=$(aviation_pct_decode "${pair#*=}") || return 2
      if [[ ! $key =~ ^[a-z_]+$ ]]; then
        echo "DATABASE_MIGRATOR_URL has an invalid parameter name" >&2
        return 2
      fi
      lines+=("$key=$value")
    done
  fi
  local line
  for line in "${lines[@]}"; do
    if [[ $line == *$'\n'* || $line == *$'\r'* ]]; then
      echo "DATABASE_MIGRATOR_URL holds a line break" >&2
      return 2
    fi
  done
  (umask 077 && printf '%s\n' "${lines[@]}" > "$dir/pg_service.conf") || return 2
  export PGSERVICEFILE="$dir/pg_service.conf" PGSERVICE=aviation
  unset DATABASE_MIGRATOR_URL
}
