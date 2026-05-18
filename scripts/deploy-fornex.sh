#!/usr/bin/env bash
#
# deploy-fornex.sh — Phase 2 NativeDEX-Concentrated-Redesign Fornex VPS deploy.
#
# Mirrors verify-fresh-deploy.sh's local-mac flow but targets the Fornex VPS
# test-validator. Operator runs THIS script from a local mac; it SSHes to the
# `vps-vpn` alias as root, syncs /opt/areal, BUILDS contracts LOCALLY on the
# mac and rsyncs the .so artifacts to the VPS (the VPS has no Rust/cargo-
# build-sbf toolchain, and installing it is invasive — full Rust + Solana
# platform-tools cache, none of which the VPS needs for any other purpose),
# upgrades 5 programs in place at their canonical vanity IDs (authority match
# was verified out-of-band — see Phase 2 spec), runs e2e-bootstrap on the VPS
# to seed singletons + pools, then opens a local SSH tunnel and runs
# scripts/smoke-swap.ts against the VPS RPC.
#
# PRIVILEGE MODEL
#   Local mac side: runs as the local user; only needs SSH access to vps-vpn.
#   VPS side:       every remote command runs as root (per the `vps-vpn` alias
#                   ~/.ssh/config). Contracts deploy is admin-tier and rare,
#                   so we do NOT route through the deployer runuser indirection
#                   used by areal-deploy-app / areal-deploy-dashboard. This is
#                   intentional: cargo build-sbf + solana program deploy with
#                   the upgrade authority belong to the operator, not the
#                   deploy-app service account.
#
# NEVER RUNS verify-fresh-deploy.sh ON VPS — that script wipes the validator
# ledger every run, which would destroy 45+ days of VPS validator state. We
# use the surgical e2e-bootstrap.sh flow (KEEP_LEDGER=1, SKIP_BUILD=0) plus
# a manual program-upgrade loop instead.
#
# Flags:
#   --dry-run         Echo every SSH/local command without executing.
#   --skip-build      Reuse remote .so artifacts already present in
#                     /opt/areal/contracts/target/deploy/ on the VPS — skips
#                     BOTH the local `cargo build-sbf` AND the rsync push.
#   --skip-deploy     Skip the 5-program upgrade step (test bootstrap + smoke
#                     in isolation against already-deployed programs).
#   --smoke-only      Skip everything pre-tunnel; only open SSH tunnel + run
#                     scripts/smoke-swap.ts (assumes prior steps already done).
#   --force-keypair   Overwrite the remote deployer keypair (default: refuse).
#
# Outputs:
#   data/fornex-deploy.log   Local timestamped log (full tee).
#
# Exit codes:
#   0   all steps green
#   1   step failure (see log for which)
#   64  bad arguments

set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DATA_DIR="$ROOT_DIR/data"
LOG_FILE="$DATA_DIR/fornex-deploy.log"

mkdir -p "$DATA_DIR"

# ----------------------------------------------------------------------------
# CLI flags
# ----------------------------------------------------------------------------

DRY_RUN=0
SKIP_BUILD=0
SKIP_DEPLOY=0
SMOKE_ONLY=0
FORCE_KEYPAIR=0

for arg in "$@"; do
  case "$arg" in
    --dry-run)        DRY_RUN=1 ;;
    --skip-build)     SKIP_BUILD=1 ;;
    --skip-deploy)    SKIP_DEPLOY=1 ;;
    --smoke-only)     SMOKE_ONLY=1 ;;
    --force-keypair)  FORCE_KEYPAIR=1 ;;
    -h|--help)
      sed -n '2,50p' "$0"
      exit 0
      ;;
    *)
      echo "[deploy-fornex] unknown arg: $arg" >&2
      exit 64
      ;;
  esac
done

# Tee everything to LOG_FILE while still printing to stdout (mirrors
# verify-fresh-deploy.sh convention).
exec > >(tee -a "$LOG_FILE") 2>&1

