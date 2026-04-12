#!/usr/bin/env bash
# install.sh -- Harmony AIO Agent installer for Linux
#
# Installs the harmony-agent binary as a systemd service on a Linux host,
# writes /etc/harmony/agent.json so the agent knows which server to call,
# and leaves a persistent log at /var/log/harmony-install.log.
#
# Server URL precedence (highest to lowest):
#   1. --server-url command-line argument
#   2. HARMONY_SERVER environment variable
#   3. Worker-injected default (when served from harmonyaio.com with ?server=)
#
# Binary source: if neither --binary-path nor --binary-url is given, defaults
# to ${SERVER_URL}/api/agent/download.
#
# Simplest invocation (Worker-injected server URL via harmonyaio.com):
#   curl -sSL "https://harmonyaio.com/install.sh?server=http://your-harmony-server:8420" | sudo bash
#
# With an env var:
#   export HARMONY_SERVER=http://192.168.50.115:8420
#   curl -sSL https://harmonyaio.com/install.sh | sudo -E bash
#
# With explicit args (dev / testing):
#   sudo ./install.sh --server-url http://192.168.50.115:8420 --binary-path /tmp/harmony-agent

set -euo pipefail

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

readonly INSTALL_DIR="/opt/harmony"
readonly BINARY_PATH="${INSTALL_DIR}/harmony-agent"
readonly CONFIG_DIR="/etc/harmony"
readonly CONFIG_PATH="${CONFIG_DIR}/agent.json"
readonly UNIT_PATH="/etc/systemd/system/harmony-agent.service"
readonly LOG_PATH="/var/log/harmony-install.log"
readonly DEFAULT_SERVICE_NAME="harmony-agent"

# ---------------------------------------------------------------------------
# Color helpers
# ---------------------------------------------------------------------------

RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'  # no color

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

# log_msg writes a timestamped message to the install log and to stdout.
log_msg() {
    local level="$1"
    local msg="$2"
    local ts
    ts="$(date '+%Y-%m-%d %H:%M:%S')"
    local line="[harmony-install] ${ts} [${level}] ${msg}"

    # Append to persistent log file (create if needed).
    # The log directory is / (root-level), which is always writable by root.
    echo "${line}" >> "${LOG_PATH}" 2>/dev/null || true

    case "${level}" in
        ERROR)   echo -e "${RED}${line}${NC}" >&2 ;;
        WARN)    echo -e "${YELLOW}${line}${NC}" ;;
        SUCCESS) echo -e "${GREEN}${line}${NC}" ;;
        *)       echo -e "${CYAN}[harmony-install]${NC} ${ts} ${msg}" ;;
    esac
}

log_info()    { log_msg "INFO"    "$1"; }
log_warn()    { log_msg "WARN"    "$1"; }
log_error()   { log_msg "ERROR"   "$1"; }
log_success() { log_msg "SUCCESS" "$1"; }

# ---------------------------------------------------------------------------
# Rollback state
# ---------------------------------------------------------------------------

# Track what we've created so we can undo on error.
CREATED_FILES=()
SERVICE_ENABLED=false
SERVICE_STARTED=false

rollback() {
    log_warn "Rolling back installation..."

    if "${SERVICE_STARTED}"; then
        log_info "Stopping ${SERVICE_NAME} service..."
        systemctl stop "${SERVICE_NAME}" 2>/dev/null || true
    fi

    if "${SERVICE_ENABLED}"; then
        log_info "Disabling ${SERVICE_NAME} service..."
        systemctl disable "${SERVICE_NAME}" 2>/dev/null || true
    fi

    for f in "${CREATED_FILES[@]+"${CREATED_FILES[@]}"}"; do
        if [[ -f "${f}" ]]; then
            log_info "Removing ${f}"
            rm -f "${f}" || true
        fi
    done

    # Remove the install dir only if it's now empty (don't wipe pre-existing data).
    if [[ -d "${INSTALL_DIR}" ]] && [[ -z "$(ls -A "${INSTALL_DIR}" 2>/dev/null)" ]]; then
        rmdir "${INSTALL_DIR}" 2>/dev/null || true
    fi

    if [[ -d "${CONFIG_DIR}" ]] && [[ -z "$(ls -A "${CONFIG_DIR}" 2>/dev/null)" ]]; then
        rmdir "${CONFIG_DIR}" 2>/dev/null || true
    fi

    # Reload systemd so the removed unit file is forgotten.
    systemctl daemon-reload 2>/dev/null || true

    log_warn "Rollback complete.  Nothing was installed."
}

