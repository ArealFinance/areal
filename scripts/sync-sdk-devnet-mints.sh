#!/usr/bin/env bash
#
# sync-sdk-devnet-mints.sh — patch sdk/src/network/constants.ts so the
# `devnet` entries of `USDC_MINTS` and `RWT_MINTS` match what the live
# devnet chain holds in data/devnet-addresses.json.
#
# Background:
#   After scripts/deploy-devnet.sh creates the devnet RWT mint (and pins
#   the test USDC mint), data/devnet-addresses.json carries the canonical
#   pubkeys. The SDK constants table (sdk/src/network/constants.ts) still
#   reflects the pre-redeploy state (mainnet placeholder / older devnet
#   pubkey) until an operator runs this script.
#
# Inputs:
#   data/devnet-addresses.json — `.mints.usdc` (string), `.mints.rwt` (string|null)
#   sdk/src/network/constants.ts — `USDC_MINTS.devnet`, `RWT_MINTS.devnet` entries
#
# Behaviour:
#   1. Read USDC + RWT pubkeys from devnet-addresses.json.
#   2. Read current SDK devnet pubkeys.
#   3. If both match → exit 0 (idempotent no-op).
#   4. Patch the file (PublicKey('<old>') → PublicKey('<new>')) for each
#      diverging entry.
#   5. (optional) Run `npm run build` in sdk/ as a smoke check.
#
# Flags:
#   --no-build   Skip the SDK build smoke check (faster).
#   --dry-run    Show planned edits without writing.
#   -h|--help    This header.
#
# Limitations:
#   - SDK widening (Phase 25+ stage of the devnet rehearsal) may add
#     additional cluster-keyed constants (NEXUS_* / governance / ...). This
#     script currently only handles USDC_MINTS + RWT_MINTS — the rest
#     are TODO once the widening lands. The intent is to mirror the
#     existing sync-sdk-localnet-mints.sh shape with a devnet target.

set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

ADDRESSES_FILE="$ROOT_DIR/data/devnet-addresses.json"
SDK_DIR="$ROOT_DIR/sdk"
SDK_CONSTANTS="$SDK_DIR/src/network/constants.ts"

NO_BUILD=0
DRY_RUN=0

for arg in "$@"; do
  case "$arg" in
    --no-build) NO_BUILD=1 ;;
    --dry-run)  DRY_RUN=1 ;;
    -h|--help)
      sed -n '2,40p' "$0"
      exit 0
      ;;
    *)
      echo "[sync-sdk-devnet-mints] unknown arg: $arg" >&2
      exit 64
      ;;
  esac
done

log() { printf '[sync-sdk-devnet-mints] %s\n' "$*"; }

if [[ ! -f "$ADDRESSES_FILE" ]]; then
  log "ERROR: addresses file missing: $ADDRESSES_FILE"
  exit 1
fi
if [[ ! -f "$SDK_CONSTANTS" ]]; then
  log "ERROR: SDK constants missing: $SDK_CONSTANTS"
  exit 1
fi

DEVNET_USDC="$(python3 -c "import json; print((json.load(open('$ADDRESSES_FILE')).get('mints') or {}).get('usdc') or '')")"
DEVNET_RWT="$(python3 -c "import json; print((json.load(open('$ADDRESSES_FILE')).get('mints') or {}).get('rwt') or '')")"

if [[ -z "$DEVNET_USDC" ]]; then
  log "ERROR: data/devnet-addresses.json::.mints.usdc is empty/null"
  exit 1
fi
if [[ -z "$DEVNET_RWT" ]]; then
  log "WARN: data/devnet-addresses.json::.mints.rwt is empty/null — skipping RWT_MINTS.devnet update"
fi

log "devnet chain state:"
log "  USDC: $DEVNET_USDC"
log "  RWT:  ${DEVNET_RWT:-<unset>}"

# Read current SDK devnet pubkeys via python regex.
SDK_USDC="$(python3 - "$SDK_CONSTANTS" <<'PY'
import re, sys
src = open(sys.argv[1]).read()
m = re.search(r"USDC_MINTS[^{]*\{[^}]*devnet:\s*new\s+PublicKey\(\s*'([1-9A-HJ-NP-Za-km-z]+)'", src, re.DOTALL)
print(m.group(1) if m else '')
PY
)"
SDK_RWT="$(python3 - "$SDK_CONSTANTS" <<'PY'
import re, sys
src = open(sys.argv[1]).read()
m = re.search(r"RWT_MINTS[^{]*\{[^}]*devnet:\s*new\s+PublicKey\(\s*'([1-9A-HJ-NP-Za-km-z]+)'", src, re.DOTALL)
print(m.group(1) if m else '')
PY
)"

log "SDK current state:"
log "  USDC: ${SDK_USDC:-<not-parseable>}"
log "  RWT:  ${SDK_RWT:-<not-parseable>}"

NEEDS_USDC=0
NEEDS_RWT=0
[[ -n "$SDK_USDC" && "$SDK_USDC" != "$DEVNET_USDC" ]] && NEEDS_USDC=1
[[ -n "$DEVNET_RWT" && -n "$SDK_RWT" && "$SDK_RWT" != "$DEVNET_RWT" ]] && NEEDS_RWT=1

if (( ! NEEDS_USDC && ! NEEDS_RWT )); then
  log "SDK already in sync with devnet chain — nothing to do"
  exit 0
fi

if (( DRY_RUN )); then
  (( NEEDS_USDC )) && log "(dry-run) would update USDC_MINTS.devnet: $SDK_USDC -> $DEVNET_USDC"
  (( NEEDS_RWT ))  && log "(dry-run) would update RWT_MINTS.devnet:  $SDK_RWT -> $DEVNET_RWT"
  exit 0
fi

# In-place rewrites. Python anchors each substitution to the table name so
# we never touch the wrong cluster row.
python3 - "$SDK_CONSTANTS" "$SDK_USDC" "$DEVNET_USDC" "$SDK_RWT" "$DEVNET_RWT" "$NEEDS_USDC" "$NEEDS_RWT" <<'PY'
import re, sys
path, old_usdc, new_usdc, old_rwt, new_rwt, needs_usdc, needs_rwt = sys.argv[1:8]
src = open(path).read()

def replace_devnet(src, table_name, old_pk, new_pk):
    pattern = re.compile(
        rf"({table_name}[^{{]*\{{[^}}]*devnet:\s*new\s+PublicKey\(\s*')"
        + re.escape(old_pk)
        + r"(')",
        re.DOTALL,
    )
    new_src, n = pattern.subn(rf"\g<1>{new_pk}\g<2>", src)
    if n != 1:
        raise SystemExit(f"ERROR: expected 1 match for {table_name}.devnet, got {n}")
    return new_src

if needs_usdc == "1":
    src = replace_devnet(src, "USDC_MINTS", old_usdc, new_usdc)
if needs_rwt == "1":
    src = replace_devnet(src, "RWT_MINTS",  old_rwt,  new_rwt)
open(path, "w").write(src)
PY

(( NEEDS_USDC )) && log "rewrote USDC_MINTS.devnet -> $DEVNET_USDC"
(( NEEDS_RWT  )) && log "rewrote RWT_MINTS.devnet  -> $DEVNET_RWT"

if (( NO_BUILD )); then
  log "--no-build: skipped SDK build smoke check"
  exit 0
fi

log "running 'npm run build' in $SDK_DIR (smoke check)"
(
  cd "$SDK_DIR"
  npm run build 2>&1 | tail -30
) || {
  log "ERROR: SDK build failed after rewrite — inspect $SDK_CONSTANTS"
  exit 1
}
log "SDK build OK"
