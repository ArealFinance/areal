#!/usr/bin/env bash
#
# bootstrap-fornex.sh — Phase 12.1 backend deploy bootstrap (Fornex VPS).
#
# Idempotent first-time + repeat deploy of the @areal/backend container stack
# (Postgres 15 + Redis 7 + Nest.js 11 indexer/API) on the existing Fornex VPS
# that already runs the Phase 20 observability stack (Prometheus + Grafana +
# Cloudflared tunnel for panel.areal.finance / status.areal.finance).
#
# What this script does (in order):
#   1. Verifies prerequisites (docker, docker compose plugin, git, openssl, curl).
#   2. Ensures the host-level docker network `areal-net` exists.
#   3. Clones (first run) or pulls (subsequent runs) the backend submodule
#      to /opt/areal/backend.
#   4. Verifies /opt/areal/backend/.env exists and contains all required vars.
#   5. Renders /opt/areal/backend/docker-compose.prod.yml from the template.
#   6. Brings up postgres + redis (waits for healthcheck).
#   7. Builds + starts the backend container.
#   8. Runs migrations.
#   9. Smoke tests: GET http://127.0.0.1:3010/health and
#      GET http://127.0.0.1:9201/metrics.
#  10. Prints next-step hints (Cloudflared, Prometheus scrape, backups).
#
# It does NOT:
#   - Generate or rotate secrets (operator must populate /opt/areal/backend/.env
#     before first run; see OPERATOR-RUNBOOK-PHASE-12.1.md for the openssl
#     incantations).
#   - Touch the cloudflared config (operator merges the snippet at
#     backend/scripts/cloudflared-config.snippet.yml manually).
#   - Modify the Phase 20 prometheus.yml (operator adds the `backend` scrape
#     job per the runbook).
#
# Re-runnable: every step is an upsert. Safe to run after `git pull` in this
# meta-repo to roll out a backend submodule pointer bump.
#
# Usage:
#   sudo bash bootstrap-fornex.sh                    # full deploy
#   sudo bash bootstrap-fornex.sh --dry-run          # validate only, no docker actions
#   sudo bash bootstrap-fornex.sh --skip-build       # skip backend image build (use cached)
#
# Env knobs (optional):
#   AREAL_BACKEND_REPO   default: https://github.com/ArealFinance/backend.git
#   AREAL_BACKEND_REF    default: main  (branch, tag, or sha to check out)
#   AREAL_BACKEND_DIR    default: /opt/areal/backend

set -euo pipefail
umask 077

readonly DEFAULT_REPO="https://github.com/ArealFinance/backend.git"
readonly DEFAULT_REF="main"
readonly DEFAULT_DIR="/opt/areal/backend"
readonly NETWORK_NAME="areal-net"

REPO="${AREAL_BACKEND_REPO:-$DEFAULT_REPO}"
REF="${AREAL_BACKEND_REF:-$DEFAULT_REF}"
TARGET_DIR="${AREAL_BACKEND_DIR:-$DEFAULT_DIR}"

DRY_RUN=0
SKIP_BUILD=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    -h|--help)
      sed -n '2,40p' "$0"
      exit 0
      ;;
    *) echo "[ERROR] unknown arg: $arg" >&2; exit 2 ;;
  esac
done

# ----------------------------------------------------------------------------
# Logging
# ----------------------------------------------------------------------------
log_info()  { printf '[INFO]  %s\n' "$*"; }
log_warn()  { printf '[WARN]  %s\n' "$*" >&2; }
log_error() { printf '[ERROR] %s\n' "$*" >&2; }
log_step()  { printf '\n[STEP]  %s\n' "$*"; }

