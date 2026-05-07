#!/usr/bin/env bash
# Bootstrap the Areal observability stack on the Fornex VPS.
# - Adds 2GB swap if missing
# - Validates and renders templates from bots/observability/ with envsubst
# - Validates rendered config (promtool, amtool, docker compose config)
# - Audits all port bindings are 127.0.0.1 only
# - Brings up Docker compose stack (5 services)
# - Smoke checks all endpoints respond on loopback
# Run as root on the Fornex VPS. Idempotent — re-run safe.

set -euo pipefail

# Defaults.
DRY_RUN=0
ENV_FILE="/etc/areal-obs/.env"
RENDERED_DIR="/etc/areal-obs/rendered"
SOURCE_DIR="/opt/areal/bots/observability"

usage() {
  cat <<'USAGE'
Usage: bootstrap-fornex.sh [OPTIONS]

Render and bring up the Areal observability stack on the Fornex VPS.

Options:
  --dry-run                     Skip docker compose up and runtime probes.
  --env-file <path>             .env path (default: /etc/areal-obs/.env)
  --rendered-dir <path>         Output dir for rendered configs
                                (default: /etc/areal-obs/rendered)
  --source-dir <path>           Template source dir
                                (default: /opt/areal/bots/observability)
  -h, --help                    Show this help and exit.

Run as root unless --dry-run is set.
USAGE
}

# ---------- Argument parsing ----------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --env-file)
      ENV_FILE="$2"
      shift 2
      ;;
    --rendered-dir)
      RENDERED_DIR="$2"
      shift 2
      ;;
    --source-dir)
      SOURCE_DIR="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument: $1" >&2
      usage >&2
      exit 64
      ;;
  esac
done

log() {
  echo "[bootstrap] $*"
}

die() {
  echo "[bootstrap] ERROR: $*" >&2
  exit "${2:-1}"
}

# ---------- Pre-flight checks ----------
log "starting (dry_run=${DRY_RUN}, env_file=${ENV_FILE}, rendered=${RENDERED_DIR}, source=${SOURCE_DIR})"

if [[ ${DRY_RUN} -eq 0 ]]; then
  if [[ ${EUID} -ne 0 ]]; then
    die "must be run as root (or use --dry-run)" 1
  fi
fi

if ! command -v docker >/dev/null 2>&1; then
  die "docker not found in PATH" 1
fi

# Verify docker version >= 24.
docker_version_raw="$(docker version --format '{{.Server.Version}}' 2>/dev/null || true)"
if [[ -z "${docker_version_raw}" ]]; then
  # Fallback to client-side version (for --dry-run on machines without daemon).
  docker_version_raw="$(docker version --format '{{.Client.Version}}' 2>/dev/null || true)"
fi
if [[ -z "${docker_version_raw}" ]]; then
  die "could not determine docker version" 1
fi
docker_major="${docker_version_raw%%.*}"
if [[ ! "${docker_major}" =~ ^[0-9]+$ ]] || [[ "${docker_major}" -lt 24 ]]; then
  die "docker version ${docker_version_raw} is too old; need >= 24" 1
fi

if ! docker compose version >/dev/null 2>&1; then
  die "docker compose plugin not available" 1
fi

if ! command -v envsubst >/dev/null 2>&1; then
  die "envsubst not found (install gettext)" 1
fi

log "preflight ok (docker ${docker_version_raw})"

# ---------- Swap check ----------
swap_total_mb=0
if command -v free >/dev/null 2>&1; then
  swap_total_mb="$(free -m | awk '/^Swap:/ {print $2}')"
  swap_total_mb="${swap_total_mb:-0}"
fi

if [[ "${swap_total_mb}" -lt 1500 ]]; then
  if grep -qE '^/swapfile[[:space:]]' /etc/fstab 2>/dev/null; then
    log "swap already configured in /etc/fstab"
  else
    if [[ ${DRY_RUN} -eq 1 ]]; then
      log "[dry-run] would add 2G swap at /swapfile"
    else
      log "adding 2G swap at /swapfile"
      fallocate -l 2G /swapfile
      chmod 600 /swapfile
      mkswap /swapfile
      swapon /swapfile
      echo '/swapfile none swap sw 0 0' >> /etc/fstab
      log "swap added (2G)"
    fi
  fi
else
  log "swap already configured (${swap_total_mb} MB)"
fi

# ---------- Load .env ----------
if [[ ! -f "${ENV_FILE}" ]]; then
  die "env file not found: ${ENV_FILE}" 2
fi

log "loading env file: ${ENV_FILE}"
set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