# err_handler is called by the ERR trap.  Performs rollback then exits 1.
err_handler() {
    local exit_code="$?"
    local line_no="${1:-}"
    log_error "Unexpected error (exit ${exit_code}) at line ${line_no}.  Starting rollback."
    rollback
    exit 1
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

# Worker-injected default.  When this script is served from harmonyaio.com,
# the Cloudflare Worker replaces the placeholder below with the value of the
# ?server= query string after sanitization.  Anything left as the literal
# placeholder token is treated as unset and we fall through to the env var
# and then the command-line arg.
SERVER_URL="__HARMONY_SERVER_URL__"
BINARY_SRC_PATH=""
BINARY_SRC_URL=""
FORCE=false
SERVICE_NAME="${DEFAULT_SERVICE_NAME}"

usage() {
    cat <<EOF
Usage: sudo $0 [--server-url URL] [--binary-path PATH | --binary-url URL] [OPTIONS]

Server URL (one of):
  --server-url URL        Harmony server URL the agent phones home to
  HARMONY_SERVER env var  Fallback when --server-url is not given
  ?server= query string   Set automatically when served from harmonyaio.com

Binary source (optional, defaults to \${SERVER_URL}/api/agent/download):
  --binary-path PATH      Local path to the harmony-agent Linux binary
  --binary-url  URL       URL to download the harmony-agent binary from

Options:
  --force                 Re-install even if agent is already running
  --service-name NAME     Systemd service name (default: ${DEFAULT_SERVICE_NAME})
  -h, --help              Show this message

Examples:
  curl -sSL "https://harmonyaio.com/install.sh?server=http://192.168.50.115:8420" | sudo bash
  HARMONY_SERVER=http://192.168.50.115:8420 sudo -E ./install.sh
  sudo ./install.sh --server-url http://192.168.50.115:8420 --binary-path /tmp/harmony-agent
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --server-url)
            SERVER_URL="${2:?--server-url requires a value}"
            shift 2
            ;;
        --binary-path)
            BINARY_SRC_PATH="${2:?--binary-path requires a value}"
            shift 2
            ;;
        --binary-url)
            BINARY_SRC_URL="${2:?--binary-url requires a value}"
            shift 2
            ;;
        --force)
            FORCE=true
            shift
            ;;
        --service-name)
            SERVICE_NAME="${2:?--service-name requires a value}"
            shift 2
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            log_error "Unknown argument: $1"
            usage >&2
            exit 1
            ;;
    esac
done

# ---------------------------------------------------------------------------
# Pre-flight checks
# ---------------------------------------------------------------------------

# Must run as root.
if [[ "${EUID}" -ne 0 ]]; then
    echo -e "${RED}[harmony-install] ERROR: This script must be run as root (use sudo).${NC}" >&2
    exit 1
fi

# Apply the fallback chain for the server URL now that args are parsed.  If
# the arg wasn't passed and the Worker left the placeholder in place, check
# the environment variable.  If that's also empty, wipe SERVER_URL so the
# validation below trips the clean error path.
if [[ "${SERVER_URL}" == "__HARMONY_SERVER_URL__" ]]; then
    if [[ -n "${HARMONY_SERVER:-}" ]]; then
        SERVER_URL="${HARMONY_SERVER}"
    else
        SERVER_URL=""
    fi
fi

# Validate required arguments.
if [[ -z "${SERVER_URL}" ]]; then
    log_error "Server URL is required.  Provide one of:"
    log_error "  --server-url http://your-harmony-server:8420"
    log_error "  HARMONY_SERVER=http://your-harmony-server:8420 (env var)"
    log_error "  Use the pre-configured URL: https://harmonyaio.com/install.sh?server=http://your-harmony-server:8420"
    usage >&2
    exit 1
fi

# Default the binary source to the server's agent download endpoint if the
# caller didn't pin a local path or an explicit URL.  This is the hands-off
# path that makes the one-liner work: the agent always ships alongside the
# server it reports to.
if [[ -z "${BINARY_SRC_PATH}" && -z "${BINARY_SRC_URL}" ]]; then
    BINARY_SRC_URL="${SERVER_URL%/}/api/agent/download"
fi

if [[ -n "${BINARY_SRC_PATH}" && -n "${BINARY_SRC_URL}" ]]; then
    log_error "--binary-path and --binary-url are mutually exclusive."
    usage >&2
    exit 1
fi

# Check systemd is available.
if ! command -v systemctl &>/dev/null; then
    log_error "systemctl not found.  This installer requires a systemd-based Linux distribution."
    exit 1
