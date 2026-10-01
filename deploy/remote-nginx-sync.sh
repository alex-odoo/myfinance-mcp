#!/usr/bin/env bash
# Runs ON the box, called by deploy.sh after rsync. Installs the MyFinance
# nginx files so that a broken one never stays in place: every changed file
# is swapped in with a backup, `nginx -t` decides, and a failed test restores
# the previous files before anything reloads. (The vhosts used to include the
# landing file straight from the rsync target, so a typo went live on disk
# before the test, and a re-run saw "unchanged" and skipped the test while
# every later reload on this shared box failed.)
set -euo pipefail

# Overridable only so the rollback path can be rehearsed in a sandbox.
ETC=${MYFINANCE_NGINX_ETC:-/etc/nginx}
REPO=${MYFINANCE_DEPLOY_DIR:-/opt/myfinance-mcp/deploy}
SNIPPETS=$ETC/snippets
OLD_INCLUDE="include /opt/myfinance-mcp/deploy/nginx-landing-locations.conf;"
NEW_INCLUDE="include $SNIPPETS/myfinance-landing-locations.conf;"

changed=()
stage() { # stage FILE: remember how to undo a change to FILE
  if [ -f "$1" ]; then cp -p "$1" "$1.myfinance-bak"; else : >"$1.myfinance-absent"; fi
  changed+=("$1")
}
install_file() { # install_file SRC DEST
  if ! cmp -s "$1" "$2"; then
    stage "$2"
    cp "$1" "$2"
  fi
}
rollback() {
  for f in "${changed[@]}"; do
    if [ -f "$f.myfinance-absent" ]; then rm -f "$f" "$f.myfinance-absent"; else mv "$f.myfinance-bak" "$f"; fi
  done
}
cleanup() {
  for f in "${changed[@]}"; do rm -f "$f.myfinance-bak" "$f.myfinance-absent"; done
}

mkdir -p "$SNIPPETS"
install_file "$REPO/nginx-security-headers.conf" "$SNIPPETS/myfinance-security-headers.conf"
install_file "$REPO/nginx-landing-locations.conf" "$SNIPPETS/myfinance-landing-locations.conf"
install_file "$REPO/nginx-finance-ratelimit.conf" "$ETC/conf.d/finance-mcp-ratelimit.conf"

# Vhosts: installed once (certbot then adds the TLS blocks, so the repo copy is
# only the bootstrap version); afterwards only the include path is migrated.
for pair in "nginx-finance-rteam-agency.conf:finance-rteam-agency" "nginx-myfinance-mcp-com.conf:myfinance-mcp-com"; do
  src="$REPO/${pair%%:*}"
  dest="$ETC/sites-available/${pair##*:}"
  if [ ! -f "$dest" ]; then
    stage "$dest"
    cp "$src" "$dest"
    ln -sf "$dest" "$ETC/sites-enabled/${pair##*:}"
  elif grep -qF "$OLD_INCLUDE" "$dest"; then
    stage "$dest"
    sed -i "s|$OLD_INCLUDE|$NEW_INCLUDE|" "$dest"
  fi
done
rm -f "$ETC/.myfinance-landing.applied" # marker of the old sync, unused now

if [ ${#changed[@]} -eq 0 ]; then
  echo "    nginx config unchanged"
  exit 0
fi
if nginx -t 2>/tmp/myfinance-nginx-test.log; then
  systemctl reload nginx
  cleanup
  echo "    nginx reloaded (${#changed[@]} file(s) changed)"
else
  rollback
  cat /tmp/myfinance-nginx-test.log >&2
  echo "FATAL: nginx -t failed; previous config restored, nothing reloaded" >&2
  exit 1
fi
