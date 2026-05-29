#!/usr/bin/env bash
#
# deploy-devnet.sh — Areal Finance devnet orchestrator (5-contract redeploy).
#
# Sub-command driver that mirrors the structure of scripts/deploy.sh (the
# mainnet 8-phase orchestrator) but targets the devnet feature-flagged
# build path:
#   - vanity-set keypairs at keys/devnet/*.json (NOT keys/vanity/*.json)
#   - declare_id! resolved via `#[cfg(feature = "devnet")]` blocks
#   - all artifact state journalled in data/devnet-addresses.json
#
# State of truth: data/devnet-addresses.json. The script never edits the
# mainnet path (scripts/deploy.sh, scripts/e2e-bootstrap.sh) — those stay
# untouched per the devnet rehearsal plan.
#
# Exit codes:
#   0   success
#   1   hard failure (build, deploy, network, validation)
#   2   guard rejected (mainnet-contamination, missing keypair, etc.)
#   64  bad usage
#
# Usage:
#   ./scripts/deploy-devnet.sh <subcommand> [args]
#
# Subcommands:
#   status         Show deployer balance + deployment state per program
#   airdrop        CLI airdrop loop; falls back to web faucet prompt
#   build          Build all 7 contracts with --features devnet
#   deploy <c>     Deploy a single contract by short name (yield-distribution,
#                  futarchy, ownership-token, rwt-engine, native-dex)
#   deploy-all     Deploy all 7 in smallest-first order (idempotent)
#   verify         Run verify-program-ids-devnet.sh + on-chain solana program show
#   help           Print this header

set -euo pipefail
umask 077

# ----------------------------------------------------------------------------
# Paths + globals
# ----------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DATA_DIR="$ROOT_DIR/data"
ADDRESSES_FILE="$DATA_DIR/devnet-addresses.json"
DEVNET_KEY_DIR="$ROOT_DIR/keys/devnet"
DEPLOYER_KP="$DEVNET_KEY_DIR/deployer.json"
LOG_FILE="$DATA_DIR/deploy-devnet.log"

# Helius devnet RPC defaults (overridable via env). The airdrop endpoint is
# pinned separately because Helius doesn't service `solana airdrop` requests
# — only api.devnet.solana.com does.
DEFAULT_HTTP="https://devnet.helius-rpc.com/?api-key=4e2f4597-b7dc-4258-9d59-449f4fe3a776"
DEFAULT_WS="wss://devnet.helius-rpc.com/?api-key=4e2f4597-b7dc-4258-9d59-449f4fe3a776"
DEFAULT_AIRDROP_HTTP="https://api.devnet.solana.com"

DEVNET_RPC_HTTP="${DEVNET_RPC_HTTP:-$DEFAULT_HTTP}"
DEVNET_RPC_WS="${DEVNET_RPC_WS:-$DEFAULT_WS}"
DEVNET_AIRDROP_HTTP="${DEVNET_AIRDROP_HTTP:-$DEFAULT_AIRDROP_HTTP}"

# Smallest-first deploy order — chosen so airdropped balance covers the
# cheapest binaries first, giving the operator a chance to abort if the
# rent estimate for the next program would overflow the wallet.
DEPLOY_ORDER=(
  "yield-distribution"
  "futarchy"
  "ownership-token"
  "rwt-engine"
  "native-dex"
  "earn"
  "staking"
)

# Short-name to JSON key + .so filename mapping. The .so artifact lives at
# contracts/target/deploy/<crate_snake>.so (verified via current artifact
# layout — see contracts/target/deploy/*.so).
declare -A JSON_KEY=(
  [yield-distribution]="yield_distribution"
  [futarchy]="futarchy"
  [ownership-token]="ownership_token"
  [rwt-engine]="rwt_engine"
  [native-dex]="native_dex"
  [earn]="earn"
  [staking]="staking"
)

declare -A SO_NAME=(
  [yield-distribution]="yield_distribution.so"
  [futarchy]="futarchy.so"
  [ownership-token]="ownership_token.so"
  [rwt-engine]="rwt_engine.so"
  [native-dex]="native_dex.so"
  [earn]="earn.so"
  [staking]="staking.so"
)

# ----------------------------------------------------------------------------
# Logging
# ----------------------------------------------------------------------------

