#!/usr/bin/env bash
#
# e2e-bootstrap.sh — Layer 9 Substep 12 single-command bootstrap.
#
# Provisions a local Solana test-validator, deploys all 5 Areal programs at
# their canonical vanity IDs, runs the on-chain init driver to seed singletons,
# generates 4 bot keypairs, and renders `.env` files for downstream bots/tests.
#
# Required env:
#   BOOTSTRAP_TARGET=localhost   (`devnet` is reserved for Substep 13/14)
#
# Optional env knobs:
#   KEEP_LEDGER=1                Reuse existing test-ledger (warm restart)
#   SKIP_BUILD=1                 Skip `cargo build-sbf` (use existing .so files)
#   SBF_PARALLEL=1               Build the 5 programs in parallel (default sequential)
#   DEPLOYER_AIRDROP_SOL=100     Deployer airdrop in SOL (default 100)
#   CRANK_AIRDROP_SOL=5          Per-bot airdrop in SOL (default 5)
#   OT_TEST_COUNT=3              Number of test OTs to create (default 3)
#   VALIDATOR_LEDGER_DIR=...     Override ledger dir (default data/test-ledger)
#
# Outputs:
#   data/e2e-bootstrap.log       Timestamped per-stage log
#   data/e2e-bootstrap.json      Machine-readable artifact map
#   data/e2e-bootstrap.env       Sourced by cu-profile.sh + bots/.e2e tests
#   data/test-ledger/            Validator ledger
#   bots/<bot>/data/<bot>.json   Bot keypair (5 bots)
#   bots/<bot>/.env              Rendered env (5 bots)
#
# Idempotent: KEEP_LEDGER=1 reuses validator state; init driver reads PDAs
# first and skips already-initialized accounts.

set -euo pipefail

# Restrict file creation to operator-only (sec M-1 — keypairs, .env files,
# and the artifact JSON contain mint authorities + bot wallet secrets that
# must not be world-readable on shared CI runners or multi-user dev hosts).
umask 077

# ----------------------------------------------------------------------------
# Paths + globals
# ----------------------------------------------------------------------------

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT_DIR="$ROOT_DIR/scripts"
DATA_DIR="$ROOT_DIR/data"
LOG_FILE="$DATA_DIR/e2e-bootstrap.log"
ARTIFACT_FILE="$DATA_DIR/e2e-bootstrap.json"
ENV_OUT_FILE="$DATA_DIR/e2e-bootstrap.env"
LEDGER_DIR="${VALIDATOR_LEDGER_DIR:-$DATA_DIR/test-ledger}"
DEPLOYER_KP_FILE="$ROOT_DIR/deploy-keypair.json"
VANITY_DIR="$ROOT_DIR/keys/vanity"

KEEP_LEDGER="${KEEP_LEDGER:-0}"
SKIP_BUILD="${SKIP_BUILD:-0}"
SBF_PARALLEL="${SBF_PARALLEL:-0}"
DEPLOYER_AIRDROP_SOL="${DEPLOYER_AIRDROP_SOL:-100}"
CRANK_AIRDROP_SOL="${CRANK_AIRDROP_SOL:-5}"
OT_TEST_COUNT="${OT_TEST_COUNT:-3}"

# Vanity program IDs (canonical, from scripts/verify-program-ids.sh).
declare -a PROGRAMS=(
  "ownership-token:oWnqbNwmEdjNS5KVbxz8xeuGNjKMd1aiNF89d7qdARL"
  "native-dex:DEX8LmvJpjefPS1cGS9zWB9ybxN24vNjTTrusBeqyARL"
  "rwt-engine:RWT9hgbjHQDj98xP7FYsT5QYp5X32XyK6QfMRmFtARL"
  "yield-distribution:YLD9EBikcTmVCnVzdx6vuNajrDkp8tyCAgZrqTwmMXF"
  "futarchy:FUTsbsdyJmEWa5LSYHWXMr9hQFyVsrJ1agGvRQGR1ARL"
)

