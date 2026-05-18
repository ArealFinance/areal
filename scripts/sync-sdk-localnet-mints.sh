#!/usr/bin/env bash
#
# sync-sdk-localnet-mints.sh — re-pin SDK localnet mint constants to the
# current Fornex VPS test-validator chain state, bump SDK patch version,
# prepend a CHANGELOG entry, and commit.
#
# Background:
#   After scripts/deploy-fornex.sh resets the VPS test-validator state,
#   the RWT + USDC test mints are regenerated as random keypairs by
#   bootstrap-init.ts (phase-c, retrying until canonical rwt<usdc byte
#   ordering holds). The new pubkeys land in two places:
#     - on-chain (the .so artifacts have the new bytes baked in via the
#       R20 migrate-mints pipeline)
#     - data/e2e-bootstrap.json::mints (pulled from VPS by deploy-fornex.sh
#       step 8a.1)
#   But sdk/src/network/constants.ts::{USDC_MINTS,RWT_MINTS}.localnet
#   stays pinned to the previous values until an operator runs this
#   script. Until then, frontend's pool-catalogue filter misses the
#   master pool (the on-chain pool's mints don't match the SDK
#   constants), and the backend indexer indexes the wrong mints.
#
# What this does:
#   1. Reads RWT + USDC test-mint pubkeys from data/e2e-bootstrap.json.
#   2. Compares them against sdk/src/network/constants.ts; exits 0 if
#      already in sync (idempotent).
#   3. Rewrites the two localnet PublicKey literals in-place.
#   4. Bumps sdk/package.json patch version (X.Y.Z -> X.Y.{Z+1}).
#   5. Prepends a CHANGELOG entry under "## <new-version> — <date>".
#   6. Commits sdk/ changes with a conventional commit message.
#   7. Prints follow-up instructions (downstream rebuild + redeploy).
#
# Privilege model:
#   Local operator only. Does NOT touch the VPS, the contracts, or any
#   submodule other than sdk/. Does NOT push (operator chooses when to
#   push the SDK + meta-repo bump).
#
# Flags:
#   --dry-run   Print every mutation without applying. No version bump,
#               no CHANGELOG write, no git commit.
#   --no-commit Apply mutations but skip the git commit. Useful when
#               batching with other unrelated SDK changes.
#   -h|--help   Print this header and exit.
#
# Exit codes:
#   0   Already in sync, OR mutations applied successfully.
#   1   Hard failure (artifact missing, parse failure, git failure, etc.)
#   64  Bad arguments.

set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

ARTIFACT_FILE="$ROOT_DIR/data/e2e-bootstrap.json"
SDK_DIR="$ROOT_DIR/sdk"
SDK_CONSTANTS="$SDK_DIR/src/network/constants.ts"
SDK_PACKAGE="$SDK_DIR/package.json"
SDK_CHANGELOG="$SDK_DIR/CHANGELOG.md"

DRY_RUN=0
NO_COMMIT=0

for arg in "$@"; do
  case "$arg" in
    --dry-run)   DRY_RUN=1 ;;
    --no-commit) NO_COMMIT=1 ;;
    -h|--help)
      sed -n '2,55p' "$0"
      exit 0
      ;;
    *)
      echo "[sync-sdk-mints] unknown arg: $arg" >&2
      exit 64
      ;;
  esac
done

log() {
  printf '[sync-sdk-mints] %s\n' "$*"
}

# ----------------------------------------------------------------------------
# Pre-flight
# ----------------------------------------------------------------------------

if [[ ! -f "$ARTIFACT_FILE" ]]; then
  log "ERROR: bootstrap artifact missing at $ARTIFACT_FILE"
  log "       run scripts/deploy-fornex.sh first (or pull data/e2e-bootstrap.json from VPS)"
  exit 1
fi

if [[ ! -f "$SDK_CONSTANTS" ]]; then
  log "ERROR: SDK constants missing at $SDK_CONSTANTS"
  exit 1
fi

if [[ ! -f "$SDK_PACKAGE" ]]; then
  log "ERROR: SDK package.json missing at $SDK_PACKAGE"
  exit 1
fi

# ----------------------------------------------------------------------------
# Extract VPS pubkeys from artifact
# ----------------------------------------------------------------------------

