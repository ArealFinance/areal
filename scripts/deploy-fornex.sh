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
VPS_ARTIFACT_FILE="$VPS_REPO_ROOT/data/e2e-bootstrap.json"
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
LOCAL_ARTIFACT_FILE="$DATA_DIR/e2e-bootstrap.json"

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

# Pull a remote file to a local path. Used to sync the VPS bootstrap artifact
# down to the operator's mac before running smoke-swap from local (smoke reads
# data/e2e-bootstrap.json relative to the repo root and talks to the VPS RPC
# via the SSH tunnel — the artifact MUST reflect VPS chain state, otherwise
# vault PDAs from a prior local run leak in and "wrong owner for 'vault_in'"
# fires in account validation).
pull_file() {
  local src="$1" dst="$2"
  log "[scp] $SSH_HOST:$src -> $dst"
  if (( DRY_RUN )); then
    return 0
  fi
  # sudo cat over ssh keeps the pull working when $src is owned by root with
  # 0600 mode (which is how bootstrap-init writes data/e2e-bootstrap.json on
  # VPS). scp would require relaxing remote perms; we keep them as-is.
  ssh "$SSH_HOST" "sudo cat $src" > "$dst"
}

# ----------------------------------------------------------------------------
# SSH tunnel lifecycle (step 8/9 — smoke against VPS RPC)
# ----------------------------------------------------------------------------

TUNNEL_PID=""
R20_MUTATED_FILES=0

teardown_tunnel() {
  if [[ -n "$TUNNEL_PID" ]]; then
    log "step 9: tearing down SSH tunnel (pid=$TUNNEL_PID)"
    kill "$TUNNEL_PID" 2>/dev/null || true
    wait "$TUNNEL_PID" 2>/dev/null || true
    TUNNEL_PID=""
  fi
}

# Restore local constants.rs files mutated by r20_migrate_local. The R20
# migration step rewrites RWT_MINT / USDC_MINT bytes in 3 contracts to pin
# them to the VPS-side mint pubkeys before the build/deploy/bootstrap chain.
# Once VPS has the pinned .so artifacts deployed, the local source tree
# should revert to placeholder bytes so a subsequent local `verify-fresh-
# deploy.sh` (or any local cargo build-sbf) operates on a clean tree. Run
# unconditionally on EXIT so a mid-pipeline failure still leaves the
# working copy clean.
teardown_r20_local() {
  if (( R20_MUTATED_FILES == 0 )); then
    return 0
  fi
  log "cleanup: reverting local constants.rs to placeholder + clearing R20 sentinel"
  (
    cd "$ROOT_DIR/contracts"
    git checkout -- \
      yield-distribution/src/constants.rs \
      native-dex/src/constants.rs \
      ownership-token/src/constants.rs 2>/dev/null || true
  )
  rm -f "$DATA_DIR/r20-migrated.json" 2>/dev/null || true
}

# ERR / EXIT trap so SSH tunnel + local R20 mutations are always cleaned up,
# even on partial failure.
trap 'rc=$?; teardown_tunnel; teardown_r20_local; exit $rc' EXIT
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

  local local_vanity_dir="$ROOT_DIR/keys/vanity"
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
  rsync -av --include='*.json' --exclude='*' \
    "$local_vanity_dir/" "$SSH_HOST:$VPS_REPO_ROOT/keys/vanity/" \
    >> "$LOG_FILE" 2>&1
  # Enforce 0600 on remote — rsync's --chmod syntax varies across versions
  # (macOS BSD rsync rejects F0600), so apply chmod after via ssh.
  remote "chmod 0600 $VPS_REPO_ROOT/keys/vanity/*.json"
}

