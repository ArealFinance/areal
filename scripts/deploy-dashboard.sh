#!/usr/bin/env bash
#
# Production deploy logic for panel.areal.finance.
#
# Canonical path: GitHub Actions deploy-dashboard.yml SSHes deployer@vps with
# verb "deploy-dashboard"; that verb is routed by /usr/local/bin/areal-deploy
# through sudo to /usr/local/sbin/areal-deploy-dashboard, which `git pull`s the
# meta-repo and execs THIS script. Always runs as root on the VPS.
#
# Manual fallback: when Actions is unavailable, an operator can run this
# directly on the VPS as root: `sudo bash /opt/areal/scripts/deploy-dashboard.sh`.
#
# Uses `npm install` (not `npm ci`) deliberately — npm ci skips OS-specific
# optional deps when their entries are missing from package-lock.json (npm
# bug https://github.com/npm/cli/issues/4828); npm install fills them in.
#
set -euo pipefail

REPO_ROOT="${REPO_ROOT:-/opt/areal}"
DASHBOARD_WEBROOT="${DASHBOARD_WEBROOT:-/var/www/panel.areal.finance}"

cd "${REPO_ROOT}"
git submodule update --init --recursive

# Build SDK first — dashboard consumes file:../sdk and reads its dist/.
cd "${REPO_ROOT}/sdk"
npm install --no-audit --no-fund
npm run build

cd "${REPO_ROOT}/dashboard"
npm install --no-audit --no-fund
npm run build
rsync -az --delete build/ "${DASHBOARD_WEBROOT}/"
