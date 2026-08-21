# Engineering notes

This is notes for this project's infra and my decisions behind it.

Written as I went. Decisions first, then the things that broke and what they taught me.

---

## Design decisions

**`node:20-alpine` as the base image.** Alpine's base layer is ~5MB against ~100MB+ for the
Debian variants. The API image lands at 218MB, most of which is Node itself plus
`node_modules`. Alpine uses musl instead of glibc, which can matter for packages with native
bindings — none here, so the tradeoff is free.

**`npm ci`, not `npm install`.** `npm install` treats `package-lock.json` as a suggestion: if
`package.json` permits a newer version it will install it and rewrite the lockfile. Inside a
container that rewrite is thrown away at the end of the build, so the image can quietly
contain versions I never tested. `npm ci` installs strictly from the lockfile and fails loudly
if the two files disagree — a silent drift turned into a build error.

**Manifests copied before source.** `COPY package*.json ./` and `RUN npm ci` sit above
`COPY . .` so that editing a route file doesn't reinstall every dependency. Docker keys its
cache on **file content**, not timestamps — I confirmed this: `touch package.json` did *not*
bust the cache, but changing a character inside it did.

**`node src/server.js` as CMD, not `npm start`.** With `npm start`, npm is PID 1 and the app
is its child. Docker sends `SIGTERM` to PID 1 on `docker compose stop`, npm doesn't reliably
forward it, so the shutdown handlers in `server.js` never run — connections get severed
instead of closed, and the container is `SIGKILL`ed after the 10s grace period. Running Node
directly makes it PID 1 so signals land where they're handled.

**`USER node` plus `COPY --chown=node:node`.** The official Node image ships an unprivileged
user. The `USER` line goes *after* the `COPY` steps, since those need root to write into
`/app`. `--chown` makes file ownership match the runtime user rather than leaving everything
root-owned and readable-only by luck.

**Multi-stage build for the frontend.** Building React needs Node, npm, Vite and esbuild.
*Serving* it needs a web server and nothing else — the compiled JS runs in the user's browser,
not in my container. Stage one builds; stage two starts from `nginx:1.27-alpine` and copies
only `dist/` across. Result: **75MB versus 218MB** for the API, with all the build tooling
discarded rather than shipped as attack surface.

**Pinned image tags.** `mongo:7`, `nginx:1.27-alpine`, `node:20-alpine` — not `latest`.
`latest` is a moving pointer that can jump a major version between builds and break the stack
with no change on my side.

**Only the proxy publishes a port.** `ports: "8080:80"` on the proxy; `expose` on api and web,
which documents the internal port without opening it to the host. Mongo and Redis get neither.
Verified: 4000, 8081, 27017 and 6379 all refuse connections from the host; only 8080 answers.

**Static serving and routing kept separate.** The web container only hands out files
(`try_files`). All routing decisions live in the proxy. Mixing the two is what caused the
worst bug in this project (below).

---

## Things that broke, and what I learned

**`nodejs:20-alpine` doesn't exist.** The official image is `node`. Build failed at line 1
with `pull access denied` — which is what Docker Hub returns for a nonexistent repository, not
a permissions problem. Misleading error; worth remembering.

**`npm src/server.js` isn't a command.** `npm` is a package manager — its first argument must
be a subcommand (`install`, `ci`, `start`). To *run* a JS file you need `node`, a different
binary. Container built fine and died instantly on start.

**Node can't run `main.jsx`.** My first web Dockerfile was a copy of the API's, trying to
`node src/main.js`. Two reasons that can never work: `<App />` is JSX, which isn't JavaScript
and must be compiled away first; and `document` is a browser API that doesn't exist in Node.
This was the moment the frontend/backend distinction actually clicked — the API is a program
that runs, the frontend is files that get compiled and downloaded.

**Vite outputs to `dist/`, not `build/`.** `build/` is Create React App's convention and most
React tutorials online are CRA-era. `COPY --from=0 /app/build` failed with
`"/app/build": not found`. Technique worth keeping: `docker build --target <stage>` then
`docker run --rm <image> ls /app` shows exactly what a build stage produced, instead of
guessing.

**`//` is not a Dockerfile comment.** Dockerfiles use `#`. The parser read `//stage` as an
instruction name: `unknown instruction: //stage`.

**YAML: `-key=value` and `- key=value` are different things.** A list item is dash *plus
space*. Without the space it's a plain string starting with a hyphen, so Compose saw
`environment` holding a string and rejected it with
`services.api.environment must be a mapping`.

**A container's DNS name is its service name.** I had a service named `db` and a connection
string pointing at `mongo://mongo:27017` — nothing resolved. Renamed the service to `mongo` so
the name matches the thing, which also means the app's built-in default is already correct.

**Environment variable names are case-sensitive and fail silently.** I first wrote
`Database_url` instead of `MONGO_URL`. No error anywhere — the app just fell back to its
default. Wrong-but-silent is much worse to debug than wrong-and-loud.

**Declaring a volume is not mounting it.** A top-level `volumes:` block only says the volume
exists. Data isn't persisted until a *service* mounts it at the path the image actually writes
to (`/data/db` for Mongo — found in the image docs, not guessed).

**`proxy_pass` and the trailing slash.** If the `proxy_pass` URL has a path component, Nginx
*replaces* the matched location prefix with it; with no path, the original URI passes through
untouched. For `location /api/`, `http://api:4000` forwards `/api/items` as `/api/items`,
while `http://api:4000/` would forward it as `/items`. The Express routes are mounted at
`/api`, so the no-slash form is correct. One character between working and 404s.

**The proxy loop — best bug of the project.** After wiring the proxy, `/api/*` returned 200
but `/` returned **400**. Not 404, not 502. Cause: I had overwritten `web/nginx.conf` with the
proxy's config, so the web container was proxying to *itself* in an infinite loop. The 400
came from `$proxy_add_x_forwarded_for` **appending** the client IP on every hop until the
request header outgrew Nginx's buffer and got rejected. Two lasting lessons: a growing
`X-Forwarded-For` chain in the logs is the fingerprint of a proxy loop, and because the
innermost request fails first, the *longest* chain appears *first* in the log — reversed
ordering is itself the tell.

**Rebuilding doesn't always replace the running container.** The web image had been rebuilt
but the container was still running the old image ID — Compose reported `Running`, not
`Recreated`. `docker compose up -d --build --force-recreate` guarantees replacement. "I
rebuilt and nothing changed" is usually this.

**Commit early.** I lost `web/nginx.conf` by overwriting it, and it was unrecoverable because
nothing had been committed for days. Committing after each working step turns that from a
rewrite into a `git checkout`.

---

## Open items

- [ ] `ENV NODE_ENV=production` in the API image — Express still runs in dev mode and will
      leak stack traces in error responses.
- [ ] **Redis persistence — decide and justify.** Currently no volume, so the cache is empty
      after a restart. For a pure cache that's arguably correct: a cold start costs one slow
      request. It would matter much more if Redis ever held sessions or queues. If persisting,
      `appendonly` is needed — Redis's default durability is weaker than it looks.
- [ ] Healthchecks on all five services.
- [ ] `depends_on` with `condition: service_healthy`. Right now it only orders *starts*; the
      stack works because the API retries its connections ten times, not because Compose waits.
- [ ] Auth on Mongo and Redis, credentials in `.env`, with a committed `.env.example`.
- [ ] `restart: unless-stopped` policies.