# ----------------------------------------------------------------------------
# Constants — VPS shape (per Phase 2 spec / reconnaissance)
# ----------------------------------------------------------------------------

SSH_HOST="vps-vpn"
VPS_REPO_ROOT="/opt/areal"
VPS_DEPLOYER_KP="/root/.config/solana/deploy-keypair.json"
VPS_SECRETS_FILE="$VPS_REPO_ROOT/data/e2e-bootstrap.secrets.json"
VPS_SOLANA_BIN="/root/.local/share/solana/install/active_release/bin/solana"
# VPS validator binds 0.0.0.0:8899/8900; firewall blocks external — accessible
# only through SSH tunnel.
VPS_RPC_LOCAL="http://localhost:8899"

# Local-side SSH tunnel ports (unique to avoid clash with running local
# validator on 8899/8900).
TUNNEL_RPC_PORT=18899
TUNNEL_WS_PORT=18900
SMOKE_RPC_URL="http://127.0.0.1:${TUNNEL_RPC_PORT}"

# Local files we may need to push to the VPS.
LOCAL_DEPLOYER_KP="$ROOT_DIR/deploy-keypair.json"
LOCAL_SECRETS_FILE="$DATA_DIR/e2e-bootstrap.secrets.json"

# Canonical vanity program IDs (mirrors PROGRAMS array in e2e-bootstrap.sh).
# crate-name : on-chain program ID
PROGRAMS=(
  "ownership-token:oWnqbNwmEdjNS5KVbxz8xeuGNjKMd1aiNF89d7qdARL"
  "native-dex:DEX8LmvJpjefPS1cGS9zWB9ybxN24vNjTTrusBeqyARL"
  "rwt-engine:RWT9hgbjHQDj98xP7FYsT5QYp5X32XyK6QfMRmFtARL"
  "yield-distribution:YLD9EBikcTmVCnVzdx6vuNajrDkp8tyCAgZrqTwmMXF"
  "futarchy:FUTsbsdyJmEWa5LSYHWXMr9hQFyVsrJ1agGvRQGR1ARL"
)

# ----------------------------------------------------------------------------
# Logging + remote-exec helpers
# ----------------------------------------------------------------------------