# ---------- Validate required vars ----------
REQUIRED_VARS=(
  AREAL_ENV
  AREAL_CLUSTER
  SOLANA_NETWORK
  GF_SECURITY_ADMIN_USER
  GF_SECURITY_ADMIN_PASSWORD
  GF_SERVER_ROOT_URL
  GF_AUTH_ANONYMOUS_ORG_NAME
  PROM_RETENTION_TIME
  PROM_RETENTION_SIZE
  PROM_SCRAPE_INTERVAL
  TELEGRAM_BOT_TOKEN
  TELEGRAM_CHAT_ID_CRITICAL
  TELEGRAM_CHAT_ID_WARNING
  BLACKBOX_TARGET_PANEL
  BLACKBOX_TARGET_APP
  BLACKBOX_TARGET_RPC
)

missing=0
for var in "${REQUIRED_VARS[@]}"; do
  if [[ -z "${!var:-}" ]]; then
    echo "[bootstrap] ERROR: required variable ${var} is empty in ${ENV_FILE}" >&2
    missing=$((missing + 1))
  fi
done
if [[ ${missing} -gt 0 ]]; then
  die "${missing} required variable(s) missing — see above" 2
fi
log "all required env vars present"

# ---------- Validate .env.example is all-empty ----------
example_file="${SOURCE_DIR}/.env.example"
if [[ ! -f "${example_file}" ]]; then
  die ".env.example not found at ${example_file}" 3
fi

