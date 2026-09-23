#!/usr/bin/env bash
# Creates .env from .env.example with freshly generated passwords. Used by CI and for new clones.
#   ./scripts/init-env.sh
set -euo pipefail

cd "$(dirname "$0")/.."

# Never overwrite: Mongo stores its root password in the data volume on first start, so new
# passwords in .env would lock the API out of an existing database.
if [ -e .env ]; then
  echo ".env already exists — leaving it alone. Delete it first if you really want new passwords." >&2
  exit 1
fi

cp .env.example .env
chmod 600 .env
sed -i "s/^MONGO_ROOT_PASSWORD=$/MONGO_ROOT_PASSWORD=$(openssl rand -hex 24)/" .env
sed -i "s/^REDIS_PASSWORD=$/REDIS_PASSWORD=$(openssl rand -hex 24)/" .env

# sed succeeds even when it matches nothing, so confirm both passwords were actually filled in.
for var in MONGO_ROOT_PASSWORD REDIS_PASSWORD; do
  if ! grep -q "^$var=[0-9a-f]\{48\}$" .env; then
    echo "$var was not generated — check its name in .env.example" >&2
    rm .env
    exit 1
  fi
done

echo "Created .env with new passwords."