fi

# ---------------------------------------------------------------------------
# Idempotency check
# ---------------------------------------------------------------------------

# If the service is already active and the config already matches, we're done.
if ! "${FORCE}"; then
    if systemctl is-active --quiet "${SERVICE_NAME}" 2>/dev/null; then
        if [[ -f "${CONFIG_PATH}" ]]; then
            existing_url=""
            # Extract server_url value with basic shell parsing (no jq dependency).
            existing_url="$(grep -o '"server_url"[[:space:]]*:[[:space:]]*"[^"]*"' "${CONFIG_PATH}" \
                            | grep -o '"[^"]*"$' | tr -d '"' || true)"
            if [[ "${existing_url}" == "${SERVER_URL}" ]]; then
                log_success "harmony-agent is already installed and running with the correct server URL.  Nothing to do."
                log_info "Run with --force to reinstall."
                exit 0
            else
                log_warn "Service is running but server URL has changed (${existing_url} -> ${SERVER_URL}).  Use --force to update."
                exit 0
            fi
        fi
    fi
fi

# ---------------------------------------------------------------------------
# Header
# ---------------------------------------------------------------------------

echo ""
echo -e "${CYAN}=== Harmony AIO Agent Installer ===${NC}"
log_info "Starting installation"
log_info "Server URL:   ${SERVER_URL}"
log_info "Service name: ${SERVICE_NAME}"
log_info "Install dir:  ${INSTALL_DIR}"
log_info "Log file:     ${LOG_PATH}"
echo ""

# Enable the ERR trap now that pre-flight is done.
trap 'err_handler ${LINENO}' ERR

# ---------------------------------------------------------------------------
# Step 1: Acquire binary
# ---------------------------------------------------------------------------

log_info "Step 1/7: Acquiring binary..."

STAGING_BINARY=""

if [[ -n "${BINARY_SRC_PATH}" ]]; then
    # Local path provided.
    if [[ ! -f "${BINARY_SRC_PATH}" ]]; then
        log_error "Binary not found at ${BINARY_SRC_PATH}"
        exit 1
    fi
    STAGING_BINARY="${BINARY_SRC_PATH}"
    log_info "Using local binary: ${BINARY_SRC_PATH}"
else
    # Download the binary.
    STAGING_BINARY="$(mktemp /tmp/harmony-agent-XXXXXX)"
    CREATED_FILES+=("${STAGING_BINARY}")

    log_info "Downloading binary from ${BINARY_SRC_URL} ..."
    if command -v curl &>/dev/null; then
        curl -fsSL --progress-bar -o "${STAGING_BINARY}" "${BINARY_SRC_URL}"
    elif command -v wget &>/dev/null; then
        wget -q --show-progress -O "${STAGING_BINARY}" "${BINARY_SRC_URL}"
    else
        log_error "Neither curl nor wget found.  Install one and retry, or use --binary-path."
        exit 1
    fi
    log_info "Download complete."
fi

# Sanity-check: verify it looks like an ELF binary (Linux executable).
magic_bytes="$(xxd -l 4 -p "${STAGING_BINARY}" 2>/dev/null || od -A n -N 4 -t x1 "${STAGING_BINARY}" 2>/dev/null | tr -d ' \n' || true)"
if [[ "${magic_bytes}" != "7f454c46"* ]]; then
    log_warn "Binary does not appear to be a Linux ELF executable (magic: ${magic_bytes}).  Proceeding anyway."
fi

# ---------------------------------------------------------------------------
# Step 2: Create install directory
# ---------------------------------------------------------------------------

log_info "Step 2/7: Creating install directory ${INSTALL_DIR} ..."

DIR_CREATED=false
if [[ ! -d "${INSTALL_DIR}" ]]; then
    install -d -m 0755 -o root -g root "${INSTALL_DIR}"
    DIR_CREATED=true
fi

# ---------------------------------------------------------------------------
# Step 3: Install binary
# ---------------------------------------------------------------------------

log_info "Step 3/7: Installing binary to ${BINARY_PATH} ..."

BINARY_WAS_NEW=false
if [[ ! -f "${BINARY_PATH}" ]]; then
    BINARY_WAS_NEW=true
fi

install -D -m 0755 -o root -g root "${STAGING_BINARY}" "${BINARY_PATH}"

if "${BINARY_WAS_NEW}"; then
    CREATED_FILES+=("${BINARY_PATH}")
fi

