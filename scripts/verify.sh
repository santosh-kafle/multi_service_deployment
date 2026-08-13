#!/usr/bin/env bash
# Checks a running stack from the outside. Reports what's broken, not how to fix it.
#   ./scripts/verify.sh [base_url]      default: http://localhost:8080
set -uo pipefail

BASE="${1:-http://localhost:8080}"
pass=0
fail=0

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; pass=$((pass + 1)); }
no()   { printf '  \033[31m✗\033[0m %s\n' "$1"; [ $# -gt 1 ] && printf '      %s\n' "$2"; fail=$((fail + 1)); }
head_() { printf '\n\033[1m%s\033[0m\n' "$1"; }

code() { curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$@"; }
body() { curl -s --max-time 10 "$@"; }
json() { python3 -c "import sys,json;d=json.load(sys.stdin);print(d$1)" 2>/dev/null; }

head_ "Routing"
if [ "$(code "$BASE/")" = "200" ]; then
  if body "$BASE/" | grep -qi '<div id="root">'; then
    ok "GET / serves the React app"
  else
    no "GET / responds but doesn't look like the React app" "expected a <div id=\"root\"> in the HTML"
  fi
else
  no "GET / returned $(code "$BASE/")" "the proxy isn't serving the frontend"
fi

if [ "$(code "$BASE/some/client/route")" = "200" ]; then
  ok "unknown paths fall back to index.html (SPA routing)"
else
  no "GET /some/client/route returned $(code "$BASE/some/client/route")" "client-side routes will 404 on refresh"
fi

asset=$(body "$BASE/" | grep -oE '/assets/[A-Za-z0-9._-]+\.js' | head -1)
if [ -n "$asset" ] && [ "$(code "$BASE$asset")" = "200" ]; then
  ok "built JS bundle is served ($asset)"
elif [ -z "$asset" ]; then
  no "no /assets/*.js reference in the HTML" "the frontend may not have been built"
else
  no "asset $asset returned $(code "$BASE$asset")"
fi

head_ "Health"
if [ "$(code "$BASE/api/health")" = "200" ]; then
  ok "GET /api/health is reachable through the proxy"
else
  no "GET /api/health returned $(code "$BASE/api/health")" "/api/ isn't reaching the API, or the API is down"
fi

ready=$(body "$BASE/api/ready")
if [ "$(printf '%s' "$ready" | json "['ready']")" = "True" ]; then
  ok "GET /api/ready reports all dependencies healthy"
else
  no "readiness check failed" "${ready:-no response}"
fi

head_ "CRUD"
created=$(body -XPOST "$BASE/api/items" -H 'Content-Type: application/json' \
  -d '{"title":"verify-script-item"}')
id=$(printf '%s' "$created" | json "['id']")
if [ -n "$id" ]; then
  ok "POST /api/items creates an item"
else
  no "POST /api/items failed" "${created:-no response}"
fi

if [ "$(body "$BASE/api/items" | json "['count']")" -gt 0 ] 2>/dev/null; then
  ok "GET /api/items returns the item"
else
  no "GET /api/items didn't return the created item"
fi

if [ -n "$id" ]; then
  patched=$(body -XPATCH "$BASE/api/items/$id" -H 'Content-Type: application/json' -d '{"done":true}')
  [ "$(printf '%s' "$patched" | json "['done']")" = "True" ] \
    && ok "PATCH /api/items/:id updates" || no "PATCH failed" "${patched:-no response}"
fi

if [ "$(code -XPOST "$BASE/api/items" -H 'Content-Type: application/json' -d '{"title":"   "}')" = "400" ]; then
  ok "invalid input is rejected with 400"
else
  no "empty title wasn't rejected with 400"
fi

head_ "Cache behavior"
body "$BASE/api/items" >/dev/null                       # warm it
second=$(body "$BASE/api/items" | json "['source']")
if [ "$second" = "cache" ]; then
  ok "repeat read is served from Redis"
else
  no "repeat read reported source=$second, expected cache" "Redis isn't being read, or writes aren't caching"
fi

body -XPOST "$BASE/api/items" -H 'Content-Type: application/json' -d '{"title":"cache-buster"}' >/dev/null
after=$(body "$BASE/api/items" | json "['source']")
if [ "$after" = "mongo" ]; then
  ok "a write invalidates the cache"
else
  no "read after write reported source=$after, expected mongo" "stale data will be served after writes"
fi

head_ "Persistence"
if command -v docker >/dev/null && docker compose ps --quiet mongo >/dev/null 2>&1; then
  before=$(body "$BASE/api/items" | json "['count']")
  docker compose restart mongo >/dev/null 2>&1
  for _ in $(seq 1 20); do
    [ "$(code "$BASE/api/ready")" = "200" ] && break
    sleep 1
  done
  docker compose exec -T redis sh -c 'redis-cli --no-auth-warning ${REDIS_PASSWORD:+-a "$REDIS_PASSWORD"} DEL items:all' >/dev/null 2>&1
  after_restart=$(body "$BASE/api/items" | json "['count']")
  if [ -n "$after_restart" ] && [ "$after_restart" = "$before" ]; then
    ok "data survives a mongo restart (volume is mounted)"
  else
    no "item count went $before → ${after_restart:-?} after restarting mongo" "data isn't on a volume"
  fi
else
  printf '  \033[33m—\033[0m skipped persistence check (run from the compose project root)\n'
fi

head_ "Exposure"
published=$(docker compose ps --format '{{.Service}} {{.Publishers}}' 2>/dev/null \
  | grep -E '\-> ' | awk '{print $1}' | sort -u)
if [ -z "$published" ]; then
  printf '  \033[33m—\033[0m skipped port check (run from the compose project root)\n'
elif [ "$published" = "proxy" ]; then
  ok "only the proxy publishes a port"
else
  no "services publishing ports to the host: $(echo "$published" | tr '\n' ' ')" "only the proxy should be reachable"
fi

# Cleanup: remove anything this script created.
for leftover in $(body "$BASE/api/items" | python3 -c \
  "import sys,json;print(' '.join(i['id'] for i in json.load(sys.stdin)['items'] if i['title'] in ('verify-script-item','cache-buster')))" 2>/dev/null); do
  curl -s -o /dev/null -XDELETE "$BASE/api/items/$leftover"
done

printf '\n\033[1m%d passed, %d failed\033[0m\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
