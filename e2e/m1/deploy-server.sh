#!/usr/bin/env bash
# Deploy the M1 validation bench to the homeserver and generate fixtures.
# Idempotent — safe to re-run after pushing new commits.
#
# Usage: e2e/m1/deploy-server.sh
# Reads e2e/m1/local.env (copy local.env.example first).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$here/../.." && pwd)"

if [ -f "$here/local.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$here/local.env"
  set +a
else
  echo "error: $here/local.env not found — copy local.env.example and fill it in" >&2
  exit 1
fi

: "${SSH_HOST:?set SSH_HOST in e2e/m1/local.env}"
: "${DROPARR_BASE_URL:?}"
: "${REMOTE_APP_DIR:?}"
: "${DATA_HOST_DIR:?}"
: "${STAGING_HOST_DIR:?}"
: "${DROPS_HOST_DIR:?}"
: "${TEST_ROOT_HOST_DIR:?}"
: "${LAN_IP:?}"

branch="${BRANCH:-$(git -C "$repo_root" rev-parse --abbrev-ref HEAD)}"

echo "==> Checking server prerequisites"
ssh "$SSH_HOST" 'command -v git >/dev/null && command -v docker >/dev/null && docker compose version >/dev/null'

echo "==> Preparing directories on $SSH_HOST"
ssh "$SSH_HOST" "mkdir -p '$REMOTE_APP_DIR' '$DATA_HOST_DIR/config' '$DATA_HOST_DIR/data' '$STAGING_HOST_DIR' '$DROPS_HOST_DIR' '$TEST_ROOT_HOST_DIR' && { chown -R 1000:1000 '$DATA_HOST_DIR' '$STAGING_HOST_DIR' '$DROPS_HOST_DIR' '$TEST_ROOT_HOST_DIR' 2>/dev/null || true; }"

echo "==> Cloning/updating Droparr ($branch)"
ssh "$SSH_HOST" "if [ -d '$REMOTE_APP_DIR/.git' ]; then git -C '$REMOTE_APP_DIR' fetch origin && git -C '$REMOTE_APP_DIR' checkout '$branch' && git -C '$REMOTE_APP_DIR' pull --ff-only origin '$branch'; else git clone --branch '$branch' https://github.com/patterueldev/Droparr.git '$REMOTE_APP_DIR'; fi"

echo "==> Writing compose .env"
ssh "$SSH_HOST" "printf '%s\n' 'LAN_IP=$LAN_IP' 'DATA_HOST_DIR=$DATA_HOST_DIR' 'STAGING_HOST_DIR=$STAGING_HOST_DIR' 'DROPS_HOST_DIR=$DROPS_HOST_DIR' > '$REMOTE_APP_DIR/e2e/m1/.env'"

echo "==> Building + starting Droparr (this can take a few minutes)"
ssh "$SSH_HOST" "cd '$REMOTE_APP_DIR/e2e/m1' && docker compose --project-name droparr -f server-compose.yaml up -d --build"

echo "==> Waiting for health at $DROPARR_BASE_URL"
healthy=""
for _ in $(seq 1 60); do
  if curl -fsS "$DROPARR_BASE_URL/api/health" >/dev/null 2>&1; then
    healthy="yes"
    break
  fi
  sleep 2
done
if [ -z "$healthy" ]; then
  echo "error: Droparr did not become healthy — check 'ssh $SSH_HOST docker logs droparr'" >&2
  exit 1
fi
echo "    healthy"

echo "==> Generating fixtures on the server"
ssh "$SSH_HOST" "'$REMOTE_APP_DIR/e2e/m1/gen-fixtures.sh' '$DROPS_HOST_DIR' && chown -R 1000:1000 '$DROPS_HOST_DIR'"

echo
echo "Done. Next:"
echo "  node --env-file=e2e/m1/local.env e2e/m1/setup.mjs"
echo "  node --env-file=e2e/m1/local.env e2e/m1/run.mjs"
