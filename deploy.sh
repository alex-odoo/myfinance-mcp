#!/usr/bin/env bash
# One-way deploy Mac -> rteam-ai (23.88.115.126). Never edit code on the box.
# Usage: ./deploy.sh "what changed"
set -euo pipefail

SERVER="root@23.88.115.126"
SSH_KEY="$HOME/.ssh/rteam_hetzner"
REMOTE_DIR="/opt/myfinance-mcp"
DOMAIN="myfinance-mcp.com"
LEGACY_DOMAIN="finance.rteam.agency"
LOCK="$REMOTE_DIR.deploy.lock"

MSG="${1:?Usage: ./deploy.sh \"what changed\"}"

export PATH="$HOME/homebrew/bin:$PATH"
remote() { ssh -i "$SSH_KEY" "$SERVER" "$@"; }

# The hosted database accepts connections only from the app server (Supabase
# network restrictions), so DB steps from this Mac go through an SSH tunnel via
# that server. TLS still runs end to end: the tunnel only forwards TCP.
TUNNEL_PID=""
open_db_tunnel() { # $1 = connection string; sets TUNNEL_URL
  local hostport host port lport
  hostport=$(sed -E 's#^[a-z]+://[^@]*@([^/?]+).*#\1#' <<<"$1")
  host=${hostport%:*}; port=${hostport##*:}
  [ "$port" != "$hostport" ] || port=5432
  lport=$(python3 -I -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')
  ssh -i "$SSH_KEY" -o ExitOnForwardFailure=yes -N -L "127.0.0.1:$lport:$host:$port" "$SERVER" &
  TUNNEL_PID=$!
  trap close_db_tunnel EXIT
  for _ in $(seq 1 50); do
    (exec 3<>"/dev/tcp/127.0.0.1/$lport") 2>/dev/null && break
    kill -0 "$TUNNEL_PID" 2>/dev/null || { echo "FATAL: SSH tunnel to the database did not open" >&2; exit 1; }
    sleep 0.2
  done
  (exec 3<>"/dev/tcp/127.0.0.1/$lport") 2>/dev/null || { echo "FATAL: SSH tunnel to the database did not open" >&2; exit 1; }
  TUNNEL_URL=$(sed -E "s#@[^/?]+#@127.0.0.1:$lport#" <<<"$1")
}
close_db_tunnel() {
  [ -n "$TUNNEL_PID" ] || return 0
  kill "$TUNNEL_PID" 2>/dev/null || true
  wait "$TUNNEL_PID" 2>/dev/null || true
  TUNNEL_PID=""
}

echo "==> Preflight: main branch, nothing untracked"
# What runs in prod must be what main holds: a deploy from another branch used
# to push an unchanged main and rsync the branch's tree.
BRANCH=$(git rev-parse --abbrev-ref HEAD)
[ "$BRANCH" = "main" ] || { echo "FATAL: deploy from main only (on $BRANCH)" >&2; exit 1; }
UNTRACKED=$(git ls-files --others --exclude-standard)
[ -z "$UNTRACKED" ] || { echo "FATAL: untracked files (commit or .gitignore them first):" >&2; echo "$UNTRACKED" >&2; exit 1; }

echo "==> Local gate: typecheck + site facts + e2e"
bun run build
# Facts copied across the static pages (tool count, code length, FAQ
# structured data) must match the code: a release used to leave some stale.
bun run check:site
# The e2e runs on a separate local Postgres (E2E_DATABASE_URL), never the
# hosted one; a reboot stops that cluster, so start it when it is down.
E2E_DATABASE_URL=$(grep -E '^E2E_DATABASE_URL=' .env | cut -d= -f2- | tr -d '"')
[ -n "$E2E_DATABASE_URL" ] || { echo "FATAL: E2E_DATABASE_URL missing in .env (a local test database)" >&2; exit 1; }
PG_E2E="$HOME/.local/share/pg-e2e"
if ! pg_isready -q -d "$E2E_DATABASE_URL" && [ -d "$PG_E2E" ]; then
  LC_ALL=C pg_ctl -D "$PG_E2E" -l "$PG_E2E/log.txt" -w start >/dev/null
fi
# Never `cmd && echo ok` for a gate: set -e ignores a failure on the left of
# &&, so a red e2e used to fall through to commit, push and deploy.
E2E_DATABASE_URL="$E2E_DATABASE_URL" bun run e2e >/dev/null || { echo "FATAL: e2e failed, nothing deployed" >&2; exit 1; }
echo "    e2e green"

echo "==> DB: schema (non-destructive) + Row-Level Security on every public table"
DATABASE_URL=$(grep -E '^DATABASE_URL=' .env | cut -d= -f2- | tr -d '"')
open_db_tunnel "$DATABASE_URL"
# db push without --accept-data-loss refuses a change that would drop data.
DATABASE_URL="$TUNNEL_URL" ./node_modules/.bin/prisma db push
# prisma db push creates new tables with RLS OFF; without RLS the Supabase Data
# API exposes them to anyone with the anon key. rls.sql is idempotent.
psql "$TUNNEL_URL" -q -v ON_ERROR_STOP=1 -f prisma/rls.sql
UNPROTECTED=$(psql "$TUNNEL_URL" -tA -c "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND NOT rowsecurity;")
close_db_tunnel
[ "$UNPROTECTED" = "0" ] || { echo "FATAL: $UNPROTECTED public table(s) without RLS"; exit 1; }
echo "    RLS green (all public tables)"

echo "==> Supabase advisor: no ERROR-level security lint"
# The advisor sees exposure the RLS count above cannot (security-definer views,
# exposed functions); asked on every deploy instead of read from its weekly
# email, it becomes a gate. The token is a read-only PAT (advisors_read on the
# MCP projects), kept outside the repo.
ADVISOR_TOKEN_FILE="${SUPABASE_ADVISOR_TOKEN_FILE:-$HOME/.config/supabase/advisors-read.token}"
[ -s "$ADVISOR_TOKEN_FILE" ] || { echo "FATAL: $ADVISOR_TOKEN_FILE missing (read-only Supabase PAT)" >&2; exit 1; }
# The ref comes from the connection string (pooler user postgres.<ref>, or host
# db.<ref>.supabase.co): this public repo does not name the project.
REF=$(sed -nE 's/.*postgres\.([a-z]{20})[:@].*/\1/p; s/.*db\.([a-z]{20})\.supabase\.co.*/\1/p' <<<"$DATABASE_URL" | head -1)
[ -n "$REF" ] || { echo "FATAL: no Supabase project ref in DATABASE_URL" >&2; exit 1; }
# The header goes through curl's stdin config, not argv, so ps never shows it.
LINTS=$(printf 'header = "Authorization: Bearer %s"\n' "$(tr -d '[:space:]' < "$ADVISOR_TOKEN_FILE")" \
  | curl -sf --max-time 30 -K - "https://api.supabase.com/v1/projects/$REF/advisors/security") \
  || { echo "FATAL: the Supabase advisor did not answer (token expired or revoked?)" >&2; exit 1; }
# WARN is printed, not fatal: it includes "upgrade Postgres", which must not
# block a fix. A response without "lints" fails closed.
python3 -I -c '
import json, sys
lints = json.load(sys.stdin)["lints"]
for l in lints:
    if l["level"] in ("ERROR", "WARN"):
        print("    %s %s: %s" % (l["level"], l["name"], l.get("detail") or l.get("title")))
sys.exit(any(l["level"] == "ERROR" for l in lints))
' <<<"$LINTS" || { echo "FATAL: the Supabase advisor reports an ERROR-level lint (or an unreadable answer)" >&2; exit 1; }
echo "    advisor green (no ERROR-level lint)"

echo "==> Deploy lock on the box"
# One deploy at a time: two interleaved rsync --delete runs into the same dir
# leave a tree nobody committed. The owner line says who holds it.
OWNER="$(hostname -s) pid $$ since $(date -u +%Y-%m-%dT%H:%M:%SZ)"
if ! remote "mkdir $LOCK 2>/dev/null && echo '$OWNER' > $LOCK/owner"; then
  echo "FATAL: another deploy holds $LOCK: $(remote "cat $LOCK/owner 2>/dev/null" || echo unknown)." >&2
  echo "       If that deploy is dead: ssh $SERVER rm -rf $LOCK" >&2
  exit 1
fi
trap 'remote "rm -rf $LOCK" >/dev/null 2>&1 || true' EXIT

echo "==> Commit + push"
git add -u
git diff --cached --quiet || git commit -m "$MSG"
if git remote get-url origin >/dev/null 2>&1; then
  git push origin main # a rejected push stops the deploy: prod never runs unpushed code
else
  echo "    (no origin remote yet, skipping push)"
fi
SHA=$(git rev-parse --short=12 HEAD)

echo "==> Rsync code to $SERVER:$REMOTE_DIR"
# .gitignore is the exclude list: secrets, node_modules, the local Prisma
# client and agent worktrees never leave the Mac (excluded files on the box,
# such as app.env, are also kept by --delete).
rsync -az --delete \
  -e "ssh -i $SSH_KEY" \
  --exclude '.git' --exclude 'state-e2e' --filter=':- .gitignore' \
  ./ "$SERVER:$REMOTE_DIR/"

# The landing font is not in git (Fontshare's licence forbids redistribution),
# so the .gitignore filter above skips it (and keeps the box's copy); it ships
# from this Mac's working copy instead.
if ls site/fonts/Switzer-*.woff2 >/dev/null 2>&1; then
  rsync -az -e "ssh -i $SSH_KEY" site/fonts/Switzer-*.woff2 "$SERVER:$REMOTE_DIR/site/fonts/"
else
  echo "    (no site/fonts/Switzer-*.woff2 here: the box keeps its copy, a fresh box falls back to system fonts)"
fi

# nginx right after rsync, before the long image build: rsync just rewrote
# files nginx may still include from the deploy dir, and anything that reloads
# nginx on this shared box mid-build must find a config that tests clean.
echo "==> Sync nginx configs (tested before going live)"
remote "bash $REMOTE_DIR/deploy/remote-nginx-sync.sh"

echo "==> Rebuild + restart container"
remote "set -e
  cd $REMOTE_DIR
  test -f app.env || { echo 'FATAL: $REMOTE_DIR/app.env missing (bootstrap first)'; exit 1; }
  rm -rf src/generated # stale client from older deploys; the image generates its own
  docker compose build --quiet --build-arg GIT_SHA=$SHA
  docker compose up -d
"

echo "==> Health check (container must serve $SHA)"
# Boot runs DB steps before listening, so poll; a healthy OLD container (failed
# recreate) must not pass, hence the commit match, not just a 200.
healthy=0
for _ in $(seq 1 20); do
  body=$(remote "curl -sf http://127.0.0.1:8788/health" 2>/dev/null || true)
  if [[ "$body" == *"\"commit\":\"$SHA\""* ]]; then
    healthy=1
    break
  fi
  sleep 3
done
[ "$healthy" = 1 ] || { echo "FATAL: container not serving $SHA after 60s (ssh $SERVER docker logs myfinance-mcp)" >&2; exit 1; }
remote "echo '$SHA $(date -u +%Y-%m-%dT%H:%M:%SZ)' > $REMOTE_DIR.deployed-sha"
echo "    container healthy, serving $SHA"
reachable=""
for d in "$DOMAIN" "$LEGACY_DOMAIN"; do
  if curl -sf --max-time 10 "https://$d/health" >/dev/null 2>&1; then
    echo "    https://$d healthy"
    reachable="$reachable $d"
  elif [ "$d" = "$DOMAIN" ]; then
    echo "FATAL: https://$d/health does not answer through nginx, though the container does" >&2
    exit 1
  else
    echo "    (https://$d not reachable yet: DNS or certbot pending)"
  fi
done

# The sign-in steps (and the /admin pages) through nginx, as a browser sends them: each must reach the
# app, whose answers carry X-Powered-By (nginx's own 301, 404 and 5xx pages do
# not). The e2e talks to the app port, so twice a release went live with one of
# them broken (/login/email 404, /login 301). Empty ids cost no sign-in budget.
for d in $reachable; do
  for step in "POST /login" "POST /login/email" "POST /login/email/verify" "GET /auth/google?request_id=" "GET /auth/google/callback?state=" "GET /admin" "POST /admin/logout"; do
    method=${step%% *}
    route=${step#* }
    if [ "$method" = POST ]; then
      hdr=$(curl -s -o /dev/null -D - --max-time 10 -X POST -d "request_id=" "https://$d$route" || true)
    else
      hdr=$(curl -s -o /dev/null -D - --max-time 10 "https://$d$route" || true)
    fi
    if ! grep -qi "^x-powered-by: express" <<<"$hdr"; then
      echo "FATAL: $method https://$d$route did not reach the app ($(head -1 <<<"$hdr" | tr -d '\r')): check the nginx locations" >&2
      exit 1
    fi
  done
done
echo "    sign-in steps and /admin reach the app through nginx"

echo "==> Done: $MSG"
