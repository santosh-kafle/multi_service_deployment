# Multi-Service Deployment

Five containers behind a single entry point: a React frontend, an Express API, MongoDB for
persistence, Redis for caching, and Nginx as a reverse proxy. Orchestrated with Docker Compose.

Built as a solution to the roadmap.sh **Multi-Service Application with Docker** project:
<https://roadmap.sh/projects/multiservice-docker>

```
                       ┌──────────────────────────────┐
  browser ──:8080──▶   │  proxy (Nginx)               │
                       │   /      → web               │
                       │   /api/  → api               │
                       └───────┬──────────────┬───────┘
                               │              │
                    ┌──────────▼───┐   ┌──────▼────────┐
                    │ web (Nginx + │   │ api (Express) │
                    │ static React)│   └───┬───────┬───┘
                    └──────────────┘       │       │
                                     ┌─────▼──┐ ┌──▼─────┐
                                     │ mongo  │ │ redis  │
                                     │ (auth) │ │ (auth) │
                                     └────────┘ └────────┘
```

The proxy is the only service that publishes a port. The API, database and cache are reachable
only on the internal `app_network` bridge — verified: connections to 4000, 27017 and 6379 from
the host are refused. Mongo and Redis both require a password on top of that.

## Quick start

```bash
cp .env.example .env
# fill in MONGO_ROOT_PASSWORD and REDIS_PASSWORD — generate each with:
openssl rand -hex 24

docker compose up -d --build --wait
```

Open <http://localhost:8080>. `--wait` returns once all five services report `healthy`.

```bash
docker compose ps              # status and health of all five services
docker compose logs -f api     # follow one service
docker compose down            # stop, keep data
docker compose down -v         # stop and wipe volumes
```

## Configuration

All configuration lives in one root `.env` file (gitignored; `.env.example` is the committed
template). Compose reads it to fill in `${...}` references in `docker-compose.yml`, and each
container is handed only the variables it actually uses.

| Variable | Used by | Purpose |
|---|---|---|
| `MONGO_ROOT_USERNAME` | mongo, api | Root user created on Mongo's first start |
| `MONGO_ROOT_PASSWORD` | mongo, api | Its password |
| `REDIS_PASSWORD` | redis, api | Passed to `redis-server --requirepass` |
| `MONGO_DB` | api | Database the app reads and writes (`appdb`) |
| `CACHE_TTL_SECONDS` | api | Lifetime of cached responses |
| `PORT` | api | Port Express listens on inside the network |
| `NODE_ENV` | api | `production` — no stack traces in error responses |

The API never receives the raw passwords as separate variables. Compose builds its connection
strings from the parts above:

```
MONGO_URL = mongodb://<user>:<password>@mongo:27017/appdb?authSource=admin
REDIS_URL = redis://:<password>@redis:6379
```

`authSource=admin` is needed because the root user lives in Mongo's `admin` database while the
app works in `appdb`. Passwords are generated as hex so they never contain URL-reserved
characters like `@`, `:` or `/`.

