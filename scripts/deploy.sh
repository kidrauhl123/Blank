#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"
target="${1:-CONTABO-jp}"
if [[ ! "$target" =~ ^[A-Za-z0-9][A-Za-z0-9_.@-]*$ ]]; then
  echo "Invalid SSH target." >&2
  exit 2
fi
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Commit the working tree before deployment." >&2
  exit 2
fi
commit_sha="$(git rev-parse HEAD)"
release_stamp="$(date -u +%Y%m%dT%H%M%SZ)"
release_dir="$(mktemp -d "${TMPDIR:-/tmp}/bankpilot-release.XXXXXX")"
trap 'rm -rf "$release_dir"' EXIT

# Export the committed source only; local credentials and untracked files never
# enter the release directory. Existing deployment state is backed up remotely.
git archive HEAD | tar -x -C "$release_dir"
ssh -o BatchMode=yes -o ConnectTimeout=10 "$target" bash -s -- "$release_stamp" <<'REMOTE_BACKUP'
set -euo pipefail
cd /opt/bankpilot
test -f deploy/.env.production
backup_dir="/opt/bankpilot/backups/release-$1"
install -d -m 700 "$backup_dir"
cp deploy/.env.production "$backup_dir/production.env"
chmod 600 "$backup_dir/production.env"
docker exec bankpilot-postgres pg_dump -U bankpilot -d bankpilot -Fc > "$backup_dir/bankpilot.dump"
chmod 600 "$backup_dir/bankpilot.dump"
tar --exclude='./backups' --exclude='./releases' --exclude='./node_modules' --exclude='./.next' \
  --exclude='./.git' --exclude='./deploy/.env.production' --exclude='./.env*' \
  -czf "$backup_dir/source.tar.gz" .
chmod 600 "$backup_dir/source.tar.gz"
if [[ -f /opt/premsir-chat/source/Caddyfile.production ]]; then
  cp /opt/premsir-chat/source/Caddyfile.production "$backup_dir/edge.Caddyfile"
  chmod 600 "$backup_dir/edge.Caddyfile"
fi
echo "Database, environment and source backed up."
REMOTE_BACKUP

# Install only Jev's explicitly configured local values after the private remote
# environment backup exists. The helper streams secrets over SSH stdin.
node scripts/configure-jev-remote.mjs "$target" "$release_stamp"

rsync -az --delete \
  --exclude .git --exclude node_modules --exclude .next \
  --include '.env.example' --include 'deploy/.env.production.example' \
  --exclude '.env' --exclude '.env.*' --exclude deploy/.env.production \
  --exclude backups --exclude releases --exclude DEPLOYED_COMMIT --exclude .playwright-cli \
  "$release_dir/" "$target:/opt/bankpilot/"

ssh -o BatchMode=yes -o ConnectTimeout=10 "$target" bash -s -- "$commit_sha" "$release_stamp" <<'REMOTE_DEPLOY'
set -euo pipefail
cd /opt/bankpilot
release_commit="$1"
backup_dir="/opt/bankpilot/backups/release-$2"
trap 'echo "Deployment stopped. Backups: $backup_dir. No database restore was attempted." >&2' ERR
compose=(docker compose --env-file deploy/.env.production -f deploy/compose.production.yml)

# Build while the old application is still running.
# Provision one private scheduler credential on first upgrade; never print it.
if ! grep -Eq '^SCHEDULER_TOKEN=.{32,}$' deploy/.env.production; then
  sed '/^SCHEDULER_TOKEN=/d' deploy/.env.production > "$backup_dir/scheduler.env"
  printf '\nSCHEDULER_TOKEN=%s\n' "$(openssl rand -hex 32)" >> "$backup_dir/scheduler.env"
  chmod 600 "$backup_dir/scheduler.env"
  cp "$backup_dir/scheduler.env" deploy/.env.production
  chmod 600 deploy/.env.production
fi
"${compose[@]}" build app scheduler voice
if docker container inspect bankpilot-voice >/dev/null 2>&1; then
  docker stop bankpilot-voice >/dev/null
fi
if docker container inspect bankpilot-scheduler >/dev/null 2>&1; then
  docker stop bankpilot-scheduler >/dev/null
fi
if docker container inspect bankpilot-nanobot >/dev/null 2>&1; then
  docker stop bankpilot-nanobot >/dev/null
fi
if docker container inspect bankpilot-app >/dev/null 2>&1; then
  docker stop bankpilot-app >/dev/null
fi
"${compose[@]}" up -d --wait postgres
# Do not let Docker's non-interactive exec drain the SSH script's stdin.
bash scripts/migrate.sh --env-file deploy/.env.production -f deploy/compose.production.yml < /dev/null

sed '/^[[:space:]]*NANOBOT_/d; /^[[:space:]]*BANKPILOT_NANOBOT_/d; /^[[:space:]]*MCP_ALLOWED_ORIGINS=/d' \
  deploy/.env.production > "$backup_dir/production.cleaned.env"
chmod 600 "$backup_dir/production.cleaned.env"
cp "$backup_dir/production.cleaned.env" deploy/.env.production
chmod 600 deploy/.env.production
"${compose[@]}" up -d --wait app

