#!/usr/bin/env bash
#
# setup-deployer-user.sh — idempotent VPS bootstrap for the `deployer` user.
#
# Purpose:
#   Codify the current production VPS state so a fresh box can be re-provisioned
#   with the same forced-command SSH deployment surface used by GitHub Actions
#   workflows (deploy-observability, deploy-app, deploy-dashboard).
#
# Intended usage (one-time, run as root on the target VPS):
#
#   sudo bash scripts/setup-deployer-user.sh --pubkey-file ~/.ssh/areal_deployer.pub
#
# The script is idempotent: re-running it on an already-provisioned host should
# converge to the same state without errors. All actions check current state
# before mutating.
#
# What this script provisions:
#   - `deployer` user (preferred uid 999, group 988; falls back to next free if taken)
#   - /etc/sudoers.d/areal-deployer with NOPASSWD entries for the deploy verbs
#   - /usr/local/bin/areal-deploy forced-command wrapper (verb router)
#   - /usr/local/sbin/areal-deploy-{app,dashboard,observability} verb scripts
#   - /usr/local/sbin/areal-deploy-health (curl-based health probe)
#   - ~deployer/.ssh/authorized_keys with command="…" lock (no port/agent/X11/pty)
#
# Constraints:
#   - The SSH public key is supplied via --pubkey-file PATH (NEVER hardcoded).
#   - All sudoers writes are validated with `visudo -c` and applied atomically.
#   - All script writes use `install -m …` for deterministic perms on re-run.
#

set -euo pipefail

# ---------- helpers ----------

err() { printf 'error: %s\n' "$*" >&2; }
log() { printf '==> %s\n' "$*" >&2; }
die() { err "$@"; exit 1; }

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    die "must run as root (try: sudo bash $0 --pubkey-file PATH)"
  fi
}

# ---------- arg parse ----------

# Defaults — overridable via flags below. Values land in
# /etc/areal-deploy/config.env so wrappers/scripts can pick them up at runtime
# without re-running this bootstrap.
PUBKEY_FILE=""
REPO_ROOT="/opt/areal"
APP_WEBROOT="/var/www/app.areal.finance"
DASHBOARD_WEBROOT="/var/www/panel.areal.finance"
HEALTH_URL="https://status.areal.finance/api/health"

flag_value() {
  # Pull the value from `--flag value` (already shifted) or `--flag=value`.
  local arg="$1" expected="$2"
  case "$arg" in
    "$expected"=*) printf '%s' "${arg#*=}" ;;
    *) printf '%s' "${REQUIRED_NEXT:-}" ;;
  esac
}

while [ $# -gt 0 ]; do
  case "$1" in
    --pubkey-file)
      shift
      [ $# -gt 0 ] || die "--pubkey-file requires a path argument"
      PUBKEY_FILE="$1"
      ;;
    --pubkey-file=*)
      PUBKEY_FILE="${1#*=}"
      ;;
    --repo-root)
      shift; [ $# -gt 0 ] || die "--repo-root requires a path argument"
      REPO_ROOT="$1"
      ;;
    --repo-root=*)
      REPO_ROOT="${1#*=}"
      ;;
    --app-webroot)
      shift; [ $# -gt 0 ] || die "--app-webroot requires a path argument"
      APP_WEBROOT="$1"
      ;;
    --app-webroot=*)
      APP_WEBROOT="${1#*=}"
      ;;
    --dashboard-webroot)
      shift; [ $# -gt 0 ] || die "--dashboard-webroot requires a path argument"
      DASHBOARD_WEBROOT="$1"
      ;;
    --dashboard-webroot=*)
      DASHBOARD_WEBROOT="${1#*=}"
      ;;
    --health-url)
      shift; [ $# -gt 0 ] || die "--health-url requires a URL argument"
      HEALTH_URL="$1"
      ;;
    --health-url=*)
      HEALTH_URL="${1#*=}"
      ;;
    -h|--help)
      sed -n '2,30p' "$0"
      cat <<'HELP_EOF'

