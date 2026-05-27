#!/usr/bin/env bash
#
# migrate-mints.sh — R20 closure tool (devnet rehearsal AND mainnet ceremony).
#
# SD-32 closure: extends the R20 mint-pin chain from a single contract
# (yield-distribution) to all 3 R20-pinned contracts:
#   - yield-distribution  (full RWT + USDC pin; gated behind
#                          `dev-placeholder-mints` feature)
#   - native-dex          (RWT-only pin; vanity-byte placeholder, no flag)
#   - ownership-token     (RWT-only pin; vanity-byte placeholder, no flag)
#
# Replaces the placeholder RWT_MINT / USDC_MINT byte arrays in the 3
# constants.rs files with the real deployed mint pubkeys, then rebuilds
# each contract. For yield-distribution this drops the
# `dev-placeholder-mints` feature so the R20 tripwire validates the
# replacement at compile time. native-dex and ownership-token have no
# feature flag — the post-write byte verify is the only gate.
#
# Reference:
#   contracts/yield-distribution/Cargo.toml — R20 tripwire comment block.
#   contracts/yield-distribution/src/constants.rs — `is_rwt_placeholder` /
#     `is_usdc_placeholder` const fns gated behind
#     `cfg(not(feature = "dev-placeholder-mints"))`.
#   contracts/native-dex/src/constants.rs       — RWT_MINT placeholder.
#   contracts/ownership-token/src/constants.rs  — RWT_MINT placeholder.
#
# CLUSTER selection (env, optional):
#   CLUSTER=mainnet (default) — Original mainnet behavior. RWT_MINT_PUBKEY +
#                               USDC_MINT_PUBKEY must be set in env. The
#                               existing flat `pub const RWT_MINT/USDC_MINT`
#                               blocks are edited in-place. Build runs
#                               WITHOUT the `--features devnet` flag and
#                               (for YD) WITHOUT `dev-placeholder-mints`,
#                               so the R20 tripwire fires on bad input.
#                               Sentinel: data/r20-migrated.json.
#
#   CLUSTER=devnet            — Reads RWT mint from data/devnet-addresses.json
#                               (`.mints.rwt`) and USDC from
#                               (`.mints.usdc`). Either env override still
#                               works (operator wins) but neither is
#                               required. Rewrites go into the
#                               `#[cfg(feature = "devnet")]` branch of each
#                               constant — if the branch doesn't exist yet,
#                               the script splits the flat block into
#                               devnet+mainnet branches on first run; on
#                               subsequent runs the existing devnet branch
#                               is updated in-place. The mainnet branch
#                               (`#[cfg(not(feature = "devnet"))]`) is
#                               NEVER touched.
#                               Build runs WITH `--features devnet`.
#                               Sentinel: data/r20-migrated.devnet.json.
#                               Optional redeploy when RPC_URL is set.
#
# Required env (per-cluster):
#   CLUSTER=mainnet → RWT_MINT_PUBKEY, USDC_MINT_PUBKEY
#   CLUSTER=devnet  → none required; ADDRESSES is the source of truth.
#
# Optional env (any cluster):
#   ADDRESSES=<path>   Override input JSON. Defaults:
#                        mainnet → (no input JSON, env-only)
#                        devnet  → data/devnet-addresses.json
#   SENTINEL=<path>    Override sentinel output path. Defaults:
#                        mainnet → data/r20-migrated.json
#                        devnet  → data/r20-migrated.devnet.json
#   RPC_URL=<url>      Devnet only: after rebuild, `solana program deploy`
#                      YD/DEX/OT to this URL using the upgrade authority
#                      (deployer keypair at keys/devnet/deployer.json).
#                      Mainnet runs ignore RPC_URL — mainnet ceremony uses
#                      a separate redeploy step in scripts/deploy.sh.
#
# Behavior (unchanged for mainnet path):
#   1. Validates env vars match Solana base58 alphabet (32-44 char range).
#   2. Decodes both pubkeys to [u8; 32] byte arrays (rejects non-32-byte).
#   3. Backs up the 3 constants.rs files to data/<crate>-constants.rs.bak.<ts>.
#   4. In-place replaces RWT_MINT (3 files) + USDC_MINT (yield-distribution
#      only). For mainnet, edits the flat block; for devnet, edits the
#      `#[cfg(feature = "devnet")]` branch (splitting the flat block on
#      first migration).
#   5. Re-reads each file and asserts the new bytes round-trip equal to
#      the requested input byte-for-byte.
#   6. Runs `cargo build-sbf` (mainnet) or `cargo build-sbf --features devnet`
#      (devnet) for each of the 3 crates. yield-distribution mainnet path
#      is rebuilt WITHOUT `dev-placeholder-mints` so the R20 tripwire fires
#      on bad input. On any build failure the trap restores ALL 3 backups.
#   7. Verifies the 3 .so artifacts exist post-build:
#        contracts/target/deploy/yield_distribution.so
#        contracts/target/deploy/native_dex.so
#        contracts/target/deploy/ownership_token.so
#   8. Emits the sentinel JSON (path depends on CLUSTER) + echoes confirmation.
#   9. Devnet only, when RPC_URL is set: invokes `solana program deploy
#      --program-id keys/devnet/<contract>.json --keypair
#      keys/devnet/deployer.json --url $RPC_URL <so>` for YD, DEX, OT.
#
# Idempotency:
#   If sentinel already exists with matching pubkeys, the script no-ops
#   and echoes "already migrated".
#
# Concurrency:
#   flock on data/migrate-mints.lock guards against concurrent runs.

