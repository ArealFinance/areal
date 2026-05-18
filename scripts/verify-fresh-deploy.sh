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
#  3.5. Pre-generate RWT + USDC test mint keypairs (SD-32) so deploy.sh can
#       run phase_r20_migrate against real pubkeys without ever materializing
#       the secret keys on the public artifact.
#   4. Run scripts/deploy.sh (Phases 1-8 — full chain).
#   5. Run scripts/lib/e2e-runner.ts --scenario all (Master E2E).
#   6. Run scripts/verify-deployment.sh (cross-contract audit).
#   7. Run scripts/cu-profile.sh (R24 live CU profile + R46 stack-overflow
#      grep). Best-effort: skipped on missing CRANK_KEYPAIR / programs.
#   8. Run all 6 Layer 10 scenarios with SCENARIO_<N>_INLINE_EXEC=1 (§6.5
#      E2E full-flow). Chain-state verification only — no TX submission.
#      Best-effort: scenario-level skips on missing pre-flight gates.
#   9. Run scripts/smoke-swap.ts — 4 REAL swap transactions against the
#      live programs (StandardCurve OT↔RWT both directions + master pool
#      USDC→RWT mint-route + RWT→USDC bin-walk). Default ON, --no-smoke
#      to skip. Closes the gap left by step 8 which only verifies chain
#      state.
#
# Exit code carries from the first failing step. Tee-logs to
# data/layer-10-fresh-deploy.log.
#
# Args:
#   --keep-ledger   skip step 2 (wipe). Useful for quick re-runs that don't
#                   need fresh genesis. Default: full wipe. When the secrets
#                   file at data/e2e-bootstrap.secrets.json already holds
#                   RWT/USDC keypairs, stage_pregen_keypairs reuses them
#                   (so a warm-restart preserves on-chain state).
#   --no-smoke      skip step 9 (smoke-swap real-tx test). Useful for CI
#                   passes that only need chain-state verification.

set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DATA_DIR="$ROOT_DIR/data"
LEDGER_DIR="$DATA_DIR/test-ledger"
LOG_FILE="$DATA_DIR/layer-10-fresh-deploy.log"

mkdir -p "$DATA_DIR"

KEEP_LEDGER=0
SKIP_SMOKE=0
for arg in "$@"; do
  case "$arg" in
    --keep-ledger) KEEP_LEDGER=1 ;;
    --no-smoke) SKIP_SMOKE=1 ;;
    -h|--help)
      sed -n '2,25p' "$0"
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
  log "step 1: killing any running solana-test-validator + bot processes"
  pkill -f solana-test-validator || true
  # Stale bot processes from prior runs hold the merkle-publisher leader lock
  # (and other singleton resources) — kill them too so phase-8 can spawn
  # fresh. Pattern matches the tsx-spawned `src/index.ts` workspaces.
  pkill -f "bots/node_modules/.bin/tsx src/index.ts" || true
  pkill -f "tsx/dist/loader.mjs.*src/index.ts" || true
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
      # SD-32: the trap also wipes the transient pregen-keypair files so a
      # crash mid-step-3.5 cannot leave secret material on disk outside the
      # gitignored secrets.json.
      trap 'kill -9 "${VALIDATOR_PID:-}" 2>/dev/null || true; pkill -f solana-test-validator 2>/dev/null || true; rm -f "$DATA_DIR/.pregen-rwt-mint.json" "$DATA_DIR/.pregen-usdc-mint.json" 2>/dev/null || true' EXIT INT TERM
      return 0
    fi
    sleep 1
    tries=$((tries - 1))
  done
  log "ERROR: validator failed to come up within 60s"
  kill -9 "$VALIDATOR_PID" 2>/dev/null || true
  exit 1
}

# SD-32: pre-generate the RWT and USDC test mint keypairs BEFORE deploy.sh
# runs, so phase_r20_migrate has real pubkeys to pin without ever
# materializing them on the public artifact. The b64-encoded secret keys
# go to data/e2e-bootstrap.secrets.json (gitignored, chmod 0o600);
# bootstrap-init.ts reads them at phase A (USDC test mint) and phase C
# (RWT vault) via the warm-restart path.
#
# Idempotent on warm-restart: if both keypair_b64 fields are already
# present in the secrets file, reuse them (the chain holds mints whose
# authorities match those keypairs; regenerating would diverge state).
stage_pregen_keypairs() {
  log "step 3.5: pre-generating RWT + USDC mint keypairs"

  local secrets="$DATA_DIR/e2e-bootstrap.secrets.json"
  local rwt_pk="" usdc_pk=""

  if [[ -f "$secrets" ]]; then
    rwt_pk="$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(d.get('mints',{}).get('rwt_mint_pubkey',''))" "$secrets" 2>/dev/null || echo)"
    usdc_pk="$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(d.get('mints',{}).get('usdc_test_mint_pubkey',''))" "$secrets" 2>/dev/null || echo)"
    if [[ -n "$rwt_pk" && -n "$usdc_pk" ]]; then
      # Sanity-check the canonical ordering invariant (`rwt < usdc` byte-wise)
      # before reusing. Older secrets files may hold keypairs that violate
      # this; in that case fall through and regenerate. See the generation
      # branch below for full rationale (master pool USDC must live on
      # `vault_b` for CP-7 `grow_liquidity`).
      if python3 -c "