declare -A BOT_KEYPAIR_NAMES=(
  [revenue-crank]="revenue-crank.json"
  [convert-and-fund-crank]="convert-fund-crank.json"
  [yield-claim-crank]="yield-claim-crank.json"
  [nexus-manager]="manager.json"
  # Layer 10 substep 2 — R-J closure: pool-rebalancer needs its own dedicated
  # keypair so DEX::update_dex_config(rebalancer=...) registers a NON-deployer
  # wallet (otherwise the deployer-zero-authority audit fails — D39).
  [pool-rebalancer]="rebalancer.json"
  # Layer 10 substep 2 — RWT vault manager bot wallet (registered via
  # RWT::update_vault_manager). Lives alongside the other crank bots; the
  # actual RWT-manager process is the convert-and-fund-crank reading this
  # keypair through render-env.ts (D39 — separate from deployer for audit).
  [rwt-manager]="rwt-manager.json"
)

VALIDATOR_PID_FILE="$DATA_DIR/test-validator.pid"

mkdir -p "$DATA_DIR"

# ----------------------------------------------------------------------------
# Logging
# ----------------------------------------------------------------------------

log() {
  local ts
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '[%s] %s\n' "$ts" "$*" | tee -a "$LOG_FILE"
}

stage_start() {
  STAGE_NAME="$1"
  STAGE_T0="$(date +%s)"
  log "===== STAGE $STAGE_NAME — start ====="
}

stage_end() {
  local t1 dt
  t1="$(date +%s)"
  dt=$(( t1 - STAGE_T0 ))
  log "===== STAGE $STAGE_NAME — done (${dt}s) ====="
}

die() {
  log "FATAL: $*"
  exit 1
}

# ----------------------------------------------------------------------------
# Stage 0 — preflight
# ----------------------------------------------------------------------------

stage_preflight() {
  stage_start "0/preflight"

  : "${BOOTSTRAP_TARGET:?BOOTSTRAP_TARGET is required (localhost only for Substep 12)}"

  case "$BOOTSTRAP_TARGET" in
    localhost) ;;
    devnet)
      die "BOOTSTRAP_TARGET=devnet is Substep 13/14 territory; refusing to run."
      ;;
    *)
      die "BOOTSTRAP_TARGET must be 'localhost'; got '$BOOTSTRAP_TARGET'"
      ;;
  esac

  for tool in solana cargo-build-sbf node npm npx python3; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      die "required tool not found in PATH: $tool"
    fi
  done

  local node_major
  node_major="$(node --version | sed -E 's/^v([0-9]+).*/\1/')"
  if (( node_major < 20 )); then
    die "node >= 20 required, got $(node --version)"
  fi

  if [[ ! -d "$VANITY_DIR" ]]; then
    die "vanity keypairs missing at $VANITY_DIR — request from team (out-of-band per scripts/README.md)"
  fi
  for entry in "${PROGRAMS[@]}"; do
    local addr="${entry##*:}"
    if [[ ! -f "$VANITY_DIR/$addr.json" ]]; then
      die "vanity keypair missing: $VANITY_DIR/$addr.json"
    fi
  done

  # Numeric-knob validation (tester H-3) — guard against `CRANK_AIRDROP_SOL=abc`
  # producing cryptic bash arithmetic errors deep in stage 7.
  validate_numeric() {
    local name="$1" value="$2"
    if [[ ! "$value" =~ ^[0-9]+$ ]]; then
      die "$name must be a non-negative integer; got '$value'"
    fi
  }
  validate_numeric DEPLOYER_AIRDROP_SOL "$DEPLOYER_AIRDROP_SOL"
  validate_numeric CRANK_AIRDROP_SOL    "$CRANK_AIRDROP_SOL"
  validate_numeric OT_TEST_COUNT        "$OT_TEST_COUNT"
  validate_numeric KEEP_LEDGER          "$KEEP_LEDGER"
  validate_numeric SKIP_BUILD           "$SKIP_BUILD"
  validate_numeric SBF_PARALLEL         "$SBF_PARALLEL"

  log "tools OK: solana=$(solana --version | head -1), node=$(node --version)"
  log "BOOTSTRAP_TARGET=$BOOTSTRAP_TARGET"
  log "OT_TEST_COUNT=$OT_TEST_COUNT KEEP_LEDGER=$KEEP_LEDGER SKIP_BUILD=$SKIP_BUILD SBF_PARALLEL=$SBF_PARALLEL"

  stage_end
}