set -euo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="$ROOT_DIR/data"

# Cluster selection. Default to mainnet so existing operators see no
# behavior change unless they explicitly opt in to the devnet path.
CLUSTER="${CLUSTER:-mainnet}"
case "$CLUSTER" in
  mainnet|devnet) ;;
  *) echo "ERROR: CLUSTER must be 'mainnet' or 'devnet'; got '$CLUSTER'" >&2; exit 1 ;;
esac

# R20 contract list. Mainnet ceremony covers 3 contracts (YD/DEX/OT) — the
# historical scope. Devnet bootstrap requires a 4-contract sweep that
# additionally includes rwt-engine: the mainnet rwt-engine source still
# carries the same placeholder RWT_MINT bytes as YD/OT, so CPI between
# native-dex and rwt-engine would silently DoS unless rwt-engine is also
# rewritten and redeployed alongside the other three.
if [[ "$CLUSTER" == "devnet" ]]; then
  CONSTANTS_FILES=(
    "$ROOT_DIR/contracts/yield-distribution/src/constants.rs"
    "$ROOT_DIR/contracts/native-dex/src/constants.rs"
    "$ROOT_DIR/contracts/ownership-token/src/constants.rs"
    "$ROOT_DIR/contracts/rwt-engine/src/constants.rs"
  )
  BUILD_ARTIFACTS=(
    "$ROOT_DIR/contracts/target/deploy/yield_distribution.so"
    "$ROOT_DIR/contracts/target/deploy/native_dex.so"
    "$ROOT_DIR/contracts/target/deploy/ownership_token.so"
    "$ROOT_DIR/contracts/target/deploy/rwt_engine.so"
  )
else
  CONSTANTS_FILES=(
    "$ROOT_DIR/contracts/yield-distribution/src/constants.rs"
    "$ROOT_DIR/contracts/native-dex/src/constants.rs"
    "$ROOT_DIR/contracts/ownership-token/src/constants.rs"
  )
  BUILD_ARTIFACTS=(
    "$ROOT_DIR/contracts/target/deploy/yield_distribution.so"
    "$ROOT_DIR/contracts/target/deploy/native_dex.so"
    "$ROOT_DIR/contracts/target/deploy/ownership_token.so"
  )
fi

# Per-cluster defaults for input/output paths.
if [[ "$CLUSTER" == "devnet" ]]; then
  ADDRESSES_DEFAULT="$DATA_DIR/devnet-addresses.json"
  SENTINEL_DEFAULT="$DATA_DIR/r20-migrated.devnet.json"