VPS_RWT="$(python3 -c "import json; d=json.load(open('$ARTIFACT_FILE')); print(d.get('mints', {}).get('rwt_mint', ''))")"
VPS_USDC="$(python3 -c "import json; d=json.load(open('$ARTIFACT_FILE')); print(d.get('mints', {}).get('usdc_test_mint', ''))")"

if [[ -z "$VPS_RWT" || -z "$VPS_USDC" ]]; then
  log "ERROR: artifact missing mints.rwt_mint or mints.usdc_test_mint"
  log "       artifact path: $ARTIFACT_FILE"
  exit 1
fi

log "VPS chain state:"
log "  RWT:  $VPS_RWT"
log "  USDC: $VPS_USDC"

# ----------------------------------------------------------------------------
# Extract current SDK localnet pubkeys
# ----------------------------------------------------------------------------

SDK_RWT="$(python3 - "$SDK_CONSTANTS" <<'PY'
import re, sys
src = open(sys.argv[1]).read()
m = re.search(r"RWT_MINTS[^{]*\{[^}]*localnet:\s*new\s+PublicKey\(\s*'([1-9A-HJ-NP-Za-km-z]+)'", src, re.DOTALL)
print(m.group(1) if m else '')
PY
)"
SDK_USDC="$(python3 - "$SDK_CONSTANTS" <<'PY'
import re, sys
src = open(sys.argv[1]).read()
m = re.search(r"USDC_MINTS[^{]*\{[^}]*localnet:\s*new\s+PublicKey\(\s*'([1-9A-HJ-NP-Za-km-z]+)'", src, re.DOTALL)
print(m.group(1) if m else '')
PY
)"

if [[ -z "$SDK_RWT" || -z "$SDK_USDC" ]]; then
  log "ERROR: could not parse RWT_MINTS.localnet or USDC_MINTS.localnet from $SDK_CONSTANTS"
  log "       the file structure may have drifted; manual update required"
  exit 1
fi

log "SDK current state:"
log "  RWT:  $SDK_RWT"
log "  USDC: $SDK_USDC"

if [[ "$SDK_RWT" == "$VPS_RWT" && "$SDK_USDC" == "$VPS_USDC" ]]; then
  log "SDK already in sync with VPS — nothing to do"
  exit 0
fi

log "SDK and VPS diverge — proceeding with re-pin"

# ----------------------------------------------------------------------------
# Apply mutations
# ----------------------------------------------------------------------------

# Compute next patch version from SDK package.json.
CURRENT_VERSION="$(python3 -c "import json; print(json.load(open('$SDK_PACKAGE'))['version'])")"
NEXT_VERSION="$(python3 -c "
v = '$CURRENT_VERSION'.split('.')
v[2] = str(int(v[2]) + 1)
print('.'.join(v))
")"

TODAY="$(date -u +%Y-%m-%d)"

log "version bump: $CURRENT_VERSION -> $NEXT_VERSION"
log "changelog date: $TODAY"

if (( DRY_RUN )); then
  log "(dry-run): would rewrite $SDK_CONSTANTS:"
  log "  USDC_MINTS.localnet: $SDK_USDC -> $VPS_USDC"
  log "  RWT_MINTS.localnet:  $SDK_RWT -> $VPS_RWT"
  log "(dry-run): would bump $SDK_PACKAGE to $NEXT_VERSION"
  log "(dry-run): would prepend CHANGELOG entry under ## $NEXT_VERSION — $TODAY"
  log "(dry-run): would commit (run without --dry-run to apply)"
  exit 0
fi

# 1. Rewrite localnet pubkeys in constants.ts.
#    Python in-place to avoid sed's escaping pain with PublicKey('...').
python3 - "$SDK_CONSTANTS" "$SDK_USDC" "$VPS_USDC" "$SDK_RWT" "$VPS_RWT" <<'PY'
import re, sys
path, old_usdc, new_usdc, old_rwt, new_rwt = sys.argv[1:6]
src = open(path).read()

def replace_localnet(src, table_name, old_pk, new_pk):
    # Find the *_MINTS table block and replace only the localnet line
    # inside it. Anchor on the table name to avoid hitting other
    # tables (RWT_MINTS appears in USDY_MINTS via doc comments, etc.).
    pattern = re.compile(
        rf"({table_name}[^{{]*\{{[^}}]*localnet:\s*new\s+PublicKey\(\s*')"
        + re.escape(old_pk)
        + r"(')",
        re.DOTALL,
    )
    new_src, n = pattern.subn(rf"\g<1>{new_pk}\g<2>", src)
    if n != 1:
        raise SystemExit(f"ERROR: expected exactly 1 match for {table_name}.localnet, got {n}")
    return new_src

