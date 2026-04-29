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
# Required env:
#   RWT_MINT_PUBKEY=<base58>     Real RWT mint pubkey (deployer output)
#   USDC_MINT_PUBKEY=<base58>    Real USDC mint pubkey (canonical)
#
# Behavior:
#   1. Validates env vars match Solana base58 alphabet (32-44 char range).
#   2. Decodes both pubkeys to [u8; 32] byte arrays (rejects non-32-byte).
#   3. Backs up the 3 constants.rs files to data/<crate>-constants.rs.bak.<ts>.
#   4. In-place replaces RWT_MINT (3 files) + USDC_MINT (yield-distribution
#      only — DEX has a placeholder pattern that the patcher tolerates,
#      OT has no USDC_MINT const at all).
#   5. Re-reads each file and asserts the new bytes round-trip equal to
#      the requested input byte-for-byte.
#   6. Runs `cargo build-sbf` for each of the 3 crates. yield-distribution
#      is rebuilt WITHOUT `dev-placeholder-mints` so the R20 tripwire
#      fires on bad input. On any build failure the trap restores ALL 3
#      backups.
#   7. Verifies the 3 .so artifacts exist post-build:
#        contracts/target/deploy/yield_distribution.so
#        contracts/target/deploy/native_dex.so
#        contracts/target/deploy/ownership_token.so
#   8. Emits data/r20-migrated.json sentinel (v2 schema with per-contract
#      pin metadata) + echoes a confirmation line.
#
# Idempotency:
#   If data/r20-migrated.json already exists with matching pubkeys, the
#   script no-ops and echoes "already migrated".
#
# Concurrency:
#   flock on data/migrate-mints.lock guards against concurrent runs.

set -euo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="$ROOT_DIR/data"
CONSTANTS_FILES=(
  "$ROOT_DIR/contracts/yield-distribution/src/constants.rs"
  "$ROOT_DIR/contracts/native-dex/src/constants.rs"
  "$ROOT_DIR/contracts/ownership-token/src/constants.rs"
)
SENTINEL_FILE="$DATA_DIR/r20-migrated.json"
LOCK_FILE="$DATA_DIR/migrate-mints.lock"
LOG_FILE="$DATA_DIR/migrate-mints.log"
BUILD_ARTIFACTS=(
  "$ROOT_DIR/contracts/target/deploy/yield_distribution.so"
  "$ROOT_DIR/contracts/target/deploy/native_dex.so"
  "$ROOT_DIR/contracts/target/deploy/ownership_token.so"
)

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
# const). Regex requires line-anchored `^pub const ...` so it cannot match
# an inline reference inside a comment or test fixture. After each rewrite
# the script re-reads the file and asserts the new byte body matches the
# requested input byte-for-byte.
for src in "${CONSTANTS_FILES[@]}"; do
  crate_name="$(basename "$(dirname "$(dirname "$src")")")"
  log "rewriting $crate_name/src/constants.rs (RWT_MINT)"
  python3 - "$src" "$RWT_BYTES" <<'PY'
import re, sys
path, rwt_bytes_str = sys.argv[1], sys.argv[2]
with open(path) as f:
    src = f.read()

def sub_const(name, body, text):
    pattern = re.compile(
        r'(?m)^(pub const ' + re.escape(name) + r': \[u8; 32\] = \[)[^\]]*?(\];)',
        re.DOTALL,
    )
    new_block = r'\1\n' + body + r'\n\2'
    out, n = pattern.subn(new_block, text, count=1)
    return out, n

src, n = sub_const("RWT_MINT", rwt_bytes_str, src)
if n != 1:
    sys.stderr.write(f"FATAL: RWT_MINT not patched in {path}\n")
    sys.exit(1)
with open(path, "w") as f:
    f.write(src)
PY

  # USDC_MINT patch only for yield-distribution (native-dex placeholder is
  # a vanity-byte sentinel kept untouched; OT has no USDC_MINT const).
  if [[ "$crate_name" == "yield-distribution" ]]; then
    log "rewriting $crate_name/src/constants.rs (USDC_MINT)"
    python3 - "$src" "$USDC_BYTES" <<'PY'
import re, sys
path, usdc_bytes_str = sys.argv[1], sys.argv[2]
with open(path) as f:
    src = f.read()

pattern = re.compile(
    r'(?m)^(pub const USDC_MINT: \[u8; 32\] = \[)[^\]]*?(\];)',
    re.DOTALL,
)
new_block = r'\1\n' + usdc_bytes_str + r'\n\2'
out, n = pattern.subn(new_block, src, count=1)
if n != 1:
    sys.stderr.write(f"FATAL: USDC_MINT not patched in {path}\n")
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
# editing the wrong block.
for src in "${CONSTANTS_FILES[@]}"; do
  crate_name="$(basename "$(dirname "$(dirname "$src")")")"
  python3 - "$src" "$RWT_MINT_PUBKEY" <<'PY'
import re, sys, base58
path, rwt_pk = sys.argv[1], sys.argv[2]
with open(path) as f:
    src = f.read()
m = re.search(r'pub const RWT_MINT: \[u8; 32\] = \[([^\]]+)\];', src)
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
python3 - "${CONSTANTS_FILES[0]}" "$USDC_MINT_PUBKEY" <<'PY'
import re, sys, base58
path, usdc_pk = sys.argv[1], sys.argv[2]
with open(path) as f:
    src = f.read()
m = re.search(r'pub const USDC_MINT: \[u8; 32\] = \[([^\]]+)\];', src)
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
log "rebuilding 3 R20-pinned contracts"
for src in "${CONSTANTS_FILES[@]}"; do
  crate_dir="$(dirname "$(dirname "$src")")"
  crate_name="$(basename "$crate_dir")"
  log "  cargo build-sbf $crate_name"
  (
    cd "$crate_dir"
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
  ) || { log "ERROR: cargo build-sbf failed for $crate_name"; exit 1; }
done

# Verify all 3 .so artifacts exist.
for so in "${BUILD_ARTIFACTS[@]}"; do
  [[ -f "$so" ]] || { log "ERROR: missing artifact $so"; exit 1; }
  log "  artifact OK: $so"
done
stage_end

# Mutation succeeded; flag so cleanup trap doesn't restore the backups.
MIGRATION_OK=1

stage_start "sentinel"
log "writing sentinel: $SENTINEL_FILE"
TS_UTC="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
python3 - "$SENTINEL_FILE" "$RWT_MINT_PUBKEY" "$USDC_MINT_PUBKEY" "$TS_UTC" <<'PY'
import json, sys
path, rwt, usdc, ts = sys.argv[1:5]
sentinel = {
    "schema_version": 2,
    "rwt": rwt,
    "usdc": usdc,
    "migrated_at": ts,
    "contracts": {
        "yield-distribution": {"rwt_pinned": True, "usdc_pinned": True},
        "native-dex":         {"rwt_pinned": True, "usdc_pinned": False},
        "ownership-token":    {"rwt_pinned": True, "usdc_pinned": False},
    },
}
with open(path, "w") as f:
    json.dump(sentinel, f, indent=2)
    f.write("\n")
PY
chmod 600 "$SENTINEL_FILE"
stage_end

log "R20 closed: RWT=$RWT_MINT_PUBKEY, USDC=$USDC_MINT_PUBKEY (3 contracts pinned)"