Optional path/URL overrides (defaults shown in --help excerpt above):
  --repo-root PATH         (default: /opt/areal)
  --app-webroot PATH       (default: /var/www/app.areal.finance)
  --dashboard-webroot PATH (default: /var/www/panel.areal.finance)
  --health-url URL         (default: https://status.areal.finance/api/health)

These values are written to /etc/areal-deploy/config.env. Wrappers in
/usr/local/sbin/areal-deploy-* source that file at every invocation, so
operators can re-point a single setting (e.g. swap APP_WEBROOT for a
staging webroot) without re-running setup-deployer-user.sh.
HELP_EOF
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
  shift
done

require_root

if [ -z "$PUBKEY_FILE" ]; then
  die "--pubkey-file PATH is required (path to deployer SSH public key)"
fi
if [ ! -r "$PUBKEY_FILE" ]; then
  die "cannot read pubkey file: $PUBKEY_FILE"
fi

PUBKEY_CONTENT="$(tr -d '\r\n' < "$PUBKEY_FILE")"
if [ -z "$PUBKEY_CONTENT" ]; then
  die "pubkey file is empty: $PUBKEY_FILE"
fi
case "$PUBKEY_CONTENT" in
  ssh-ed25519\ *|ssh-rsa\ *|ecdsa-*\ *|sk-ssh-ed25519@*\ *|sk-ecdsa-*\ *) ;;
  *) die "pubkey file does not look like an OpenSSH public key" ;;
esac

# ---------- 1. deployer user/group ----------

DEPLOY_USER="deployer"
DEPLOY_GROUP="deployer"
PREFERRED_UID=999
PREFERRED_GID=988

ensure_group() {
  if getent group "$DEPLOY_GROUP" >/dev/null 2>&1; then
    log "group $DEPLOY_GROUP already exists"
    return 0
  fi
  if getent group "$PREFERRED_GID" >/dev/null 2>&1; then
    log "gid $PREFERRED_GID is taken; creating group $DEPLOY_GROUP with next free gid"
    groupadd --system "$DEPLOY_GROUP"
  else
    log "creating group $DEPLOY_GROUP (gid $PREFERRED_GID)"
    groupadd --system --gid "$PREFERRED_GID" "$DEPLOY_GROUP"
  fi
}

ensure_user() {
  if id "$DEPLOY_USER" >/dev/null 2>&1; then
    log "user $DEPLOY_USER already exists"
    return 0
  fi
  local uid_arg=()
  if ! getent passwd "$PREFERRED_UID" >/dev/null 2>&1; then
    uid_arg=(--uid "$PREFERRED_UID")
  else
    log "uid $PREFERRED_UID is taken; allocating next free uid for $DEPLOY_USER"
  fi
  log "creating user $DEPLOY_USER"
  useradd \
    --system \
    "${uid_arg[@]}" \
    --gid "$DEPLOY_GROUP" \
    --home-dir "/home/$DEPLOY_USER" \
    --create-home \
    --shell /bin/bash \
    "$DEPLOY_USER"
}

ensure_group
ensure_user

DEPLOY_HOME="$(getent passwd "$DEPLOY_USER" | cut -d: -f6)"
[ -n "$DEPLOY_HOME" ] || die "could not resolve home dir for $DEPLOY_USER"

# ensure REPO_ROOT is deployer-owned so the build phase can write into
# node_modules/build/ without root. If REPO_ROOT doesn't exist yet, that's
# fine — operator clones it manually as deployer afterwards. If it does
# exist and is owned by someone else (typical first run on a host where
# /opt/areal was cloned by root), chown it.
ensure_repo_root_ownership() {
  if [ ! -d "$REPO_ROOT" ]; then
    log "$REPO_ROOT does not exist; skipping chown — clone it manually as $DEPLOY_USER"
    return 0
  fi
  local current_owner
  current_owner="$(stat -c '%U' "$REPO_ROOT")"
  if [ "$current_owner" = "$DEPLOY_USER" ]; then
    log "$REPO_ROOT already owned by $DEPLOY_USER"
    return 0
  fi
  log "chowning $REPO_ROOT recursively to $DEPLOY_USER:$DEPLOY_GROUP (was $current_owner)"
  chown -R "$DEPLOY_USER:$DEPLOY_GROUP" "$REPO_ROOT"
}