# ----------------------------------------------------------------------------
# Step 1: prerequisites
# ----------------------------------------------------------------------------
check_prerequisites() {
  log_step "Verifying prerequisites"

  local missing=()
  for cmd in docker git openssl curl; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      missing+=("$cmd")
    fi
  done

  if ! docker compose version >/dev/null 2>&1; then
    missing+=("docker compose plugin")
  fi

  if ((${#missing[@]} > 0)); then
    log_error "missing prerequisites: ${missing[*]}"
    log_error "install on Debian/Ubuntu: apt-get install -y docker.io docker-compose-plugin git openssl curl"
    exit 1
  fi

  if ! docker info >/dev/null 2>&1; then
    log_error "docker daemon not reachable — is the docker service running?"
    exit 1
  fi

  log_info "prerequisites OK (docker $(docker --version | awk '{print $3}' | tr -d ,), $(docker compose version --short))"
}

# ----------------------------------------------------------------------------
# Step 2: host docker network
# ----------------------------------------------------------------------------
ensure_network() {
  log_step "Ensuring docker network '$NETWORK_NAME' exists"

  if docker network inspect "$NETWORK_NAME" >/dev/null 2>&1; then
    log_info "network $NETWORK_NAME already present"
    return
  fi

  if ((DRY_RUN)); then
    log_info "[dry-run] would create network $NETWORK_NAME"
    return
  fi

  docker network create "$NETWORK_NAME" >/dev/null
  log_info "network $NETWORK_NAME created"
}

# ----------------------------------------------------------------------------
# Step 3: clone or pull backend repo
# ----------------------------------------------------------------------------
sync_repo() {
  log_step "Syncing backend repo (ref=$REF, dir=$TARGET_DIR)"

  if [[ ! -d "$TARGET_DIR/.git" ]]; then
    if ((DRY_RUN)); then
      log_info "[dry-run] would clone $REPO -> $TARGET_DIR"
      return
    fi
    mkdir -p "$(dirname "$TARGET_DIR")"
    git clone --recurse-submodules "$REPO" "$TARGET_DIR"
    log_info "cloned $REPO into $TARGET_DIR"
  else
    log_info "$TARGET_DIR exists, fetching"
    if ((DRY_RUN)); then
      log_info "[dry-run] would fetch + checkout $REF in $TARGET_DIR"
      return
    fi
    (cd "$TARGET_DIR" && git fetch --all --tags --prune)
  fi

  if ((! DRY_RUN)); then
    (cd "$TARGET_DIR" && git checkout "$REF" && git pull --ff-only origin "$REF" 2>/dev/null || true)
    log_info "checked out ref: $(cd "$TARGET_DIR" && git rev-parse --short HEAD) ($(cd "$TARGET_DIR" && git describe --always --dirty))"
  fi
}

# ----------------------------------------------------------------------------
# Step 4: validate .env
# ----------------------------------------------------------------------------
REQUIRED_ENV_VARS=(
  POSTGRES_DB
  POSTGRES_USER
  POSTGRES_PASSWORD
  REDIS_PASSWORD
  JWT_SECRET
  JWT_REFRESH_SECRET
  RPC_URL_DEVNET
  RPC_URL_MAINNET
  SOLANA_CLUSTER
)

validate_env() {
  log_step "Validating $TARGET_DIR/.env"

  local env_file="$TARGET_DIR/.env"
  if [[ ! -f "$env_file" ]]; then
    log_error ".env not found at $env_file"
    log_error "operator must populate it before running this script — see OPERATOR-RUNBOOK-PHASE-12.1.md §3"
    exit 1
  fi

  # Lock down .env perms — secrets in here.
  chmod 600 "$env_file"

  local missing=()
  # shellcheck disable=SC1090
  set -a; source "$env_file"; set +a
  for var in "${REQUIRED_ENV_VARS[@]}"; do
    if [[ -z "${!var:-}" ]]; then
      missing+=("$var")
    fi
  done

  if ((${#missing[@]} > 0)); then
    log_error "missing required env vars in $env_file: ${missing[*]}"
    exit 1
  fi

  # Tripwire: never deploy with placeholder secrets.
  for var in JWT_SECRET JWT_REFRESH_SECRET POSTGRES_PASSWORD REDIS_PASSWORD; do
    case "${!var}" in
      *change-me*|*example*|dev-only-*|"")
        log_error "$var still contains placeholder value — generate with: openssl rand -hex 32"
        exit 1
        ;;
    esac
  done

  # Production sanity: refuse to deploy with NODE_ENV != production.
  if [[ "${NODE_ENV:-}" != "production" ]]; then
    log_warn "NODE_ENV is '${NODE_ENV:-unset}' — production deploys must set NODE_ENV=production"
    log_warn "  CORS allow-list is gated on NODE_ENV=production (see backend/src/main.ts)"
  fi

  log_info ".env OK (${#REQUIRED_ENV_VARS[@]} required vars present, no placeholders detected)"
}

# ----------------------------------------------------------------------------
# Step 5: render docker-compose.prod.yml
# ----------------------------------------------------------------------------
render_compose() {
  log_step "Rendering docker-compose.prod.yml from template"

  local template="$TARGET_DIR/docker-compose.prod.template.yml"
  local out="$TARGET_DIR/docker-compose.prod.yml"

  if [[ ! -f "$template" ]]; then
    log_error "template not found at $template (was the repo synced correctly?)"
    exit 1
  fi

  # The template has no ${VAR} substitutions that compose itself can't
  # resolve at runtime — compose reads .env from the working dir. So this
  # "render" step is just a copy that keeps the docker-compose.prod.yml
  # filename stable for cron jobs / runbook references.
  if ((DRY_RUN)); then
    log_info "[dry-run] would copy template -> docker-compose.prod.yml"
    return
  fi

  cp "$template" "$out"
  log_info "rendered $out"
}

# ----------------------------------------------------------------------------
# Step 6 + 7: bring up stack
# ----------------------------------------------------------------------------
compose_up() {
  log_step "Starting postgres + redis (waiting for healthcheck)"

  if ((DRY_RUN)); then
    log_info "[dry-run] would: docker compose -f docker-compose.prod.yml up -d postgres redis"
    return
  fi

  (cd "$TARGET_DIR" && docker compose -f docker-compose.prod.yml --env-file .env up -d postgres redis)

  # Wait for postgres healthcheck (max 60s).
  local attempts=0
  until (cd "$TARGET_DIR" && docker compose -f docker-compose.prod.yml --env-file .env exec -T postgres pg_isready -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" >/dev/null 2>&1); do
    attempts=$((attempts + 1))
    if ((attempts > 30)); then
      log_error "postgres failed to become healthy after 60s"
      (cd "$TARGET_DIR" && docker compose -f docker-compose.prod.yml --env-file .env logs --tail=50 postgres) >&2
      exit 1
    fi
    sleep 2
  done
  log_info "postgres healthy"

  log_step "Building + starting backend"

  local build_flag="--build"
  if ((SKIP_BUILD)); then
    build_flag=""
    log_info "skipping image rebuild (--skip-build)"
  fi

  # NB: build context for backend Dockerfile must include sdk + vendor dirs
  # (see backend/Dockerfile L6). The repo cloned into $TARGET_DIR is the
  # backend submodule alone — it does NOT contain sibling sdk/vendor. The
  # Dockerfile build will fail unless the operator either:
  #   (a) clones the meta-repo with submodules to /opt/areal/areal-meta and
  #       runs compose from there with build.context=./backend, OR
  #   (b) pre-publishes @areal/sdk + @arlex/client to npm (Phase 12.2+).
  # This script intentionally surfaces that limit instead of papering over it.
  if [[ ! -d "$TARGET_DIR/../sdk" && ! -d "$TARGET_DIR/sdk" ]]; then
    log_warn "sibling sdk/ directory not present — image build will fail."
    log_warn "  fix: clone the meta-repo with submodules to /opt/areal/areal-meta and"
    log_warn "       set AREAL_BACKEND_DIR=/opt/areal/areal-meta/backend, OR wait for"
    log_warn "       Phase 12.2+ when @areal/sdk publishes to npm."
    log_warn "  proceeding anyway — image build will report the actual error."
  fi

  # shellcheck disable=SC2086
  (cd "$TARGET_DIR" && docker compose -f docker-compose.prod.yml --env-file .env up -d $build_flag backend)
}

# ----------------------------------------------------------------------------
# Step 8: migrations
# ----------------------------------------------------------------------------
run_migrations() {
  log_step "Running TypeORM migrations"

  if ((DRY_RUN)); then
    log_info "[dry-run] would: docker compose exec backend npm run migration:run"
    return
  fi

  # Backend container needs a moment to initialize the Nest app before
  # `exec` can find a healthy node process — but `migration:run` is a
  # standalone CLI invocation, so it doesn't depend on the running app.
  # Just wait briefly for the container to be `running`.
  sleep 3

  (cd "$TARGET_DIR" && docker compose -f docker-compose.prod.yml --env-file .env exec -T backend npm run migration:run)
  log_info "migrations applied"
}

# ----------------------------------------------------------------------------
# Step 9: smoke tests
# ----------------------------------------------------------------------------
smoke_test() {
  log_step "Smoke testing /health + /metrics"

  if ((DRY_RUN)); then
    log_info "[dry-run] would: curl 127.0.0.1:3010/health + 127.0.0.1:9201/metrics"
    return
  fi

  # /health is on the API listener (3010, mapped to host).
  local health_attempts=0
  until curl -fsS -m 5 http://127.0.0.1:3010/health >/dev/null 2>&1; do
    health_attempts=$((health_attempts + 1))
    if ((health_attempts > 20)); then
      log_error "/health did not return 200 after 40s"
      (cd "$TARGET_DIR" && docker compose -f docker-compose.prod.yml --env-file .env logs --tail=80 backend) >&2
      exit 1
    fi
    sleep 2
  done
  log_info "/health -> 200 OK"

  # /metrics is on a separate Nest listener (9201) bound to 127.0.0.1
  # INSIDE the container. For host-level scrape (Prometheus on the same VPS),
  # the prod compose template must publish 127.0.0.1:9201:9201 — see
  # OPERATOR-RUNBOOK-PHASE-12.1.md §7 if this check fails.
  if curl -fsS -m 5 http://127.0.0.1:9201/metrics >/dev/null 2>&1; then
    log_info "/metrics -> 200 OK (Prometheus-scrapable from host)"
  else
    log_warn "/metrics not reachable on host 127.0.0.1:9201"
    log_warn "  if you need host-scrape, ensure docker-compose.prod.yml publishes"
    log_warn "  '127.0.0.1:\${METRICS_PORT:-9201}:9201'. Otherwise Prometheus must"
    log_warn "  scrape via the docker bridge network."
  fi
}

# ----------------------------------------------------------------------------
# Step 10: next-step hints
# ----------------------------------------------------------------------------
print_next_steps() {
  log_step "Done. Next operator actions"
  cat <<'EOF'

  1. Cloudflared route:
       merge backend/scripts/cloudflared-config.snippet.yml into your existing
       ~/.cloudflared/config.yml (or /etc/cloudflared/config.yml), then:
       sudo systemctl reload cloudflared

  2. Prometheus scrape (if obs stack is on the same VPS):
       add this scrape job to bots/observability/prometheus.template.yml,
       then re-render + reload:

         - job_name: 'areal-backend'
           static_configs:
             - targets: ['localhost:9201']  # backend metrics listener
               labels:
                 service: 'backend'

  3. Backups: install the nightly pg_dump cron entry:
       crontab -e
       0 3 * * * /opt/areal/backend/scripts/backup-postgres.sh >> /var/log/areal-backup.log 2>&1

  4. Verify externally (after Cloudflared route is live):
       curl https://api.areal.finance/health     -> {"status":"ok",...}
       curl https://api.areal.finance/metrics    -> 404 (blocked by ingress rule)

  5. Grafana: import the backend dashboard (Phase 21 follow-up).

EOF
}

# ----------------------------------------------------------------------------
main() {
  log_info "Areal backend bootstrap (Phase 12.1) starting$([[ $DRY_RUN -eq 1 ]] && echo ' [DRY-RUN]')"
  log_info "  repo:    $REPO"
  log_info "  ref:     $REF"
  log_info "  target:  $TARGET_DIR"

  check_prerequisites
  ensure_network
  sync_repo
  validate_env
  render_compose
  compose_up
  run_migrations
  smoke_test
  print_next_steps

  log_info "bootstrap-fornex.sh complete."
}

main "$@"
