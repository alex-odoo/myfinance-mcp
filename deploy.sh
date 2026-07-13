#!/usr/bin/env bash
# One-way deploy Mac -> rteam-ai (23.88.115.126). Never edit code on the box.
# Usage: ./deploy.sh "what changed"
set -euo pipefail

SERVER="root@23.88.115.126"
SSH_KEY="$HOME/.ssh/rteam_hetzner"
REMOTE_DIR="/opt/finance-mcp"
DOMAIN="finance.rteam.agency"

MSG="${1:?Usage: ./deploy.sh \"what changed\"}"

export PATH="$HOME/homebrew/bin:$PATH"

echo "==> Local gate: typecheck + e2e"
bun run build
bun run e2e >/dev/null && echo "    e2e green"

echo "==> Commit + push"
git add -A
git diff --cached --quiet || git commit -m "$MSG"
git remote get-url origin >/dev/null 2>&1 && git push origin main || echo "    (no origin remote yet, skipping push)"

echo "==> Rsync code to $SERVER:$REMOTE_DIR"
rsync -az --delete \
  -e "ssh -i $SSH_KEY" \
  --exclude '.git' --exclude 'node_modules' --exclude 'state' --exclude 'state-e2e' \
  --exclude '.env' \
  ./ "$SERVER:$REMOTE_DIR/"

echo "==> Rebuild + restart container"
ssh -i "$SSH_KEY" "$SERVER" "set -e
  cd $REMOTE_DIR
  test -f .env || { echo 'FATAL: $REMOTE_DIR/.env missing (bootstrap first)'; exit 1; }
  docker compose build --quiet
  docker compose up -d
"

echo "==> Sync nginx configs (reload only if changed)"
ssh -i "$SSH_KEY" "$SERVER" "set -e
  changed=0
  if ! cmp -s $REMOTE_DIR/deploy/nginx-finance-ratelimit.conf /etc/nginx/conf.d/finance-mcp-ratelimit.conf 2>/dev/null; then
    cp /etc/nginx/conf.d/finance-mcp-ratelimit.conf /root/finance-ratelimit.bak.\$(date +%s) 2>/dev/null || true
    cp $REMOTE_DIR/deploy/nginx-finance-ratelimit.conf /etc/nginx/conf.d/finance-mcp-ratelimit.conf
    changed=1
  fi
  if [ ! -f /etc/nginx/sites-available/finance-rteam-agency ]; then
    cp $REMOTE_DIR/deploy/nginx-finance-rteam-agency.conf /etc/nginx/sites-available/finance-rteam-agency
    ln -sf /etc/nginx/sites-available/finance-rteam-agency /etc/nginx/sites-enabled/finance-rteam-agency
    changed=1
  fi
  if [ \$changed = 1 ]; then nginx -t && systemctl reload nginx; fi
"
# NOTE: after certbot rewrites the vhost with TLS blocks, deploy.sh intentionally
# stops overwriting it (the repo copy is the pre-TLS bootstrap version).

echo "==> Health check"
sleep 2
ssh -i "$SSH_KEY" "$SERVER" "curl -sf http://127.0.0.1:8788/health" && echo "    container healthy"
if curl -sf --max-time 10 "https://$DOMAIN/health" >/dev/null 2>&1; then
  echo "    https://$DOMAIN healthy"
else
  echo "    (https://$DOMAIN not reachable yet: DNS or certbot pending)"
fi

echo "==> Done: $MSG"