ensure_repo_root_ownership

# ---------- 2. forced-command wrapper /usr/local/bin/areal-deploy ----------

WRAPPER_PATH="/usr/local/bin/areal-deploy"

install_wrapper() {
  local tmp
  tmp="$(mktemp)"
  cat > "$tmp" <<'WRAPPER_EOF'
#!/usr/bin/env bash
#
# areal-deploy — forced-command wrapper for the `deployer` SSH user.
# Invoked via SSH command="…" lock; the requested verb is in $SSH_ORIGINAL_COMMAND
# (passed by sshd) or $1 if invoked locally for testing.
#
# Allowed verbs:
#   deploy-observability  — pull repo + run observability bootstrap
#   deploy-dashboard      — pull repo + build+sync dashboard
#   deploy-app            — pull repo + build+sync app
#   health                — curl public health endpoint, return its exit
#
# Everything else exits 42 with a "rejected: …" message on stderr.
#
set -euo pipefail

cmd="${SSH_ORIGINAL_COMMAND:-${1:-}}"
# Take only the first whitespace-separated token — refuse extra args.
verb="${cmd%% *}"

case "$verb" in
  deploy-observability)
    exec sudo -n /usr/local/sbin/areal-deploy-observability
    ;;
  deploy-dashboard)
    exec sudo -n /usr/local/sbin/areal-deploy-dashboard
    ;;
  deploy-app)
    exec sudo -n /usr/local/sbin/areal-deploy-app
    ;;
  health)
    exec /usr/local/sbin/areal-deploy-health
    ;;
  *)
    printf 'rejected: %s\n' "$cmd" >&2
    exit 42
    ;;
esac
WRAPPER_EOF
  install -o root -g root -m 0755 "$tmp" "$WRAPPER_PATH"
  rm -f "$tmp"
}

log "installing $WRAPPER_PATH"
install_wrapper

# ---------- 3. /etc/areal-deploy/config.env (runtime config for wrappers) ----------

CONFIG_DIR="/etc/areal-deploy"
CONFIG_PATH="${CONFIG_DIR}/config.env"

install_config_env() {
  local tmp
  tmp="$(mktemp)"
  cat > "$tmp" <<CFG_EOF
# Managed by scripts/setup-deployer-user.sh. Edit and the next deploy picks it
# up — no need to re-run setup-deployer-user.sh just to change a path.
# Wrappers in /usr/local/sbin/areal-deploy-* source this file at every
# invocation; values here override the defaults baked into each wrapper.
#
# Operators: changing REPO_ROOT requires the new directory to be a clone of
# ArealFinance/areal with submodules initialised. Changing webroots requires
# the matching nginx vhost to point at the new path.
REPO_ROOT="${REPO_ROOT}"
APP_WEBROOT="${APP_WEBROOT}"
DASHBOARD_WEBROOT="${DASHBOARD_WEBROOT}"
HEALTH_URL="${HEALTH_URL}"
CFG_EOF
  install -d -o root -g root -m 0755 "$CONFIG_DIR"
  install -o root -g root -m 0644 "$tmp" "$CONFIG_PATH"
  rm -f "$tmp"
}

log "installing $CONFIG_PATH"
install_config_env

# ---------- 4. verb scripts in /usr/local/sbin ----------
#
# Wrappers source $CONFIG_PATH at every invocation, falling back to
# baked-in defaults if the config file is missing or doesn't override
# a given variable. The defaults baked here match the values written
# by this run of setup-deployer-user.sh.

