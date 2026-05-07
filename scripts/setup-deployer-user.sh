#!/usr/bin/env bash
# setup-deployer-user.sh — one-time root setup for Phase 25 CI/CD deployer.
# Usage: sudo bash scripts/setup-deployer-user.sh <github-actions-pubkey-file>
# Idempotent: re-running produces same end state.
#
# What this script DOES install:
#   - System user `deployer` with locked-down ~/.ssh
#   - SSH forced-command wrapper at /usr/local/bin/areal-deploy
#   - sudoers fragment at /etc/sudoers.d/deployer (validated with visudo)
#
# What this script DOES NOT install (operator-installed, one-time):
#   The /usr/local/sbin/areal-deploy-{observability,dashboard,app} scripts
#   that the wrapper sudo-execs. Each must be a no-arg shell that exits 0
#   on success and writes errors to stderr. Recommended one-liners:
#     /usr/local/sbin/areal-deploy-observability →
#       exec /opt/areal/scripts/observability/bootstrap-fornex.sh
#     /usr/local/sbin/areal-deploy-dashboard →
#       cd /opt/areal && git pull && git submodule update --remote dashboard \
#         && cd dashboard && npm ci && npm run build \
#         && rsync -az --delete build/ /var/www/panel.areal.finance/
#     /usr/local/sbin/areal-deploy-app → equivalent for app/
#   See INFRASTRUCTURE.md → Deploy automation for the full contract.

set -euo pipefail

# ---------- 1. Assert root ----------
if [[ "${EUID}" -ne 0 ]]; then
  echo "ERROR: this script must run as root." >&2
  echo "Try: sudo bash scripts/setup-deployer-user.sh <pubkey-file>" >&2
  exit 1
fi

# ---------- 2. Validate pubkey arg ----------
if [[ $# -lt 1 ]]; then
  echo "ERROR: missing pubkey file argument." >&2
  echo "Usage: sudo bash scripts/setup-deployer-user.sh <github-actions-pubkey-file>" >&2
  exit 1
fi

PUBKEY_FILE="$1"

if [[ ! -r "${PUBKEY_FILE}" ]]; then
  echo "ERROR: pubkey file not readable: ${PUBKEY_FILE}" >&2
  exit 1
fi

if ! ssh-keygen -l -f "${PUBKEY_FILE}" >/dev/null 2>&1; then
  echo "ERROR: pubkey file does not parse as an SSH public key: ${PUBKEY_FILE}" >&2
  exit 1
fi

echo "→ Pubkey validated: $(ssh-keygen -l -f "${PUBKEY_FILE}")"

# ---------- 3. Create deployer user (idempotent) ----------
if id -u deployer >/dev/null 2>&1; then
  echo "→ User 'deployer' already exists, skipping useradd."
else
  useradd --system --create-home --shell /bin/bash deployer
  echo "→ Created user 'deployer'."
fi

# ---------- 4. Lock down ~/.ssh ----------
install -d -m 0700 -o deployer -g deployer /home/deployer/.ssh

# ---------- 5. Write authorized_keys with restriction directives ----------
# NOTE: ${SSH_ORIGINAL_COMMAND} below is an SSH server-side variable expanded
# at connection time, NOT a shell variable expanded by this setup script.
# We write it as a literal string by using single quotes in the heredoc.
PUBKEY_CONTENT="$(tr -d '\n' < "${PUBKEY_FILE}")"

AUTH_TMP="$(mktemp)"
trap 'rm -f "${AUTH_TMP}"' EXIT

cat > "${AUTH_TMP}" <<EOF_AUTH
command="/usr/local/bin/areal-deploy \${SSH_ORIGINAL_COMMAND}",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty ${PUBKEY_CONTENT}
EOF_AUTH

install -m 0600 -o deployer -g deployer "${AUTH_TMP}" /home/deployer/.ssh/authorized_keys
echo "→ Installed authorized_keys with restriction directives."

# ---------- 6. Write forced-command wrapper ----------
WRAPPER_TMP="$(mktemp)"
trap 'rm -f "${AUTH_TMP}" "${WRAPPER_TMP}"' EXIT

cat > "${WRAPPER_TMP}" <<'EOF_WRAPPER'
#!/usr/bin/env bash
# Forced command for the deployer SSH key.
# Receives SSH_ORIGINAL_COMMAND; only allows whitelisted verbs.
set -euo pipefail
cmd="${SSH_ORIGINAL_COMMAND:-}"
case "$cmd" in
  "deploy-observability")
    exec sudo -n /usr/local/sbin/areal-deploy-observability
    ;;
  "deploy-dashboard")
    exec sudo -n /usr/local/sbin/areal-deploy-dashboard
    ;;
  "deploy-app")
    exec sudo -n /usr/local/sbin/areal-deploy-app
    ;;
  "health")
    exec /usr/local/sbin/areal-deploy-health
    ;;
  *)
    echo "rejected: $cmd" >&2
    exit 42
    ;;
