#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mock_dir="$(mktemp -d "${TMPDIR:-/tmp}/bankpilot-migration-check.XXXXXX")"
trap 'rm -rf "$mock_dir"' EXIT
cat > "$mock_dir/docker" <<'MOCK'
#!/usr/bin/env bash
if [[ "$1 $2" == "compose version" ]]; then exit 0; fi
# Simulate docker exec forwarding stdin even for a psql -c query.
cat > /dev/null
printf '1\n'
MOCK
chmod 700 "$mock_dir/docker"
output="$(printf 'bash scripts/migrate.sh\nprintf "REMOTE_SCRIPT_CONTINUED\\n"\n' | PATH="$mock_dir:$PATH" bash -s)"
if [[ "$output" != *REMOTE_SCRIPT_CONTINUED* ]]; then
  echo "Migration check consumed subsequent remote commands." >&2
  exit 1
fi
for migration in db/migrations/*.sql; do
  if [[ "$output" != *"skip $(basename "$migration")"* ]]; then
    echo "Migration check omitted $migration." >&2
    exit 1
  fi
done
echo "Migration stdin regression passed."
