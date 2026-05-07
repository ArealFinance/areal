#!/usr/bin/env bash
# DEPRECATED — use .github/workflows/deploy-dashboard.yml.
# This script is retained ONLY as an emergency manual fallback for when
# GitHub Actions is down or the deployer SSH path is broken. Running it
# bypasses the audit trail (Actions log, concurrency lock, Telegram alert).
#
# Scheduled for removal in Phase 26 once Phase 25 has run cleanly for 30 days.
# Operator runbook: see INFRASTRUCTURE.md → Deploy automation → Emergency fallback.
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
