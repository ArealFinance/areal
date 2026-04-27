#!/usr/bin/env bash
#
# cu-profile.sh — R24 acceptance harness for Layer 8 / 9.
#
# Captures `computeUnitsConsumed` from getTransaction RPC for each registered
# instruction and emits a P50 / P95 / max table.
#
# Inputs (env):
#   RPC_URL                    Solana RPC endpoint with the 5 programs deployed.
#   CRANK_KEYPAIR              Path to a funded keypair (~5 SOL minimum).
#   YD_PROGRAM_ID, RWT_ENGINE_PROGRAM_ID, DEX_PROGRAM_ID,
#   OT_PROGRAM_ID, FUTARCHY_PROGRAM_ID
#                              Program addresses (must match canonical vanity).
#   E2E_BOOTSTRAP_DONE=1       Marker that the validator state is seeded.
#
# Output: writes JSON to data/cu-profile-*.json. When the internal docs
#   sibling repo is present (for the team), the harness also appends a
#   Markdown section to the corresponding cu-profile doc; without it, JSON
#   alone is emitted.
#
# Status: live (Layer 9 Substep 14). Without bootstrap the script exits 0
#   with a clear "needs bootstrap" message rather than failing CI.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

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
  echo "             see scripts/README.md for the harness contract." >&2
  exit 0
fi

if [[ "${E2E_BOOTSTRAP_DONE:-0}" != "1" ]]; then
  echo "[cu-profile] E2E_BOOTSTRAP_DONE not set — bootstrap required." >&2
  echo "             Run scripts/e2e-bootstrap.sh first to seed the localhost" >&2
  echo "             validator state. See scripts/README.md." >&2
  exit 0
fi

# Layer 9 Substep 14: live harness wired. Reads the bootstrap artifact at
# data/e2e-bootstrap.json (+ secrets file), submits each registered ix N
# times, captures CU + log signatures, and writes JSON to
# data/cu-profile-*.json. When the team's internal docs sibling is present,
# a Markdown section is also appended; the JSON output is always produced.
ARTIFACT="${E2E_BOOTSTRAP_ARTIFACT:-$ROOT_DIR/data/e2e-bootstrap.json}"
ITERATIONS="${CU_PROFILE_ITERATIONS:-5}"
OUTPUT_DIR="${CU_PROFILE_OUTPUT_DIR:-$ROOT_DIR/data}"

cd "$ROOT_DIR"
exec npx --prefix bots tsx scripts/lib/cu-profile.ts \
  --artifact "$ARTIFACT" \
  --iterations "$ITERATIONS" \
  --output-dir "$OUTPUT_DIR"
