#!/usr/bin/env bash
#
# verify-fresh-deploy.sh — Layer 10 Substep 10 reproducibility runner.
#
# Drives a clean-slate localnet validator → deploy → E2E → audit cycle so
# operators can confirm the entire Layer 10 pipeline is deterministic.
#
# Steps:
#   1. Kill any running solana-test-validator + clear state.
#   2. Wipe data/test-ledger (unless --keep-ledger).
#   3. Start a fresh validator in background; wait for RPC ready.
#   4. Run scripts/deploy.sh (Phases 1-8 — full chain).
#   5. Run scripts/lib/e2e-runner.ts --scenario all (Master E2E).
#   6. Run scripts/verify-deployment.sh (cross-contract audit).
#
# Exit code carries from the first failing step. Tee-logs to
# data/layer-10-fresh-deploy.log.
#
# Args:
#   --keep-ledger   skip step 2 (wipe). Useful for quick re-runs that don't
#                   need fresh genesis. Default: full wipe.

set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DATA_DIR="$ROOT_DIR/data"
LEDGER_DIR="$DATA_DIR/test-ledger"
LOG_FILE="$DATA_DIR/layer-10-fresh-deploy.log"

mkdir -p "$DATA_DIR"

KEEP_LEDGER=0
for arg in "$@"; do
  case "$arg" in
    --keep-ledger) KEEP_LEDGER=1 ;;
    -h|--help)
      sed -n '2,20p' "$0"
      exit 0
      ;;
    *)
      echo "[verify-fresh-deploy] unknown arg: $arg" >&2
      exit 64
      ;;
  esac
done

# Tee everything to LOG_FILE while still printing to stdout.
exec > >(tee -a "$LOG_FILE") 2>&1

log() {
  printf '[%s][fresh-deploy] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

cleanup_validator() {
  log "step 1: killing any running solana-test-validator"
  pkill -f solana-test-validator || true
  sleep 2
}

wipe_ledger() {
  if (( KEEP_LEDGER )); then
    log "step 2: --keep-ledger set; skipping wipe"
    return
  fi
  log "step 2: wiping $LEDGER_DIR"
  rm -rf "$LEDGER_DIR"
}

start_validator() {
  log "step 3: starting solana-test-validator"
  solana-test-validator \
    --quiet \
    --reset \
    --ledger "$LEDGER_DIR" \
    >>"$DATA_DIR/test-validator.log" 2>&1 &
  VALIDATOR_PID=$!
  log "  validator pid=$VALIDATOR_PID"

  # Wait for RPC ready — solana cluster-version probes the localhost endpoint.
  local tries=60
  while (( tries > 0 )); do
    if solana cluster-version --url http://127.0.0.1:8899 >/dev/null 2>&1; then
      log "  validator ready"
      # SEC-78: install zombie cleanup trap once the validator is confirmed
      # alive, so any subsequent failure (run_deploy / run_e2e / run_audit
      # under set -e) tears down the host-bound validator on EXIT/INT/TERM.
      trap 'kill -9 "${VALIDATOR_PID:-}" 2>/dev/null || true; pkill -f solana-test-validator 2>/dev/null || true' EXIT INT TERM
      return 0
    fi
    sleep 1
    tries=$((tries - 1))
  done
  log "ERROR: validator failed to come up within 60s"
  kill -9 "$VALIDATOR_PID" 2>/dev/null || true
  exit 1
}

run_deploy() {
  log "step 4: running scripts/deploy.sh"
  # By definition, fresh-deploy operates on the local test-validator we just
  # spun up — set BOOTSTRAP_TARGET=localhost so e2e-bootstrap.sh's safety gate
  # (which refuses devnet/mainnet) lets the deploy proceed.
  BOOTSTRAP_TARGET=localhost bash "$SCRIPT_DIR/deploy.sh"
}

run_e2e() {
  log "step 5: running scripts/lib/e2e-runner.ts --scenario all"
  local tsx_bin="$ROOT_DIR/bots/node_modules/.bin/tsx"
  if [[ ! -x "$tsx_bin" ]]; then
    tsx_bin="tsx"
  fi
  (cd "$ROOT_DIR" && "$tsx_bin" "$SCRIPT_DIR/lib/e2e-runner.ts" --scenario all)
}

run_audit() {
  log "step 6: running scripts/verify-deployment.sh"
  bash "$SCRIPT_DIR/verify-deployment.sh"
}

main() {
  log "Layer 10 fresh-deploy starting (keep-ledger=$KEEP_LEDGER)"
  cleanup_validator
  wipe_ledger
  start_validator
  run_deploy
  run_e2e
  run_audit
  log "Layer 10 fresh-deploy complete — all 6 steps green"
}

main
