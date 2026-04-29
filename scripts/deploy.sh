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
#  R20. Optional 3-contract mint-pin migration + redeploy (post-deploy, pre-state-init)
#       (yield-distribution full RWT+USDC; native-dex + ownership-token RWT-only)
#   2. Initialize singletons (DEX/RWT/YD config)              [phaseE prefix]
#   3. ARL OT bootstrap (init, Futarchy, YD distributor, mint) [bootstrap-init.ts]
#   4. DEX pools (StandardCurve + concentrated) + initial LP  [bootstrap-init.ts]
#   5. Initialize Nexus                                       [phaseNexus]
#   6. Register bot wallets                                   [bootstrap-init.ts]
#   7. Authority transfers (deployer → Multisig → Futarchy)   [transfer-authority.ts]
#   8. Fund + start 6 bots                                    [TODO Substep 4]
#
# When both RWT_MINT_PUBKEY and USDC_MINT_PUBKEY env vars are set, deploy.sh
# runs the R20 migration AFTER Phase 1 and BEFORE Phase 2: rewrites the 3
# contract source files (YD full; DEX + OT RWT-only), rebuilds the 3 .so
# artifacts, and upgrades the on-chain programs at their existing IDs via
# the BPF Loader v3 upgrade primitive. Subsequent state-init phases run
# against the R20-pinned binaries.
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
#   Layer 10 substep 4 — covered by scripts/lib/start-bots.ts. Stage 1
#   tops up each bot wallet to FUNDING_LAMPORTS (default 0.1 SOL); Stage 2
#   spawns the 6 bots in D33 order (pool-rebalancer + merkle-publisher,
#   block on first merkle root publish, then revenue-crank +
#   convert-and-fund-crank + yield-claim-crank + nexus-manager); Stage 3
#   verifies every spawned child is still alive after a short dwell. The
#   orchestrator is idempotent — re-running after a partial failure does
#   not double-fund or spawn duplicates.
#
#   Env knobs (all optional):
#     FUNDING_LAMPORTS              Per-bot funding floor (lamports).
#                                    Default 100_000_000 = 0.1 SOL.
#                                    Capped to < 1 SOL to prevent fat-finger
#                                    drains of the deployer wallet.
#     FIRST_ROOT_TIMEOUT_MS         Time budget for the merkle-publisher
#                                    first-root wait (R-C). Default 600_000
#                                    = 10 min per Layer 10 plan.
#     POLL_INTERVAL_MS              Cadence for the on-chain liveness probe.
#                                    Default 5_000.
#     ARTIFACT=<path>               Override the bootstrap artifact path
#                                    (default: data/e2e-bootstrap.json).
# ----------------------------------------------------------------------------
phase_8_start_bots() {
  log "=== Phase 8: Fund + start bots ==="

  local artifact="${ARTIFACT:-$DATA_DIR/e2e-bootstrap.json}"
  if [[ ! -f "$artifact" ]]; then
    log "ERROR: artifact not found at $artifact — run earlier phases first"
    exit 1
  fi

  local extra_args=()
  if [[ -n "${FUNDING_LAMPORTS:-}" ]]; then
    extra_args+=("--funding-lamports" "$FUNDING_LAMPORTS")
  fi
  if [[ -n "${FIRST_ROOT_TIMEOUT_MS:-}" ]]; then
    extra_args+=("--first-root-timeout-ms" "$FIRST_ROOT_TIMEOUT_MS")
  fi
  if [[ -n "${POLL_INTERVAL_MS:-}" ]]; then
    extra_args+=("--poll-interval-ms" "$POLL_INTERVAL_MS")
  fi

  log "running scripts/lib/start-bots.ts (artifact=$artifact)"
  (
    cd "$ROOT_DIR"
    NODE_PATH="$ROOT_DIR/bots/node_modules" \
      "$ROOT_DIR/bots/node_modules/.bin/tsx" \
      "$SCRIPT_DIR/lib/start-bots.ts" \
      --artifact "$artifact" \
      "${extra_args[@]}" \
      2>&1 | tee -a "$LOG_FILE"
  ) || {
    log "ERROR: start-bots.ts failed; halting deploy.sh"
    exit 1
  }
}