# ANSI color helpers (kept aligned with scripts/deploy.sh conventions).
COLOR_RESET=$'\033[0m'
COLOR_OK=$'\033[32m'
COLOR_WARN=$'\033[33m'
COLOR_ERR=$'\033[31m'
COLOR_INFO=$'\033[36m'

mkdir -p "$DATA_DIR"

_log() {
  local ts
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '[%s] %s\n' "$ts" "$*" | tee -a "$LOG_FILE"
}

_ok()   { _log "${COLOR_OK}OK${COLOR_RESET}    $*"; }
_warn() { _log "${COLOR_WARN}WARN${COLOR_RESET}  $*"; }
_err()  { _log "${COLOR_ERR}ERROR${COLOR_RESET} $*" >&2; }
_info() { _log "${COLOR_INFO}INFO${COLOR_RESET}  $*"; }

_die() {
  _err "$*"
  exit 1
}

# ----------------------------------------------------------------------------
# Pre-flight guards
# ----------------------------------------------------------------------------

# Mainnet-contamination guard: any state-changing operation that lands a
# mainnet RPC URL in env vars is a critical mis-config. Hard-reject the run.
# Read-only ops (status) call this defensively too — the deployer keypair is
# the same for both clusters and an accidental mainnet airdrop is destructive.
_assert_devnet_rpc() {
  if [[ "$DEVNET_RPC_HTTP" == *mainnet* ]]; then
    _err "DEVNET_RPC_HTTP contains 'mainnet' — refusing to operate on mainnet"
    _err "  got: $DEVNET_RPC_HTTP"
    exit 2
  fi
  if [[ "$DEVNET_RPC_HTTP" != *devnet* && "$DEVNET_RPC_HTTP" != *localhost* && "$DEVNET_RPC_HTTP" != *127.0.0.1* ]]; then
    _warn "DEVNET_RPC_HTTP does not look like a devnet URL: $DEVNET_RPC_HTTP"
  fi
}

_assert_tools() {
  for tool in solana solana-keygen jq python3; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      _die "required tool not found in PATH: $tool"
    fi
  done
}

_assert_state() {
  [[ -f "$ADDRESSES_FILE" ]] || _die "addresses file not found: $ADDRESSES_FILE"
  [[ -f "$DEPLOYER_KP" ]]    || _die "deployer keypair not found: $DEPLOYER_KP"
  [[ -d "$DEVNET_KEY_DIR" ]] || _die "devnet key dir not found: $DEVNET_KEY_DIR"
}

# Atomic write helper for jq edits.
#   _jq_update <jq_filter> [<jq_arg_flag> <name> <value> ...]
# Writes filter output to a tmp file then mv's into place; never leaves the
# addresses file half-written.
_jq_update() {
  local filter="$1"
  shift
  local tmp
  tmp="$(mktemp "${ADDRESSES_FILE}.tmp.XXXXXX")"
  if ! jq "$@" "$filter" "$ADDRESSES_FILE" >"$tmp"; then
    rm -f "$tmp"
    _die "jq update failed for filter: $filter"
  fi
  mv "$tmp" "$ADDRESSES_FILE"
  chmod 600 "$ADDRESSES_FILE"
}

# Read a deployer or program field from the addresses file.
#   _jq_read <jq_filter>
_jq_read() {
  jq -r "$1" "$ADDRESSES_FILE"
}

# Wraps `solana <cmd>` with the devnet URL + deployer keypair pinned.
_solana() {
  solana --url "$DEVNET_RPC_HTTP" --keypair "$DEPLOYER_KP" "$@"
}

# Current deployer balance in SOL (best-effort; returns "?" on RPC error).
_deployer_balance_sol() {
  local pk
  pk="$(_jq_read '.deployer.pubkey')"
  local out
  if out="$(solana balance "$pk" --url "$DEVNET_RPC_HTTP" 2>/dev/null)"; then
    # `solana balance` prints "X SOL" — keep just the number.
    echo "${out% SOL}"
  else
    echo "?"
  fi
}

# ----------------------------------------------------------------------------
# Subcommand: status
# ----------------------------------------------------------------------------