# ----------------------------------------------------------------------------
# Stage 1 — restart validator
# ----------------------------------------------------------------------------

is_validator_up() {
  solana cluster-version --url "http://127.0.0.1:8899" >/dev/null 2>&1
}

stage_validator() {
  stage_start "1/validator"

  # pkill is gated to localhost target — never devnet (preflight enforces it).
  # Sec M-3: prefer the recorded PID file over a global pkill, so we don't
  # kill an unrelated test-validator started by another project on the same
  # workstation. Fall back to pattern-match only if the PID file is missing
  # or points to a dead PID.
  if [[ "$KEEP_LEDGER" != "1" ]]; then
    log "tearing down any existing test-validator"
    if [[ -f "$VALIDATOR_PID_FILE" ]]; then
      local recorded_pid
      recorded_pid="$(cat "$VALIDATOR_PID_FILE" 2>/dev/null || echo '')"
      if [[ -n "$recorded_pid" ]] && kill -0 "$recorded_pid" 2>/dev/null; then
        log "killing recorded test-validator pid=$recorded_pid"
        kill "$recorded_pid" 2>/dev/null || true
        sleep 2
      fi
      rm -f "$VALIDATOR_PID_FILE"
    elif pgrep -f 'solana-test-validator' >/dev/null 2>&1; then
      log "no PID file; falling back to pkill -f 'solana-test-validator' (may affect other workspaces)"
      pkill -f 'solana-test-validator' || true
      sleep 2
    fi
    rm -rf "$LEDGER_DIR"
  else
    if is_validator_up; then
      log "KEEP_LEDGER=1 and validator already up; reusing"
      stage_end
      return
    fi
    log "KEEP_LEDGER=1 but validator not up; starting on existing ledger"
  fi

  mkdir -p "$LEDGER_DIR"
  log "starting solana-test-validator (ledger=$LEDGER_DIR)"

  # Background validator; captures pid so we can clean up on rerun.
  (
    cd "$DATA_DIR"
    nohup solana-test-validator \
      --quiet \
      --reset \
      --ledger "$LEDGER_DIR" \
      --rpc-port 8899 \
      --bind-address 127.0.0.1 \
      --limit-ledger-size 50000000 \
      >>"$LOG_FILE" 2>&1 &
    echo $! > "$VALIDATOR_PID_FILE"
  )

  # Wait up to 30s for RPC to come up.
  local i
  for (( i = 0; i < 60; i++ )); do
    if is_validator_up; then
      log "validator RPC up after ${i}*0.5s"
      stage_end
      return
    fi
    sleep 0.5
  done
  die "validator failed to come up within 30s; see $LOG_FILE"
}

# ----------------------------------------------------------------------------
# Stage 2 — deployer keypair + airdrop
# ----------------------------------------------------------------------------

deployer_pubkey() {
  solana-keygen pubkey "$DEPLOYER_KP_FILE"
}

stage_deployer() {
  stage_start "2/deployer"

  if [[ -f "$DEPLOYER_KP_FILE" ]]; then
    log "reusing deploy keypair: $DEPLOYER_KP_FILE"
  else
    log "generating new deploy keypair"
    solana-keygen new --no-bip39-passphrase --silent --outfile "$DEPLOYER_KP_FILE"
  fi

  local pk
  pk="$(deployer_pubkey)"
  log "deployer pubkey: $pk"

  # Airdrop loop (test-validator caps single airdrops at ~100 SOL, but warm
  # restarts may already hold the balance).
  local target_lamports
  target_lamports=$(( DEPLOYER_AIRDROP_SOL * 1000000000 ))
  local current
  current="$(solana balance --url http://127.0.0.1:8899 "$pk" --lamports 2>/dev/null | awk '{print $1}' || echo 0)"
  current="${current:-0}"
  if [[ "$current" -lt "$target_lamports" ]]; then
    log "airdropping $DEPLOYER_AIRDROP_SOL SOL to deployer"
    solana airdrop "$DEPLOYER_AIRDROP_SOL" "$pk" --url http://127.0.0.1:8899 >>"$LOG_FILE" 2>&1 || true
  else
    log "deployer already funded ($current lamports)"
  fi

  stage_end
}

