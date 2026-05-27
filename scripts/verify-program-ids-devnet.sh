#!/usr/bin/env bash
#
# verify-program-ids-devnet.sh — devnet mirror of verify-program-ids.sh.
#
# The mainnet `verify-program-ids.sh` walks the canonical vanity ID list
# and asserts that every `declare_id!(...)` + cross-pinned `[u8; 32]`
# `*_PROGRAM_ID` constant in the workspace agrees with the expected
# base58 string. This devnet variant does the same for the
# `#[cfg(feature = "devnet")]` branch — it reads pubkeys from
# `keys/devnet/*.json` (the on-disk authority for devnet program IDs)
# and confirms each shows up unchanged in:
#
#   1. The matching `declare_id!(...)` under the `#[cfg(feature = "devnet")]`
#      attribute in `contracts/*/src/lib.rs`.
#   2. The `#[cfg(feature = "devnet")]` `pub const X_PROGRAM_ID: [u8; 32]`
#      cross-pins inside any sibling crate's `constants.rs`.
#
# Drift = exit non-zero. CI uses this as a tripwire before any devnet
# deploy.
#
# Run: scripts/verify-program-ids-devnet.sh
# Exit 0 = clean. Exit 1 = drift detected.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEVNET_KEY_DIR="$ROOT_DIR/keys/devnet"

if ! command -v python3 >/dev/null 2>&1; then
  echo "[verify-program-ids-devnet] error: python3 required (base58 decode)" >&2
  exit 2
fi
if ! command -v solana-keygen >/dev/null 2>&1; then
  echo "[verify-program-ids-devnet] error: solana-keygen required" >&2
  exit 2
fi

# Map short crate name -> canonical *_PROGRAM_ID constant name. Same names
# as scripts/verify-program-ids.sh — the names are cluster-independent;
# only the bytes change.
declare -A CONST_NAME=(
  [ownership-token]="OT_PROGRAM_ID"
  [futarchy]="FUTARCHY_PROGRAM_ID"
  [rwt-engine]="RWT_ENGINE_PROGRAM_ID"
  [native-dex]="DEX_PROGRAM_ID"
  [yield-distribution]="YD_PROGRAM_ID"
)

CRATES=(ownership-token futarchy rwt-engine native-dex yield-distribution)

# Load expected pubkeys from the devnet keypair files (source of truth).
declare -A EXPECTED_PK
for crate in "${CRATES[@]}"; do
  kp="$DEVNET_KEY_DIR/${crate}.json"
  [[ -f "$kp" ]] || { echo "[verify-program-ids-devnet] missing keypair: $kp" >&2; exit 2; }
  EXPECTED_PK[$crate]="$(solana-keygen pubkey "$kp")"
done

# Pre-decode each expected pubkey to a comma-separated hex byte list — used
# for cross-pin verification below.
declare -A EXPECTED_HEX
for crate in "${CRATES[@]}"; do
  EXPECTED_HEX[$crate]="$(python3 - "${EXPECTED_PK[$crate]}" <<'PY'
import sys
ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
def b58dec(s):
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
    print(",".join(f"0x{x:02x}" for x in out))
b58dec(sys.argv[1])
PY
  )"
done

# Extract the `#[cfg(feature = "devnet")]` declare_id! base58 from a lib.rs.
# Returns the base58 pubkey (string) or empty if not found.
extract_devnet_declare_id() {
  local libfile="$1"
  python3 - "$libfile" <<'PY'
import re, sys
src = open(sys.argv[1], encoding="utf-8").read()
# Find the FIRST declare_id!("...") that follows a `#[cfg(feature = "devnet")]`
# line. The mainnet branch sits behind `cfg(not(feature = "devnet"))` so it
# won't match this pattern.
m = re.search(
    r'#\[cfg\(feature\s*=\s*"devnet"\)\]\s*\n\s*declare_id!\s*\(\s*"([^"]+)"\s*\)',
    src,
)
if m:
    print(m.group(1))
PY
}