example_violations=0
example_lineno=0
while IFS= read -r line || [[ -n "${line}" ]]; do
  example_lineno=$((example_lineno + 1))
  # Skip blank lines and comments.
  if [[ -z "${line}" ]] || [[ "${line}" =~ ^[[:space:]]*# ]]; then
    continue
  fi
  # Allow KEY= (empty value).
  if [[ "${line}" =~ ^[A-Z_][A-Z0-9_]*=$ ]]; then
    continue
  fi
  # Disallow KEY=value (any non-empty RHS).
  if [[ "${line}" =~ ^[A-Z_][A-Z0-9_]*=.+$ ]]; then
    echo "[bootstrap] ERROR: ${example_file}:${example_lineno}: convention violated — value present after '=' (must be empty in .env.example)" >&2
    example_violations=$((example_violations + 1))
  fi
done < "${example_file}"

if [[ ${example_violations} -gt 0 ]]; then
  die ".env.example has ${example_violations} populated value(s); convention requires empty values only" 3
fi
log ".env.example convention: ok"

# ---------- Render templates ----------
log "rendering templates from ${SOURCE_DIR} -> ${RENDERED_DIR}"
mkdir -p "${RENDERED_DIR}"

# Whitelist of vars exposed to envsubst (avoid leaking unrelated env).
# Phase 20 ships Telegram-only routing; SMTP / Slack vars deferred.
ENVSUBST_VARS=""
for var in "${REQUIRED_VARS[@]}"; do
  ENVSUBST_VARS+=" \${${var}}"
done

# Render every *.template.{yml,ini}.
while IFS= read -r src; do
  rel="${src#"${SOURCE_DIR}/"}"
  # Strip ".template" from the filename component only.
  dst_rel="$(printf '%s' "${rel}" | sed -E 's/\.template\.(yml|ini)$/.\1/')"
  dst="${RENDERED_DIR}/${dst_rel}"
  mkdir -p "$(dirname "${dst}")"
  envsubst "${ENVSUBST_VARS}" < "${src}" > "${dst}"
  log "  rendered: ${rel} -> ${dst_rel}"
done < <(
  find "${SOURCE_DIR}" -type f \( -name '*.template.yml' -o -name '*.template.ini' \) | sort
)

# Copy non-template files verbatim.
copy_tree() {
  local src_subdir="$1"
  local pattern="$2"
  local src_dir="${SOURCE_DIR}/${src_subdir}"
  local dst_dir="${RENDERED_DIR}/${src_subdir}"
  if [[ ! -d "${src_dir}" ]]; then
    return 0
  fi
  mkdir -p "${dst_dir}"
  # shellcheck disable=SC2231
  for f in ${src_dir}/${pattern}; do
    [[ -e "${f}" ]] || continue
    cp "${f}" "${dst_dir}/$(basename "${f}")"
    log "  copied: ${src_subdir}/$(basename "${f}")"
  done
}

copy_tree "prometheus/rules" "*.yml"
copy_tree "grafana/provisioning/dashboards" "*.yml"
copy_tree "grafana/dashboards" "*.json"

# ---------- Validate rendered output ----------
log "validating rendered configs"

# NOTE: prom/prometheus and prom/alertmanager images use the main daemon as
# their ENTRYPOINT, so we must override with --entrypoint to invoke the
# bundled promtool / amtool CLIs instead.

if [[ -f "${RENDERED_DIR}/prometheus/prometheus.yml" ]]; then
  docker run --rm --entrypoint /bin/promtool \
    -v "${RENDERED_DIR}/prometheus:/cfg:ro" \
    prom/prometheus:v2.55.1 \
    check config /cfg/prometheus.yml \
    || die "promtool check config failed" 6
fi

if [[ -f "${RENDERED_DIR}/prometheus/rules/infra.yml" ]]; then
  docker run --rm --entrypoint /bin/promtool \
    -v "${RENDERED_DIR}/prometheus:/cfg:ro" \
    prom/prometheus:v2.55.1 \
    check rules /cfg/rules/infra.yml \
    || die "promtool check rules failed" 6
fi

docker compose -f "${RENDERED_DIR}/docker-compose.yml" config -q \
  || die "docker compose config -q failed" 6

if [[ -f "${RENDERED_DIR}/alertmanager/alertmanager.yml" ]]; then
  docker run --rm --entrypoint /bin/amtool \
    -v "${RENDERED_DIR}/alertmanager:/cfg:ro" \
    prom/alertmanager:v0.27.0 \
    check-config /cfg/alertmanager.yml \
    || die "amtool check-config failed" 6
fi

log "rendered config: validated"

# ---------- Bind audit ----------
log "auditing port bindings (must all be 127.0.0.1)"
bind_violations=0
bind_lineno=0
while IFS= read -r line || [[ -n "${line}" ]]; do
  bind_lineno=$((bind_lineno + 1))
  # Match port mapping lines like:  "127.0.0.1:9090:9090"  or  - "9090:9090"
  if [[ "${line}" =~ ^[[:space:]]*-[[:space:]]*\"([^\"]+)\"[[:space:]]*$ ]]; then
    mapping="${BASH_REMATCH[1]}"
    # Heuristic: only treat as a port mapping if it looks like host:container.
    if [[ "${mapping}" =~ ^[0-9.:]+:[0-9]+:[0-9]+$ ]] || [[ "${mapping}" =~ ^[0-9]+:[0-9]+$ ]]; then
      if [[ ! "${mapping}" =~ ^127\.0\.0\.1: ]]; then
        echo "[bootstrap] ERROR: docker-compose.yml:${bind_lineno}: port mapping \"${mapping}\" must bind 127.0.0.1" >&2
        bind_violations=$((bind_violations + 1))
      fi
    fi
  fi
done < "${RENDERED_DIR}/docker-compose.yml"

if [[ ${bind_violations} -gt 0 ]]; then
  die "${bind_violations} non-loopback port binding(s) detected" 4
fi
log "bind audit: all port mappings are 127.0.0.1"

# ---------- Bring up ----------
if [[ ${DRY_RUN} -eq 1 ]]; then
  log "[dry-run] skipping docker compose up"
else
  log "pulling images and bringing up stack"
  ( cd "${RENDERED_DIR}" && docker compose pull && docker compose up -d )
fi

# ---------- Smoke checks ----------
if [[ ${DRY_RUN} -eq 0 ]]; then
  log "running smoke checks"

  # Wait up to 30s for prometheus.
  ready=0
  for _ in $(seq 1 30); do
    if curl -fsS http://127.0.0.1:9090/-/ready >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 1
  done
  if [[ ${ready} -eq 0 ]]; then
    die "prometheus not ready after 30s" 7
  fi
  log "  prometheus ready"

  # Wait up to 30s for alertmanager.
  ready=0
  for _ in $(seq 1 30); do
    if curl -fsS http://127.0.0.1:9093/-/ready >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 1
  done
  if [[ ${ready} -eq 0 ]]; then
    die "alertmanager not ready after 30s" 7
  fi
  log "  alertmanager ready"

  # Wait up to 60s for grafana (cold-start can take 15-30s for migrations
  # on first run / fresh volume).
  ready=0
  for _ in $(seq 1 60); do
    if curl -fsS http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 1
  done
  if [[ ${ready} -eq 0 ]]; then
    die "grafana not healthy after 60s" 7
  fi
  log "  grafana healthy"

  curl -fsS -o /dev/null http://127.0.0.1:9100/metrics \
    || die "node-exporter not responding" 7
  log "  node-exporter responding"

  curl -fsS -o /dev/null "http://127.0.0.1:9115/probe?target=https://www.cloudflare.com&module=http_2xx" \
    || die "blackbox-exporter probe failed" 7
  log "  blackbox-exporter probe ok"

  # End-to-end query: prometheus must report `up==1` for the scrape jobs
  # whose targets are part of THIS docker-compose stack (prometheus,
  # node-exporter, blackbox-http). bots-* / chain-invariants-* may legitimately
  # be UP=0 if the bot processes aren't running yet — those have their own
  # alerts (BotDown) and are not a bootstrap failure. The query filters by
  # job to keep the check narrowly scoped to "in-container scrape
  # connectivity actually works".
  log "  verifying prometheus scrape connectivity (up{job=~prometheus|node|blackbox-http} == 1)"
  e2e_ready=0
  for _ in $(seq 1 30); do
    resp=$(curl -fsSG 'http://127.0.0.1:9090/api/v1/query' \
             --data-urlencode 'query=up{job=~"prometheus|node|blackbox-http"} == 1' \
             2>/dev/null || true)
    # Each of the 3 expected jobs must appear with up==1. blackbox-http
    # has 3 targets (panel/app/rpc), so it can return 0..3 series; we just
    # need its job= label to appear at least once.
    if printf '%s' "${resp}" | grep -q '"job":"prometheus"' \
       && printf '%s' "${resp}" | grep -q '"job":"node"' \
       && printf '%s' "${resp}" | grep -q '"job":"blackbox-http"'; then
      e2e_ready=1
      break
    fi
    sleep 1
  done
  if [[ ${e2e_ready} -eq 0 ]]; then
    die "prometheus scrape connectivity check failed (up != 1 for prometheus or node after 30s)" 7
  fi
  log "  prometheus + node scrape: up == 1"
fi

# ---------- Listen audit ----------
if [[ ${DRY_RUN} -eq 0 ]]; then
  log "auditing host listening sockets"
  if ! command -v ss >/dev/null 2>&1; then
    log "WARN: ss(8) not available; skipping listen audit"
  else
    listen_violations=0
    while IFS= read -r addr; do
      [[ -z "${addr}" ]] && continue
      if [[ "${addr}" != 127.0.0.1:* ]]; then
        echo "[bootstrap] ERROR: socket bound non-loopback: ${addr}" >&2
        listen_violations=$((listen_violations + 1))
      fi
    done < <(
      ss -tlnp 2>/dev/null \
        | grep -E ':(9090|9093|9100|9115|3000)[[:space:]]' \
        | awk '{print $4}'
    )
    if [[ ${listen_violations} -gt 0 ]]; then
      ss -tlnp 2>/dev/null \
        | grep -E ':(9090|9093|9100|9115|3000)[[:space:]]' >&2 || true
      die "${listen_violations} socket(s) bound off-loopback" 5
    fi
    log "listen audit: all observability sockets on 127.0.0.1"
  fi
fi

# ---------- Grafana org rename (idempotent) ----------
# Anonymous viewer uses org_id=1 (default org), but we want the public-facing
# org to display the configured name (e.g. "Areal Public"). Rename the default
# org via API on every bootstrap — idempotent: if name already matches, the
# PUT is a no-op.
if [[ ${DRY_RUN} -eq 0 ]]; then
  log "ensuring Grafana default org is named '${GF_AUTH_ANONYMOUS_ORG_NAME}'"
  for _ in $(seq 1 30); do
    if curl -fsS http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
  org_payload=$(printf '{"name":"%s"}' "${GF_AUTH_ANONYMOUS_ORG_NAME}")
  if curl -fsS -u "${GF_SECURITY_ADMIN_USER}:${GF_SECURITY_ADMIN_PASSWORD}" \
       -X PUT http://127.0.0.1:3000/api/orgs/1 \
       -H "Content-Type: application/json" \
       -d "${org_payload}" >/dev/null; then
    log "  grafana org name set to '${GF_AUTH_ANONYMOUS_ORG_NAME}'"
  else
    log "  WARN: failed to set grafana org name (continuing — anonymous still works via org_id=1)"
  fi
fi

# ---------- Final summary ----------
log "----- DONE -----"
log "rendered files: ${RENDERED_DIR}"
if [[ ${DRY_RUN} -eq 0 ]]; then
  ( cd "${RENDERED_DIR}" && docker compose ps ) || true
fi
log "next: add cloudflared route — hostname=status.areal.finance service=http://127.0.0.1:3000 then 'cloudflared service restart'"

exit 0