cmd_status() {
  _assert_tools
  _assert_state
  _assert_devnet_rpc

  local deployer_pk balance
  deployer_pk="$(_jq_read '.deployer.pubkey')"
  balance="$(_deployer_balance_sol)"

  echo
  _info "Devnet deployment status"
  _info "  cluster:        $(_jq_read '.cluster')"
  _info "  rpc:            $DEVNET_RPC_HTTP"
  _info "  deployer:       $deployer_pk"
  _info "  balance:        $balance SOL"
  echo

  printf '  %-22s %-46s %s\n' "PROGRAM" "PUBKEY" "DEPLOYED_AT"
  for short in "${DEPLOY_ORDER[@]}"; do
    local key="${JSON_KEY[$short]}"
    local pk deployed
    pk="$(_jq_read ".programs.${key}.pubkey")"
    deployed="$(_jq_read ".programs.${key}.deployed_at // \"-\"")"
    printf '  %-22s %-46s %s\n' "$short" "$pk" "$deployed"
  done
  echo

  # Best-effort live check: which programs actually exist on-chain right now?
  _info "On-chain presence check:"
  for short in "${DEPLOY_ORDER[@]}"; do
    local key="${JSON_KEY[$short]}"
    local pk
    pk="$(_jq_read ".programs.${key}.pubkey")"
    if solana program show "$pk" --url "$DEVNET_RPC_HTTP" >/dev/null 2>&1; then
      _ok "  $short ($pk)"
    else
      _warn "  $short ($pk) — not deployed"
    fi
  done
}

# ----------------------------------------------------------------------------
# Subcommand: airdrop
# ----------------------------------------------------------------------------

cmd_airdrop() {
  _assert_tools
  _assert_state
  _assert_devnet_rpc

  local pk attempts max_attempts chunk_sol
  pk="$(_jq_read '.deployer.pubkey')"
  max_attempts=3
  chunk_sol=2

  _info "Airdrop loop for deployer $pk (chunks of $chunk_sol SOL, max $max_attempts attempts)"
  _info "  airdrop endpoint: $DEVNET_AIRDROP_HTTP (Helius doesn't service airdrops)"

  for (( attempts = 1; attempts <= max_attempts; attempts++ )); do
    if solana airdrop "$chunk_sol" "$pk" --url "$DEVNET_AIRDROP_HTTP" 2>&1 | tee -a "$LOG_FILE"; then
      _ok "airdrop attempt $attempts succeeded"
      local bal
      bal="$(_deployer_balance_sol)"
      _info "deployer balance: $bal SOL"
      # Record successful airdrop into the addresses file's history block.
      local ts
      ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
      _jq_update \
        '.deployer.airdrop_history += [{"at": $ts, "amount_sol": ($amt|tonumber), "endpoint": $ep}]' \
        --arg ts "$ts" --arg amt "$chunk_sol" --arg ep "$DEVNET_AIRDROP_HTTP"
      return 0
    fi
    _warn "airdrop attempt $attempts failed"
    if (( attempts < max_attempts )); then
      _info "sleeping 30s before retry"
      sleep 30
    fi
  done

  _err "all $max_attempts airdrop attempts failed (rate-limited or upstream issue)"
  echo
  echo "  Fallback: use the web faucet manually."
  echo "  Faucet URL: https://faucet.solana.com/"
  echo "  Pubkey:     $pk"
  echo
  echo "  After topping up, re-run: ./scripts/deploy-devnet.sh status"
  exit 1
}

# ----------------------------------------------------------------------------
# Subcommand: build
# ----------------------------------------------------------------------------

# Build a single contract crate with the devnet feature flag.
_build_one() {
  local short="$1"
  local crate_dir="$ROOT_DIR/contracts/$short"
  if [[ ! -d "$crate_dir" ]]; then
    _die "crate dir not found: $crate_dir"
  fi
  _info "  cargo build-sbf --features devnet ($short)"
  (
    cd "$crate_dir"
    cargo build-sbf --features devnet 2>&1 | tee -a "$LOG_FILE"
  ) || _die "cargo build-sbf failed for $short — see $LOG_FILE"

  local so="$ROOT_DIR/contracts/target/deploy/${SO_NAME[$short]}"
  [[ -f "$so" ]] || _die "build OK but artifact missing: $so"
  _ok "  $short → $so"
}

cmd_build() {
  _assert_tools
  _info "Building all 7 contracts with --features devnet"
  for short in "${DEPLOY_ORDER[@]}"; do
    _build_one "$short"
  done
  _ok "All 5 builds complete"
}

