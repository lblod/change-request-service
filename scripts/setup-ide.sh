#!/usr/bin/env bash
# Populates ./node_modules with the template's dependencies and its `mu` helper package, so
# `npm test` and editors can resolve `import ... from 'mu'`. This is what `mu script setup-ide`
# does; the template's own script copies the sources one level too deep in 1.9.1, so the steps
# are spelled out here. Needs docker; the template version is read from the Dockerfile.
set -euo pipefail
cd "$(dirname "$0")/.."

image=$(sed -n 's/^FROM[[:space:]]\+\(semtech\/mu-javascript-template:[^[:space:]]\+\).*/\1/p' Dockerfile | head -1)
if [ -z "$image" ]; then
  echo "No semtech/mu-javascript-template FROM line in the Dockerfile" >&2
  exit 1
fi

echo "Installing the node_modules of $image into $PWD/node_modules"
docker run --rm -v "$PWD":/app -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" --entrypoint /bin/bash "$image" -c '
  set -e
  mkdir -p /usr/src/app/app
  rsync -a --exclude node_modules --exclude .git /app/ /usr/src/app/app/
  cd /usr/src/app
  ./npm-install-dependencies.sh development install
  test -f /app/node_modules/mu/index.js
  chown -R "$HOST_UID:$HOST_GID" /app/node_modules
  if [ -f /app/package-lock.json ]; then chown "$HOST_UID:$HOST_GID" /app/package-lock.json; fi
'
echo "Done. Run the tests with: npm test"