# ----------------------------------------------------------------------------
# Stage 3 — cargo build-sbf
# ----------------------------------------------------------------------------

# Cross-check that the R20 sentinel agrees with the on-disk constants.rs.
# Two attack vectors close here (per SD-1 follow-up SEC-17 / A-10):
#   (a) operator runs migrate-mints.sh then `git checkout` reverts
#       constants.rs — sentinel becomes stale, build silently picks
#       no-flag mode and panics with a confusing cargo trace;
#   (b) attacker creates an empty / spoofed sentinel to flip the build
#       mode without actually pinning real bytes.
# When the sentinel is present, decode the sentinel pubkeys and compare
# them byte-for-byte against the RWT_MINT / USDC_MINT bodies in
# constants.rs. Mismatch = die with a clear remediation message.
verify_r20_sentinel() {
  local sentinel="$ROOT_DIR/data/r20-migrated.json"
  local consts="$ROOT_DIR/contracts/yield-distribution/src/constants.rs"
  python3 - "$sentinel" "$consts" <<'PY'
import json, re, sys
try:
    import base58
except Exception as e:
    print(f"ERROR: python3 base58 module missing ({e}); cannot verify R20 sentinel", file=sys.stderr)
    sys.exit(1)
sentinel_path, consts_path = sys.argv[1], sys.argv[2]
try:
    with open(sentinel_path) as f:
        d = json.load(f)
except Exception as e:
    print(f"ERROR: failed to parse {sentinel_path}: {e}", file=sys.stderr)
    sys.exit(1)
rwt_pk, usdc_pk = d.get("rwt"), d.get("usdc")
if not rwt_pk or not usdc_pk:
    print(f"ERROR: {sentinel_path} missing 'rwt' or 'usdc' field", file=sys.stderr)
    sys.exit(1)
with open(consts_path) as f:
    src = f.read()
def expected_body(pubkey):
    raw = base58.b58decode(pubkey)
    if len(raw) != 32:
        raise ValueError(f"{pubkey} decodes to {len(raw)} bytes, expected 32")
    lines = []
    for chunk_start in range(0, 32, 8):
        chunk = raw[chunk_start:chunk_start + 8]
        lines.append("    " + ", ".join(f"0x{b:02x}" for b in chunk) + ",")
    return "\n".join(lines)
def actual_body(name):
    m = re.search(r'(?m)^pub const ' + re.escape(name) + r': \[u8; 32\] = \[(.*?)\];',
                  src, re.DOTALL)
    if not m:
        return None
    return "\n".join(l.strip() for l in m.group(1).strip().splitlines())
for name, pubkey in [("RWT_MINT", rwt_pk), ("USDC_MINT", usdc_pk)]:
    exp = "\n".join(l.strip() for l in expected_body(pubkey).splitlines())
    act = actual_body(name)
    if act is None:
        print(f"ERROR: cannot find {name} const in {consts_path}", file=sys.stderr)
        sys.exit(1)
    if exp != act:
        print(f"ERROR: R20 sentinel/source out-of-sync for {name}", file=sys.stderr)
        print(f"  sentinel claims pubkey {pubkey}", file=sys.stderr)
        print(f"  but constants.rs holds different bytes", file=sys.stderr)
        print(f"  remediation: re-run scripts/migrate-mints.sh OR `rm $sentinel_path` to revert to placeholder build", file=sys.stderr)
        sys.exit(1)
print("R20 sentinel verified against constants.rs")
PY
}