install_verb_app() {
  local tmp
  tmp="$(mktemp)"
  cat > "$tmp" <<APP_EOF
#!/usr/bin/env bash
#
# areal-deploy-app — thin wrapper. Sources runtime config, exports the
# canonical paths, and execs scripts/deploy-app.sh from the repo. The
# build itself runs as deployer (uid 999); only the final rsync into
# /var/www/ runs as root. See scripts/deploy-app.sh for the privilege
# model (Phase 25 NOTE-4 hardening).
#
# Runtime config: ${CONFIG_PATH} (sourced if readable). Override a path
# by editing that file; no need to reinstall this wrapper.
#
# Invoked by /usr/local/bin/areal-deploy via NOPASSWD sudo.
#
set -euo pipefail

# shellcheck disable=SC1091
[ -r ${CONFIG_PATH} ] && . ${CONFIG_PATH}
REPO_ROOT="\${REPO_ROOT:-${REPO_ROOT}}"
APP_WEBROOT="\${APP_WEBROOT:-${APP_WEBROOT}}"

# scripts/deploy-app.sh handles git pull as deployer, then rsyncs as root.
# We exec it directly without changing cwd or pulling here.
exec /usr/bin/env REPO_ROOT="\${REPO_ROOT}" APP_WEBROOT="\${APP_WEBROOT}" \\
  /usr/bin/bash "\${REPO_ROOT}/scripts/deploy-app.sh"
APP_EOF
  install -o root -g root -m 0755 "$tmp" /usr/local/sbin/areal-deploy-app
  rm -f "$tmp"
}

install_verb_dashboard() {
  local tmp
  tmp="$(mktemp)"
  cat > "$tmp" <<DASH_EOF
#!/usr/bin/env bash
#
# areal-deploy-dashboard — thin wrapper, see areal-deploy-app for design.
# Build runs as deployer; only rsync runs as root.
#
# Runtime config: ${CONFIG_PATH} (sourced if readable).
#
# Invoked by /usr/local/bin/areal-deploy via NOPASSWD sudo.
#
set -euo pipefail

# shellcheck disable=SC1091
[ -r ${CONFIG_PATH} ] && . ${CONFIG_PATH}
REPO_ROOT="\${REPO_ROOT:-${REPO_ROOT}}"
DASHBOARD_WEBROOT="\${DASHBOARD_WEBROOT:-${DASHBOARD_WEBROOT}}"

exec /usr/bin/env REPO_ROOT="\${REPO_ROOT}" DASHBOARD_WEBROOT="\${DASHBOARD_WEBROOT}" \\
  /usr/bin/bash "\${REPO_ROOT}/scripts/deploy-dashboard.sh"
DASH_EOF
  install -o root -g root -m 0755 "$tmp" /usr/local/sbin/areal-deploy-dashboard
  rm -f "$tmp"
}

install_verb_observability() {
  local tmp
  tmp="$(mktemp)"
  cat > "$tmp" <<OBS_EOF
#!/usr/bin/env bash
#
# areal-deploy-observability — pull meta-repo, run observability bootstrap.
#
# Runtime config: ${CONFIG_PATH} (sourced if readable).
#
# Invoked by /usr/local/bin/areal-deploy via NOPASSWD sudo.
#
set -euo pipefail

# shellcheck disable=SC1091
[ -r ${CONFIG_PATH} ] && . ${CONFIG_PATH}
REPO_ROOT="\${REPO_ROOT:-${REPO_ROOT}}"

cd "\${REPO_ROOT}"
git pull --recurse-submodules
exec "\${REPO_ROOT}/scripts/observability/bootstrap-fornex.sh"
OBS_EOF
  install -o root -g root -m 0755 "$tmp" /usr/local/sbin/areal-deploy-observability
  rm -f "$tmp"
}

install_verb_health() {
  local tmp
  tmp="$(mktemp)"
  cat > "$tmp" <<HEALTH_EOF
#!/usr/bin/env bash
#
# areal-deploy-health — public health probe with retries.
# Exit 0 on HTTP 2xx; non-zero (curl exit code) otherwise.
#
# Runtime config: ${CONFIG_PATH} (sourced if readable).
#
set -euo pipefail

# shellcheck disable=SC1091
[ -r ${CONFIG_PATH} ] && . ${CONFIG_PATH}
URL="\${HEALTH_URL:-${HEALTH_URL}}"

exec curl \\
  --fail \\
  --silent \\
  --show-error \\
  --max-time 10 \\
  --retry 3 \\
  --retry-delay 2 \\
  "\$URL"
HEALTH_EOF
  install -o root -g root -m 0755 "$tmp" /usr/local/sbin/areal-deploy-health
  rm -f "$tmp"
}