else
  ADDRESSES_DEFAULT=""
  SENTINEL_DEFAULT="$DATA_DIR/r20-migrated.json"
fi
ADDRESSES="${ADDRESSES:-$ADDRESSES_DEFAULT}"
SENTINEL_FILE="${SENTINEL:-$SENTINEL_DEFAULT}"
RPC_URL="${RPC_URL:-}"

LOCK_FILE="$DATA_DIR/migrate-mints.lock"
LOG_FILE="$DATA_DIR/migrate-mints.log"
DEVNET_KEY_DIR="$ROOT_DIR/keys/devnet"
DEVNET_DEPLOYER_KP="$DEVNET_KEY_DIR/deployer.json"

mkdir -p "$DATA_DIR"

# Refuse to operate inside a symlinked data dir (defence against symlink
# redirection on shared dev hosts).
if [[ -L "$DATA_DIR" ]]; then
  echo "ERROR: $DATA_DIR is a symlink, refusing to proceed" >&2
  exit 1
fi

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

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "ERROR: $name is required (base58 pubkey)" >&2
    exit 1
  fi
}

# Strict validation against Solana base58 alphabet (excludes 0/O/I/l).
# Pubkeys are exactly 32 bytes raw; base58-encoded they fall in the
# 32..44 char range. Anything else is rejected before any further
# processing — this gate closes shell-injection vectors on subsequent
# steps that interpolate the value.
validate_base58() {
  local name="$1"
  local val="${!name}"
  if ! [[ "$val" =~ ^[1-9A-HJ-NP-Za-km-z]{32,44}$ ]]; then
    echo "ERROR: $name is not a valid Solana base58 pubkey (got: ${val:0:8}...)" >&2
    exit 1
  fi
}

# Pre-flight: required Python module.
if ! python3 -c "import base58" >/dev/null 2>&1; then
  echo "ERROR: python3 'base58' module missing. Install with: pip3 install base58" >&2
  exit 1
fi

# Devnet: source unset RWT/USDC pubkeys from the addresses JSON so
# operators don't have to retype them. Env overrides still win, mirroring
# the mainnet ergonomics (env-as-source-of-truth).
if [[ "$CLUSTER" == "devnet" ]]; then
  if [[ -z "${RWT_MINT_PUBKEY:-}" || -z "${USDC_MINT_PUBKEY:-}" ]]; then
    if [[ ! -f "$ADDRESSES" ]]; then
      echo "ERROR: CLUSTER=devnet requires ADDRESSES JSON ($ADDRESSES) or" >&2
      echo "       explicit RWT_MINT_PUBKEY + USDC_MINT_PUBKEY env vars" >&2
      exit 1
    fi
    if [[ -z "${RWT_MINT_PUBKEY:-}" ]]; then
      RWT_MINT_PUBKEY="$(python3 -c "import json; d=json.load(open('$ADDRESSES')); print(d.get('mints',{}).get('rwt') or '')")"
    fi
    if [[ -z "${USDC_MINT_PUBKEY:-}" ]]; then
      USDC_MINT_PUBKEY="$(python3 -c "import json; d=json.load(open('$ADDRESSES')); print(d.get('mints',{}).get('usdc') or '')")"
    fi
    if [[ -z "$RWT_MINT_PUBKEY" || -z "$USDC_MINT_PUBKEY" ]]; then
      echo "ERROR: CLUSTER=devnet: ADDRESSES JSON $ADDRESSES missing .mints.rwt or .mints.usdc" >&2
      echo "       run scripts/deploy-devnet.sh after mint creation to populate these fields" >&2
      exit 1
    fi
    export RWT_MINT_PUBKEY USDC_MINT_PUBKEY
  fi
fi

require_env RWT_MINT_PUBKEY
require_env USDC_MINT_PUBKEY
validate_base58 RWT_MINT_PUBKEY
validate_base58 USDC_MINT_PUBKEY

# Acquire concurrency lock. macOS does not ship `flock`, so we use a
# directory-create as the atomic lock primitive (mkdir is guaranteed
# atomic on POSIX, including HFS+/APFS).
LOCK_DIR="$LOCK_FILE.d"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "ERROR: another migrate-mints.sh run holds $LOCK_DIR" >&2
  exit 1