# ----------------------------------------------------------------------------
# Step 4.6 — R20 mint-pin migration (LOCAL only, mirrors verify-fresh-deploy.sh)
# ----------------------------------------------------------------------------
#
# Root cause this step fixes: the DEX `update_areal_fee_destination`
# instruction (and runtime swap.rs / zap_liquidity.rs guards) validate
# `read_token_account_mint(areal_fee_account) == RWT_MINT`, where RWT_MINT
# is a compile-time constant baked into the .so binary at the bytes in
# `contracts/native-dex/src/constants.rs`. On a fresh VPS bootstrap the
# RWT mint is generated as a random keypair (`Keypair.generate()` retried
# for canonical `rwt < usdc` byte ordering — see bootstrap-init.ts
# phase-c), so the on-chain mint pubkey never matches the placeholder
# constant in the shipped .so. Result: every swap (and the bootstrap's
# own DexConfig fee-destination rotation) reverts with 0x178e
# InvalidProtocolFeeDestination.
#
# Local-mac `verify-fresh-deploy.sh` sidesteps this via `stage_pregen_keypairs`
# (exports RWT_MINT_PUBKEY + USDC_MINT_PUBKEY) → `stage_r20_migrate` inside
# e2e-bootstrap.sh runs scripts/migrate-mints.sh, which rewrites constants.rs
# in all 3 R20-pinned crates (YD/DEX/OT) and rebuilds those .so files with
# the real pubkey bytes baked in. The fresh VPS path bypassed that flow
# entirely because deploy-fornex.sh runs e2e-bootstrap.sh without
# RWT_MINT_PUBKEY in env, AND the VPS has no Rust/cargo-build-sbf toolchain
# so it can't run migrate-mints.sh's rebuild step.
#
# Fix: do the migration LOCALLY on the mac (where the toolchain lives), so
# the .so artifacts rsynced in step 5 already have the pinned bytes. The
# pubkeys come from the VPS-side secrets file (b64-encoded keypairs from a
# prior bootstrap or pushed-fresh from local). After deploy + bootstrap
# succeeds the EXIT trap reverts constants.rs to placeholder via
# `git checkout` so the local source tree stays clean.
#
# Skipped on --skip-build (caller is asserting the rsynced .so artifacts on
# VPS already match the on-chain mints — typical for re-bootstrap with no
# code changes; mismatch will still fire 0x178e at swap time and the
# operator should drop --skip-build).
r20_migrate_local() {
  if (( SKIP_BUILD )); then
    log "step 4.6: --skip-build set; skipping R20 local mint-pin (assuming existing .so artifacts already pinned)"
    return 0
  fi

  log "step 4.6: R20 local mint-pin (derive pubkeys from VPS secrets, rewrite constants.rs, rebuild 3 contracts)"

  if (( DRY_RUN )); then
    log "  (dry-run: skipping)"
    return 0
  fi

  # Derive RWT + USDC test-mint pubkeys from the VPS secrets file. b64
  # keypair → 64-byte raw secret → last 32 bytes are the public key. Doing
  # this server-side (over ssh) keeps the b64 secret material on the VPS
  # at rest; only the pubkey strings transit back over the SSH channel.
  local pubkeys
  pubkeys="$(ssh "$SSH_HOST" "python3 - <<'PY'
import json, base64
with open('$VPS_SECRETS_FILE') as f:
    d = json.load(f)
m = d.get('mints', {})
rwt_b64 = m.get('rwt_mint_keypair_b64', '')
usdc_b64 = m.get('usdc_test_mint_keypair_b64', '')
if not rwt_b64 or not usdc_b64:
    raise SystemExit('ERROR: VPS secrets missing rwt_mint_keypair_b64 or usdc_test_mint_keypair_b64')
rwt_raw = base64.b64decode(rwt_b64)
usdc_raw = base64.b64decode(usdc_b64)
if len(rwt_raw) != 64 or len(usdc_raw) != 64:
    raise SystemExit(f'ERROR: keypair b64 decode wrong length (rwt={len(rwt_raw)}, usdc={len(usdc_raw)})')
print(rwt_raw[32:].hex())
print(usdc_raw[32:].hex())
PY
")"

  local rwt_hex usdc_hex
  rwt_hex="$(echo "$pubkeys" | sed -n '1p')"
  usdc_hex="$(echo "$pubkeys" | sed -n '2p')"

  if [[ -z "$rwt_hex" || -z "$usdc_hex" ]]; then
    log "ERROR: failed to derive RWT/USDC pubkeys from VPS secrets"
    log "  ssh output: $pubkeys"
    exit 1
  fi

  # Convert hex → base58 locally (avoid shipping the pubkeys back through
  # another ssh round-trip).
  local rwt_pk usdc_pk
  rwt_pk="$(python3 -c "import base58; print(base58.b58encode(bytes.fromhex('$rwt_hex')).decode())")"
  usdc_pk="$(python3 -c "import base58; print(base58.b58encode(bytes.fromhex('$usdc_hex')).decode())")"

  log "  derived RWT_MINT_PUBKEY=$rwt_pk"
  log "  derived USDC_MINT_PUBKEY=$usdc_pk"

  # Mark constants.rs as mutated BEFORE running migrate-mints.sh so the EXIT
  # trap reverts the working tree even on a mid-migration crash.
  R20_MUTATED_FILES=1

  log "  running scripts/migrate-mints.sh (rewrites RWT_MINT/USDC_MINT, rebuilds 3 R20 contracts)"
  RWT_MINT_PUBKEY="$rwt_pk" USDC_MINT_PUBKEY="$usdc_pk" \
    bash "$SCRIPT_DIR/migrate-mints.sh" 2>&1 | tee -a "$LOG_FILE" \
    || { log "ERROR: migrate-mints.sh failed; see $LOG_FILE"; exit 1; }

  log "  R20 local migration OK — .so artifacts now hold pinned RWT_MINT bytes"
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

    # `solana program deploy --program-id <vanity-kp>` works for BOTH first
    # deploy (when the program does not exist yet on the validator — fresh
    # ledger) AND in-place upgrade on BPF Loader v3 (when it does). Step 4.5
    # ensures the vanity keypair files are present on the VPS at
    # /opt/areal/keys/vanity/<addr>.json. Passing a raw pubkey here would
    # fail with "Initial deployments require a keypair" on a fresh ledger.
    local vanity_kp="$VPS_REPO_ROOT/keys/vanity/${addr}.json"
    remote "$VPS_SOLANA_BIN program deploy --url $VPS_RPC_LOCAL --keypair $VPS_DEPLOYER_KP --program-id $vanity_kp $so"
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

  # bots/node_modules carries @arlex/client + tsx (the runtime for
  # scripts/lib/bootstrap-init.ts). Stale partial installs on VPS have
  # produced "Cannot find module '@arlex/client'" — refresh deps via npm ci
  # (idempotent on warm installs, ~5s; full first-install ~60s).
  log "  refreshing bots/node_modules on VPS (npm ci)"
  remote "cd $VPS_REPO_ROOT/bots && npm ci --silent"

  # bootstrap-init.ts uses NODE_PATH=$VPS_REPO_ROOT/bots/node_modules to find
  # @arlex/client. Locally npm hoists the file://vendor tarball into both
  # bots/ and sdk/ node_modules; on VPS it only lands in sdk/. Symlink it
  # into bots/ to bridge the gap (idempotent: -sfn).
  log "  ensuring @arlex/client symlink in bots/node_modules"
  remote "mkdir -p $VPS_REPO_ROOT/bots/node_modules/@arlex && ln -sfn $VPS_REPO_ROOT/sdk/node_modules/@arlex/client $VPS_REPO_ROOT/bots/node_modules/@arlex/client"

  remote "cd $VPS_REPO_ROOT && PATH=$vps_solana_dir:\$PATH KEEP_LEDGER=1 SKIP_BUILD=1 BOOTSTRAP_TARGET=localhost bash scripts/e2e-bootstrap.sh"
}