src = replace_localnet(src, "USDC_MINTS", old_usdc, new_usdc)
src = replace_localnet(src, "RWT_MINTS", old_rwt, new_rwt)
open(path, "w").write(src)
PY
log "rewrote localnet pubkeys in $SDK_CONSTANTS"

# 2. Bump package.json version.
python3 - "$SDK_PACKAGE" "$NEXT_VERSION" <<'PY'
import json, sys
path, new_version = sys.argv[1], sys.argv[2]
with open(path) as f:
    d = json.load(f)
d["version"] = new_version
with open(path, "w") as f:
    json.dump(d, f, indent=2)
    f.write("\n")
PY
log "bumped $SDK_PACKAGE to $NEXT_VERSION"

# 3. Prepend CHANGELOG entry.
TMP_CHANGELOG="$(mktemp)"
trap 'rm -f "$TMP_CHANGELOG"' EXIT

if [[ -f "$SDK_CHANGELOG" ]]; then
  EXISTING_TAIL="$(tail -n +2 "$SDK_CHANGELOG")"
else
  EXISTING_TAIL=""
fi

{
  printf '# Changelog\n\n'
  printf '## %s — %s\n\n' "$NEXT_VERSION" "$TODAY"
  printf '### Fixed\n\n'
  printf -- '- Re-pinned `RWT_MINTS.localnet` + `USDC_MINTS.localnet` to the\n'
  printf '  Fornex VPS test-validator'\''s current runtime mints after a\n'
  printf '  `scripts/deploy-fornex.sh` validator reset:\n\n'
  printf -- '    - USDC: `%s` (was `%s`)\n' "$VPS_USDC" "$SDK_USDC"
  printf -- '    - RWT:  `%s` (was `%s`)\n\n' "$VPS_RWT" "$SDK_RWT"
  printf '  Source of truth: `data/e2e-bootstrap.json::mints`. Generated by\n'
  printf '  `scripts/sync-sdk-localnet-mints.sh`.\n\n'
  printf 'Non-breaking — constants point at real on-chain mints (matching\n'
  printf 'the YD `RWT_MINT` pin baked into the deployed .so by the\n'
  printf 'migrate-mints pipeline); no SDK API or type changes.\n\n'
  printf '%s\n' "$EXISTING_TAIL"
} > "$TMP_CHANGELOG"

mv "$TMP_CHANGELOG" "$SDK_CHANGELOG"
trap - EXIT
log "prepended CHANGELOG entry for $NEXT_VERSION"

# 4. Commit (unless --no-commit).
if (( NO_COMMIT )); then
  log "--no-commit: skipping git commit (mutations applied)"
else
  (
    cd "$SDK_DIR"
    git add src/network/constants.ts package.json CHANGELOG.md
    git commit -m "fix(network): re-pin localnet mints to VPS Fornex chain state

After deploy-fornex.sh validator reset, the runtime RWT + USDC test
mints land in data/e2e-bootstrap.json. Re-sync SDK constants so
frontend pool-catalogue and backend indexer find the master pool.

USDC: $VPS_USDC
RWT:  $VPS_RWT"
  )
  log "committed sdk/$NEXT_VERSION on submodule branch"
fi

# ----------------------------------------------------------------------------
# Follow-up instructions
# ----------------------------------------------------------------------------

cat <<EOF

[sync-sdk-mints] DONE — SDK localnet mints re-pinned.

Next operator steps (manual):

  1) Build SDK to refresh dist/:
       npm -w sdk run build

  2) Rebuild + redeploy frontend (app.areal.finance):
       npm -w app run build
       (then deploy via your usual app-deploy flow,
        e.g. ssh vps-vpn /usr/local/sbin/areal-deploy-app)

  3) Rebuild + redeploy backend (api.areal.finance) — only if the
     backend was running with the stale SDK constants:
       npm -w backend run build
       (then deploy via your usual backend-deploy flow)

  4) Bump meta-repo submodule pointer for sdk/ and commit:
       git -C $ROOT_DIR add sdk
       git -C $ROOT_DIR commit -m "chore(submodules): bump sdk for localnet mint re-pin"

  5) Push when ready:
       git -C $SDK_DIR push
       git -C $ROOT_DIR push

EOF
