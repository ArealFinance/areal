#!/usr/bin/env bash
#
# verify-program-ids.sh — R12 from Layer 8 decisions log.
#
# Each contract crate pins cross-program IDs as `[u8; 32]` byte arrays so the
# arlex `#[account]` / CPI-invoke macros can resolve them at parse time.
# The same vanity addresses live in multiple files; if anyone hand-edits one
# without the others, CPI dispatch silently breaks (mismatched program IDs
# revert as `InvalidArgument` with no clear root cause).
#
# This script re-derives each `*_PROGRAM_ID` constant from the canonical
# vanity base58 string and asserts byte-equality against every shadow copy
# across the workspace. Drift fails CI.
#
# Run: scripts/verify-program-ids.sh
# Exit 0 = all constants match; 1 = drift detected.

set -euo pipefail

# ---------------------------------------------------------------------------
# Canonical vanity addresses (single source of truth).
#
# These match `declare_id!(...)` in each crate's `src/lib.rs`. The base58
# values have been hand-vanity-mined, so the hex bytes shouldn't drift —
# this script is a tripwire, not a recomputation.
# ---------------------------------------------------------------------------

declare -A EXPECTED=(
  [OT_PROGRAM_ID]="oWnqbNwmEdjNS5KVbxz8xeuGNjKMd1aiNF89d7qdARL"
  [FUTARCHY_PROGRAM_ID]="FUTsbsdyJmEWa5LSYHWXMr9hQFyVsrJ1agGvRQGR1ARL"
  [RWT_ENGINE_PROGRAM_ID]="RWT9hgbjHQDj98xP7FYsT5QYp5X32XyK6QfMRmFtARL"
  [DEX_PROGRAM_ID]="DEX8LmvJpjefPS1cGS9zWB9ybxN24vNjTTrusBeqyARL"
  [YD_PROGRAM_ID]="YLD9EBikcTmVCnVzdx6vuNajrDkp8tyCAgZrqTwmMXF"
)

# Workspace root: parent dir of the script directory.
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ---------------------------------------------------------------------------
# Tools required: python3 (base58 decode) — pre-installed on macOS / Ubuntu.
# ---------------------------------------------------------------------------

if ! command -v python3 >/dev/null 2>&1; then
  echo "[verify-program-ids] error: python3 is required (base58 decode)." >&2
  exit 2
fi

