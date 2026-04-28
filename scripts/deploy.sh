#!/usr/bin/env bash
#
# deploy.sh — Layer 10 Mainnet Bootstrap (devnet rehearsal entry point).
#
# 8-phase deployment orchestrator. Each phase delegates to a focused
# script; this file is the canonical sequence + healthcheck. The R20
# mint-pin migration is interleaved between Phase 1 (deploy) and Phase 5
# (Nexus init) so the Nexus binary boots with the real pinned mints.
#
# Phase map:
#   1. Deploy 5 contracts + record program IDs + cross-verify
#  R20. Optional mint-pin migration (post-deploy, pre-state-init)
#   2. Initialize singletons (DEX/RWT/YD config)              [phaseE prefix]
#   3. ARL OT bootstrap (init, Futarchy, YD distributor, mint) [bootstrap-init.ts]
#   4. DEX pools (StandardCurve + concentrated) + initial LP  [bootstrap-init.ts]
#   5. Initialize Nexus                                       [phaseNexus]
#   6. Register bot wallets                                   [bootstrap-init.ts]
#   7. Authority transfers (deployer → Multisig → Futarchy)   [transfer-authority.ts]
#   8. Fund + start 6 bots                                    [TODO Substep 4]
#
# Optional env (forwarded to migrate-mints.sh):
#   RWT_MINT_PUBKEY=<base58>     Real RWT mint pubkey
#   USDC_MINT_PUBKEY=<base58>    Real USDC mint pubkey

set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DATA_DIR="$ROOT_DIR/data"
LOG_FILE="$DATA_DIR/deploy.log"

mkdir -p "$DATA_DIR"

log() {
  local ts
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '[%s] %s\n' "$ts" "$*" | tee -a "$LOG_FILE"
}

# ----------------------------------------------------------------------------
# Phase 1: Deploy 5 contracts + record program IDs + cross-verify.
#   Reuses existing build+deploy stages from e2e-bootstrap.sh; the staged
#   approach here keeps the Layer 10 ceremony idempotent with the localnet
#   rehearsal harness.
# ----------------------------------------------------------------------------
phase_1_deploy() {
  log "=== Phase 1: Deploy programs ==="
  bash "$SCRIPT_DIR/e2e-bootstrap.sh" "$@"
  bash "$SCRIPT_DIR/verify-program-ids.sh"
}

# ----------------------------------------------------------------------------
# Phase 2: Initialize singletons (DEX/RWT/YD config).
#   Already covered by phaseE early stages in bootstrap-init.ts; this entry
#   exists as a named slot for the deployment runbook.
# ----------------------------------------------------------------------------
phase_2_singletons() {
  log "=== Phase 2: Initialize singletons ==="
  log "(covered by phaseE early stages in scripts/lib/bootstrap-init.ts)"
}

# ----------------------------------------------------------------------------
# Phase 3: ARL OT bootstrap.
#   Layer 10 substep 2 — covered by bootstrap-init.ts phases:
#     - phaseFutarchy           (initialize_futarchy for ARL OT)
#     - phaseArlDistributor     (vesting-period verification)
#     - phaseDestinations       (batch_update_destinations 70/20/10)
#     - phaseArlMint            (mint_ot initial supply, BEFORE Phase 7)
# ----------------------------------------------------------------------------
phase_3_arl_bootstrap() {
  log "=== Phase 3: ARL OT bootstrap ==="
  log "(covered by phaseFutarchy / phaseDestinations / phaseArlMint in scripts/lib/bootstrap-init.ts)"
}

# ----------------------------------------------------------------------------
# Phase 4: Create DEX pools + initial LP.
#   Layer 10 substep 2 — covered by bootstrap-init.ts phases:
#     - ensureDeployerPoolCreator (update_pool_creators ADD deployer)
#     - phaseMasterPool           (RWT/USDC concentrated, bin_step=10, SD-4)
#     - phaseArlRwtPool           (ARL_OT/RWT StandardCurve, OT-pair fee)
# ----------------------------------------------------------------------------
phase_4_dex_pools() {
  log "=== Phase 4: DEX pools + initial LP ==="
  log "(covered by phaseMasterPool / phaseArlRwtPool in scripts/lib/bootstrap-init.ts)"
}

# ----------------------------------------------------------------------------
# Phase 5: Initialize Nexus.
#   Layer 10 Substep 1 dropped the phaseNexus precondition skip; the call
#   now fails LOUDLY if the IDL is stale. Already covered by phaseNexus in
#   bootstrap-init.ts (called from phase_1_deploy via e2e-bootstrap.sh).
# ----------------------------------------------------------------------------
phase_5_nexus() {
  log "=== Phase 5: Initialize Nexus ==="
  log "(covered by phaseNexus in scripts/lib/bootstrap-init.ts)"
}

# ----------------------------------------------------------------------------
# Phase 6: Register bot wallets.
#   Layer 10 substep 2 — covered by phaseRegisterBots in bootstrap-init.ts:
#     - RWT::update_vault_manager(rwt-manager.pubkey)
#     - DEX::update_dex_config(rebalancer=pool-rebalancer.pubkey)
#     - YD publish_authority + nexus.manager — verification only (set earlier)
# ----------------------------------------------------------------------------
phase_6_bot_registration() {
  log "=== Phase 6: Register bot wallets ==="
  log "(covered by phaseRegisterBots in scripts/lib/bootstrap-init.ts)"
}

