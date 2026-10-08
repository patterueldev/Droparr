#!/bin/sh
# Droparr container entrypoint.
#
# PUID/PGID support (LinuxServer-style): when the container starts as root,
# make /data and /config writable by PUID:PGID, apply UMASK, then drop
# privileges before running the server. When compose already sets `user:`,
# this script passes straight through.
set -e

if [ "$(id -u)" = "0" ]; then
  PUID="${PUID:-1000}"
  PGID="${PGID:-1000}"
  UMASK="${UMASK:-022}"

  case "$PUID" in
    '' | *[!0-9]*) echo "PUID must be a numeric user id (got: $PUID)" >&2; exit 1 ;;
  esac
  case "$PGID" in
    '' | *[!0-9]*) echo "PGID must be a numeric group id (got: $PGID)" >&2; exit 1 ;;
  esac

  if ! getent group "$PGID" >/dev/null 2>&1; then
    groupadd --gid "$PGID" droparr
  fi
  GROUP_NAME="$(getent group "$PGID" | cut -d: -f1)"

  if ! getent passwd "$PUID" >/dev/null 2>&1; then
    useradd --uid "$PUID" --gid "$GROUP_NAME" --no-create-home \
      --shell /usr/sbin/nologin droparr
  fi
  USER_NAME="$(getent passwd "$PUID" | cut -d: -f1)"

  # State volumes must be writable by the runtime user. Only paths Droparr
  # owns are touched recursively: /config and the default quarantine dir
  # under /data. The shared staging volume (often nested under /data, or
  # remapped in Settings) deliberately keeps its own ownership — the *arr
  # stack must be able to move staged files.
  chown "$PUID:$PGID" /data 2>/dev/null || true
  find /data -maxdepth 1 -type f -exec chown "$PUID:$PGID" {} + 2>/dev/null || true
  chown -R "$PUID:$PGID" /config 2>/dev/null || true
  chown -R "$PUID:$PGID" /data/quarantine 2>/dev/null || true

  umask "$UMASK"
  echo "Droparr starting as ${USER_NAME} (${PUID}:${PGID}, umask ${UMASK})"
  exec gosu "$USER_NAME" "$@"
fi

umask "${UMASK:-022}"
exec "$@"
