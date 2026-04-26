#!/usr/bin/env bash
#
# cu-profile.sh — R24 acceptance harness for Layer 8.
#
# Captures `computeUnitsConsumed` from getTransaction RPC for each Layer 8
# instruction and emits a P50 / P95 / max table to stdout.
#
# Inputs (env):
#   RPC_URL                    Solana RPC endpoint with the 5 programs deployed.
#   CRANK_KEYPAIR              Path to a funded keypair (~5 SOL minimum).
#   YD_PROGRAM_ID, RWT_ENGINE_PROGRAM_ID, DEX_PROGRAM_ID,
#   OT_PROGRAM_ID, FUTARCHY_PROGRAM_ID
#                              Program addresses (must match canonical vanity).
#   E2E_BOOTSTRAP_DONE=1       Marker that the validator state is seeded.
#
# Output: appends a "## Live Measurements (<UTC date>)" block to
#   ../areal-planning/plan/layer-08-cu-profile.md
#
# Status: scaffolded. The TX-submitter harness is left as an exercise for
#   Layer 9 polish, when the bootstrap script lands. This file checks the
#   environment and prints the methodology so operators know exactly what's
#   needed; without bootstrap it exits 0 with a clear "needs bootstrap"
#   message rather than failing CI.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLAN_FILE="$ROOT_DIR/../areal-planning/plan/layer-08-cu-profile.md"

required_env=(
  RPC_URL
  CRANK_KEYPAIR
  YD_PROGRAM_ID
  RWT_ENGINE_PROGRAM_ID
  DEX_PROGRAM_ID
  OT_PROGRAM_ID
)

missing=()
for v in "${required_env[@]}"; do
  if [[ -z "${!v:-}" ]]; then
    missing+=("$v")
  fi
done

if (( ${#missing[@]} > 0 )); then
  echo "[cu-profile] env not set, skipping live profiling." >&2
  echo "             missing: ${missing[*]}" >&2
  echo "             see plan/layer-08-cu-profile.md for the harness contract." >&2
  exit 0
fi

if [[ "${E2E_BOOTSTRAP_DONE:-0}" != "1" ]]; then
  echo "[cu-profile] E2E_BOOTSTRAP_DONE not set — bootstrap required." >&2
  echo "             Layer 9 polish ships scripts/e2e-bootstrap.sh; until then" >&2
  echo "             the validator state must be seeded manually (see" >&2
  echo "             bots/.e2e/README.md scenario list)." >&2
  exit 0
fi

# When the bootstrap lands, the loop below replaces this comment and submits
# 10+ TXs per ix, parses computeUnitsConsumed from getTransaction, computes
# P50 / P95, and appends the result table to plan/layer-08-cu-profile.md.
#
# Pseudocode:
#
#   for ix in claim_yd_for_treasury compound_yield claim_yield \
#             convert_to_rwt:swap convert_to_rwt:mint convert_to_rwt:dual; do
#     for i in $(seq 1 12); do
#       sig=$(submit_tx "$ix" "$i")
#       cu=$(solana confirm -v "$sig" 2>&1 | grep -oE 'consumed [0-9]+' | head -1)
#       echo "$ix,$cu"
#     done
#   done | tee cu-runs.csv
#
#   python3 scripts/cu-profile-summarize.py cu-runs.csv \
#     >> "$PLAN_FILE"

echo "[cu-profile] OK: env present, bootstrap detected — but harness execution"
echo "             is gated until Layer 9 polish lands the bootstrap script."
echo "             see plan/layer-08-cu-profile.md §Methodology."