log "installing /usr/local/sbin/areal-deploy-app"
install_verb_app
log "installing /usr/local/sbin/areal-deploy-dashboard"
install_verb_dashboard
log "installing /usr/local/sbin/areal-deploy-observability"
install_verb_observability
log "installing /usr/local/sbin/areal-deploy-health"
install_verb_health

# ---------- 5. sudoers /etc/sudoers.d/areal-deployer ----------

SUDOERS_PATH="/etc/sudoers.d/areal-deployer"

install_sudoers() {
  local tmp
  tmp="$(mktemp)"
  cat > "$tmp" <<SUDOERS_EOF
# Managed by scripts/setup-deployer-user.sh — do not edit by hand.
# Allow the deployer user to invoke the deploy verb scripts and read service
# status, all without a password. Nothing else is permitted.
deployer ALL=(root) NOPASSWD: /usr/local/sbin/areal-deploy-observability
deployer ALL=(root) NOPASSWD: /usr/local/sbin/areal-deploy-dashboard
deployer ALL=(root) NOPASSWD: /usr/local/sbin/areal-deploy-app
deployer ALL=(root) NOPASSWD: /usr/bin/systemctl status grafana-server
deployer ALL=(root) NOPASSWD: /usr/bin/systemctl status prometheus
deployer ALL=(root) NOPASSWD: /usr/bin/systemctl status loki
SUDOERS_EOF
  chmod 0440 "$tmp"

  # Validate before activating.
  if ! visudo -c -f "$tmp" >/dev/null; then
    rm -f "$tmp"
    die "sudoers file failed visudo -c validation"
  fi

  # Skip atomic mv if existing file is byte-identical (idempotency).
  if [ -f "$SUDOERS_PATH" ] && cmp -s "$tmp" "$SUDOERS_PATH"; then
    log "sudoers $SUDOERS_PATH already current"
    rm -f "$tmp"
    return 0
  fi

  log "installing $SUDOERS_PATH"
  install -o root -g root -m 0440 "$tmp" "$SUDOERS_PATH"
  rm -f "$tmp"
}

install_sudoers

# ---------- 6. authorized_keys with command="…" lock ----------

SSH_DIR="${DEPLOY_HOME}/.ssh"
AUTH_KEYS="${SSH_DIR}/authorized_keys"

install -d -o "$DEPLOY_USER" -g "$DEPLOY_GROUP" -m 0700 "$SSH_DIR"

# shellcheck disable=SC2016 # ${SSH_ORIGINAL_COMMAND} is literal — sshd expands it.
KEY_OPTIONS='command="/usr/local/bin/areal-deploy ${SSH_ORIGINAL_COMMAND}",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty'
NEW_LINE="${KEY_OPTIONS} ${PUBKEY_CONTENT}"

# Extract the body of the pubkey (type + base64) for fingerprint comparison —
# we look for that substring in authorized_keys regardless of leading options.
PUBKEY_BODY="$(printf '%s' "$PUBKEY_CONTENT" | awk '{print $1" "$2}')"

if [ -f "$AUTH_KEYS" ] && grep -F -q -- "$PUBKEY_BODY" "$AUTH_KEYS"; then
  log "authorized_keys already contains pubkey body — leaving as-is"
else
  log "appending pubkey to $AUTH_KEYS"
  # Ensure file exists with correct ownership/perms before appending.
  if [ ! -f "$AUTH_KEYS" ]; then
    install -o "$DEPLOY_USER" -g "$DEPLOY_GROUP" -m 0600 /dev/null "$AUTH_KEYS"
  fi
  printf '%s\n' "$NEW_LINE" >> "$AUTH_KEYS"
  chown "$DEPLOY_USER:$DEPLOY_GROUP" "$AUTH_KEYS"
  chmod 0600 "$AUTH_KEYS"
fi

# ---------- done ----------

log "deployer user bootstrap complete"
log "verify with: sudo -u $DEPLOY_USER -- /usr/local/bin/areal-deploy health"