# ----------------------------------------------------------------------------
# Subcommand: deploy <short_name>
# ----------------------------------------------------------------------------

# Deploy one contract — caller is responsible for the CHECKPOINT 3 prompt
# (deploy-all calls _deploy_one in a loop with its own confirmations; the
# `deploy <c>` sub-command wraps a single call with its own prompt).
_deploy_one() {
  local short="$1"
  local key="${JSON_KEY[$short]}"
  local so="$ROOT_DIR/contracts/target/deploy/${SO_NAME[$short]}"
  local prog_kp="$DEVNET_KEY_DIR/${short}.json"

  [[ -f "$so" ]]      || _die "missing artifact $so — run: ./scripts/deploy-devnet.sh build"
  [[ -f "$prog_kp" ]] || _die "missing program keypair $prog_kp"

  local pk
  pk="$(_jq_read ".programs.${key}.pubkey")"

  # Sanity: the keypair on disk must match the pinned pubkey, otherwise we'd
  # silently deploy to a fresh address.
  local key_pubkey
  key_pubkey="$(solana-keygen pubkey "$prog_kp")"
  if [[ "$key_pubkey" != "$pk" ]]; then
    _die "keypair/pubkey drift for $short: keypair=$key_pubkey, addresses=$pk"
  fi

  _info "Deploying $short -> $pk"
  _info "  artifact: $so"
  _info "  keypair:  $prog_kp"

  if ! _solana program deploy --program-id "$prog_kp" "$so" 2>&1 | tee -a "$LOG_FILE"; then
    _die "solana program deploy failed for $short — see $LOG_FILE"
  fi

  # Parse `solana program show` for slot + program data address (best effort).
  local show_out slot prog_data
  show_out="$(solana program show "$pk" --url "$DEVNET_RPC_HTTP" 2>&1 || true)"
  slot="$(echo "$show_out" | awk -F': *' '/Last Deployed In Slot/ {print $2; exit}')"
  prog_data="$(echo "$show_out" | awk -F': *' '/ProgramData Address/ {print $2; exit}')"

  local ts
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  _jq_update \
    ".programs.${key}.deployed_at = \$ts | .programs.${key}.last_deployed_slot = (\$slot | tonumber? // null) | .programs.${key}.program_data_address = (\$pd | select(length>0)) // .programs.${key}.program_data_address" \
    --arg ts "$ts" --arg slot "${slot:-}" --arg pd "${prog_data:-}"

  _ok "$short deployed @ slot=${slot:-?} (program_data=${prog_data:-?})"
}

# Estimate rent for a .so file. Returns lamports as integer; "?" if probe fails.
_estimate_rent_lamports() {
  local so="$1"
  local bytes
  bytes="$(wc -c <"$so" 2>/dev/null | tr -d ' ')"
  if [[ -z "$bytes" ]]; then
    echo "?"
    return
  fi
  # ProgramData accounts have an upfront 45-byte metadata header; the BPF
  # loader doubles the program-data slot size for upgrade headroom. The
  # operator-facing estimate is best-effort — we ask the cluster for the
  # actual rent-exempt threshold using the doubled byte count.
  local probe_size=$(( bytes * 2 + 45 ))
  solana rent "$probe_size" --url "$DEVNET_RPC_HTTP" 2>/dev/null \
    | awk '/Rent-exempt minimum/ {print $4}' \
    | head -1
}

# Prompt the operator before a state-changing deploy. CHECKPOINT 3 enforcement.
_confirm_deploy() {
  local short="$1"
  local so="$ROOT_DIR/contracts/target/deploy/${SO_NAME[$short]}"
  local rent_lamports
  rent_lamports="$(_estimate_rent_lamports "$so")"

  local rent_sol="?"
  if [[ "$rent_lamports" =~ ^[0-9]+$ ]]; then
    rent_sol="$(python3 -c "print(f'{$rent_lamports/1_000_000_000:.4f}')")"
  fi

  local balance
  balance="$(_deployer_balance_sol)"

  echo
  _info "===== CHECKPOINT 3: deploy confirmation ====="
  _info "  contract:        $short"
  _info "  estimated cost:  ~${rent_sol} SOL  (rent for ~2x.so + tx fee)"
  _info "  current balance: ${balance} SOL"
  _info "============================================="
  read -r -p "Continue with deploy? [y/N] " ans
  case "$ans" in
    y|Y|yes|YES) return 0 ;;
    *)
      _warn "deploy of $short cancelled by operator"
      return 1
      ;;
  esac
}

