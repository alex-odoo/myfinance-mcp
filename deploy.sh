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

echo "==> Preflight: main branch, nothing untracked"
# What runs in prod must be what main holds: a deploy from another branch used
# to push an unchanged main and rsync the branch's tree.
BRANCH=$(git rev-parse --abbrev-ref HEAD)
[ "$BRANCH" = "main" ] || { echo "FATAL: deploy from main only (on $BRANCH)" >&2; exit 1; }
UNTRACKED=$(git ls-files --others --exclude-standard)
[ -z "$UNTRACKED" ] || { echo "FATAL: untracked files (commit or .gitignore them first):" >&2; echo "$UNTRACKED" >&2; exit 1; }

echo "==> Local gate: typecheck + e2e"
bun run build
# Never `cmd && echo ok` for a gate: set -e ignores a failure on the left of
# &&, so a red e2e used to fall through to commit, push and deploy.
bun run e2e >/dev/null || { echo "FATAL: e2e failed, nothing deployed" >&2; exit 1; }
echo "    e2e green"

echo "==> DB gate: Row-Level Security on every public table"
# prisma db push creates new tables with RLS OFF; without RLS the Supabase Data
# API exposes them to anyone with the anon key. rls.sql is idempotent.
DATABASE_URL=$(grep -E '^DATABASE_URL=' .env | cut -d= -f2- | tr -d '"')
psql "$DATABASE_URL" -q -f prisma/rls.sql
UNPROTECTED=$(psql "$DATABASE_URL" -tA -c "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND NOT rowsecurity;")
[ "$UNPROTECTED" = "0" ] || { echo "FATAL: $UNPROTECTED public table(s) without RLS"; exit 1; }
echo "    RLS green (all public tables)"

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

echo "==> Rebuild + restart container"
remote "set -e
  cd $REMOTE_DIR
  test -f app.env || { echo 'FATAL: $REMOTE_DIR/app.env missing (bootstrap first)'; exit 1; }
  rm -rf src/generated # stale client from older deploys; the image generates its own
  docker compose build --quiet --build-arg GIT_SHA=$SHA
  docker compose up -d
"

echo "==> Sync nginx configs (tested before going live)"
remote "bash $REMOTE_DIR/deploy/remote-nginx-sync.sh"

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
for d in "$DOMAIN" "$LEGACY_DOMAIN"; do
  if curl -sf --max-time 10 "https://$d/health" >/dev/null 2>&1; then
    echo "    https://$d healthy"
  else
    echo "    (https://$d not reachable yet: DNS or certbot pending)"
  fi
done

echo "==> Done: $MSG"