fi

# Track per-file backups for the 3 R20-pinned contracts so the trap can
# restore each individually on any failure after the backup stage.
declare -a BACKUP_FILES=()
MIGRATION_OK=0

# Combined cleanup: release lock + (optionally) restore ALL 3 constants.rs
# backups if the script exited non-zero after the backups were created.
cleanup() {
  local rc=$?
  if (( rc != 0 )) && [[ "${MIGRATION_OK:-0}" != "1" ]] && (( ${#BACKUP_FILES[@]} > 0 )); then
    log "ERROR: migration failed (rc=$rc); restoring constants.rs files from backups"
    for i in "${!BACKUP_FILES[@]}"; do
      local bak="${BACKUP_FILES[$i]}"
      local orig="${CONSTANTS_FILES[$i]}"
      if [[ -f "$bak" ]]; then
        cp "$bak" "$orig"
        log "  restored $orig"
      fi
    done
  fi
  rmdir "$LOCK_DIR" 2>/dev/null || true
}
trap cleanup EXIT

# Idempotency check: matching sentinel means we're done. Sentinel content
# is passed via argv (NOT shell interpolation in the heredoc) so a
# malicious env var cannot inject Python.
#
# Note: v2 sentinel keeps the v1 top-level "rwt"/"usdc" keys for backward-compat
# with e2e-bootstrap.sh::verify_r20_sentinel. The new "contracts" + "schema_version"
# fields are additive and ignored by v1 readers.
if [[ -f "$SENTINEL_FILE" ]]; then
  if python3 - "$SENTINEL_FILE" "$RWT_MINT_PUBKEY" "$USDC_MINT_PUBKEY" <<'PY'
import json, sys
path, rwt, usdc = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    with open(path) as f:
        d = json.load(f)
except Exception:
    sys.exit(1)
sys.exit(0 if d.get("rwt") == rwt and d.get("usdc") == usdc else 1)
PY
  then
    log "already migrated (sentinel matches): RWT=$RWT_MINT_PUBKEY USDC=$USDC_MINT_PUBKEY"
    exit 0
  fi
  log "WARN: sentinel exists with different pubkeys; re-running migration"
fi

# Decode base58 pubkey to formatted Rust [u8; 32] body (4 lines x 8 bytes).
# Pubkey is passed via argv to avoid shell interpolation in the heredoc.
decode_to_rust() {
  local pubkey="$1"
  python3 - "$pubkey" <<'PY'
import sys, base58
pk = sys.argv[1]
try:
    raw = base58.b58decode(pk)
except Exception as e:
    print(f"ERROR: pubkey '{pk}' is not valid base58: {e}", file=sys.stderr)
    sys.exit(1)
if len(raw) != 32:
    print(f"ERROR: pubkey '{pk}' decodes to {len(raw)} bytes, expected 32", file=sys.stderr)
    sys.exit(1)
lines = []
for chunk_start in range(0, 32, 8):
    chunk = raw[chunk_start:chunk_start + 8]
    lines.append("    " + ", ".join(f"0x{b:02x}" for b in chunk) + ",")
print("\n".join(lines))
PY
}

stage_start "decode"
RWT_BYTES="$(decode_to_rust "$RWT_MINT_PUBKEY")"
USDC_BYTES="$(decode_to_rust "$USDC_MINT_PUBKEY")"
log "decoded RWT_MINT_PUBKEY ($RWT_MINT_PUBKEY) -> 32 bytes"
log "decoded USDC_MINT_PUBKEY ($USDC_MINT_PUBKEY) -> 32 bytes"
stage_end

# Backup the 3 constants.rs files before any mutation. On any error after
# this point, the trap restores all originals — this prevents leaving
# files in a corrupted state that a follow-up `cargo build` might silently
# pick up.
stage_start "backup"
TS_FILE="$(date -u +%Y%m%dT%H%M%SZ)"
for src in "${CONSTANTS_FILES[@]}"; do
  crate_name="$(basename "$(dirname "$(dirname "$src")")")"
  bak="$DATA_DIR/${crate_name}-constants.rs.bak.$TS_FILE"
  cp "$src" "$bak"
  chmod 600 "$bak"
  BACKUP_FILES+=("$bak")
  log "backed up $crate_name constants.rs -> $bak"
done
stage_end

stage_start "rewrite-constants"
# In-place replace RWT_MINT in all 3 files; USDC_MINT in yield-distribution
# only (native-dex carries a USDC placeholder pattern but the contract
# treats it as a vanity-byte sentinel; ownership-token has no USDC_MINT
# const).
#
# Mainnet path (CLUSTER=mainnet): edits the flat `pub const RWT_MINT/
# USDC_MINT` block in place. Identical to pre-CLUSTER-parameterization
# behavior.
#
# Devnet path (CLUSTER=devnet): edits ONLY the `#[cfg(feature = "devnet")]`
# branch of each constant. If no devnet branch exists yet (the file still
# has a flat block from a fresh checkout), the patcher splits the flat
# block into devnet/not(devnet) branches on first run; on subsequent runs
# the existing devnet branch is updated and the mainnet branch is left
# untouched. Regex requires line-anchored `^pub const ...` (or
# `^#[cfg(...)]`) so it cannot match an inline reference inside a comment
# or test fixture. After each rewrite the script re-reads the file and
# asserts the new byte body matches the requested input byte-for-byte.
for src in "${CONSTANTS_FILES[@]}"; do
  crate_name="$(basename "$(dirname "$(dirname "$src")")")"
  log "rewriting $crate_name/src/constants.rs (RWT_MINT, cluster=$CLUSTER)"
  python3 - "$src" "$RWT_BYTES" "$CLUSTER" <<'PY'
import re, sys
path, rwt_bytes_str, cluster = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path) as f:
    src = f.read()

def patch_flat(name, body, text):
    """Edit a flat `pub const NAME: [u8; 32] = [...];` block in place."""
    pattern = re.compile(
        r'(?m)^(pub const ' + re.escape(name) + r': \[u8; 32\] = \[)[^\]]*?(\];)',
        re.DOTALL,
    )
    new_block = r'\1\n' + body + r'\n\2'
    return pattern.subn(new_block, text, count=1)

def patch_devnet_branch(name, body, text):
    """Edit only the `#[cfg(feature = "devnet")] pub const NAME ...` branch.

    Returns (new_text, n) where n is the number of substitutions made.
    Returns n=0 if no devnet branch is present (caller should fall back
    to split-flat-block).
    """
    pattern = re.compile(
        r'(?m)^(#\[cfg\(feature\s*=\s*"devnet"\)\]\s*\npub const '
        + re.escape(name)
        + r': \[u8; 32\] = \[)[^\]]*?(\];)',
        re.DOTALL,
    )
    new_block = r'\1\n' + body + r'\n\2'
    return pattern.subn(new_block, text, count=1)

def split_flat_into_branches(name, devnet_body, text):
    """Convert a flat `pub const NAME: [u8;32] = [old_bytes];` block into:

        #[cfg(feature = "devnet")]
        pub const NAME: [u8; 32] = [
            <devnet_body>
        ];
        #[cfg(not(feature = "devnet"))]
        pub const NAME: [u8; 32] = [
            <old_body>
        ];

    The original (mainnet) bytes are preserved in the `cfg(not(devnet))`
    branch — this is the FIRST-RUN devnet path that converts a previously
    cluster-agnostic constants.rs into a dual-cluster file.
    """
    pattern = re.compile(
        r'(?m)^pub const ' + re.escape(name) + r': \[u8; 32\] = \[([^\]]+?)\];',
        re.DOTALL,
    )
    m = pattern.search(text)
    if not m:
        return text, 0
    old_body = m.group(1).rstrip('\n').lstrip('\n')
    replacement = (
        '#[cfg(feature = "devnet")]\n'
        f'pub const {name}: [u8; 32] = [\n'
        f'{devnet_body}\n'
        '];\n'
        '#[cfg(not(feature = "devnet"))]\n'
        f'pub const {name}: [u8; 32] = [{old_body}];'
    )
    return pattern.sub(replacement, text, count=1), 1

if cluster == "devnet":
    # Try edit the existing devnet branch; if absent, split the flat block.
    out, n = patch_devnet_branch("RWT_MINT", rwt_bytes_str, src)
    if n == 0:
        out, n = split_flat_into_branches("RWT_MINT", rwt_bytes_str, src)
else:
    out, n = patch_flat("RWT_MINT", rwt_bytes_str, src)

if n != 1:
    sys.stderr.write(f"FATAL: RWT_MINT not patched in {path} (cluster={cluster})\n")
    sys.exit(1)
with open(path, "w") as f:
    f.write(out)
PY

  # USDC_MINT patch only for yield-distribution (native-dex placeholder is
  # a vanity-byte sentinel kept untouched; OT has no USDC_MINT const).
  if [[ "$crate_name" == "yield-distribution" ]]; then
    log "rewriting $crate_name/src/constants.rs (USDC_MINT, cluster=$CLUSTER)"
    python3 - "$src" "$USDC_BYTES" "$CLUSTER" <<'PY'
import re, sys
path, usdc_bytes_str, cluster = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path) as f:
    src = f.read()

def patch_flat(text):
    pattern = re.compile(
        r'(?m)^(pub const USDC_MINT: \[u8; 32\] = \[)[^\]]*?(\];)',
        re.DOTALL,
    )
    new_block = r'\1\n' + usdc_bytes_str + r'\n\2'
    return pattern.subn(new_block, text, count=1)

def patch_devnet_branch(text):
    pattern = re.compile(
        r'(?m)^(#\[cfg\(feature\s*=\s*"devnet"\)\]\s*\npub const '
        r'USDC_MINT: \[u8; 32\] = \[)[^\]]*?(\];)',
        re.DOTALL,
    )
    new_block = r'\1\n' + usdc_bytes_str + r'\n\2'
    return pattern.subn(new_block, text, count=1)

def split_flat_into_branches(text):
    pattern = re.compile(
        r'(?m)^pub const USDC_MINT: \[u8; 32\] = \[([^\]]+?)\];',
        re.DOTALL,
    )
    m = pattern.search(text)
    if not m:
        return text, 0
    old_body = m.group(1).rstrip('\n').lstrip('\n')
    replacement = (
        '#[cfg(feature = "devnet")]\n'
        'pub const USDC_MINT: [u8; 32] = [\n'
        f'{usdc_bytes_str}\n'
        '];\n'
        '#[cfg(not(feature = "devnet"))]\n'
        f'pub const USDC_MINT: [u8; 32] = [{old_body}];'
    )
    return pattern.sub(replacement, text, count=1), 1

if cluster == "devnet":
    out, n = patch_devnet_branch(src)
    if n == 0:
        out, n = split_flat_into_branches(src)
else:
    out, n = patch_flat(src)

if n != 1:
    sys.stderr.write(f"FATAL: USDC_MINT not patched in {path} (cluster={cluster})\n")
    sys.exit(1)
with open(path, "w") as f:
    f.write(out)
PY
  fi
done
stage_end

stage_start "verify-bytes"
# Post-write byte verification: re-read each file and assert the body
# matches what we asked for. Defends against regex over-match silently
# editing the wrong block. For CLUSTER=devnet the check targets the
# `#[cfg(feature = "devnet")]` branch; for CLUSTER=mainnet it targets
# the flat block (or the `cfg(not(devnet))` branch — same regex catches
# either because the `#[cfg(...)]` line is optional).
for src in "${CONSTANTS_FILES[@]}"; do
  crate_name="$(basename "$(dirname "$(dirname "$src")")")"
  python3 - "$src" "$RWT_MINT_PUBKEY" "$CLUSTER" <<'PY'
import re, sys, base58
path, rwt_pk, cluster = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path) as f:
    src = f.read()