# ----------------------------------------------------------------------------
# Step 8 + 9 — open SSH tunnel + run smoke-swap from local mac, then teardown
# ----------------------------------------------------------------------------

run_smoke() {
  open_tunnel

  # Pull VPS-side bootstrap artifact down to local before running smoke.
  # smoke-swap.ts hard-codes ARTIFACT_PATH = $REPO_ROOT/data/e2e-bootstrap.json
  # — it always reads the LOCAL file, even when --rpc points elsewhere. After a
  # fresh VPS bootstrap the on-chain vault PDAs (random Keypair.generate())
  # differ from any prior LOCAL test-validator artifact; without this sync the
  # smoke sends stale local vault pubkeys to VPS RPC and the contract reverts
  # with "Arlex: wrong owner for 'vault_in'" (zero-lamport System-owned dummy
  # at the unknown address).
  log "step 8a.1: syncing VPS bootstrap artifact to local"
  if (( DRY_RUN )); then
    log "  (dry-run: skipping artifact sync)"
  else
    mkdir -p "$DATA_DIR"
    # Back up any pre-existing local artifact so a local test-validator run
    # can be restored later if desired.
    if [[ -f "$LOCAL_ARTIFACT_FILE" ]]; then
      cp -f "$LOCAL_ARTIFACT_FILE" "${LOCAL_ARTIFACT_FILE}.preFornexBackup"
      log "  backed up existing local artifact -> ${LOCAL_ARTIFACT_FILE}.preFornexBackup"
    fi
    pull_file "$VPS_ARTIFACT_FILE" "$LOCAL_ARTIFACT_FILE"
  fi

  # smoke-swap.ts also reads data/e2e-bootstrap.secrets.json to load the
  # RWT/USDC test-mint authorities (needed to mint test tokens to the smoke
  # actor). The b64 keypairs in that file must match the on-chain mints —
  # so pull the VPS-side secrets too. Same backup pattern as the artifact:
  # preserve any pre-existing local secrets in a .preFornexBackup sidecar
  # so a subsequent local verify-fresh-deploy.sh has them on hand.
  #
  # The VPS secrets file holds `deployer_keypair_path` pointing at the
  # absolute VPS path (`/opt/areal/deploy-keypair.json`). smoke-swap.ts
  # reads this path directly via `loadKeypairFromFile`, so we rewrite it
  # to the local mac path before smoke runs. The deployer keypair on
  # both sides is the same Ed25519 key (push_keypair copies from local),
  # so just pointing at the local copy works.
  log "step 8a.2: syncing VPS bootstrap secrets to local"
  if (( DRY_RUN )); then
    log "  (dry-run: skipping secrets sync)"
  else
    if [[ -f "$LOCAL_SECRETS_FILE" ]]; then
      cp -f "$LOCAL_SECRETS_FILE" "${LOCAL_SECRETS_FILE}.preFornexBackup"
      log "  backed up existing local secrets -> ${LOCAL_SECRETS_FILE}.preFornexBackup"
    fi
    pull_file "$VPS_SECRETS_FILE" "$LOCAL_SECRETS_FILE"
    chmod 0600 "$LOCAL_SECRETS_FILE"

    # Rewrite deployer_keypair_path to the local copy so smoke-swap.ts
    # can sign txns from the operator's mac.
    python3 - "$LOCAL_SECRETS_FILE" "$LOCAL_DEPLOYER_KP" <<'PY'
import json, sys
path, local_kp = sys.argv[1], sys.argv[2]
with open(path) as f:
    d = json.load(f)
d["deployer_keypair_path"] = local_kp
with open(path, "w") as f:
    json.dump(d, f, indent=2)
    f.write("\n")
PY
    log "  rewrote deployer_keypair_path -> $LOCAL_DEPLOYER_KP"
  fi

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
  r20_migrate_local
  build_contracts
  deploy_programs
  bootstrap_pools
  run_smoke

  log "Fornex deploy complete — all 9 steps green"
}

main
