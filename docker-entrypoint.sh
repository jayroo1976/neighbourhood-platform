#!/bin/sh
# Docker creates bind-mounted folders as root. Make the photo folder writable for the
# unprivileged "node" user, then drop privileges before starting the app.
set -e
if [ "$(id -u)" = "0" ]; then
  DIR="${STORAGE_LOCAL_DIR:-/data/files}"
  mkdir -p "$DIR" && chown -R node:node "$DIR" || echo "warning: could not prepare $DIR"
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi
exec "$@"
