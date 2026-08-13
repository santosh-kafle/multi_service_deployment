# Multi-Service Deployment

A React frontend and an Express API, to be containerized and orchestrated behind an
Nginx reverse proxy with MongoDB and Redis.

**The application code is written. The infrastructure is the exercise.**

```
                       ┌──────────────────────────────┐
  browser ──:8080──▶   │  proxy (Nginx)               │
                       │   /      → web               │
                       │   /api/  → api               │
                       └───────┬──────────────┬───────┘
                               │              │
                    ┌──────────▼───┐   ┌──────▼────────┐
                    │ web (static  │   │ api (Express) │
                    │ React build) │   └───┬───────┬───┘
                    └──────────────┘       │       │
                                     ┌─────▼──┐ ┌──▼─────┐
                                     │ mongo  │ │ redis  │
                                     └────────┘ └────────┘
```

## What you need to build

- `api/Dockerfile`
- `web/Dockerfile` — the React app is a Vite project; `npm run build` emits static files to `dist/`
- `proxy/` — an Nginx reverse proxy image and its config
- an Nginx config for serving the built frontend
- `docker-compose.yml` tying all five services together
- `.dockerignore` files
- `.env.example` documenting the variables below

## The contract the app expects

**API** — listens on `PORT` (default `4000`), reads these environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `4000` | Listen port |
| `MONGO_URL` | `mongodb://mongo:27017` | Connection string, including credentials if auth is on |
| `MONGO_DB` | `appdb` | Database name |
| `REDIS_URL` | `redis://redis:6379` | Connection string, including password if set |
| `CACHE_TTL_SECONDS` | `30` | Cache TTL for the items list |

Defaults assume the hostnames `mongo` and `redis`. Name your services differently and you'll
need to set the URLs explicitly.

**Routes the API serves** (all under `/api`, so the frontend can use relative URLs):

| Route | Purpose |
|---|---|
| `GET /api/health` | Liveness — process is up, no dependency calls. Cheap to poll |
| `GET /api/ready` | Readiness — pings Mongo and Redis, returns `503` if either is down |
| `GET /api/items` | List items (cached in Redis) |
| `POST /api/items` | Create, body `{ "title": "..." }` |
| `PATCH /api/items/:id` | Update, body `{ "done": true }` |
| `DELETE /api/items/:id` | Delete |

**Frontend** — calls `/api/...` with relative URLs and has no API host baked in at build time.
Whatever serves it must route `/api/` to the API, and must serve `index.html` for unknown
paths so client-side routes don't 404.

**On startup** the API retries its Mongo and Redis connections ten times, two seconds apart,
before exiting. You have a window, not an excuse to skip ordering.

## Requirements checklist

Orchestration:
- [ ] All five services defined and running from one `docker compose up`
- [ ] Only the proxy publishes a port to the host — API, Mongo, and Redis stay internal
- [ ] Services communicate over a user-defined bridge network by service name
- [ ] Mongo and Redis data survive `docker compose down` and come back on `up`

Reverse proxy:
- [ ] `/` serves the React app
- [ ] `/api/` reaches the API with the path intact
- [ ] Unknown frontend paths serve `index.html` rather than 404

Health and ordering:
- [ ] Healthchecks on every service
- [ ] The API waits for Mongo and Redis to be *healthy*, not merely *started*
- [ ] `docker compose up --wait` returns only when the stack genuinely serves traffic

Image hygiene:
- [ ] The frontend uses a multi-stage build — no Node or `node_modules` in the runtime image
- [ ] Dependency install is cached separately from source, so a code change doesn't reinstall
- [ ] Containers don't run as root where the base image offers an alternative

Configuration:
- [ ] Credentials come from `.env`, which is gitignored; `.env.example` documents the shape
- [ ] No secrets committed

## Verifying it

Once your stack is up, this checks the whole thing from the outside:

```bash
./scripts/verify.sh
```

It tests routing, the SPA fallback, health and readiness, full CRUD, cache hit/miss behavior,
cache invalidation on write, volume persistence across a restart, and that nothing but the
proxy is exposed. It tells you what failed, not how to fix it.

## Things worth getting right

A few of these have non-obvious answers. Worth thinking through rather than reaching for:

1. `depends_on` alone only orders *starts*. Getting the API to wait for a database that
   actually answers takes something more.
2. A healthcheck hitting `localhost` inside an Nginx container can fail while the service is
   perfectly healthy. Worth understanding why before you hit it.
3. An `upstream` block resolves its hostname once, at startup. Think about what happens to
   the proxy when a container restarts with a new IP.
4. `GET /api/items` returns a `source` field of `cache` or `mongo`. If it never says `cache`,
   or never goes back to `mongo` after a write, something in your wiring is off.

## How the caching works

`GET /api/items` is cache-aside: check Redis, fall back to Mongo on a miss, backfill the key
with a TTL. Writes delete the key rather than updating it. The response reports which path it
took and how long it took, and the frontend shows this as a badge — so the cache is visible
in the UI, which makes it easy to tell whether your Redis wiring actually works.

## Running the app without Docker

Useful for confirming the app itself works while you debug your containers:

```bash
cd api && npm install && npm run dev   # needs Mongo and Redis reachable
cd web && npm install && npm run dev   # Vite dev server proxies /api to localhost:4000
```
