#!/usr/bin/env bash
#
# build-devnet.sh — build all 5 contracts with `--features devnet` and
# tripwire-check each .so for the Layer 10 RWT placeholder byte sequence.
#
# Why a separate wrapper:
#   The YD contract has a compile-time const-assert that fires when the
#   `dev-placeholder-mints` feature is OFF and the RWT_MINT bytes still
#   match the placeholder. But that assert only protects YD's mainnet
#   path — it doesn't guard against accidentally shipping a devnet build
#   whose RWT_MINT was never re-pinned for the live cluster. This
#   wrapper greps each freshly built .so for the canonical placeholder
#   sequence (the first 8 bytes of the original `0x29, 0xcd, 0xfa, ...`
#   block) and fails if any match.
#
# Exit codes:
#   0   all 5 built + tripwire clean
#   1   build failure or tripwire hit

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

CRATES=(yield-distribution futarchy ownership-token rwt-engine native-dex)

# Layer 10 RWT placeholders — first 8 bytes of each mainnet RWT_MINT
# byte sequence used across the 4 RWT-bearing contracts:
#   - 29cdfa852d5ed939 = YD/OT/RWT-engine R20 placeholder (3pBtHBi...)
#   - fe25034007748910 = native-dex's distinct mainnet RWT pin (J75HniqiQ...)
# If any freshly built .so contains EITHER sequence, the build is
# poisoned (the const-rewrite step never ran) and we refuse to ship.
PLACEHOLDER_HEXES=('29cdfa852d5ed939' 'fe25034007748910')

log() {
  local ts
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '[%s] %s\n' "$ts" "$*"
}

build_one() {
  local crate="$1"
  log "cargo build-sbf --features devnet ($crate)"
  (
    cd "$ROOT_DIR/contracts/$crate"
    cargo build-sbf --features devnet
  ) || { log "ERROR: build failed for $crate"; exit 1; }
}

# Returns 0 if .so is clean, 1 if any placeholder sequence is present.
tripwire_check() {
  local so="$1"
  local crate="$2"
  # `xxd -p` outputs lowercase hex with no separators; tr removes the
  # newlines xxd inserts every 60 chars. Check against every known
  # mainnet placeholder pattern (PLACEHOLDER_HEXES array).
  local so_hex
  so_hex="$(xxd -p "$so" | tr -d '\n')"
  local hex
  for hex in "${PLACEHOLDER_HEXES[@]}"; do
    if echo "$so_hex" | grep -qi "$hex"; then
      log "TRIPWIRE  $crate ($so) contains mainnet RWT placeholder bytes ($hex)"
      log "          run scripts/migrate-mints.sh CLUSTER=devnet to pin the real mint, then rebuild"
      return 1
    fi
  done
  return 0
}

main() {
  log "build-devnet: building 5 contracts (devnet feature)"
  for crate in "${CRATES[@]}"; do
    build_one "$crate"
  done

  log "build-devnet: tripwire check for Layer 10 RWT placeholder bytes"
  local fail=0
  for crate in "${CRATES[@]}"; do
    local snake so
    snake="$(echo "$crate" | tr '-' '_')"
    so="$ROOT_DIR/contracts/target/deploy/${snake}.so"
    [[ -f "$so" ]] || { log "ERROR: missing artifact $so"; exit 1; }
    if tripwire_check "$so" "$crate"; then
      log "  $crate OK"
    else
      fail=$(( fail + 1 ))
    fi
  done

  if (( fail > 0 )); then
    log "build-devnet: FAILED — $fail/${#CRATES[@]} .so contain placeholder bytes"
    exit 1
  fi
  log "build-devnet: OK — all 5 .so built and tripwire clean"
}

main "$@"
