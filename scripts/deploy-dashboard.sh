#!/usr/bin/env bash
# Build and deploy the admin dashboard.
#
# Loads DEPLOY_HOST and DEPLOY_PATH from .env at the repo root (if present).
# Example .env:
#   DEPLOY_HOST=your-server.example.com
#   DEPLOY_PATH=/var/www/panel.areal.finance/
#
# Usage: npm run dashboard:deploy  (or invoke directly)

set -euo pipefail

cd "$(dirname "$0")/.."

if [ -f .env ]; then
  # shellcheck disable=SC1091
  set -a; source .env; set +a
fi

: "${DEPLOY_HOST:?DEPLOY_HOST is not set. Copy .env.example to .env and fill it in.}"
: "${DEPLOY_PATH:?DEPLOY_PATH is not set. Copy .env.example to .env and fill it in.}"

echo "→ Building dashboard..."
npm run dashboard:build

echo "→ Uploading to ${DEPLOY_HOST}:${DEPLOY_PATH}"
rsync -az --delete dashboard/build/ "${DEPLOY_HOST}:${DEPLOY_PATH}"

echo "✓ Deployed."