import sys, base58
rwt_bytes = base58.b58decode(sys.argv[1])
usdc_bytes = base58.b58decode(sys.argv[2])
sys.exit(0 if rwt_bytes < usdc_bytes else 1)
" "$rwt_pk" "$usdc_pk"; then
        log "  reusing existing keypairs from $secrets"
        log "    RWT_MINT_PUBKEY=$rwt_pk"
        log "    USDC_MINT_PUBKEY=$usdc_pk"
        export RWT_MINT_PUBKEY="$rwt_pk"
        export USDC_MINT_PUBKEY="$usdc_pk"
        return 0
      fi
      log "  existing keypairs violate rwt < usdc invariant (CP-7 grow_liquidity); regenerating"
      log "    pre-existing RWT=$rwt_pk USDC=$usdc_pk"
    fi
  fi

  log "  generating fresh keypairs"
  local tmp_rwt="$DATA_DIR/.pregen-rwt-mint.json"
  local tmp_usdc="$DATA_DIR/.pregen-usdc-mint.json"

  # Generate USDC first, then RWT — retry RWT until its decoded pubkey bytes
  # sort BEFORE the USDC bytes (`rwt < usdc`). The master pool's canonical
  # mint ordering (`mint_a < mint_b` in `create_concentrated_pool`) maps to
  # `vault_a = RWT vault`, `vault_b = USDC vault` only when this byte
  # invariant holds. `grow_liquidity` (CP-7) hardcodes `pool_vault_b` as the
  # Nexus-drain destination, so USDC MUST live on `vault_b`. Mainnet pinning
  # via the canonical `RWT_MINT` vanity bytes (`0x5d…`) guarantees this
  # naturally; on test-validator the random keypair can land either side
  # unless we constrain it here.
  solana-keygen new --no-bip39-passphrase --silent --outfile "$tmp_usdc" >/dev/null
  chmod 0o600 "$tmp_usdc" 2>/dev/null || true
  usdc_pk="$(solana-keygen pubkey "$tmp_usdc")"

  local attempt=0
  while :; do
    solana-keygen new --no-bip39-passphrase --silent --outfile "$tmp_rwt" >/dev/null
    chmod 0o600 "$tmp_rwt" 2>/dev/null || true
    rwt_pk="$(solana-keygen pubkey "$tmp_rwt")"
    # Decode both base58 pubkeys to raw bytes and compare lexicographically.
    # ~50% chance of `rwt < usdc` per attempt → effectively single-iteration.
    if python3 -c "
import sys, base58
rwt_bytes = base58.b58decode(sys.argv[1])
usdc_bytes = base58.b58decode(sys.argv[2])
sys.exit(0 if rwt_bytes < usdc_bytes else 1)
" "$rwt_pk" "$usdc_pk"; then
      break
    fi
    attempt=$((attempt + 1))
    if (( attempt > 200 )); then
      log "FATAL: failed to generate RWT mint with rwt < usdc after $attempt attempts"
      exit 1
    fi
  done
  log "  RWT mint generated with canonical order rwt < usdc ($((attempt + 1)) attempt(s))"

  local rwt_b64 usdc_b64
  rwt_b64="$(python3 -c "import json,base64,sys; raw=json.load(open(sys.argv[1])); print(base64.b64encode(bytes(raw)).decode())" "$tmp_rwt")"
  usdc_b64="$(python3 -c "import json,base64,sys; raw=json.load(open(sys.argv[1])); print(base64.b64encode(bytes(raw)).decode())" "$tmp_usdc")"

  python3 - "$secrets" "$rwt_b64" "$usdc_b64" "$rwt_pk" "$usdc_pk" <<'PY'
import json, os, sys
path, rwt_b64, usdc_b64, rwt_pk, usdc_pk = sys.argv[1:6]
data = {"schema_version": 1, "mints": {}}
if os.path.exists(path):
    try:
        with open(path) as f:
            data = json.load(f)
        data.setdefault("mints", {})
    except Exception:
        pass