# Clean up temp file if we downloaded it.
if [[ -n "${BINARY_SRC_URL}" && -f "${STAGING_BINARY}" && "${STAGING_BINARY}" != "${BINARY_PATH}" ]]; then
    rm -f "${STAGING_BINARY}" || true
    # Remove from CREATED_FILES since we've already cleaned it up.
    CREATED_FILES=("${CREATED_FILES[@]/${STAGING_BINARY}/}")
fi

log_info "Binary installed ($(du -h "${BINARY_PATH}" | cut -f1))."

# ---------------------------------------------------------------------------
# Step 4: Write /etc/harmony/agent.json
# ---------------------------------------------------------------------------

log_info "Step 4/7: Writing ${CONFIG_PATH} ..."

CONFIG_WAS_NEW=false
if [[ ! -f "${CONFIG_PATH}" ]]; then
    CONFIG_WAS_NEW=true
fi

install -d -m 0755 -o root -g root "${CONFIG_DIR}"

# Write the config using printf to avoid trailing newline ambiguity.
printf '{"server_url":"%s"}\n' "${SERVER_URL}" > "${CONFIG_PATH}"
chmod 0644 "${CONFIG_PATH}"
chown root:root "${CONFIG_PATH}"

if "${CONFIG_WAS_NEW}"; then
    CREATED_FILES+=("${CONFIG_PATH}")
fi

log_info "agent.json written (server_url: ${SERVER_URL})."

# ---------------------------------------------------------------------------
# Step 5: Write systemd unit file
# ---------------------------------------------------------------------------

log_info "Step 5/7: Writing systemd unit file to ${UNIT_PATH} ..."

UNIT_WAS_NEW=false
if [[ ! -f "${UNIT_PATH}" ]]; then
    UNIT_WAS_NEW=true
fi

cat > "${UNIT_PATH}" <<'UNIT'
[Unit]
Description=Harmony AIO Agent
Documentation=https://harmonyaio.com
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
ExecStart=/opt/harmony/harmony-agent
Restart=on-failure
RestartSec=10s
StandardOutput=journal
StandardError=journal
SyslogIdentifier=harmony-agent

[Install]
WantedBy=multi-user.target
UNIT

chmod 0644 "${UNIT_PATH}"
chown root:root "${UNIT_PATH}"

if "${UNIT_WAS_NEW}"; then
    CREATED_FILES+=("${UNIT_PATH}")
fi

log_info "Unit file written."

# ---------------------------------------------------------------------------
# Step 6: Enable and start the service
# ---------------------------------------------------------------------------

log_info "Step 6/7: Enabling and starting ${SERVICE_NAME}.service ..."

systemctl daemon-reload
log_info "systemctl daemon-reload done."

systemctl enable "${SERVICE_NAME}.service"
SERVICE_ENABLED=true
log_info "Service enabled (starts on boot)."

systemctl start "${SERVICE_NAME}.service"
SERVICE_STARTED=true
log_info "Service start command issued."

# ---------------------------------------------------------------------------
# Step 7: Verify service is active
# ---------------------------------------------------------------------------

log_info "Step 7/7: Waiting for ${SERVICE_NAME} to become active (up to 30s) ..."

deadline=$(( $(date +%s) + 30 ))
while (( $(date +%s) < deadline )); do
    if systemctl is-active --quiet "${SERVICE_NAME}" 2>/dev/null; then
        log_success "harmony-agent.service is active."
        break
    fi
    sleep 2
done

if ! systemctl is-active --quiet "${SERVICE_NAME}" 2>/dev/null; then
    log_error "harmony-agent.service did not become active within 30 seconds."
    log_error "Last journal output:"
    journalctl -u "${SERVICE_NAME}.service" -n 20 --no-pager 2>/dev/null | while IFS= read -r line; do
        log_error "  ${line}"
    done
    rollback
    exit 1
fi

# Disable the ERR trap now that we've succeeded.
trap - ERR

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------

echo ""
log_success "=== Installation complete ==="
log_success "  Binary:      ${BINARY_PATH}"
log_success "  Config:      ${CONFIG_PATH}"
log_success "  Unit file:   ${UNIT_PATH}"
log_success "  Service:     ${SERVICE_NAME} (active, enabled)"
log_success "  Log file:    ${LOG_PATH}"
echo ""
log_info "The agent will phone home to ${SERVER_URL} on its next heartbeat (within 30s)."
log_info "To check status:  systemctl status ${SERVICE_NAME}"
log_info "To view logs:     journalctl -u ${SERVICE_NAME} -f"
echo ""