build_one() {
  local crate="$1"
  log "building $crate"
  (
    cd "$ROOT_DIR/contracts/$crate"
    # R20 tripwire: yield-distribution refuses to build with the devnet
    # placeholder RWT/USDC mint bytes unless `dev-placeholder-mints` is
    # enabled. Mainnet runbook drops this flag after replacing the bytes
    # via scripts/migrate-mints.sh. We auto-detect which mode applies by
    # checking the data/r20-migrated.json sentinel; sentinel content is
    # cross-checked against constants.rs to defeat sentinel-spoofing /
    # source-revert skews (SD-1 follow-up SEC-17 / A-10).
    if [[ "$crate" == "yield-distribution" ]]; then
      if [[ -f "$ROOT_DIR/data/r20-migrated.json" ]]; then
        log "  R20: data/r20-migrated.json present → cross-checking against constants.rs"
        verify_r20_sentinel
        log "  R20: building yield-distribution WITHOUT dev-placeholder-mints"
        cargo build-sbf >>"$LOG_FILE" 2>&1
      else
        cargo build-sbf --features dev-placeholder-mints >>"$LOG_FILE" 2>&1
      fi
    else
      cargo build-sbf >>"$LOG_FILE" 2>&1
    fi
  )
}

stage_build() {
  stage_start "3/build"
  if [[ "$SKIP_BUILD" == "1" ]]; then
    log "SKIP_BUILD=1; skipping cargo build-sbf"
    stage_end
    return
  fi

  if [[ "$SBF_PARALLEL" == "1" ]]; then
    log "building 5 programs in parallel"
    local pids=()
    for entry in "${PROGRAMS[@]}"; do
      local crate="${entry%%:*}"
      build_one "$crate" &
      pids+=($!)
    done
    local rc=0
    for p in "${pids[@]}"; do
      wait "$p" || rc=1
    done
    [[ "$rc" == "0" ]] || die "one or more cargo build-sbf invocations failed; see $LOG_FILE"
  else
    for entry in "${PROGRAMS[@]}"; do
      local crate="${entry%%:*}"
      build_one "$crate"
    done
  fi

  stage_end
}

# ----------------------------------------------------------------------------
# Stage 4 — solana program deploy × 5 (sequential)
# ----------------------------------------------------------------------------

so_path_for() {
  local crate="$1"
  local snake
  snake="$(echo "$crate" | tr '-' '_')"
  echo "$ROOT_DIR/contracts/target/deploy/${snake}.so"
}

is_program_deployed() {
  local addr="$1"
  solana account "$addr" --url http://127.0.0.1:8899 >/dev/null 2>&1
}

stage_deploy() {
  stage_start "4/deploy"

  for entry in "${PROGRAMS[@]}"; do
    local crate="${entry%%:*}"
    local addr="${entry##*:}"
    local so
    so="$(so_path_for "$crate")"
    local kp="$VANITY_DIR/$addr.json"

    if [[ ! -f "$so" ]]; then
      die "missing .so artifact: $so (run with SKIP_BUILD=0)"
    fi

    if is_program_deployed "$addr"; then
      log "$crate ($addr) already deployed; skipping"
      continue
    fi

    log "deploying $crate -> $addr"
    solana program deploy \
      --url http://127.0.0.1:8899 \
      --keypair "$DEPLOYER_KP_FILE" \
      --program-id "$kp" \
      "$so" >>"$LOG_FILE" 2>&1 \
      || die "deploy failed for $crate; see $LOG_FILE"
  done

  stage_end
}

# ----------------------------------------------------------------------------
# Stage 5 — verify program IDs
# ----------------------------------------------------------------------------

stage_verify_ids() {
  stage_start "5/verify-ids"
  bash "$SCRIPT_DIR/verify-program-ids.sh" 2>&1 | tee -a "$LOG_FILE" \
    || die "verify-program-ids.sh failed"
  stage_end
}

# ----------------------------------------------------------------------------
# Stage 6 — on-chain init driver (tsx)
# ----------------------------------------------------------------------------

write_initial_artifact() {
  local pk
  pk="$(deployer_pubkey)"
  cat >"$ARTIFACT_FILE" <<EOF
{
  "bootstrap_target": "$BOOTSTRAP_TARGET",
  "rpc_url": "http://127.0.0.1:8899",
  "ws_url": "ws://127.0.0.1:8900",
  "deployer_keypair_path": "$DEPLOYER_KP_FILE",
  "deployer_pubkey": "$pk",
  "programs": {
    "ownership_token": "oWnqbNwmEdjNS5KVbxz8xeuGNjKMd1aiNF89d7qdARL",
    "native_dex": "DEX8LmvJpjefPS1cGS9zWB9ybxN24vNjTTrusBeqyARL",
    "rwt_engine": "RWT9hgbjHQDj98xP7FYsT5QYp5X32XyK6QfMRmFtARL",
    "yield_distribution": "YLD9EBikcTmVCnVzdx6vuNajrDkp8tyCAgZrqTwmMXF",
    "futarchy": "FUTsbsdyJmEWa5LSYHWXMr9hQFyVsrJ1agGvRQGR1ARL"
  }
}
EOF
}

