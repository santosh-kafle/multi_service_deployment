# Engineering notes

These are my notes on this project's infrastructure: what I chose, and why. The README says
what the stack does; this file is the reasoning behind it.

Project brief: <https://roadmap.sh/projects/multiservice-docker>

---

## Images and builds

**`node:20-alpine` as the base image.** Alpine's base layer is about 5MB, against 100MB+ for
the Debian variants. The API image lands at 218MB, and most of that is Node itself plus
`node_modules`. Alpine uses musl instead of glibc, which can matter for packages with native
bindings. None of mine have any, so the smaller image costs me nothing.

**`npm ci`, not `npm install`.** `npm install` treats `package-lock.json` as a suggestion: if
`package.json` allows a newer version, it installs that and rewrites the lockfile. Inside a
build, that rewrite is thrown away, so the image could quietly contain versions I never tested.
`npm ci` installs exactly what the lockfile says and fails if the two files disagree.

**Dependency manifests copied before source.** `COPY package*.json ./` and `RUN npm ci` sit
above `COPY . .`, so editing a route file doesn't reinstall every dependency. Docker keys its
layer cache on file *content*, not timestamps, so only a real change to `package.json`
triggers a reinstall.

**`node src/server.js` as the command, not `npm start`.** With `npm start`, npm becomes PID 1
and the app is its child. Docker sends `SIGTERM` to PID 1 on shutdown, and npm doesn't reliably
pass it on, so the API's shutdown handlers would never run. Running Node directly makes it
PID 1, and the signal lands where it's handled.

**The API runs as the `node` user.** The official Node image ships an unprivileged user.
`USER node` comes after the `COPY` steps, because those need root to write into `/app`, and
`COPY --chown=node:node` makes the files belong to the user that actually runs them.

**Multi-stage build for the frontend.** Building React needs Node, npm, Vite and esbuild.
*Serving* it needs only a web server, because the compiled JavaScript runs in the user's
browser, not in my container. Stage one builds; stage two starts from `nginx:1.27-alpine` and
copies only `dist/` across. The result is 75MB against 218MB for the API, with none of the build
tooling shipped.

**Pinned image tags.** `mongo:7`, `redis:8`, `nginx:1.27-alpine`, `node:20-alpine`. Never
`latest`, which is a moving pointer that can jump a major version between two builds and break
the stack without any change on my side.

---

## Networking and routing

**Only the proxy publishes a port.** `ports: "8080:80"` on the proxy, `expose` on the API and
web (which documents the internal port without opening it to the host), and nothing at all on
Mongo and Redis. I checked from the host: 4000, 27017 and 6379 refuse connections; only 8080
answers.

**Serving and routing are separate jobs.** The web container only hands out files, with
`try_files` falling back to `index.html` so React can handle its own routes. Every routing
decision lives in the proxy. Keeping each Nginx config to one job means neither can quietly do
the other's.

**The frontend calls the API with a relative URL.** `/api/items` resolves against whatever host
served the page, so no hostname is baked into the build and the same image works anywhere.

**`proxy_pass` without a path.** When `proxy_pass` contains a path, Nginx replaces the matched
location prefix with it. My Express routes are mounted at `/api`, so the proxy must forward
`/api/items` unchanged.

**The proxy re-resolves service names.** By default Nginx looks up `api` and `web` once, at
startup, and keeps those IPs forever. If either container is recreated and comes back on a new
IP, the proxy keeps sending traffic to the old one. I point Nginx at Docker's embedded DNS
(`resolver 127.0.0.11 valid=10s`) and put the upstream in a variable, which forces a fresh
lookup at most every 10 seconds. With a variable, `proxy_pass` no longer passes the URI through
on its own, so I append `$request_uri` explicitly.

---

## Startup, health and recovery

**Every service has a healthcheck.** "Running" only means the process exists; it says nothing
about whether it works. Each check tests the thing the service is for: the web servers fetch
their own root page, the API hits `/api/ready`, and the databases answer an authenticated ping.

**Healthchecks use `127.0.0.1`, not `localhost`.** Inside Alpine, `localhost` can resolve to
the IPv6 address `::1`, while Nginx listens on IPv4 only. The literal address removes the
ambiguity.

**The API's healthcheck uses readiness, not liveness.** `/api/ready` pings Mongo and Redis, so
the API only reports healthy when it can actually serve requests. That's what the proxy should
wait for. The cost: a database outage marks the API unhealthy too, even though its process is
fine.