docker exec -i bankpilot-postgres psql -v ON_ERROR_STOP=1 -U bankpilot -d bankpilot < db/invariants.sql
docker exec -i bankpilot-postgres psql -v ON_ERROR_STOP=1 -U bankpilot -d bankpilot <<'SQL'
DO $$
BEGIN
  IF to_regclass('public.nanobot_runs') IS NOT NULL
     OR to_regclass('public.nanobot_consents') IS NOT NULL
     OR to_regclass('public.nanobot_channels') IS NOT NULL
     OR to_regclass('public.nanobot_channel_messages') IS NOT NULL THEN
    RAISE EXCEPTION 'Retired runtime tables still exist';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version='009_retire_legacy_agent.sql') THEN
    RAISE EXCEPTION 'Retirement migration is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version='020_scheduled_tasks.sql') THEN
    RAISE EXCEPTION 'Scheduled task migration is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version='021_simulated_investments.sql')
     OR to_regclass('public.investment_positions') IS NULL
     OR to_regclass('public.investment_simulation_clocks') IS NULL THEN
    RAISE EXCEPTION 'Simulated investments migration is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version='022_demo_investment_history.sql') THEN
    RAISE EXCEPTION 'Demo investment history migration is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version='023_daily_ai_reviews.sql')
     OR to_regclass('public.scheduled_ai_reviews') IS NULL THEN
    RAISE EXCEPTION 'Daily AI review migration is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version='024_review_recording_support.sql') THEN
    RAISE EXCEPTION 'Review recording support migration is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version='025_business_display_labels.sql') THEN
    RAISE EXCEPTION 'Business display labels migration is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version='027_feed_posts.sql')
     OR to_regclass('public.feed_posts') IS NULL
     OR to_regclass('public.feed_publisher_state') IS NULL THEN
    RAISE EXCEPTION 'Feed posts migration is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version='028_demo_life.sql')
     OR to_regclass('public.demo_life_state') IS NULL THEN
    RAISE EXCEPTION 'Demo life migration is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version='019_authorization_hardening.sql') THEN
    RAISE EXCEPTION 'Authorization hardening migration is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version='013_retire_external_access.sql')
     OR to_regclass('public.api_tokens') IS NOT NULL
     OR to_regclass('public.api_clients') IS NOT NULL
     OR to_regclass('public.mcp_invocations') IS NOT NULL THEN
    RAISE EXCEPTION 'External access retirement is incomplete';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version='014_app_agent_model.sql')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='app_agent_runs' AND column_name='model')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='user_sessions' AND column_name='ai_model') THEN
    RAISE EXCEPTION 'Model settings migration is incomplete';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version='015_visitor_memory.sql')
     OR to_regclass('public.visitor_memory_owners') IS NULL
     OR to_regclass('public.visitor_memory_scopes') IS NULL
     OR to_regclass('public.visitor_memory_preferences') IS NULL THEN
    RAISE EXCEPTION 'Visitor memory migration is incomplete';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version='016_app_agent_memory_scope.sql')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='app_agent_runs' AND column_name='memory_owner_id')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='app_agent_runs' AND column_name='memory_profile_key')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='agent_runtime_runs' AND column_name='memory_owner_id')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='agent_runtime_runs' AND column_name='memory_profile_key') THEN
    RAISE EXCEPTION 'Agent memory scope migration is incomplete';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version='017_app_agent_timeline.sql') THEN
    RAISE EXCEPTION 'Agent timeline migration is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version='018_totp_replay_protection.sql')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='mfa_totp' AND column_name='last_used_counter') THEN
    RAISE EXCEPTION 'TOTP replay protection migration is incomplete';
  END IF;
END;
$$;
SQL

docker exec -i bankpilot-app node - <<'JS'
(async () => {
  const response = await fetch('http://127.0.0.1:3000/api/health');
  const health = await response.json();
  if (!response.ok || health.database !== 'connected' || health.agentRuntime !== 'ready') {
    throw new Error('Application or LangGraph is not ready');
  }
  for (const path of ['/api/nanobot', '/api/nanobot/channels', '/api/internal/nanobot/result', '/api/mcp', '/api/openapi', '/developers', '/api/v1/developer/tokens', '/api/v1/developer/tokens/retired']) {
    const result = await fetch('http://127.0.0.1:3000' + path);
    if (result.status !== 404) throw new Error('Retired endpoint remains: ' + path);
  }
  const tokenAttempt = await fetch('http://127.0.0.1:3000/api/bootstrap', { headers: { authorization: 'Bearer retired-client' } });
  if (tokenAttempt.status !== 403) throw new Error('External credentials still accepted by bank APP');
  console.log(JSON.stringify({ database: health.database, agentRuntime: health.agentRuntime, aiConfigured: health.ai.configured }));
})().catch(() => { console.error('Application verification failed'); process.exitCode = 1; });
JS

if docker container inspect bankpilot-nanobot >/dev/null 2>&1; then
  docker rm bankpilot-nanobot >/dev/null
fi
if docker volume inspect bankpilot_nanobot >/dev/null 2>&1; then
  docker volume rm bankpilot_nanobot >/dev/null
fi
# Start the scheduler only after migration and invariant checks passed.
scheduler_start_epoch="$(date +%s)"
"${compose[@]}" up -d scheduler
scheduler_ready=false
for attempt in 1 2 3 4 5 6; do
  if [[ "$(docker exec bankpilot-postgres psql -U bankpilot -d bankpilot -Atc "SELECT count(*) FROM scheduler_heartbeat WHERE last_tick_at>=to_timestamp($scheduler_start_epoch)")" == "1" ]]; then
    scheduler_ready=true
    break
  fi
  sleep 5
done
if [[ "$scheduler_ready" != true ]]; then
  echo "Scheduler heartbeat unavailable; deployment verification failed." >&2
  exit 1
fi
if grep -Eq '^VOICE_API_KEY=.+$' deploy/.env.production && grep -Eq '^VOICE_BRIDGE_TOKEN=.{32,}$' deploy/.env.production; then
  "${compose[@]}" up -d --wait voice
  python3 scripts/configure-voice-edge.py
fi
printf '%s\n' "$release_commit" > DEPLOYED_COMMIT
echo "Deployed $release_commit. Backups: $backup_dir"
REMOTE_DEPLOY
