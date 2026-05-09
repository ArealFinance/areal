#!/usr/bin/env bash
#
# Production deploy logic for app.areal.finance.
#
# Invoked indirectly: GitHub Actions deploy-app.yml SSHes deployer@vps with
# verb "deploy-app", which is routed by /usr/local/bin/areal-deploy through
# sudo to /usr/local/sbin/areal-deploy-app, which `git pull`s the meta-repo
# and execs THIS script. Always runs as root on the VPS.
#
# Privilege model (Phase 25 NOTE-4 hardening):
#   - git pull + npm install + npm run build run as `deployer` (uid 999) via
#     runuser. Compromised npm postinstall scripts cannot escalate to root.
#   - Only the final rsync runs as root (it writes into /var/www/, which is
#     root-owned). Everything before that is dropped privilege.
#
# Uses `npm install` (not `npm ci`) deliberately — npm ci skips OS-specific
# optional deps when their entries are missing from package-lock.json (npm
# bug https://github.com/npm/cli/issues/4828); npm install fills them in.
#
# REPO_ROOT and APP_WEBROOT come from /etc/areal-deploy/config.env (sourced by
# the wrapper at /usr/local/sbin/areal-deploy-app), with bake-time defaults
# baked into the wrapper. They MUST already be exported into this script's
# environment by the wrapper (or by the operator running it manually).
#
set -euo pipefail

REPO_ROOT="${REPO_ROOT:-/opt/areal}"
APP_WEBROOT="${APP_WEBROOT:-/var/www/app.areal.finance}"
DEPLOY_USER="${DEPLOY_USER:-deployer}"

# Sanity: REPO_ROOT must be deployer-owned so the build phase can write into
# its node_modules and build/ directories. The bootstrap script (scripts/
# setup-deployer-user.sh) chowns it; if it isn't, we fail loudly rather than
# silently building as root.
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

  # Build SDK first — app consumes file:../sdk and reads its dist/.
  cd '${REPO_ROOT}/sdk'
  npm install --no-audit --no-fund
  npm run build

  cd '${REPO_ROOT}/app'
  npm install --no-audit --no-fund
  npm run build
"

# Publish phase — root needed for rsync to root-owned /var/www/.
rsync -az --delete "${REPO_ROOT}/app/build/" "${APP_WEBROOT}/"