stage_init() {
  stage_start "6/init"

  if [[ ! -f "$ARTIFACT_FILE" ]]; then
    log "writing initial artifact: $ARTIFACT_FILE"
    write_initial_artifact
  else
    # Even on warm restart, refresh deployer + RPC fields in case env changed.
    log "refreshing artifact deployer + rpc fields"
    write_initial_artifact
  fi

  log "running scripts/lib/bootstrap-init.ts (OT_TEST_COUNT=$OT_TEST_COUNT)"
  export OT_TEST_COUNT
  (
    cd "$ROOT_DIR"
    NODE_PATH="$ROOT_DIR/bots/node_modules" \
      "$ROOT_DIR/bots/node_modules/.bin/tsx" \
      "$SCRIPT_DIR/lib/bootstrap-init.ts" \
      --artifact "$ARTIFACT_FILE" \
      --ot-count "$OT_TEST_COUNT" \
      2>&1 | tee -a "$LOG_FILE"
  ) || die "bootstrap-init.ts failed; see $LOG_FILE"

  stage_end
}

# ----------------------------------------------------------------------------
# Stage 7 — bot keypairs + airdrops
# ----------------------------------------------------------------------------

stage_bots() {
  stage_start "7/bots"

  # Bootstrap the artifact file before populating the bots block, since this
  # stage runs before stage_init (per the comment in main()). Idempotent: a
  # warm restart preserves an existing artifact and refreshes deployer + RPC
  # fields, mirroring stage_init's branch.
  if [[ ! -f "$ARTIFACT_FILE" ]]; then
    log "writing initial artifact: $ARTIFACT_FILE"
    write_initial_artifact
  fi

  # Append/update bots block in the artifact via an awk one-liner per bot.
  # Layer 10 substep 2: pool-rebalancer + rwt-manager added (R-J / D39). The
  # rwt-manager keypair lives under bots/convert-and-fund-crank/data/ because
  # that crank carries the RWT-side authority calls; the pool-rebalancer has
  # its own bot directory (already exists in repo).
  for bot in revenue-crank convert-and-fund-crank yield-claim-crank nexus-manager pool-rebalancer rwt-manager; do
    local kpname="${BOT_KEYPAIR_NAMES[$bot]}"
    local botdata
    if [[ "$bot" == "rwt-manager" ]]; then
      # rwt-manager has no dedicated bot dir — colocate keypair with
      # convert-and-fund-crank (the crank that consumes the manager role).
      botdata="$ROOT_DIR/bots/convert-and-fund-crank/data"
    else
      botdata="$ROOT_DIR/bots/$bot/data"
    fi
    local kpath="$botdata/$kpname"

    mkdir -p "$botdata"
    if [[ ! -f "$kpath" ]]; then
      log "generating $bot keypair at $kpath"
      solana-keygen new --no-bip39-passphrase --silent --outfile "$kpath"
    else
      log "$bot keypair already exists at $kpath"
    fi
    local pk
    pk="$(solana-keygen pubkey "$kpath")"
    log "$bot pubkey: $pk"

    # Airdrop if needed.
    local current
    current="$(solana balance --url http://127.0.0.1:8899 "$pk" --lamports 2>/dev/null | awk '{print $1}' || echo 0)"
    current="${current:-0}"
    local target=$(( CRANK_AIRDROP_SOL * 1000000000 ))
    if [[ "$current" -lt "$target" ]]; then
      solana airdrop "$CRANK_AIRDROP_SOL" "$pk" --url http://127.0.0.1:8899 >>"$LOG_FILE" 2>&1 || true
    fi

    # Persist bot entry into artifact via python (jq isn't guaranteed).
    python3 - "$ARTIFACT_FILE" "$bot" "$kpath" "$pk" <<'PY'
import json, sys
path, bot, kpath, pk = sys.argv[1:5]
with open(path) as f:
    art = json.load(f)
art.setdefault('bots', {})[bot] = {'keypair_path': kpath, 'pubkey': pk}
with open(path, 'w') as f:
    json.dump(art, f, indent=2)
    f.write('\n')
PY
  done

  # Merkle publisher: keypair lives in bots/merkle-publisher/local-mock-keypair.json
  local mp_kp="$ROOT_DIR/bots/merkle-publisher/local-mock-keypair.json"
  if [[ ! -f "$mp_kp" ]]; then
    log "generating merkle-publisher local mock keypair"
    solana-keygen new --no-bip39-passphrase --silent --outfile "$mp_kp"
  fi
  local mp_pk
  mp_pk="$(solana-keygen pubkey "$mp_kp")"
  local current
  current="$(solana balance --url http://127.0.0.1:8899 "$mp_pk" --lamports 2>/dev/null | awk '{print $1}' || echo 0)"
  current="${current:-0}"
  local target=$(( CRANK_AIRDROP_SOL * 1000000000 ))
  if [[ "$current" -lt "$target" ]]; then
    solana airdrop "$CRANK_AIRDROP_SOL" "$mp_pk" --url http://127.0.0.1:8899 >>"$LOG_FILE" 2>&1 || true
  fi
  python3 - "$ARTIFACT_FILE" "$mp_kp" "$mp_pk" <<'PY'
import json, sys
path, kpath, pk = sys.argv[1:4]
with open(path) as f:
    art = json.load(f)
art.setdefault('bots', {})['merkle-publisher'] = {'keypair_path': kpath, 'pubkey': pk}
with open(path, 'w') as f:
    json.dump(art, f, indent=2)
    f.write('\n')
PY

  stage_end
}

