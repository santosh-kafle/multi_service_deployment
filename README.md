# Multi-Service Deployment

Five containers behind a single entry point: a React frontend, an Express API, MongoDB for
persistence, Redis for caching, and Nginx as a reverse proxy. Orchestrated with Docker Compose.

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
                                     └────────┘ └────────┘
```

The proxy is the only service that publishes a port. The API, database and cache are reachable
only on the internal `app_network` bridge — verified: connections to 4000, 27017 and 6379 from
the host are refused.

## Quick start

```bash
docker compose up -d --build
```

Open <http://localhost:8080>.

```bash
docker compose ps              # status of all five services
docker compose logs -f api     # follow one service
docker compose down            # stop, keep data
docker compose down -v         # stop and wipe volumes
```

## Services

| Service | Image | Exposure | Notes |
|---|---|---|---|
| `proxy` | built from `proxy/` | **`8080` → 80** | Only published port. Routes `/api/` and `/` |
| `web` | built from `web/` | internal 80 | React compiled by Vite, served as static files |
| `api` | built from `api/` | internal 4000 | Express on Node 20 |
| `mongo` | `mongo:7` | internal 27017 | Data in the `db_data` volume |
| `redis` | `redis:8` | internal 6379 | Cache only, not persisted (see Design decisions) |

## How a request flows

A request to `http://localhost:8080/items` hits the proxy, matches `location /`, and is
forwarded to the `web` container. Nginx there finds no file at `/items` and falls back to
`index.html` via `try_files`, so the React app boots and renders the route itself.

That app then calls `/api/items` — a **relative** URL, deliberately. It resolves against
whatever host served the page, so no API hostname is baked in at build time and the same image
works in any environment. The proxy matches `location /api/` and forwards to the API with the
path intact.

Service-to-service addressing uses Compose's DNS: a container's hostname *is* its service name,
so the proxy targets `http://api:4000` and the API connects to `mongodb://mongo:27017`.

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
backfill the key with a 30-second TTL. Writes **delete** the key rather than updating it, which
costs one extra read and removes a whole class of staleness bugs.

The response reports which path it took, so the effect is measurable rather than assumed:

```json
{ "source": "mongo", "latencyMs": 9.55, "count": 1, "items": [...] }
{ "source": "cache", "latencyMs": 1.59, "count": 1, "items": [...] }
```

The frontend surfaces this as a badge — refresh twice to watch it flip to a cache hit, then add
an item to see it fall back to Mongo.

## Design decisions

Full reasoning, including the bugs that produced it, is in [`NOTES.md`](NOTES.md).

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
- **Redis is not persisted** — it holds only derived cache data. Losing it on restart costs one
  slow request, not correctness. This would change if it ever held sessions or queues.

## Verifying

```bash
./scripts/verify.sh
```

Black-box tests the running stack: routing, SPA fallback, health and readiness, full CRUD,
input validation, cache hit/miss, cache invalidation on write, volume persistence across a
Mongo restart, and that only the proxy publishes a port.

Current status: **13 passed, 0 failed**.

## Known limitations

Honest list of what isn't done yet:

- **No healthchecks.** `docker compose ps` reports `Up`, not `healthy`.
- **`depends_on` orders starts, not readiness.** The stack survives because the API retries its
  connections ten times over twenty seconds — not because Compose waits for a working database.
- **No authentication on Mongo or Redis.** Both are unreachable from the host, so this is
  defence-in-depth rather than an open door, but it should be fixed.
- **No secrets management** — no `.env` / `.env.example` yet.
- **No `restart` policies** — a crashed container stays down.
- **`NODE_ENV` is unset**, so Express runs in development mode and returns stack traces on
  errors.

## Local development without Docker

```bash
cd api && npm install && npm run dev   # needs Mongo and Redis reachable
cd web && npm install && npm run dev   # Vite dev server proxies /api to localhost:4000
```
