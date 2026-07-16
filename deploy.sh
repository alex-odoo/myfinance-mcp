#!/usr/bin/env bash
# One-way deploy Mac -> rteam-ai (23.88.115.126). Never edit code on the box.
# Usage: ./deploy.sh "what changed"
set -euo pipefail

SERVER="root@23.88.115.126"
SSH_KEY="$HOME/.ssh/rteam_hetzner"
REMOTE_DIR="/opt/myfinance-mcp"
DOMAIN="myfinance-mcp.com"
LEGACY_DOMAIN="finance.rteam.agency"

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
  --exclude '.env' --exclude 'app.env' \
  ./ "$SERVER:$REMOTE_DIR/"

echo "==> Rebuild + restart container"
ssh -i "$SSH_KEY" "$SERVER" "set -e
  cd $REMOTE_DIR
  test -f app.env || { echo 'FATAL: $REMOTE_DIR/app.env missing (bootstrap first)'; exit 1; }
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
  if [ ! -f /etc/nginx/sites-available/myfinance-mcp-com ]; then
    cp $REMOTE_DIR/deploy/nginx-myfinance-mcp-com.conf /etc/nginx/sites-available/myfinance-mcp-com
    ln -sf /etc/nginx/sites-available/myfinance-mcp-com /etc/nginx/sites-enabled/myfinance-mcp-com
    changed=1
  fi
  if [ ! -f /etc/nginx/sites-available/myfinancemcp-com ]; then
    cp $REMOTE_DIR/deploy/nginx-myfinancemcp-com.conf /etc/nginx/sites-available/myfinancemcp-com
    ln -sf /etc/nginx/sites-available/myfinancemcp-com /etc/nginx/sites-enabled/myfinancemcp-com
    changed=1
  fi
  if [ \$changed = 1 ]; then nginx -t && systemctl reload nginx; fi
"
# NOTE: after certbot rewrites the vhost with TLS blocks, deploy.sh intentionally
# stops overwriting it (the repo copy is the pre-TLS bootstrap version).

echo "==> Landing: ensure vhost serves site/ at / (one-time include patch)"
ssh -i "$SSH_KEY" "$SERVER" "set -e
  VHOST=/etc/nginx/sites-available/finance-rteam-agency
  if grep -q 'nginx-landing-locations.conf' \$VHOST; then
    echo '    landing include already present'
  else
    cp \$VHOST /root/finance-vhost.bak.\$(date +%s)
    python3 - <<'PY'
path = '/etc/nginx/sites-available/finance-rteam-agency'
old = '''    location / {
        proxy_pass http://127.0.0.1:8788;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }'''
new = '    include /opt/myfinance-mcp/deploy/nginx-landing-locations.conf;'
src = open(path).read()
if src.count(old) != 1:
    raise SystemExit('FATAL: catch-all location / block not found exactly once; patch vhost manually')
open(path, 'w').write(src.replace(old, new))
print('    vhost patched: landing include installed')
PY
    nginx -t && systemctl reload nginx
  fi
"

echo "==> Health check"
sleep 2
ssh -i "$SSH_KEY" "$SERVER" "curl -sf http://127.0.0.1:8788/health" && echo "    container healthy"
for d in "$DOMAIN" "$LEGACY_DOMAIN"; do
  if curl -sf --max-time 10 "https://$d/health" >/dev/null 2>&1; then
    echo "    https://$d healthy"
  else
    echo "    (https://$d not reachable yet: DNS or certbot pending)"
  fi
done

echo "==> Done: $MSG"