if cluster == "devnet":
    # Match only the devnet branch.
    m = re.search(
        r'#\[cfg\(feature\s*=\s*"devnet"\)\]\s*\n'
        r'pub const RWT_MINT: \[u8; 32\] = \[([^\]]+)\];',
        src,
    )
    if not m:
        sys.exit(f"RWT_MINT devnet branch missing post-write in {path}")
else:
    # Mainnet — match either a flat block or the `cfg(not(devnet))` branch.
    m = re.search(
        r'(?m)^(?:#\[cfg\(not\(feature\s*=\s*"devnet"\)\)\]\s*\n)?'
        r'pub const RWT_MINT: \[u8; 32\] = \[([^\]]+)\];',
        src,
    )
    if not m:
        sys.exit(f"RWT_MINT pattern missing post-write in {path}")
bytes_text = m.group(1)
nums = [int(b.strip().replace("0x", ""), 16) for b in bytes_text.replace(",", " ").split() if b.strip()]
expected = list(base58.b58decode(rwt_pk))
if nums != expected:
    sys.exit(f"RWT_MINT bytes mismatch in {path}; expected {expected[:4]}..., got {nums[:4]}...")
PY
  log "  $crate_name RWT_MINT bytes verified"
done

# yield-distribution USDC verify (only file with USDC_MINT pinned).
python3 - "${CONSTANTS_FILES[0]}" "$USDC_MINT_PUBKEY" "$CLUSTER" <<'PY'
import re, sys, base58
path, usdc_pk, cluster = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path) as f:
    src = f.read()