> **Mongo reads `MONGO_ROOT_*` only when its data volume is empty.** Changing the password in
> `.env` after the first start has no effect on the existing user. See
> [Rotating passwords](#rotating-passwords).

## Services

| Service | Image | Exposure | Healthcheck |
|---|---|---|---|
| `proxy` | built from `proxy/` | **`8080` → 80** | `wget` against itself |
| `web` | built from `web/` | internal 80 | `wget` against itself |
| `api` | built from `api/` | internal 4000 | `GET /api/ready` — pings Mongo and Redis |
| `mongo` | `mongo:7` | internal 27017 | authenticated `mongosh` ping |
| `redis` | `redis:8` | internal 6379 | authenticated `redis-cli ping` |

Data lives in two named volumes: `db_data` (Mongo) and `redis_data` (Redis, append-only file).

## Startup order and health

Every service has a healthcheck, and startup is gated on them rather than on containers merely
existing:

```
mongo ─┐
       ├─(healthy)─▶ api ─┐
redis ─┘                  ├─(healthy)─▶ proxy
                    web ──┘
```

`depends_on` with `condition: service_healthy` means the API doesn't start until both data
stores answer, and the proxy doesn't start until there's something behind it to route to.

The database healthchecks **authenticate**. An unauthenticated `ping` succeeds against a
locked Mongo, and `redis-cli` exits `0` even on an auth failure — so a plain ping would report
`healthy` while every real query fails. The Redis check pipes through `grep -q PONG` to turn a
wrong password into a failing check.

Every service has `restart: unless-stopped`: a crashed container comes back on its own, but one
stopped deliberately stays stopped.

## How a request flows

A request to `http://localhost:8080/items` hits the proxy, matches `location /`, and is
forwarded to the `web` container. Nginx there finds no file at `/items` and falls back to
`index.html` via `try_files`, so the React app boots and renders the route itself.

That app then calls `/api/items` — a **relative** URL, deliberately. It resolves against
whatever host served the page, so no API hostname is baked in at build time and the same image
works in any environment. The proxy matches `location /api/` and forwards to the API with the
path intact.

Service-to-service addressing uses Compose's DNS: a container's hostname *is* its service name.
The proxy re-resolves those names every 10 seconds (`resolver 127.0.0.11 valid=10s` with a
variable in `proxy_pass`) instead of caching the IP it saw at startup, so recreating `api` or
`web` doesn't leave the proxy pointing at a dead address.

## API

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/health` | Liveness — process is up. No dependency calls |
| `GET` | `/api/ready` | Readiness — pings Mongo and Redis, `503` if either is down |
| `GET` | `/api/items` | List items (cached) |
| `POST` | `/api/items` | Create — `{ "title": "..." }` |
| `PATCH` | `/api/items/:id` | Update — `{ "done": true }` |
| `DELETE` | `/api/items/:id` | Delete |

```bash
curl localhost:8080/api/ready
curl -XPOST localhost:8080/api/items -H 'Content-Type: application/json' -d '{"title":"first"}'
curl localhost:8080/api/items
```

## Caching

`GET /api/items` uses a cache-aside strategy: check Redis, fall back to Mongo on a miss, then
backfill the key with a TTL of `CACHE_TTL_SECONDS`. Writes **delete** the key rather than
updating it, which costs one extra read and removes a whole class of staleness bugs.

The response reports which path it took, so the effect is measurable rather than assumed:

```json
{ "source": "mongo", "latencyMs": 9.55, "count": 1, "items": [...] }
{ "source": "cache", "latencyMs": 1.59, "count": 1, "items": [...] }
```

The frontend surfaces this as a badge — refresh twice to watch it flip to a cache hit, then add
an item to see it fall back to Mongo.

## Design decisions

Full reasoning is in [`NOTES.md`](NOTES.md).

- **Multi-stage build for the frontend** — build tooling (Vite, esbuild, `node_modules`) stays
  in stage one. The runtime image carries only compiled static files: **75MB vs 218MB** for the
  API.
- **Layer ordering for cache efficiency** — dependency manifests are copied and installed
  before application source, so a code change doesn't trigger a reinstall.
- **`node` as PID 1, not `npm`** — Docker signals `SIGTERM` to PID 1; npm doesn't reliably
  forward it, which would skip the API's graceful-shutdown handlers.
- **Non-root API container** — runs as the image's unprivileged `node` user, with file
  ownership set via `COPY --chown`.
- **Pinned image tags** — no `latest` anywhere, so builds are reproducible.
- **Routing separated from serving** — the web container only hands out files; every routing
  decision lives in the proxy.
- **One `.env`, least privilege per container** — a single source of truth for secrets, but
  Redis never sees the Mongo password and the API never sees raw passwords.
- **Healthchecks that prove auth works** — see [Startup order and health](#startup-order-and-health).

## Rotating passwords

**Before Mongo has ever started** (or when losing data is acceptable): edit `.env`, then
`docker compose down -v && docker compose up -d --wait`.

**With data you want to keep:** change the password inside Mongo first, while the container
still holds the old one, then update `.env` to match and recreate.

```bash
docker compose exec mongo sh -c 'mongosh --quiet \
  -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin \
  --eval "db.getSiblingDB(\"admin\").changeUserPassword(\"$MONGO_INITDB_ROOT_USERNAME\", \"NEW_PASSWORD\")"'
# put NEW_PASSWORD in .env as MONGO_ROOT_PASSWORD, then:
docker compose up -d --force-recreate --wait
```

The single quotes keep your host shell from touching the `$` variables — they're read inside
the container. Recreating hands the new value to both the Mongo healthcheck and the API's
connection string.

Redis holds its password only in memory, so updating `.env` and recreating is enough.

## Verifying

```bash
./scripts/verify.sh
```

Black-box tests the running stack: routing, SPA fallback, health and readiness, full CRUD,
input validation, cache hit/miss, cache invalidation on write, volume persistence across a
Mongo restart, and that only the proxy publishes a port.

Current status: **13 passed, 0 failed**, with authentication enabled on Mongo and Redis.

## Known limitations

Honest list of what isn't done yet:

- **No log rotation.** Containers use Docker's default `json-file` driver with no size cap, so
  logs grow until the disk fills.
- **Secrets are environment variables.** They are visible in `docker inspect`. The Redis
  password is also visible in the host's process list, because it's passed as a
  `--requirepass` command-line flag (the official image has no environment variable for it).
  Docker secrets would fix this for Mongo (via `MONGO_INITDB_ROOT_PASSWORD_FILE`); Redis would
  need a wrapper entrypoint or a mounted config file.
- **The API uses the Mongo root account.** A dedicated user with `readWrite` on `appdb` only
  would limit the damage if the API were compromised.
- **Unhealthy containers are not restarted.** Docker's restart policy acts when a process
  *exits*, not when its healthcheck fails. A hung-but-running API stays unhealthy until someone
  intervenes.
- **Nginx master processes run as root** in `web` and `proxy` (workers drop to the `nginx`
  user). `nginxinc/nginx-unprivileged` would remove that.
- **No TLS.** The proxy serves plain HTTP on 8080.
- **No CI.** `verify.sh` runs by hand, not on every push.

## Local development without Docker

```bash
cd api && npm install && npm run dev   # needs MONGO_URL and REDIS_URL pointing at running instances
cd web && npm install && npm run dev   # Vite dev server proxies /api to localhost:4000
```