log() {
  printf '[%s][fornex] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

# Run a command on the VPS as root. Echoes the command first, honors --dry-run.
remote() {
  local cmd="$*"
  log "[ssh] $cmd"
  if (( DRY_RUN )); then
    return 0
  fi
  ssh "$SSH_HOST" "$cmd"
}

# Same as `remote`, but capture stdout (so we can grep / parse). Still honors
# dry-run (returns empty + 0 in that mode).
remote_capture() {
  local cmd="$*"
  log "[ssh] $cmd"
  if (( DRY_RUN )); then
    return 0
  fi
  ssh "$SSH_HOST" "$cmd"
}

# Push a local file to a remote path. Default mode 0600 to preserve secrets.
push_file() {
  local src="$1" dst="$2" mode="${3:-0600}"
  log "[scp] $src -> $SSH_HOST:$dst (mode=$mode)"
  if (( DRY_RUN )); then
    return 0
  fi
  scp -q "$src" "$SSH_HOST:$dst"
  ssh "$SSH_HOST" "chmod $mode $dst"
}

# ----------------------------------------------------------------------------
# SSH tunnel lifecycle (step 8/9 — smoke against VPS RPC)
# ----------------------------------------------------------------------------

TUNNEL_PID=""

teardown_tunnel() {
  if [[ -n "$TUNNEL_PID" ]]; then
    log "step 9: tearing down SSH tunnel (pid=$TUNNEL_PID)"
    kill "$TUNNEL_PID" 2>/dev/null || true
    wait "$TUNNEL_PID" 2>/dev/null || true
    TUNNEL_PID=""
  fi
}

# ERR / EXIT trap so SSH tunnel is always cleaned up, even on partial failure.
trap 'rc=$?; teardown_tunnel; exit $rc' EXIT
trap 'log "ERR: caught signal — aborting"; exit 1' INT TERM

open_tunnel() {
  log "step 8a: opening SSH tunnel ${TUNNEL_RPC_PORT}->8899, ${TUNNEL_WS_PORT}->8900"
  if (( DRY_RUN )); then
    log "  (dry-run: skipping)"
    return 0
  fi

  # -N: no remote command; -T: no TTY; background.
  ssh -N -T \
    -L "${TUNNEL_RPC_PORT}:localhost:8899" \
    -L "${TUNNEL_WS_PORT}:localhost:8900" \
    "$SSH_HOST" &
  TUNNEL_PID=$!
  log "  tunnel pid=$TUNNEL_PID"

  # Poll local-side RPC port for readiness (max 30s).
  local tries=30
  while (( tries > 0 )); do
    if solana cluster-version --url "$SMOKE_RPC_URL" >/dev/null 2>&1; then
      log "  tunnel ready"
      return 0
    fi
    sleep 1
    tries=$((tries - 1))
  done
  log "ERROR: SSH tunnel failed to become reachable within 30s"
  return 1
}

# ----------------------------------------------------------------------------
# Step 1 — pre-flight
# ----------------------------------------------------------------------------

preflight() {
  log "step 1: preflight"

  if [[ ! -f "$LOCAL_DEPLOYER_KP" ]]; then
    log "ERROR: local deployer keypair missing at $LOCAL_DEPLOYER_KP"
    log "       create it with: solana-keygen new --outfile $LOCAL_DEPLOYER_KP"
    exit 1
  fi
  log "  local deployer keypair: $LOCAL_DEPLOYER_KP"

  if [[ ! -f "$LOCAL_SECRETS_FILE" ]]; then
    log "WARN: local secrets file missing at $LOCAL_SECRETS_FILE"
    log "      bootstrap-init.ts may regenerate RWT/USDC test mint keypairs"
    log "      on VPS — that's fine for a fresh VPS bootstrap, but the local"
    log "      file (if present) would have been a faster warm-restart path."
  else
    log "  local secrets file: $LOCAL_SECRETS_FILE"
  fi

  # SSH connectivity probe — fail fast if vps-vpn alias is broken.
  if ! ssh -o BatchMode=yes -o ConnectTimeout=5 "$SSH_HOST" 'true' 2>/dev/null; then
    log "ERROR: SSH probe to '$SSH_HOST' failed"
    log "       check ~/.ssh/config alias + key + VPN connection"
    exit 1
  fi
  log "  ssh $SSH_HOST: OK"

  # VPS validator health probe.
  log "[ssh] $VPS_SOLANA_BIN cluster-version --url $VPS_RPC_LOCAL"
  if (( ! DRY_RUN )); then
    if ! ssh "$SSH_HOST" "$VPS_SOLANA_BIN cluster-version --url $VPS_RPC_LOCAL" >/dev/null 2>&1; then
      log "ERROR: VPS test-validator not responding on $VPS_RPC_LOCAL"
      log "       verify solana-test-validator is running on the VPS"
      exit 1
    fi
  fi
  log "  VPS validator: OK"
}

# ----------------------------------------------------------------------------
# Step 2 — sync repo on VPS
# ----------------------------------------------------------------------------

sync_repo() {
  log "step 2: syncing $VPS_REPO_ROOT to latest main"
  # --recurse-submodules pulls submodule HEADs that meta-repo points to;
  # `git submodule update --init --recursive --remote` then advances submodules
  # to the tip of their tracked branch (matches scripts/deploy-app.sh pattern,
  # minus the runuser indirection because we're root).
  remote "cd $VPS_REPO_ROOT && git pull --ff-only --recurse-submodules && git submodule update --init --recursive"
}

# ----------------------------------------------------------------------------
# Step 3 — push deployer keypair to VPS (if missing or --force-keypair)
# ----------------------------------------------------------------------------

push_keypair() {
  log "step 3: ensuring VPS deployer keypair at $VPS_DEPLOYER_KP"

  # First, ensure the parent directory exists.
  remote "mkdir -p $(dirname $VPS_DEPLOYER_KP) && chmod 0700 $(dirname $VPS_DEPLOYER_KP)"

  # Probe remote state.
  local remote_exists=0
  if (( ! DRY_RUN )); then
    if ssh "$SSH_HOST" "test -f $VPS_DEPLOYER_KP" 2>/dev/null; then
      remote_exists=1
    fi
  fi

  if (( remote_exists )) && (( ! FORCE_KEYPAIR )); then
    log "  remote keypair already exists; refusing to overwrite (use --force-keypair)"
    return 0
  fi

  if (( remote_exists )) && (( FORCE_KEYPAIR )); then
    log "  --force-keypair: overwriting existing remote keypair"
  fi

  push_file "$LOCAL_DEPLOYER_KP" "$VPS_DEPLOYER_KP" 0600
}

# ----------------------------------------------------------------------------
# Step 4 — push e2e-bootstrap.secrets.json to VPS (if missing)
# ----------------------------------------------------------------------------

push_secrets() {
  log "step 4: ensuring VPS secrets file at $VPS_SECRETS_FILE"

  if [[ ! -f "$LOCAL_SECRETS_FILE" ]]; then
    log "  local secrets file absent; skipping push (VPS will generate its own)"
    return 0
  fi

  remote "mkdir -p $(dirname $VPS_SECRETS_FILE)"

  local remote_exists=0
  if (( ! DRY_RUN )); then
    if ssh "$SSH_HOST" "test -f $VPS_SECRETS_FILE" 2>/dev/null; then
      remote_exists=1
    fi
  fi

  if (( remote_exists )) && (( ! FORCE_KEYPAIR )); then
    # Secrets file is a state-bearing artifact (holds the on-chain mint
    # authorities for VPS RWT + USDC test mints). Overwriting it would mean
    # the freshly-generated keypairs no longer match the on-chain authorities,
    # bricking subsequent bootstrap-init.ts runs. Treat it under the same
    # --force-keypair gate as the deployer keypair.
    log "  remote secrets file already exists; refusing to overwrite (use --force-keypair)"
    return 0
  fi

  push_file "$LOCAL_SECRETS_FILE" "$VPS_SECRETS_FILE" 0600
}

# ----------------------------------------------------------------------------
# Step 4.5 — ensure VPS has vanity program keypairs (idempotent rsync)
# ----------------------------------------------------------------------------
#
# scripts/e2e-bootstrap.sh preflight requires `keys/vanity/*.json` to exist
# (it cross-checks the local keypair pubkeys against the canonical vanity
# program IDs). On dev/test-validator flows these keys are non-sensitive
# (programs already deployed under deployer authority, not first-deploy).
# Push them once via rsync; subsequent runs are no-ops if files match.
ensure_vps_vanity_keys() {
  log "step 4.5: ensuring VPS vanity keypairs at $VPS_REPO_ROOT/keys/vanity"

  local local_vanity_dir="$REPO_ROOT/keys/vanity"
  if [[ ! -d "$local_vanity_dir" ]]; then
    log "  local keys/vanity absent; skipping (VPS bootstrap will fail with vanity-missing)"
    return 0
  fi

  remote "mkdir -p $VPS_REPO_ROOT/keys/vanity && chmod 0700 $VPS_REPO_ROOT/keys/vanity"

  if (( DRY_RUN )); then
    log "  [rsync] $local_vanity_dir/ -> $SSH_HOST:$VPS_REPO_ROOT/keys/vanity/"
    log "    (dry-run: skipping)"
    return 0
  fi

  log "  [rsync] $local_vanity_dir/ -> $SSH_HOST:$VPS_REPO_ROOT/keys/vanity/"
  rsync -av --chmod=F0600 --include='*.json' --exclude='*' \
    "$local_vanity_dir/" "$SSH_HOST:$VPS_REPO_ROOT/keys/vanity/" \
    >> "$LOG_FILE" 2>&1
}

# ----------------------------------------------------------------------------
# Step 5 — build contracts LOCALLY on the mac, rsync .so artifacts to VPS
# ----------------------------------------------------------------------------
#
# Rationale: the Fornex VPS only has Node.js + solana-cli installed. Adding
# Rust + cargo-build-sbf + the Solana platform-tools cache (~1 GB) just to
# rebuild .so files that the mac already builds cleanly is wasteful and
# expands the VPS attack surface for no operational benefit. We build the
# 5 .so artifacts locally (where the toolchain is always current alongside
# the source) and rsync them into the same path the VPS-side step 6
# (`solana program deploy`) already reads from.

LOCAL_DEPLOY_DIR="$ROOT_DIR/contracts/target/deploy"
VPS_DEPLOY_DIR="$VPS_REPO_ROOT/contracts/target/deploy"

# Crate-name (snake_case) artifacts produced by `cargo build-sbf` in the
# contracts workspace. Must match the crate_snake derivation in step 6's
# deploy_programs() loop.
CONTRACT_SO_FILES=(
  "futarchy.so"
  "native_dex.so"
  "ownership_token.so"
  "rwt_engine.so"
  "yield_distribution.so"
)

build_contracts() {
  if (( SKIP_BUILD )); then
    log "step 5: --skip-build set; skipping local build AND rsync (using existing remote .so artifacts on VPS at $VPS_DEPLOY_DIR)"
    return 0
  fi

  log "step 5a: building contracts LOCALLY on mac (cargo build-sbf in contracts/)"
  if (( DRY_RUN )); then
    log "  [local] cd $ROOT_DIR/contracts && cargo build-sbf"
  else
    (
      cd "$ROOT_DIR/contracts"
      cargo build-sbf
    )
  fi

  # Sanity-check all 5 artifacts exist locally before we try to push them.
  if (( ! DRY_RUN )); then
    for so in "${CONTRACT_SO_FILES[@]}"; do
      if [[ ! -f "$LOCAL_DEPLOY_DIR/$so" ]]; then
        log "ERROR: local artifact missing after build: $LOCAL_DEPLOY_DIR/$so"
        exit 1
      fi
    done
    log "  local artifacts: 5/5 present in $LOCAL_DEPLOY_DIR"
  fi

  log "step 5b: ensuring remote deploy dir exists on VPS"
  remote "mkdir -p $VPS_DEPLOY_DIR"

  log "step 5c: rsyncing .so artifacts to $SSH_HOST:$VPS_DEPLOY_DIR/"
  # --include='*.so' / --exclude='*' isolates the 5 BPF artifacts so we don't
  # accidentally drag debug symbols, *-keypair.json, or the entire build tree
  # onto the VPS. -a preserves perms/timestamps; --progress is human-friendly
  # in the tee'd log without being spammy (one line per file).
  log "[rsync] $LOCAL_DEPLOY_DIR/ -> $SSH_HOST:$VPS_DEPLOY_DIR/"
  if (( DRY_RUN )); then
    log "  (dry-run: skipping)"
  else
    rsync -av --progress \
      --include='*.so' --exclude='*' \
      "$LOCAL_DEPLOY_DIR/" "$SSH_HOST:$VPS_DEPLOY_DIR/"
  fi
}

# ----------------------------------------------------------------------------
# Step 6 — upgrade 5 programs in place
# ----------------------------------------------------------------------------

deploy_programs() {
  if (( SKIP_DEPLOY )); then
    log "step 6: --skip-deploy set; skipping program upgrades"
    return 0
  fi
  log "step 6: upgrading 5 programs on VPS"
  for entry in "${PROGRAMS[@]}"; do
    local crate="${entry%%:*}"
    local addr="${entry##*:}"
    local crate_snake
    crate_snake="$(echo "$crate" | tr '-' '_')"
    local so="$VPS_REPO_ROOT/contracts/target/deploy/${crate_snake}.so"

    log "  step 6.${crate}: upgrade $crate -> $addr"

    # Sanity check: program must already be on-chain (we're upgrading, not
    # deploying from scratch). Authority match was verified during VPS recon
    # (per Phase 2 spec); we trust that and let solana program deploy fail
    # loudly if it's wrong.
    remote "$VPS_SOLANA_BIN program show $addr --url $VPS_RPC_LOCAL | head -10"

    # `solana program deploy --program-id <pubkey>` performs an upgrade in
    # place on BPF Loader v3. We pass the raw base58 program ID, not a
    # keypair file — the program already exists, so its keypair is not
    # required; only the upgrade authority signature (from --keypair) is.
    # This avoids needing to propagate keys/vanity/*.json to the VPS.
    remote "$VPS_SOLANA_BIN program deploy --url $VPS_RPC_LOCAL --keypair $VPS_DEPLOYER_KP --program-id $addr $so"
  done
}

# ----------------------------------------------------------------------------
# Step 7 — bootstrap pools on VPS
# ----------------------------------------------------------------------------

bootstrap_pools() {
  log "step 7: bootstrapping pools + singletons on VPS"
  # KEEP_LEDGER=1: preserve the 45+ day VPS validator state (do NOT wipe).
  # SKIP_BUILD=1: contracts were already built in step 5 (or skipped via
  # --skip-build); no need to re-run cargo build-sbf inside e2e-bootstrap.sh.
  # BOOTSTRAP_TARGET=localhost satisfies the safety gate (validator is local
  # to the VPS — devnet/mainnet are forbidden there).
  # `solana` CLI lives at /root/.local/share/solana/install/active_release/bin
  # on VPS, NOT in the default non-login SSH PATH. Prepend it so
  # e2e-bootstrap.sh's preflight `command -v solana` check passes.
  local vps_solana_dir
  vps_solana_dir="$(dirname "$VPS_SOLANA_BIN")"
  remote "cd $VPS_REPO_ROOT && PATH=$vps_solana_dir:\$PATH KEEP_LEDGER=1 SKIP_BUILD=1 BOOTSTRAP_TARGET=localhost bash scripts/e2e-bootstrap.sh"
}

# ----------------------------------------------------------------------------
# Step 8 + 9 — open SSH tunnel + run smoke-swap from local mac, then teardown
# ----------------------------------------------------------------------------

run_smoke() {
  open_tunnel
  log "step 8b: running scripts/smoke-swap.ts against VPS RPC ($SMOKE_RPC_URL)"
  if (( DRY_RUN )); then
    log "  (dry-run: skipping)"
    return 0
  fi
  local tsx_bin="$ROOT_DIR/bots/node_modules/.bin/tsx"
  if [[ ! -x "$tsx_bin" ]]; then
    tsx_bin="tsx"
  fi
  (
    cd "$ROOT_DIR"
    NODE_PATH="$ROOT_DIR/bots/node_modules" "$tsx_bin" \
      "$SCRIPT_DIR/smoke-swap.ts" --rpc "$SMOKE_RPC_URL"
  )
}

# ----------------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------------

main() {
  log "Fornex deploy starting (dry-run=$DRY_RUN, skip-build=$SKIP_BUILD, skip-deploy=$SKIP_DEPLOY, smoke-only=$SMOKE_ONLY, force-keypair=$FORCE_KEYPAIR)"

  if (( SMOKE_ONLY )); then
    log "--smoke-only: skipping steps 1-7, going straight to tunnel + smoke"
    # Still do a minimal SSH preflight so we fail fast if vps-vpn is down.
    if ! ssh -o BatchMode=yes -o ConnectTimeout=5 "$SSH_HOST" 'true' 2>/dev/null; then
      log "ERROR: SSH probe to '$SSH_HOST' failed"
      exit 1
    fi
    run_smoke
    log "Fornex deploy complete (smoke-only)"
    return 0
  fi

  preflight
  sync_repo
  push_keypair
  push_secrets
  ensure_vps_vanity_keys
  build_contracts
  deploy_programs
  bootstrap_pools
  run_smoke

  log "Fornex deploy complete — all 9 steps green"
}

main