# ----------------------------------------------------------------------------
# Phase 7: Authority transfers (deployer → Multisig → Futarchy → OT).
#   Layer 10 substep 3 — covered by scripts/lib/transfer-authority.ts. Performs
#   the 7-step chain (1+2 OT→Futarchy atomic; 3+4 Futarchy→Multisig 2-TX;
#   5/6/7 RWT/DEX/YD→Multisig). Per-step on-chain assertions + R-A retry +
#   R-B precheck. The script is idempotent; re-running after partial failure
#   is safe and continues from the first un-rotated PDA.
#
#   Env knobs (all optional):
#     MULTISIG_PUBKEY=<base58>   New authority pubkey. On localhost defaults to
#                                 the deployer keypair acting as pseudo-multisig
#                                 (D32). Mainnet runbook MUST set this to the
#                                 real Squads vault pubkey.
#     MAINNET=1                   Enables --two-tx-mode (split propose/accept
#                                 into separate TXs so accept can be signed
#                                 off-line by the multisig signer set).
#     ARTIFACT=<path>             Override the bootstrap artifact path
#                                 (default: data/e2e-bootstrap.json).
# ----------------------------------------------------------------------------
phase_7_authority_transfers() {
  log "=== Phase 7: Authority transfers ==="

  local artifact="${ARTIFACT:-$DATA_DIR/e2e-bootstrap.json}"
  if [[ ! -f "$artifact" ]]; then
    log "ERROR: artifact not found at $artifact — run earlier phases first"
    exit 1
  fi

  local extra_args=()
  if [[ -n "${MULTISIG_PUBKEY:-}" ]]; then
    extra_args+=("--multisig" "$MULTISIG_PUBKEY")
  fi
  if [[ "${MAINNET:-0}" == "1" ]]; then
    extra_args+=("--two-tx-mode")
  fi

  log "running scripts/lib/transfer-authority.ts (artifact=$artifact)"
  (
    cd "$ROOT_DIR"
    NODE_PATH="$ROOT_DIR/bots/node_modules" \
      "$ROOT_DIR/bots/node_modules/.bin/tsx" \
      "$SCRIPT_DIR/lib/transfer-authority.ts" \
      --artifact "$artifact" \
      "${extra_args[@]}" \
      2>&1 | tee -a "$LOG_FILE"
  ) || {
    log "ERROR: transfer-authority.ts failed; halting deploy.sh"
    exit 1
  }
}

# ----------------------------------------------------------------------------
# Phase 8: Fund + start 6 bots.
# ----------------------------------------------------------------------------
phase_8_start_bots() {
  log "=== Phase 8: Fund + start bots ==="
  log "TODO Substep 4: scripts/start-bots.sh orchestrator + healthcheck"
}

# ----------------------------------------------------------------------------
# R20: optional mint-pin migration AFTER Phase 1 (devnet rehearsal step).
#   Triggered when both RWT_MINT_PUBKEY and USDC_MINT_PUBKEY are set; the
#   migrate-mints.sh script rebuilds yield-distribution WITHOUT the
#   dev-placeholder-mints feature so the R20 tripwire fires on bad input.
# ----------------------------------------------------------------------------
phase_r20_migrate() {
  if [[ -n "${RWT_MINT_PUBKEY:-}" && -n "${USDC_MINT_PUBKEY:-}" ]]; then
    log "=== R20: Migrate mints (real pubkeys provided) ==="
    bash "$SCRIPT_DIR/migrate-mints.sh"
    # After migrate-mints.sh the source tree carries the real bytes and
    # the .so artifact has been rebuilt without `dev-placeholder-mints`.
    # The on-chain program from Phase 1 is still the OLD placeholder
    # build, so we MUST redeploy yield-distribution before continuing —
    # otherwise downstream YD ix run against wrong-mint bytes. arlex-cli
    # redeploy wiring is a Substep 1 closure item; until then this phase
    # halts unless the operator opts in via ALLOW_INCOMPLETE_R20=1.
    if [[ "${ALLOW_INCOMPLETE_R20:-0}" == "1" ]]; then
      log "WARN: ALLOW_INCOMPLETE_R20=1 — skipping the redeploy halt; on-chain YD still has placeholder build"
    else
      log "ERROR: arlex-cli redeploy of yield-distribution is not yet wired."
      log "       Source tree + .so artifact are R20-pinned, but on-chain YD is still the placeholder build."
      log "       Run 'arlex-cli deploy contracts/yield-distribution' manually, then re-run with ALLOW_INCOMPLETE_R20=1,"
      log "       or wait for Substep 1 closure to wire this path."
      exit 2
    fi
  else
    log "R20 migration skipped (RWT_MINT_PUBKEY / USDC_MINT_PUBKEY not set; using placeholder build)"
  fi
}

# ----------------------------------------------------------------------------

main() {
  log "Layer 10 deploy.sh starting"
  phase_1_deploy "$@"
  # R20 runs IMMEDIATELY after deploy and BEFORE any state-init phase
  # (per SD-1 follow-up A-12). Rationale: phase_r20_migrate halts with
  # exit=2 unless ALLOW_INCOMPLETE_R20=1, so any state-creating phase
  # ahead of it would land on-chain against the placeholder build and
  # leak orphaned state on halt. Keeping R20 right after deploy means
  # the abort-and-redeploy recovery path is loss-free.
  phase_r20_migrate
  phase_2_singletons
  phase_3_arl_bootstrap
  phase_4_dex_pools
  phase_5_nexus
  phase_6_bot_registration
  phase_7_authority_transfers
  phase_8_start_bots
  log "Layer 10 deploy.sh complete"
}

main "$@"
