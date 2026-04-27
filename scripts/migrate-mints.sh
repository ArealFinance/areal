#!/usr/bin/env bash
#
# migrate-mints.sh — R20 closure tool (devnet rehearsal AND mainnet ceremony).
#
# Replaces the placeholder RWT_MINT / USDC_MINT byte arrays in
# contracts/yield-distribution/src/constants.rs with the real deployed mint
# pubkeys, then rebuilds yield-distribution WITHOUT the
# `dev-placeholder-mints` feature so the R20 tripwire validates the
# replacement at compile time.
#
# Reference:
#   contracts/yield-distribution/Cargo.toml — R20 tripwire comment block.
#   contracts/yield-distribution/src/constants.rs — `is_rwt_placeholder` /
#     `is_usdc_placeholder` const fns gated behind
#     `cfg(not(feature = "dev-placeholder-mints"))`.
#
# Required env:
#   RWT_MINT_PUBKEY=<base58>     Real RWT mint pubkey (deployer output)
#   USDC_MINT_PUBKEY=<base58>    Real USDC mint pubkey (canonical)
#
# Behavior:
#   1. Validates env vars match Solana base58 alphabet (32-44 char range).
#   2. Decodes both pubkeys to [u8; 32] byte arrays (rejects non-32-byte).
#   3. Backs up constants.rs to data/constants.rs.bak.<ts>.
#   4. In-place replaces RWT_MINT / USDC_MINT consts in constants.rs.
#   5. Re-reads the file and asserts the new bytes round-trip equal to input.
#   6. Runs `cargo clean -p yield-distribution` then `cargo build-sbf` from
#      contracts/yield-distribution WITHOUT `dev-placeholder-mints`. If the
#      bytes still match the placeholder pattern the tripwire fires. On
#      build failure the backup is restored automatically.
#   7. Verifies yield_distribution.so artifact exists post-build.
#   8. Emits data/r20-migrated.json sentinel + echoes a confirmation line.
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
CONSTANTS_FILE="$ROOT_DIR/contracts/yield-distribution/src/constants.rs"
SENTINEL_FILE="$DATA_DIR/r20-migrated.json"
LOCK_FILE="$DATA_DIR/migrate-mints.lock"
LOG_FILE="$DATA_DIR/migrate-mints.log"
BUILD_ARTIFACT="$ROOT_DIR/contracts/yield-distribution/target/deploy/yield_distribution.so"

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

# Single combined cleanup: release lock + (optionally) restore the
# constants.rs backup if the script exited non-zero after the backup
# was created. BACKUP_FILE is set later; cleanup checks for its
# existence before attempting restore.
cleanup() {
  local rc=$?
  if [[ -n "${BACKUP_FILE:-}" && -f "$BACKUP_FILE" && $rc -ne 0 && "${MIGRATION_OK:-0}" != "1" ]]; then
    log "ERROR: migration failed (rc=$rc); restoring constants.rs from backup"
    cp "$BACKUP_FILE" "$CONSTANTS_FILE"
  fi
  rmdir "$LOCK_DIR" 2>/dev/null || true
}
trap cleanup EXIT

# Idempotency check: matching sentinel means we're done. Sentinel content
# is passed via argv (NOT shell interpolation in the heredoc) so a
# malicious env var cannot inject Python.
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

# Backup constants.rs before any mutation. On any error after this point,
# the trap restores the original — this prevents leaving the file in a
# corrupted state that a follow-up `cargo build` might silently pick up.
TS_FILE="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_FILE="$DATA_DIR/constants.rs.bak.$TS_FILE"
cp "$CONSTANTS_FILE" "$BACKUP_FILE"
chmod 600 "$BACKUP_FILE"
log "backed up constants.rs -> $BACKUP_FILE"

stage_start "rewrite-constants"
# In-place replace RWT_MINT / USDC_MINT bodies. Regex requires line-anchored
# `^pub const ...` so it cannot match an inline reference inside a comment
# or test fixture. After rewrite the script re-reads the file and asserts
# the new byte body matches the requested input byte-for-byte.
RWT_BYTES="$RWT_BYTES" USDC_BYTES="$USDC_BYTES" python3 - "$CONSTANTS_FILE" <<'PY'
import os, re, sys
path = sys.argv[1]
with open(path) as f:
    src = f.read()

def sub_const(name, body, text):
    pattern = re.compile(
        r'(?m)^(pub const ' + re.escape(name) + r': \[u8; 32\] = \[)[^\]]*?(\];)',
        re.DOTALL,
    )
    new_block = r'\1\n' + body + r'\n\2'
    out, n = pattern.subn(new_block, text, count=1)
    if n != 1:
        print(f"ERROR: failed to locate {name} const in {path}", file=sys.stderr)
        sys.exit(1)
    return out

src = sub_const("RWT_MINT", os.environ["RWT_BYTES"], src)
src = sub_const("USDC_MINT", os.environ["USDC_BYTES"], src)
with open(path, "w") as f:
    f.write(src)

# Post-write byte verification: re-read the file and assert the body
# matches what we asked for. Defends against regex over-match silently
# editing the wrong block.
with open(path) as f:
    written = f.read()
for name, expected in [("RWT_MINT", os.environ["RWT_BYTES"]),
                       ("USDC_MINT", os.environ["USDC_BYTES"])]:
    m = re.search(
        r'(?m)^pub const ' + re.escape(name) + r': \[u8; 32\] = \[(.*?)\];',
        written, re.DOTALL)
    if not m:
        print(f"ERROR: post-write verification could not find {name}", file=sys.stderr)
        sys.exit(1)
    got_body = m.group(1).strip().splitlines()
    expected_body = expected.strip().splitlines()
    if [l.strip() for l in got_body] != [l.strip() for l in expected_body]:
        print(f"ERROR: post-write byte mismatch for {name}", file=sys.stderr)
        print(f"expected:\n{expected}\ngot:\n{m.group(1)}", file=sys.stderr)
        sys.exit(1)
print(f"rewrote and verified RWT_MINT and USDC_MINT in {path}")
PY
stage_end

stage_start "rebuild-sbf"
log "cargo clean -p yield-distribution (force fresh build, defeat artifact cache)"
(cd "$ROOT_DIR/contracts/yield-distribution" && cargo clean -p yield-distribution >>"$LOG_FILE" 2>&1)
log "rebuilding yield-distribution WITHOUT dev-placeholder-mints (R20 tripwire active)"
(cd "$ROOT_DIR/contracts/yield-distribution" && cargo build-sbf 2>&1 | tee -a "$LOG_FILE")
if [[ ! -f "$BUILD_ARTIFACT" ]]; then
  echo "ERROR: build artifact missing at $BUILD_ARTIFACT" >&2
  exit 1
fi
log "build artifact present: $BUILD_ARTIFACT"
stage_end

# Mutation succeeded; flag so cleanup trap doesn't restore the backup.
MIGRATION_OK=1

stage_start "sentinel"
TS_NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
python3 - "$SENTINEL_FILE" "$RWT_MINT_PUBKEY" "$USDC_MINT_PUBKEY" "$TS_NOW" <<'PY'
import json, sys
path, rwt, usdc, ts = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
with open(path, "w") as f:
    json.dump({"rwt": rwt, "usdc": usdc, "migrated_at": ts}, f, indent=2)
PY
chmod 600 "$SENTINEL_FILE"
stage_end

log "R20 closed: RWT=$RWT_MINT_PUBKEY, USDC=$USDC_MINT_PUBKEY"