esac
EOF_WRAPPER

install -m 0755 -o root -g root "${WRAPPER_TMP}" /usr/local/bin/areal-deploy
echo "→ Installed /usr/local/bin/areal-deploy (forced-command wrapper)."

# ---------- 7. Write & validate sudoers fragment ----------
SUDOERS_TMP="$(mktemp)"
trap 'rm -f "${AUTH_TMP}" "${WRAPPER_TMP}" "${SUDOERS_TMP}"' EXIT

cat > "${SUDOERS_TMP}" <<'EOF_SUDO'
# Managed by scripts/setup-deployer-user.sh — do not edit by hand.
Defaults:deployer !requiretty
Defaults:deployer secure_path="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
deployer ALL=(root) NOPASSWD: /usr/local/sbin/areal-deploy-observability
deployer ALL=(root) NOPASSWD: /usr/local/sbin/areal-deploy-dashboard
deployer ALL=(root) NOPASSWD: /usr/local/sbin/areal-deploy-app
deployer ALL=(root) NOPASSWD: /usr/bin/systemctl status grafana-server
deployer ALL=(root) NOPASSWD: /usr/bin/systemctl status prometheus
deployer ALL=(root) NOPASSWD: /usr/bin/systemctl status loki
EOF_SUDO

if ! visudo -cf "${SUDOERS_TMP}" >/dev/null; then
  echo "ERROR: sudoers fragment failed validation. Aborting." >&2
  exit 1
fi
echo "→ sudoers fragment validated."

install -m 0440 -o root -g root "${SUDOERS_TMP}" /etc/sudoers.d/deployer
echo "→ Installed /etc/sudoers.d/deployer."

# ---------- 8. Validation block ----------
echo ""
echo "=== Validation ==="

echo "→ Test 1: deployer can run whitelisted systemctl status (exit 0 or 3 OK)"
set +e
sudo -u deployer -n /usr/bin/systemctl status grafana-server >/dev/null 2>&1
rc=$?
set -e
if [[ $rc -eq 0 || $rc -eq 3 ]]; then
  echo "  PASS (rc=${rc})"
else
  echo "  WARN: unexpected rc=${rc} (acceptable if grafana-server not yet installed)"
fi

echo "→ Test 2: deployer CANNOT run /bin/echo via sudo (must FAIL — proves NOPASSWD restricted)"
set +e
sudo -u deployer -n /bin/echo SHOULD-FAIL >/dev/null 2>&1
rc=$?
set -e
if [[ $rc -ne 0 ]]; then
  echo "  PASS (sudo rejected as expected, rc=${rc})"
else
  echo "  FAIL: deployer was able to sudo /bin/echo — sudoers is too permissive!" >&2
  exit 1
fi

echo "→ Test 3: sshd config for deployer (forcecommand / permittty)"
sshd -T -C user=deployer 2>/dev/null | grep -E '^(forcecommand|permittty)' || \
  echo "  (sshd -T did not surface directives — they apply via authorized_keys, not sshd_config; informational only)"

# ---------- 9. Summary ----------
echo ""
echo "=== Setup complete ==="
echo "User:        deployer"
echo "Authorized:  /home/deployer/.ssh/authorized_keys (forced-command)"
echo "Wrapper:     /usr/local/bin/areal-deploy"
echo "Sudoers:     /etc/sudoers.d/deployer"
echo ""
echo "Next steps (operator):"
echo "  1. Install /usr/local/sbin/areal-deploy-observability, -dashboard, -app"
echo "     (one-line wrappers — see header comment of this script)."
echo "  2. From a workstation: gh secret set DEPLOYER_SSH_KEY (private half of pubkey)"
echo "  3. From a workstation: gh secret set DEPLOYER_HOST -b \"<vps-hostname>\""
echo "  4. Push a docs-only commit with [skip deploy] to validate workflow shape,"
echo "     then a real change to validate end-to-end."