cmd_deploy() {
  local short="${1:-}"
  if [[ -z "$short" ]]; then
    _err "usage: ./scripts/deploy-devnet.sh deploy <contract>"
    _err "  contract: ${DEPLOY_ORDER[*]}"
    exit 64
  fi
  if [[ -z "${JSON_KEY[$short]:-}" ]]; then
    _err "unknown contract: $short"
    _err "  valid names: ${DEPLOY_ORDER[*]}"
    exit 64
  fi

  _assert_tools
  _assert_state
  _assert_devnet_rpc

  _confirm_deploy "$short" || exit 0
  _deploy_one "$short"
}

# ----------------------------------------------------------------------------
# Subcommand: deploy-all
# ----------------------------------------------------------------------------

cmd_deploy_all() {
  _assert_tools
  _assert_state
  _assert_devnet_rpc

  _info "Deploying all 7 contracts in order: ${DEPLOY_ORDER[*]}"

  for short in "${DEPLOY_ORDER[@]}"; do
    local key="${JSON_KEY[$short]}"
    local pk deployed_at
    pk="$(_jq_read ".programs.${key}.pubkey")"
    deployed_at="$(_jq_read ".programs.${key}.deployed_at // \"\"")"

    # Skip programs that are already deployed AND visible on-chain.
    if [[ -n "$deployed_at" && "$deployed_at" != "null" ]]; then
      if solana program show "$pk" --url "$DEVNET_RPC_HTTP" >/dev/null 2>&1; then
        _info "[skip] $short already deployed at $deployed_at ($pk)"
        continue
      fi
      _warn "[stale] $short marked deployed at $deployed_at but not on-chain — redeploying"
    fi

    _confirm_deploy "$short" || { _warn "deploy-all halted at $short"; exit 0; }
    _deploy_one "$short"
  done

  _ok "deploy-all complete"
}

# ----------------------------------------------------------------------------
# Subcommand: verify
# ----------------------------------------------------------------------------

cmd_verify() {
  _assert_tools
  _assert_state
  _assert_devnet_rpc

  _info "Step 1: verify-program-ids-devnet.sh (declare_id + cross-pin bytes)"
  if [[ ! -x "$SCRIPT_DIR/verify-program-ids-devnet.sh" ]]; then
    _warn "verify-program-ids-devnet.sh not found or not executable; skipping"
  else
    bash "$SCRIPT_DIR/verify-program-ids-devnet.sh" 2>&1 | tee -a "$LOG_FILE" \
      || _die "verify-program-ids-devnet.sh reported drift"
  fi

  _info "Step 2: on-chain solana program show per program"
  local fail=0
  for short in "${DEPLOY_ORDER[@]}"; do
    local key="${JSON_KEY[$short]}"
    local pk
    pk="$(_jq_read ".programs.${key}.pubkey")"
    if solana program show "$pk" --url "$DEVNET_RPC_HTTP" >>"$LOG_FILE" 2>&1; then
      _ok "  $short ($pk) present"
    else
      _err "  $short ($pk) NOT visible on $DEVNET_RPC_HTTP"
      fail=$(( fail + 1 ))
    fi
  done

  if (( fail > 0 )); then
    _die "$fail/${#DEPLOY_ORDER[@]} program(s) missing on-chain"
  fi
  _ok "verify complete: all 7 program IDs match source + all 7 programs on-chain"
}

# ----------------------------------------------------------------------------
# Subcommand: help
# ----------------------------------------------------------------------------

cmd_help() {
  sed -n '2,33p' "$0"
}

# ----------------------------------------------------------------------------
# Dispatcher
# ----------------------------------------------------------------------------

main() {
  local sub="${1:-help}"
  shift || true
  case "$sub" in
    status)      cmd_status "$@" ;;
    airdrop)     cmd_airdrop "$@" ;;
    build)       cmd_build "$@" ;;
    deploy)      cmd_deploy "$@" ;;
    deploy-all)  cmd_deploy_all "$@" ;;
    verify)      cmd_verify "$@" ;;
    help|-h|--help) cmd_help ;;
    *)
      _err "unknown subcommand: $sub"
      cmd_help
      exit 64
      ;;
  esac
}

main "$@"
