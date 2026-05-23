#!/usr/bin/env bash
#
# install-bot-services.sh — install/refresh the persistent systemd units for
# the Areal off-chain bot fleet on the Fornex VPS.
#
# WHY THIS EXISTS
#   The reward pipeline (revenue → convert+fund → publish → claim) only
#   accrues yield when the cranks run continuously. Historically only
#   `areal-merkle-publisher.service` was installed; the four cranks were
#   spawned ephemerally by scripts/lib/start-bots.ts during bootstrap and did
#   NOT survive a validator reset / reboot. Result: the YD distributor reward
#   vault stayed at 0 RWT and the portfolio UI showed "0 RWT/day".
#
#   This script makes the whole fleet persistent so a fresh deploy (or a VPS
#   reboot) brings every bot back automatically.
#
# WHAT IT DOES (idempotent)
#   For each bot it writes /etc/systemd/system/areal-<bot>.service modelled on
#   the existing merkle-publisher unit (Type=simple, User=deployer, run the
#   COMPILED dist/src/index.js, Restart=on-failure), then
#   `daemon-reload` + `enable --now`.
#
# PRECONDITIONS
#   - bots are built (dist/src/index.js present) — deploy-fornex.sh runs
#     `npm run build` before invoking this. A bot whose dist is missing is
#     skipped with a warning rather than installed into a crash loop.
#   - each bot has a rendered .env (scripts/lib/render-env.ts) in its dir.
#
# All bots are long-running loops (WS subscription + runLoop/startManager that
# only return on the abort signal), so Type=simple services are correct —
# none of them are one-shot, so no systemd .timer is needed.
#
# Usage:
#   scripts/install-bot-services.sh [--dry-run]
#
# Honors the same SSH_HOST + VPS_REPO_ROOT contract as deploy-fornex.sh.

set -euo pipefail

SSH_HOST="${SSH_HOST:-vps-vpn}"
VPS_REPO_ROOT="${VPS_REPO_ROOT:-/opt/areal}"
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *) echo "[install-bot-services] unknown arg: $arg" >&2; exit 64 ;;
  esac
done

# Bots that run as persistent services. merkle-publisher first (the cranks'
# yield-claim path consumes its published proofs). pool-rebalancer is omitted:
# it is a tsx-only helper with no build output and is not part of the
# revenue→fund→publish→claim chain that drives RWT/day.
BOTS=(
  merkle-publisher
  revenue-crank
  convert-and-fund-crank
  yield-claim-crank
  nexus-manager
)

# Human-readable unit descriptions.
declare -A DESC=(
  [merkle-publisher]="Areal Merkle Publisher"
  [revenue-crank]="Areal Revenue Crank"
  [convert-and-fund-crank]="Areal Convert-and-Fund Crank"
  [yield-claim-crank]="Areal Yield-Claim Crank"
  [nexus-manager]="Areal Nexus Manager"
)

log() { printf '[install-bot-services] %s\n' "$*"; }

remote() {
  log "[ssh] $*"
  (( DRY_RUN )) && return 0
  ssh "$SSH_HOST" "$@"
}

for bot in "${BOTS[@]}"; do
  dist="$VPS_REPO_ROOT/bots/$bot/dist/src/index.js"
  # Skip a bot whose dist is missing rather than install a crash loop.
  if ! (( DRY_RUN )); then
    if ! ssh "$SSH_HOST" "test -f $dist"; then
      log "WARN: $dist missing — skipping $bot (run 'npm run build' in bots/ first)"
      continue
    fi
  fi

  unit="/etc/systemd/system/areal-$bot.service"
  desc="${DESC[$bot]}"
  log "writing $unit"
  if (( DRY_RUN )); then
    continue
  fi
  ssh "$SSH_HOST" "cat > $unit" <<EOF
[Unit]
Description=$desc
After=network.target solana-test-validator.service
Wants=solana-test-validator.service

[Service]
Type=simple
User=deployer
Group=deployer
WorkingDirectory=$VPS_REPO_ROOT/bots/$bot
ExecStart=/usr/bin/node $VPS_REPO_ROOT/bots/$bot/dist/src/index.js
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF
done

log "reloading systemd + enabling units"
remote "systemctl daemon-reload"
for bot in "${BOTS[@]}"; do
  remote "systemctl enable --now areal-$bot.service"
done

# Brief stability check — a unit that exits within RestartSec is crash-looping.
if ! (( DRY_RUN )); then
  log "verifying services stay up (sleep 12s)"
  sleep 12
  fail=0
  for bot in "${BOTS[@]}"; do
    state="$(ssh "$SSH_HOST" "systemctl is-active areal-$bot.service" || true)"
    printf '[install-bot-services]   %-32s %s\n' "areal-$bot.service" "$state"
    [[ "$state" == "active" ]] || fail=1
  done
  if (( fail )); then
    log "ERROR: one or more bot services are not active — check journalctl -u areal-<bot>"
    exit 1
  fi
fi

log "bot services installed + active"
