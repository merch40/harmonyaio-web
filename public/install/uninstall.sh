#!/usr/bin/env bash
# Harmony AIO Server - hosted one-liner uninstaller (Linux)
#
#   curl -fsSL https://harmonyaio.com/uninstall.sh | bash
#   curl -fsSL https://harmonyaio.com/uninstall.sh | bash -s -- --purge
#
# Stops and disables the service, removes the binary and unit file.
# Data, config, and logs are preserved unless --purge (or HARMONY_PURGE=1)
# is given, which also removes /etc/harmony, /var/lib/harmony,
# /var/log/harmony, and the service user.
#
# Paths intentionally mirror packaging/tarball/uninstall.sh - a contract
# test keeps the two in sync.
set -euo pipefail

BINARY_NAME="harmony-server"
INSTALL_DIR="/usr/local/bin"
CONFIG_DIR="/etc/harmony"
DATA_DIR="/var/lib/harmony"
LOG_DIR="/var/log/harmony"
SERVICE_USER="harmony"
SYSTEMD_DIR="/etc/systemd/system"
SERVICE_FILE="harmony-server.service"

log()  { printf '%s\n' "$*"; }
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

main() {
    local purge=false
    if [ "${1:-}" = "--purge" ] || [ "${HARMONY_PURGE:-}" = "1" ]; then
        purge=true
    fi

    log "=== Harmony AIO Server Uninstaller ==="
    log ""

    local SUDO=""
    if [ "$(id -u)" -ne 0 ]; then
        if command -v sudo >/dev/null 2>&1; then
            SUDO="sudo"
        else
            fail "Run as root, or install sudo."
        fi
    fi

    if systemctl is-active --quiet "$BINARY_NAME" 2>/dev/null; then
        log "Stopping $BINARY_NAME..."
        $SUDO systemctl stop "$BINARY_NAME"
    fi
    if systemctl is-enabled --quiet "$BINARY_NAME" 2>/dev/null; then
        log "Disabling $BINARY_NAME..."
        $SUDO systemctl disable "$BINARY_NAME"
    fi

    if [ -f "$SYSTEMD_DIR/$SERVICE_FILE" ]; then
        log "Removing systemd service file..."
        $SUDO rm -f "$SYSTEMD_DIR/$SERVICE_FILE"
        $SUDO systemctl daemon-reload
    fi

    if [ -f "$INSTALL_DIR/$BINARY_NAME" ]; then
        log "Removing binary..."
        $SUDO rm -f "$INSTALL_DIR/$BINARY_NAME"
    fi

    if [ "$purge" = true ]; then
        log ""
        log "Purging all data, config, and logs..."
        $SUDO rm -rf "$CONFIG_DIR" "$DATA_DIR" "$LOG_DIR"
        if id -u "$SERVICE_USER" >/dev/null 2>&1; then
            log "Removing service user: $SERVICE_USER"
            $SUDO userdel "$SERVICE_USER" 2>/dev/null || true
        fi
        log "Purge complete."
    else
        log ""
        log "Config, data, and logs preserved at:"
        log "  $DATA_DIR"
        log "  $CONFIG_DIR"
        log "  $LOG_DIR"
        log ""
        log "To remove everything: curl -fsSL https://harmonyaio.com/uninstall.sh | bash -s -- --purge"
    fi

    log ""
    log "=== Uninstall complete ==="
}

main "$@"