if cluster == "devnet":
    m = re.search(
        r'#\[cfg\(feature\s*=\s*"devnet"\)\]\s*\n'
        r'pub const USDC_MINT: \[u8; 32\] = \[([^\]]+)\];',
        src,
    )
    if not m:
        sys.exit(f"USDC_MINT devnet branch missing in {path}")
else:
    m = re.search(
        r'(?m)^(?:#\[cfg\(not\(feature\s*=\s*"devnet"\)\)\]\s*\n)?'
        r'pub const USDC_MINT: \[u8; 32\] = \[([^\]]+)\];',
        src,
    )
    if not m:
        sys.exit(f"USDC_MINT pattern missing in {path}")
bytes_text = m.group(1)
nums = [int(b.strip().replace("0x", ""), 16) for b in bytes_text.replace(",", " ").split() if b.strip()]
expected = list(base58.b58decode(usdc_pk))
if nums != expected:
    sys.exit(f"USDC_MINT bytes mismatch in {path}")
PY
log "  yield-distribution USDC_MINT bytes verified"
stage_end

stage_start "rebuild-sbf"
log "rebuilding ${#CONSTANTS_FILES[@]} R20-pinned contracts (cluster=$CLUSTER)"
for src in "${CONSTANTS_FILES[@]}"; do
  crate_dir="$(dirname "$(dirname "$src")")"
  crate_name="$(basename "$crate_dir")"
  log "  cargo build-sbf $crate_name"
  (
    cd "$crate_dir"
    if [[ "$CLUSTER" == "devnet" ]]; then
      # Devnet build: opt in to the cluster feature flag. yield-distribution
      # additionally needs `dev-placeholder-mints` because the post-rewrite
      # devnet branch is freshly written (not yet treated as a "real"
      # production pin by the R20 tripwire). Mainnet path stays unchanged.
      if [[ "$crate_name" == "yield-distribution" ]]; then
        cargo clean -p yield-distribution >>"$LOG_FILE" 2>&1 || true
        cargo build-sbf --features devnet,dev-placeholder-mints >>"$LOG_FILE" 2>&1
      else
        cargo build-sbf --features devnet >>"$LOG_FILE" 2>&1
      fi
    else
      if [[ "$crate_name" == "yield-distribution" ]]; then
        # YD uses dev-placeholder-mints feature in development; rebuild
        # WITHOUT it post-R20 so the compile-time tripwire fires if the
        # placeholder bytes survived the rewrite.
        cargo clean -p yield-distribution >>"$LOG_FILE" 2>&1 || true
        cargo build-sbf >>"$LOG_FILE" 2>&1
      else
        # native-dex + ownership-token have no feature flag; standard build.
        cargo build-sbf >>"$LOG_FILE" 2>&1
      fi
    fi
  ) || { log "ERROR: cargo build-sbf failed for $crate_name"; exit 1; }
