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

**No fixed network name.** Compose already gives every project its own network, named after
the project (`multi_service_deployment_default`), and I keep that default. A fixed name such as
`app_network` is global on the machine, so every copy of the stack would join the same network:
`api`, `mongo` and `redis` would each resolve to two containers, and requests could land on the
other copy's database with the wrong password. Nothing outside the project needs to join this
network, so a fixed name would add that risk and buy nothing.

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

## Logging

**Everything logs to stdout and stderr, and Docker collects it.** No service writes a log file
inside its own container. A file in a container is invisible to `docker compose logs`, needs its
own rotation, and disappears when the container is replaced. Both Nginx images already handle
this by symlinking their access and error logs to `/dev/stdout` and `/dev/stderr`, which is the
standard way to make a file-oriented program behave like a container.

**I capped how much Docker keeps.** The default is no limit — the log file grows until the disk
is full. What made me treat that as urgent rather than theoretical is that the failure isn't
local: a full disk breaks every service on the host, not just the noisy one. An idle API was
already writing about a megabyte a day, almost entirely from its own healthcheck.

**One policy, defined once.** The driver and its limits live in a top-level `x-logging` block as
a YAML anchor, and each service references it with an alias. Five copies of the same four lines
would have drifted the first time I changed my mind about a number.

**Mongo has a deliberately larger allowance.** I measured each service before choosing numbers.
Mongo writes around 63 MB a day where the API writes 0.2 MB — about 7 KB per healthcheck,
because it records a connection opened, a full SCRAM authentication handshake, and a connection
closed, every ten seconds. Under the shared 10 MB × 3 policy it would have kept roughly eleven
hours of history, which is short enough to have lost the evidence by the time anyone looks. It
gets 50 MB × 5 instead, about four days.

I considered two cheaper fixes and rejected both. `mongod --quiet` cut the volume by only about
30% in a side-by-side test — it drops some connection chatter but keeps the bulky authentication
records. Raising the healthcheck interval to 30 seconds would have cut it threefold, but slowing
down how fast I notice a dead database is a worse trade than spending disk. The volume comes
from an audit trail I'd actually want during an incident, so paying for it is the honest answer.

**These limits are a retention decision, not just a disk-safety one.** Rotated files are
deleted, not archived, and the lines that go first are the oldest — which is exactly the part
you want when reconstructing what happened. `max-size` also counts what Docker stores rather
than what I wrote: every line is wrapped in a JSON envelope with a 30-byte timestamp, so for
short lines most of the file is metadata.

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

## CI/CD

**CI runs the whole stack, not unit tests.** The workflow builds all five images, starts them,
waits for every healthcheck, and runs `scripts/verify.sh` — the same script I run by hand. What
I care about is that the containers work *together*, and that's only testable with all of them
running.

**GitHub-hosted runners, because I don't have a server.** Each run gets a fresh Ubuntu VM with
Docker installed, which is thrown away afterwards. That's a better test than my own machine:
it has no cached images, no leftover volumes, and no `.env`, so anything the stack silently
depends on from my laptop shows up as a failure.

**Two triggers: pushes to `master`, and pull requests.** The push trigger tells me whether
`master` works. The pull-request trigger tests a branch *before* it's merged, so broken code
never needs to reach `master` to be caught.

**CI generates its own passwords instead of using GitHub secrets.** The database in CI exists
for about two minutes and is destroyed with the VM. A random password made on the spot does the
job, and a stored secret would just be one more credential that could leak.

**One script creates `.env`, for CI and for people.** `scripts/init-env.sh` copies
`.env.example` and fills each blank password with `openssl rand -hex 24`. The same commands
started inside the workflow, but a new clone needs exactly the same thing, and two copies of
them would drift the first time the template changed. The script adds two things CI never
needed: it refuses to run if `.env` already exists, because new passwords would lock the API
out of an existing Mongo volume, and it makes the file readable only by its owner.

**The script checks its own output.** `sed` exits successfully even when it matches nothing, so
a misspelled or renamed variable would leave a password empty while everything still looked
green, and the stack would fail later somewhere unrelated. The script confirms each password is
exactly 48 hex characters, names the one that's missing, and deletes the half-made `.env`.

**Logs on failure, teardown always.** A failed step normally skips everything after it. The
log dump runs under `if: failure()`, so a red run shows me what every container said, and the
teardown runs under `if: always()`, so it happens regardless of the result. I proved the
pipeline can fail by breaking `/api/health` on a pull request: every container still came up
healthy, and only `verify.sh` caught it.

**CD means publishing images, because there's nowhere to deploy.** With no server, the useful
end of the pipeline is a tested, versioned artifact anyone can run. Green commits on `master`
push the `api`, `web` and `proxy` images to GitHub Container Registry, which comes with the
repository and needs no extra account. Deploying later would be a pull and an `up` on the
server, with no change to the pipeline.

**Images are pushed from the job that tested them.** A separate publish job would run on a new
VM and rebuild, so what I shipped wouldn't be byte-for-byte what passed. The login and push
steps sit after Verify in the same job, so a failed check means nothing is published.

**Only pushes to `master` publish.** Both CD steps run under
`github.event_name == 'push' && github.ref == 'refs/heads/master'`. Pull requests still run the
full test, but code that hasn't been merged is never released.

**Tagged by commit SHA only, no `latest`.** Every image names the exact commit it was built
from, so a bug report against a tag leads straight to the code. I pin every image I pull by
version, and publishing a moving `latest` would offer other people the thing I don't use myself.
The cost is that running an image means looking up a SHA.

**No stored registry credentials.** The login uses the `GITHUB_TOKEN` GitHub creates for each
run. The job's `permissions` allow it to read the code and write packages, nothing else, and it
expires when the job ends.

**Running from the registry is a separate Compose file.** `docker-compose.registry.yml` only
sets `image:` on the three built services. Putting those names in the main file would make
Compose tag its own local builds with them too, and CI's push loop would no longer find the
images it tags. I avoided the name `docker-compose.override.yml`, which Compose loads
automatically, so the registry file only applies when passed with `-f`. `IMAGE_TAG` uses
`${IMAGE_TAG:?...}`, so forgetting it is an error instead of a guess.

---

## Still to do

- [ ] **Ship logs off the host.** Rotation bounds the disk, but history is still deleted on
      rotation and lost entirely when containers are removed.
- [x] **CI.** `scripts/verify.sh` runs against a freshly built stack on every push and pull
      request.
- [x] **CD: publish images.** Green runs on `master` push `api`, `web` and `proxy` to GitHub
      Container Registry, tagged with the commit SHA, from the same job that tested them.
- [ ] **Deploy somewhere.** If I get a server: pull a tested SHA with
      `docker-compose.registry.yml` and `up --no-build`, triggered from the pipeline.
- [ ] **Resolve the `npm audit` warning** in the API's dependencies (one moderate advisory).
- [ ] **Docker secrets** instead of environment variables, so credentials stay out of
      `docker inspect`. Mongo supports this via `_FILE` variables; Redis would need a wrapper.
- [ ] **A dedicated Mongo user for the API**, with `readWrite` on `appdb` only, instead of root.
- [ ] **Unprivileged Nginx** (`nginxinc/nginx-unprivileged`) for `web` and `proxy`.
- [ ] Minor: `ENV NODE_ENV=production` in the API Dockerfile so the image is correct even
      without Compose; `--from=build` instead of `--from=0` in the web Dockerfile.