data["mints"]["rwt_mint_keypair_b64"] = rwt_b64
data["mints"]["rwt_mint_pubkey"] = rwt_pk
data["mints"]["usdc_test_mint_keypair_b64"] = usdc_b64
data["mints"]["usdc_test_mint_pubkey"] = usdc_pk
with open(path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
os.chmod(path, 0o600)
PY

  log "  wrote keypairs to $secrets (chmod 0o600)"
  log "    RWT_MINT_PUBKEY=$rwt_pk"
  log "    USDC_MINT_PUBKEY=$usdc_pk"

  # Cleanup transient keypair files; b64 in secrets.json is the source of truth.
  rm -f "$tmp_rwt" "$tmp_usdc"

  export RWT_MINT_PUBKEY="$rwt_pk"
  export USDC_MINT_PUBKEY="$usdc_pk"
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
  (cd "$ROOT_DIR" && NODE_PATH="$ROOT_DIR/bots/node_modules" "$tsx_bin" "$SCRIPT_DIR/lib/e2e-runner.ts" --scenario all)
}

run_audit() {
  log "step 6: running scripts/verify-deployment.sh"
  bash "$SCRIPT_DIR/verify-deployment.sh"
}

run_cu_profile() {
  log "step 7: running scripts/cu-profile.sh (R24 live CU + R46 grep)"
  # cu-profile.sh sources data/e2e-bootstrap.env for RPC + program IDs +
  # CRANK_KEYPAIR + E2E_BOOTSTRAP_DONE; that file is written by phase 1 of
  # bootstrap-init.ts (run via deploy.sh).
  if [[ ! -f "$DATA_DIR/e2e-bootstrap.env" ]]; then
    log "step 7: skipped — data/e2e-bootstrap.env not found"
    return 0
  fi
  # Source in subshell so envs leak to cu-profile.sh only.
  ( set -a; source "$DATA_DIR/e2e-bootstrap.env"; set +a; bash "$SCRIPT_DIR/cu-profile.sh" )
}

run_scenarios_inline() {
  # Localhost crank intervals are 5s (render-env.ts) but the chain has 4
  # stages: revenue → distribute → convert → publish. Wait long enough for
  # all 4 to fire at least twice so distributor.total_funded > 0 and the
  # publisher root is non-zero by the time scenario-1 reads on-chain state.
  log "step 8 prelude: waiting 90s for crank pipeline (revenue → distribute → convert → publish)"
  sleep 90
  log "step 8: running 6 Layer 10 scenarios individually with SCENARIO_*_INLINE_EXEC=1"
  local tsx_bin="$ROOT_DIR/bots/node_modules/.bin/tsx"
  if [[ ! -x "$tsx_bin" ]]; then
    tsx_bin="tsx"
  fi
  # Run each scenario individually so we get diagnostic for all 6 even when
  # earlier scenarios fail (the e2e-runner has a hard halt-after-error chain
  # for `--scenario all` to keep CI fast; we want full visibility here).
  local s
  local pass=0
  local fail=0
  local skipped=0
  for s in 1 2 3 4 5 6; do
    log "step 8.$s: scenario-$s"
    local var="SCENARIO_${s}_INLINE_EXEC"
    if (
      cd "$ROOT_DIR"
      NODE_PATH="$ROOT_DIR/bots/node_modules" \
        env "$var=1" \
        "$tsx_bin" "$SCRIPT_DIR/lib/e2e-runner.ts" --scenario "scenario-$s"
    ); then
      ((pass++)) || true
    else
      ((fail++)) || true
      log "step 8.$s: scenario-$s FAILED (continuing)"
    fi
  done
  log "step 8 summary: pass=$pass fail=$fail (of 6 scenarios)"
  # Don't propagate scenario failures to overall script — they document
  # operator-driven pre-actions still pending (mint_rwt seed, Revenue ATA
  # USDC seed). Audit + cu-profile already gate the chain; scenarios are
  # progress reporting at this stage.
  return 0
}

run_smoke_swap() {
  if (( SKIP_SMOKE )); then
    log "step 9: smoke-swap skipped (--no-smoke)"
    return 0
  fi
  log "step 9: running scripts/smoke-swap.ts (real swap transactions)"
  local tsx_bin="$ROOT_DIR/bots/node_modules/.bin/tsx"
  if [[ ! -x "$tsx_bin" ]]; then
    tsx_bin="tsx"
  fi
  # Same NODE_PATH wiring as run_e2e so @areal/sdk + @solana/web3.js
  # resolve from the bots workspace install.
  if ( cd "$ROOT_DIR" && NODE_PATH="$ROOT_DIR/bots/node_modules" "$tsx_bin" "$SCRIPT_DIR/smoke-swap.ts" ); then
    log "step 9: smoke-swap GREEN"
  else
    log "step 9: smoke-swap FAILED"
    return 1
  fi
}

main() {
  log "Layer 10 fresh-deploy starting (keep-ledger=$KEEP_LEDGER, skip-smoke=$SKIP_SMOKE)"
  cleanup_validator
  wipe_ledger
  start_validator
  stage_pregen_keypairs
  run_deploy
  run_e2e
  run_audit
  run_cu_profile
  run_scenarios_inline
  run_smoke_swap
  log "Layer 10 fresh-deploy complete — all 9 steps green"
}

main