done

# Verify all 3 .so artifacts exist.
for so in "${BUILD_ARTIFACTS[@]}"; do
  [[ -f "$so" ]] || { log "ERROR: missing artifact $so"; exit 1; }
  log "  artifact OK: $so"
done
stage_end

# Optional: devnet redeploy. When RPC_URL is set and CLUSTER=devnet, push
# the freshly built .so files to the on-chain program IDs using the devnet
# deployer keypair. Skipped in mainnet mode — mainnet ceremony uses a
# separate redeploy step in scripts/deploy.sh::redeploy_r20_contracts.
if [[ "$CLUSTER" == "devnet" && -n "$RPC_URL" ]]; then
  stage_start "devnet-redeploy"
  [[ -f "$DEVNET_DEPLOYER_KP" ]] || { log "ERROR: devnet deployer keypair missing: $DEVNET_DEPLOYER_KP"; exit 1; }

  # Short-name -> .so filename + keypair filename. Matches deploy-devnet.sh.
  declare -A DEVNET_REDEPLOY_SO=(
    [yield-distribution]="yield_distribution.so"
    [native-dex]="native_dex.so"
    [ownership-token]="ownership_token.so"
    [rwt-engine]="rwt_engine.so"
  )
  for short in yield-distribution native-dex ownership-token rwt-engine; do
    so="$ROOT_DIR/contracts/target/deploy/${DEVNET_REDEPLOY_SO[$short]}"
    kp="$DEVNET_KEY_DIR/${short}.json"
    [[ -f "$kp" ]] || { log "ERROR: missing devnet program keypair $kp"; exit 1; }
    log "  redeploying $short -> $(solana-keygen pubkey "$kp") via $RPC_URL"
    solana program deploy \
      --url "$RPC_URL" \
      --keypair "$DEVNET_DEPLOYER_KP" \
      --program-id "$kp" \
      "$so" >>"$LOG_FILE" 2>&1 \
      || { log "ERROR: redeploy failed for $short; see $LOG_FILE"; exit 1; }
    log "    $short redeploy OK"
  done
  stage_end