**Startup waits for health, not just for containers.** `depends_on` with
`condition: service_healthy` holds the API back until both data stores answer, and holds the
proxy back until the API and web are healthy. The API also retries its connections on
startup, as a second layer, rather than as the only reason the stack works.

**`restart: unless-stopped` on everything.** A container that crashes comes back on its own;
one I stop on purpose stays stopped. Docker only restarts on process *exit*, not on a failing
healthcheck, so a hung process still needs a human.

---

## Configuration and secrets

**One `.env` file at the project root.** It's the single source of truth for every setting and
secret, and it's gitignored. `.env.example` is the committed template with the secret values
left blank. With one file, a password can't drift out of sync between two copies.

**Each container gets only what it uses.** Compose reads `.env` to fill in `${...}`, but no
container receives the whole file. Redis gets its own password and nothing else. Mongo gets its
root credentials. The API gets exactly the variables `config.js` reads, plus `NODE_ENV`. If one
service were compromised, it wouldn't hand over the credentials for the others.

**Connection strings are built in Compose, not stored.** The API reads `MONGO_URL` and
`REDIS_URL`, and Compose assembles them from the username and password in `.env`. Storing
complete URLs would mean each password existed twice in the same file.

**`authSource=admin` in the Mongo URL.** The root user is created in Mongo's `admin` database,
while the app works in `appdb`. Without this, the driver would try to authenticate against
`appdb` and fail.

**Passwords are 48 hex characters, from `openssl rand -hex 24`.** Hex can't contain `@`, `:`,
`/`, `?` or `#`, all of which have meaning inside a URL and would break a connection string
unless percent-encoded.

**Mongo auth comes from the image's own variables.** `MONGO_INITDB_ROOT_USERNAME` and
`MONGO_INITDB_ROOT_PASSWORD` make the image's entrypoint create the root user and turn on
`--auth` by itself, so I don't override Mongo's command. The image only does this on an empty
data directory, so a password change after the first start has to happen inside the database.
The README has the procedure.

**Redis auth via `--requirepass`.** The official image has no environment variable for this,
so the password goes on the command line. A mounted `redis.conf` would be the alternative. Redis also gets `REDIS_PASSWORD` in its environment,
not for the server, but so the healthcheck can read it.

**The database healthchecks authenticate.** I tested this in throwaway containers. An
unauthenticated ping succeeds against a locked Mongo, and `redis-cli` exits `0` even on a wrong
password. A plain ping would report healthy while every real query failed. The Mongo check logs
in with `mongosh`; the Redis check pipes through `grep -q PONG` so only a real answer passes.
Both use `$$` so the password is read from the container's environment at check time, rather
than being written into the check itself.

**`NODE_ENV=production`.** Express in development mode returns stack traces in error
responses. Nothing about this stack is a development setup.

---

## Data

**Mongo data on a named volume, `db_data`, mounted at `/data/db`.** That path comes from the
image documentation. Declaring a volume at the top level only creates it; nothing persists
until a service mounts it where the image actually writes.

**Redis persisted with an append-only file on `redis_data`.** Redis holds only derived cache
data, so losing it would cost a slow first request, not correctness. Persisting it means a
restart doesn't start from a cold cache, and the stack is ready if Redis ever holds something
that matters, like sessions.

**Cache-aside with delete-on-write.** Reads check Redis, fall back to Mongo, and backfill the
cache. Writes delete the cached key instead of updating it. That costs one extra database read
after each write, and in exchange the cache can never hold a version of the data that Mongo
doesn't.

---

## Still to do

- [ ] **Log rotation.** Docker's default `json-file` driver has no size limit.
- [ ] **CI.** Run `scripts/verify.sh` against a freshly built stack on every push.
- [ ] **Docker secrets** instead of environment variables, so credentials stay out of
      `docker inspect`. Mongo supports this via `_FILE` variables; Redis would need a wrapper.
- [ ] **A dedicated Mongo user for the API**, with `readWrite` on `appdb` only, instead of root.
- [ ] **Unprivileged Nginx** (`nginxinc/nginx-unprivileged`) for `web` and `proxy`.
- [ ] Minor: `ENV NODE_ENV=production` in the API Dockerfile so the image is correct even
      without Compose; `--from=build` instead of `--from=0` in the web Dockerfile.
