#!/usr/bin/env bash
#
# Production deploy logic for panel.areal.finance.
#
# Canonical path: GitHub Actions deploy-dashboard.yml SSHes deployer@vps with
# verb "deploy-dashboard"; that verb is routed by /usr/local/bin/areal-deploy
# through sudo to /usr/local/sbin/areal-deploy-dashboard, which sources
# /etc/areal-deploy/config.env and execs THIS script. Always runs as root.
#
# Manual fallback: when Actions is unavailable, an operator can run this
# directly on the VPS as root:
#   sudo bash /opt/areal/scripts/deploy-dashboard.sh
#
# Privilege model (Phase 25 NOTE-4 hardening):
#   - git pull + npm install + npm run build run as `deployer` (uid 999) via
#     runuser. Compromised npm postinstall scripts cannot escalate to root.
#   - Only the final rsync runs as root (it writes into /var/www/, which is
#     root-owned). Everything before that is dropped privilege.
#
# Uses `npm ci` (multi-platform lockfile lands in sdk#22 + dashboard via app#25
# regenerate; npm ci does not mutate the lockfile so subsequent submodule
# checkouts never trip on local working-tree changes). See deploy-app.sh.
#
set -euo pipefail

REPO_ROOT="${REPO_ROOT:-/opt/areal}"
DASHBOARD_WEBROOT="${DASHBOARD_WEBROOT:-/var/www/panel.areal.finance}"
DEPLOY_USER="${DEPLOY_USER:-deployer}"

# Sanity: REPO_ROOT must be deployer-owned so the build phase can write into
# its node_modules and build/ directories.
if [ "$(stat -c '%U' "${REPO_ROOT}")" != "${DEPLOY_USER}" ]; then
  echo "error: ${REPO_ROOT} is not owned by ${DEPLOY_USER}" >&2
  echo "       run scripts/setup-deployer-user.sh as root to fix ownership," >&2
  echo "       or: chown -R ${DEPLOY_USER}:${DEPLOY_USER} ${REPO_ROOT}" >&2
  exit 1
fi

# Build phase — drop to deployer.
runuser -u "${DEPLOY_USER}" -- bash -c "
  set -euo pipefail
  cd '${REPO_ROOT}'
  git pull --ff-only --recurse-submodules
  git submodule update --init --recursive

  # Build SDK first — dashboard consumes file:../sdk and reads its dist/.
  cd '${REPO_ROOT}/sdk'
  npm ci --no-audit --no-fund
  npm run build

  cd '${REPO_ROOT}/dashboard'
  npm ci --no-audit --no-fund
  npm run build
"

# Publish phase — root needed for rsync to root-owned /var/www/.
rsync -az --delete "${REPO_ROOT}/dashboard/build/" "${DASHBOARD_WEBROOT}/"