# Extract the `#[cfg(feature = "devnet")]` byte body for a given const NAME.
# Returns a comma-separated hex byte list (lowercase, 0x-prefixed), or empty
# if no such const is pinned in the file.
extract_devnet_const_bytes() {
  local file="$1"
  local name="$2"
  python3 - "$file" "$name" <<'PY'
import re, sys
path, name = sys.argv[1], sys.argv[2]
src = open(path, encoding="utf-8").read()
# Match: #[cfg(feature = "devnet")] <ws> pub const NAME: [u8; 32] = [ ... ];
pat = re.compile(
    r'#\[cfg\(feature\s*=\s*"devnet"\)\]\s*\npub\s+const\s+'
    + re.escape(name)
    + r'\s*:\s*\[u8;\s*32\]\s*=\s*\[(.*?)\]\s*;',
    re.DOTALL,
)
m = pat.search(src)
if not m:
    sys.exit(0)
body = m.group(1)
body = re.sub(r"//[^\n]*", "", body)
body = re.sub(r"/\*.*?\*/", "", body, flags=re.DOTALL)
toks = re.findall(r"0x[0-9a-fA-F]+|\d+", body)
if len(toks) != 32:
    sys.exit(f"{path}: expected 32 byte tokens for {name}, got {len(toks)}")
vals = []
for t in toks:
    n = int(t, 16) if t.startswith("0x") else int(t, 10)
    if not (0 <= n <= 255):
        sys.exit(f"{path}: byte out of range in {name}: {t}")
    vals.append(f"0x{n:02x}")
print(",".join(vals))
PY
}

errors=0
checked=0

# ----------------------------------------------------------------------------
# Pass 1: declare_id! in each crate's lib.rs (devnet branch)
# ----------------------------------------------------------------------------
echo "[verify-program-ids-devnet] checking declare_id! under #[cfg(feature = \"devnet\")]"
for crate in "${CRATES[@]}"; do
  libfile="$ROOT_DIR/contracts/$crate/src/lib.rs"
  [[ -f "$libfile" ]] || { echo "DRIFT  missing $libfile" >&2; errors=$(( errors + 1 )); continue; }
  declared="$(extract_devnet_declare_id "$libfile" || true)"
  if [[ -z "$declared" ]]; then
    echo "DRIFT  $crate: no devnet declare_id! found in $libfile" >&2
    errors=$(( errors + 1 ))
    continue
  fi
  expected="${EXPECTED_PK[$crate]}"
  checked=$(( checked + 1 ))
  if [[ "$declared" != "$expected" ]]; then
    echo "DRIFT  $crate declare_id! mismatch" >&2
    echo "  expected: $expected" >&2
    echo "  actual:   $declared" >&2
    errors=$(( errors + 1 ))
  else
    echo "ok     declare_id! ($crate) -> $declared"
  fi
done

# ----------------------------------------------------------------------------
# Pass 2: #[cfg(feature = "devnet")] cross-pinned bytes in each constants.rs
#
# Not every crate pins every cross-program ID. If a const isn't present in a
# given constants.rs (returns empty), the check is silently skipped for that
# crate — that mirrors the mainnet verifier behaviour. The grep ensures we
# only flag drift for constants that ARE pinned but with wrong bytes.
# ----------------------------------------------------------------------------
echo
echo "[verify-program-ids-devnet] checking cross-pinned [u8; 32] constants under #[cfg(feature = \"devnet\")]"
for crate in "${CRATES[@]}"; do
  consts="$ROOT_DIR/contracts/$crate/src/constants.rs"
  [[ -f "$consts" ]] || continue
  for target_crate in "${CRATES[@]}"; do
    cname="${CONST_NAME[$target_crate]}"
    actual="$(extract_devnet_const_bytes "$consts" "$cname" || true)"
    if [[ -z "$actual" ]]; then
      # Not pinned in this file — fine.
      continue
    fi
    expected_hex="${EXPECTED_HEX[$target_crate]}"
    checked=$(( checked + 1 ))
    if [[ "$actual" != "$expected_hex" ]]; then
      echo "DRIFT  $cname in contracts/$crate/src/constants.rs (devnet branch)" >&2
      echo "  expected: $expected_hex" >&2
      echo "  actual:   $actual" >&2
      errors=$(( errors + 1 ))
    else
      echo "ok     $cname ($crate cross-pin -> $target_crate)"
    fi
  done
done

echo
if (( errors > 0 )); then
  echo "[verify-program-ids-devnet] FAILED: $errors drift(s) in $checked check(s)" >&2
  exit 1
fi

echo "[verify-program-ids-devnet] OK: $checked devnet program-ID pin(s) consistent"