# ----------------------------------------------------------------------------
# Re-deploy the 3 R20-pinned contracts to the running validator. After
# migrate-mints.sh rewrites the source bytes and rebuilds the .so files,
# the on-chain programs from Phase 1 still hold the placeholder build —
# every YD/DEX/OT instruction would run against the wrong-mint bytes. This
# function pushes the freshly built .so files to the existing program IDs.
#
# `solana program deploy --program-id <existing>` performs an upgrade in
# place because the test-validator uses BPF Loader v3 (upgradeable). The
# deployer keypair is still the upgrade authority — it was the deployer on
# Phase 1, and Phase 7 (authority transfers) hasn't run yet at this point
# in the deploy sequence (R20 is between Phase 1 and Phase 2 per main()).
#
# CRITICAL: this function MUST run before phase_7_authority_transfers.
# After Phase 7 the deployer no longer holds upgrade authority and
# `solana program deploy --program-id` will fail with a signature error.
# ----------------------------------------------------------------------------
redeploy_r20_contracts() {
  local rpc="${SOLANA_URL:-http://127.0.0.1:8899}"
  local deployer="$ROOT_DIR/deploy-keypair.json"
  local vanity_dir="$ROOT_DIR/keys/vanity"

  declare -A R20_REDEPLOY=(
    [yield_distribution]="YLD9EBikcTmVCnVzdx6vuNajrDkp8tyCAgZrqTwmMXF"
    [native_dex]="DEX8LmvJpjefPS1cGS9zWB9ybxN24vNjTTrusBeqyARL"
    [ownership_token]="oWnqbNwmEdjNS5KVbxz8xeuGNjKMd1aiNF89d7qdARL"
  )

  for crate_snake in "${!R20_REDEPLOY[@]}"; do
    local addr="${R20_REDEPLOY[$crate_snake]}"
    local so="$ROOT_DIR/contracts/target/deploy/${crate_snake}.so"
    local kp="$vanity_dir/$addr.json"

    [[ -f "$so" ]] || { log "ERROR: missing artifact $so"; exit 1; }
    [[ -f "$kp" ]] || { log "ERROR: missing vanity keypair $kp"; exit 1; }

    log "redeploying $crate_snake -> $addr (R20 upgrade)"

    # Sanity check: verify the program is on-chain and upgradeable.
    local show_out
    show_out="$(solana program show "$addr" --url "$rpc" 2>&1 || true)"
    if ! echo "$show_out" | grep -q "Last Deployed"; then
      log "ERROR: $crate_snake ($addr) not deployed on $rpc — Phase 1 must run before R20"
      exit 1
    fi
    if echo "$show_out" | grep -qE 'Upgradeable:\s*false'; then
      log "WARN: $crate_snake reports Upgradeable: false — solana program deploy may fail"
    fi

    solana program deploy \
      --url "$rpc" \
      --keypair "$deployer" \
      --program-id "$kp" \
      "$so" >>"$LOG_FILE" 2>&1 \
      || { log "ERROR: redeploy failed for $crate_snake; see $LOG_FILE"; exit 1; }
    log "  $crate_snake redeploy OK"
  done
}

# ----------------------------------------------------------------------------
# R20: optional mint-pin migration AFTER Phase 1 (devnet rehearsal step).
#   Triggered when both RWT_MINT_PUBKEY and USDC_MINT_PUBKEY are set; the
#   migrate-mints.sh script rewrites all 3 R20-pinned contracts (YD full
#   RWT+USDC, DEX RWT-only, OT RWT-only) and rebuilds the .so files.
#
#   SD-32 closure: the previous halt-with-ALLOW_INCOMPLETE_R20-escape-hatch
#   is gone now that redeploy_r20_contracts is wired (BPF Loader v3 upgrade
#   in place via solana program deploy --program-id).
# ----------------------------------------------------------------------------
phase_r20_migrate() {
  # SD-32 follow-up: R20 logic is now invoked from e2e-bootstrap.sh::stage_r20_migrate
  # (between stage_verify_ids and stage_bots) because phase_1_deploy's delegation
  # to e2e-bootstrap.sh runs stage_init INSIDE phase_1_deploy — bootstrap-init.ts
  # would halt on Phase F before control returned to deploy.sh::main(). Keeping
  # phase_r20_migrate as a no-op marker preserves the phase-map comment block
  # for readability; redeploy_r20_contracts() above is retained for direct
  # operator invocation in mainnet runbooks where the phase split differs.
  log "phase_r20_migrate: delegated to e2e-bootstrap.sh::stage_r20_migrate (SD-32)"
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