fi

# Mutation succeeded; flag so cleanup trap doesn't restore the backups.
MIGRATION_OK=1

stage_start "sentinel"
log "writing sentinel: $SENTINEL_FILE"
TS_UTC="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
python3 - "$SENTINEL_FILE" "$RWT_MINT_PUBKEY" "$USDC_MINT_PUBKEY" "$TS_UTC" "$CLUSTER" <<'PY'
import json, sys
path, rwt, usdc, ts, cluster = sys.argv[1:6]
contracts = {
    "yield-distribution": {"rwt_pinned": True, "usdc_pinned": True},
    "native-dex":         {"rwt_pinned": True, "usdc_pinned": False},
    "ownership-token":    {"rwt_pinned": True, "usdc_pinned": False},
}
# Devnet sweep additionally pins rwt-engine — mainnet rwt-engine source
# still carries the placeholder RWT_MINT and must be rewritten alongside
# the other three to keep cross-program CPIs (DEX::mint_route ->
# rwt-engine::mint_rwt) consistent on devnet.
if cluster == "devnet":
    contracts["rwt-engine"] = {"rwt_pinned": True, "usdc_pinned": False}
sentinel = {
    "schema_version": 2,
    "cluster": cluster,
    "rwt": rwt,
    "usdc": usdc,
    "migrated_at": ts,
    "contracts": contracts,
}
with open(path, "w") as f:
    json.dump(sentinel, f, indent=2)
    f.write("\n")
PY
chmod 600 "$SENTINEL_FILE"
stage_end

contract_count="${#CONSTANTS_FILES[@]}"
log "R20 closed (cluster=$CLUSTER): RWT=$RWT_MINT_PUBKEY, USDC=$USDC_MINT_PUBKEY ($contract_count contracts pinned)"