# ----------------------------------------------------------------------------
# Stage 8 — render .env files
# ----------------------------------------------------------------------------

stage_render_env() {
  stage_start "8/render-env"
  (
    cd "$ROOT_DIR"
    NODE_PATH="$ROOT_DIR/bots/node_modules" \
      "$ROOT_DIR/bots/node_modules/.bin/tsx" \
      "$SCRIPT_DIR/lib/render-env.ts" \
      "$ARTIFACT_FILE" 2>&1 | tee -a "$LOG_FILE"
  ) || die "render-env.ts failed"
  stage_end
}

# ----------------------------------------------------------------------------
# Stage 9 — smoke test
# ----------------------------------------------------------------------------

stage_smoke() {
  stage_start "9/smoke"

  for entry in "${PROGRAMS[@]}"; do
    local crate="${entry%%:*}"
    local addr="${entry##*:}"
    if solana program show --url http://127.0.0.1:8899 "$addr" >>"$LOG_FILE" 2>&1; then
      log "smoke OK: $crate ($addr)"
    else
      die "smoke FAIL: $crate ($addr) not visible"
    fi
  done

  # Nexus PDA presence (best-effort — Layer 9 IDL may not be regenerated yet).
  python3 - "$ARTIFACT_FILE" <<'PY' || true
import json, sys, urllib.request

path = sys.argv[1]
with open(path) as f:
    art = json.load(f)
nexus = (art.get('pdas') or {}).get('liquidity_nexus')
if not nexus:
    print('[smoke] LiquidityNexus PDA not in artifact; skipping (Layer 9 init was best-effort)')
    sys.exit(0)
req = {
    "jsonrpc": "2.0", "id": 1,
    "method": "getAccountInfo",
    "params": [nexus, {"encoding": "base64"}]
}
import json as J
body = J.dumps(req).encode()
r = urllib.request.Request(art['rpc_url'], data=body, headers={'Content-Type': 'application/json'})
with urllib.request.urlopen(r, timeout=5) as resp:
    data = json.load(resp)
if data.get('result', {}).get('value'):
    print(f'[smoke] LiquidityNexus PDA {nexus} present')
else:
    print(f'[smoke] LiquidityNexus PDA {nexus} ABSENT (init skipped or failed)')
PY

  stage_end
}

