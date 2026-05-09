#!/usr/bin/env bash
#
# Production deploy logic for app.areal.finance.
#
# Invoked indirectly: GitHub Actions deploy-app.yml SSHes deployer@vps with
# verb "deploy-app", which is routed by /usr/local/bin/areal-deploy through
# sudo to /usr/local/sbin/areal-deploy-app, which `git pull`s the meta-repo
# and execs THIS script. Always runs as root.
#
# Uses `npm install` (not `npm ci`) deliberately — npm ci skips OS-specific
# optional deps when their entries are missing from package-lock.json (npm
# bug https://github.com/npm/cli/issues/4828); npm install fills them in.
#
set -euo pipefail

REPO_ROOT="${REPO_ROOT:-/opt/areal}"
APP_WEBROOT="${APP_WEBROOT:-/var/www/app.areal.finance}"

cd "${REPO_ROOT}"
git submodule update --init --recursive

# Build SDK first — app consumes file:../sdk and reads its dist/.
cd "${REPO_ROOT}/sdk"
npm install --no-audit --no-fund
npm run build

cd "${REPO_ROOT}/app"
npm install --no-audit --no-fund
npm run build
rsync -az --delete build/ "${APP_WEBROOT}/"
