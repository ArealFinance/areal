#!/usr/bin/env bash
# !! EMERGENCY MANUAL FALLBACK !!
# This script is preserved as a manual fallback for cases when GitHub Actions
# is unavailable. Preferred path: .github/workflows/deploy-dashboard.yml.
# Do not use this script unless Actions cannot run (e.g., GitHub outage).
# Keep parity with the workflow if you change one.
#
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