# ----------------------------------------------------------------------------
# Stage 10 — summary + env file
# ----------------------------------------------------------------------------

write_env_export_file() {
  python3 - "$ARTIFACT_FILE" "$ENV_OUT_FILE" <<'PY'
import json, sys
ai, ao = sys.argv[1:3]
with open(ai) as f:
    art = json.load(f)
lines = []
lines.append(f"# generated by scripts/e2e-bootstrap.sh — sourced by cu-profile.sh + bots/.e2e tests")
lines.append(f"export RPC_URL={art['rpc_url']}")
lines.append(f"export WS_URL={art.get('ws_url','ws://127.0.0.1:8900')}")
lines.append(f"export OT_PROGRAM_ID={art['programs']['ownership_token']}")
lines.append(f"export YD_PROGRAM_ID={art['programs']['yield_distribution']}")
lines.append(f"export RWT_ENGINE_PROGRAM_ID={art['programs']['rwt_engine']}")
lines.append(f"export DEX_PROGRAM_ID={art['programs']['native_dex']}")
lines.append(f"export FUTARCHY_PROGRAM_ID={art['programs']['futarchy']}")
lines.append(f"export CRANK_KEYPAIR={art['deployer_keypair_path']}")
mints = art.get('mints') or {}
if mints.get('usdc_test_mint'):
    lines.append(f"export USDC_MINT={mints['usdc_test_mint']}")
if mints.get('rwt_mint'):
    lines.append(f"export RWT_MINT={mints['rwt_mint']}")
if mints.get('arl_ot_mint'):
    lines.append(f"export ARL_OT_MINT={mints['arl_ot_mint']}")
pdas = art.get('pdas') or {}
if pdas.get('master_pool'):
    lines.append(f"export MASTER_RWT_USDC_POOL={pdas['master_pool']}")
lines.append("export E2E_BOOTSTRAP_DONE=1")
with open(ao, 'w') as f:
    f.write('\n'.join(lines) + '\n')
PY
  log "wrote env exports: $ENV_OUT_FILE"
}

stage_summary() {
  stage_start "10/summary"
  write_env_export_file

  log ""
  log "================ Bootstrap Complete ================"
  log "Artifact:   $ARTIFACT_FILE"
  log "Env file:   $ENV_OUT_FILE"
  log "Log file:   $LOG_FILE"
  log "Validator:  http://127.0.0.1:8899 (pid file: $VALIDATOR_PID_FILE)"
  log ""
  log "Next steps:"
  log "  source $ENV_OUT_FILE"
  log "  cd bots && npm test --workspaces --if-present     # in-budget tests"
  log "  npx tsx bots/.e2e/layer-08-e2e.test.ts            # gated E2E"
  log "===================================================="

  python3 - "$ARTIFACT_FILE" <<'PY' | tee -a "$LOG_FILE"
import json, sys
with open(sys.argv[1]) as f:
    art = json.load(f)
skipped = art.get('init_skipped') or []
if skipped:
    print(f'[summary] init steps skipped: {len(skipped)}')
    for s in skipped:
        print(f'  - {s}')
else:
    print('[summary] no init steps skipped')
PY

  stage_end
}

# ----------------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------------

main() {
  : >"$LOG_FILE"
  log "scripts/e2e-bootstrap.sh started (root=$ROOT_DIR)"
  stage_preflight
  stage_validator
  stage_deployer
  stage_build
  stage_deploy
  stage_verify_ids
  # Stage ordering invariant (Layer 10 substep 2 follow-up A-13):
  # stage_bots MUST run before stage_init. bootstrap-init.ts phaseRegisterBots
  # consumes art.bots[pool-rebalancer] and art.bots[rwt-manager]; if stage_init
  # ran first on a cold KEEP_LEDGER=0 ledger, those keypairs would be missing
  # and Phase 6 registrations would silently push to init_skipped (no-op).
  # Keep stage_bots first; init is read-only on bot keypair generation, so
  # there is no reverse dependency.
  stage_bots
  stage_init
  stage_render_env
  stage_smoke
  stage_summary
}

main "$@"