# Decode base58 to a comma-separated list of 32 hex bytes (lowercase, 0x-prefixed).
b58_to_hex32() {
  python3 - "$1" <<'PY'
import sys
ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

def b58dec(s: str) -> bytes:
    n = 0
    for c in s:
        if c not in ALPHABET:
            raise SystemExit(f"invalid base58 char: {c!r}")
        n = n * 58 + ALPHABET.index(c)
    pad = 0
    for c in s:
        if c == '1':
            pad += 1
        else:
            break
    body = n.to_bytes((n.bit_length() + 7) // 8, "big") if n > 0 else b""
    out = b"\x00" * pad + body
    if len(out) != 32:
        raise SystemExit(f"base58 decode: expected 32 bytes, got {len(out)}")
    return out

addr = sys.argv[1]
b = b58dec(addr)
print(",".join(f"0x{x:02x}" for x in b))
PY
}

# Extract the 32-byte literal array assigned to a `pub const NAME` in a Rust
# file. Returns a comma-separated lowercase hex list, or empty string if not
# found.
extract_rust_const_bytes() {
  local file="$1"
  local name="$2"
  python3 - "$file" "$name" <<'PY'
import re
import sys

path, name = sys.argv[1], sys.argv[2]
with open(path, encoding="utf-8") as f:
    src = f.read()

# Match `pub const NAME: [u8; 32] = [ ... ];` allowing arbitrary whitespace
# and inline comments inside the bracketed literal.
pat = re.compile(
    r"pub\s+const\s+" + re.escape(name) + r"\s*:\s*\[u8;\s*32\]\s*=\s*\[(.*?)\]\s*;",
    re.DOTALL,
)
m = pat.search(src)
if not m:
    sys.exit(0)

body = m.group(1)
# Strip line / block comments.
body = re.sub(r"//[^\n]*", "", body)
body = re.sub(r"/\*.*?\*/", "", body, flags=re.DOTALL)

# Tokens: hex (0x..) or decimal integers. Hex preferred — match either.
toks = re.findall(r"0x[0-9a-fA-F]+|\d+", body)
if len(toks) != 32:
    sys.exit(f"file {path}: expected 32 byte tokens for {name}, got {len(toks)}")

vals = []
for t in toks:
    n = int(t, 16) if t.startswith("0x") else int(t, 10)
    if not (0 <= n <= 255):
        sys.exit(f"file {path}: byte out of range in {name}: {t}")
    vals.append(f"0x{n:02x}")
print(",".join(vals))
PY
}

# ---------------------------------------------------------------------------
# Main verification loop.
# ---------------------------------------------------------------------------

errors=0
checked=0

declare -A EXPECTED_HEX
for name in "${!EXPECTED[@]}"; do
  EXPECTED_HEX[$name]="$(b58_to_hex32 "${EXPECTED[$name]}")"
done

# Search every constants.rs that pins program IDs.
shopt -s nullglob
for crate_consts in \
  "$ROOT_DIR"/contracts/futarchy/src/constants.rs \
  "$ROOT_DIR"/contracts/native-dex/src/constants.rs \
  "$ROOT_DIR"/contracts/ownership-token/src/constants.rs \
  "$ROOT_DIR"/contracts/rwt-engine/src/constants.rs \
  "$ROOT_DIR"/contracts/yield-distribution/src/constants.rs; do
  if [[ ! -f "$crate_consts" ]]; then
    continue
  fi
  for name in "${!EXPECTED[@]}"; do
    actual="$(extract_rust_const_bytes "$crate_consts" "$name" || true)"
    if [[ -z "$actual" ]]; then
      # Constant not pinned in this crate (expected — not all crates pin every
      # cross-program ID). Skip silently.
      continue
    fi
    expected_hex="${EXPECTED_HEX[$name]}"
    checked=$((checked + 1))
    if [[ "$actual" != "$expected_hex" ]]; then
      echo "DRIFT  $name in $crate_consts" >&2
      echo "  expected: $expected_hex" >&2
      echo "  actual:   $actual" >&2
      errors=$((errors + 1))
    else
      echo "ok     $name in ${crate_consts#$ROOT_DIR/}"
    fi
  done
done

# ---------------------------------------------------------------------------
# Cross-check `declare_id!` in each crate's lib.rs — program's own vanity ID
# must match the expected base58 string, since each crate IS its own program.
# ---------------------------------------------------------------------------

extract_declare_id() {
  local file="$1"
  python3 - "$file" <<'PY'
import re
import sys
path = sys.argv[1]
with open(path, encoding="utf-8") as f:
    src = f.read()
m = re.search(r'declare_id!\s*\(\s*"([^"]+)"\s*\)', src)
if m:
    print(m.group(1))
PY
}

declare -A LIB_NAME=(
  ["$ROOT_DIR/contracts/ownership-token/src/lib.rs"]="OT_PROGRAM_ID"
  ["$ROOT_DIR/contracts/futarchy/src/lib.rs"]="FUTARCHY_PROGRAM_ID"
  ["$ROOT_DIR/contracts/rwt-engine/src/lib.rs"]="RWT_ENGINE_PROGRAM_ID"
  ["$ROOT_DIR/contracts/native-dex/src/lib.rs"]="DEX_PROGRAM_ID"
  ["$ROOT_DIR/contracts/yield-distribution/src/lib.rs"]="YD_PROGRAM_ID"
)

for libfile in "${!LIB_NAME[@]}"; do
  if [[ ! -f "$libfile" ]]; then
    continue
  fi
  name="${LIB_NAME[$libfile]}"
  declared="$(extract_declare_id "$libfile" || true)"
  if [[ -z "$declared" ]]; then
    echo "DRIFT  declare_id! missing in ${libfile#$ROOT_DIR/}" >&2
    errors=$((errors + 1))
    continue
  fi
  if [[ "$declared" != "${EXPECTED[$name]}" ]]; then
    echo "DRIFT  declare_id! mismatch in ${libfile#$ROOT_DIR/}" >&2
    echo "  expected: ${EXPECTED[$name]}" >&2
    echo "  actual:   $declared" >&2
    errors=$((errors + 1))
  else
    echo "ok     declare_id! ($name) in ${libfile#$ROOT_DIR/}"
    checked=$((checked + 1))
  fi
done

echo
if (( errors > 0 )); then
  echo "[verify-program-ids] FAILED: $errors drift(s) in $checked check(s)." >&2
  exit 1
fi

echo "[verify-program-ids] OK: $checked program-ID pin(s) consistent."
