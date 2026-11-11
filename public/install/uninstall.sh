#!/usr/bin/env bash
# Harmony AIO Server - hosted one-liner uninstaller (Linux)
#
#   curl -fsSL https://harmonyaio.com/uninstall.sh | bash
#   curl -fsSL https://harmonyaio.com/uninstall.sh | bash -s -- --purge
#
# Stops and disables the service, removes the binary and unit file.
# Data, config, and logs are preserved unless --purge (or HARMONY_PURGE=1)
# is given, which also removes /etc/harmony, /var/lib/harmony,
# /var/log/harmony, and the service user. A co-located Harmony agent's files
# (agent.json, trust/, its state and logs) are kept; the agent has its own
# uninstaller.
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
AGENT_DIR="/opt/harmony"

log()  { printf '%s\n' "$*"; }
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# >>> harmony-firewall (ADR 0263 W2 round 2; byte-identical in the tarball and
# hosted install.sh and uninstall.sh, pinned by packaging tests)
# The installers open exactly the ports the service binds under the env file
# they wrote: HTTPS on 8443 when HARMONY_BOOTSTRAP_TLS=1 is seeded (its 8420
# redirect listener stays closed), plain HTTP on 8420 otherwise, plus the
# agent-CA listener on 8444 (ADR 0262 CX5A). Each port this install opened is
# recorded as "<ufw|firewalld> <port>"; a port that was already open is left
# out, so the uninstallers remove exactly what the install added.
HARMONY_FW_RECORD="/etc/harmony/firewall-opened"
harmony_fw_plan() {
    if ${SUDO:-} grep -qx 'HARMONY_BOOTSTRAP_TLS=1' "$1" 2>/dev/null; then
        echo "8443 8444"
    else
        echo "8420 8444"
    fi
}
harmony_fw_open() {
    local kind="$1" port
    shift
    for port in "$@"; do
        case "$kind" in
            ufw)
                if ${SUDO:-} ufw show added 2>/dev/null | grep -x "ufw allow $port/tcp" >/dev/null; then
                    continue
                fi
                ${SUDO:-} ufw allow "$port/tcp" >/dev/null
                ;;
            firewalld)
                if ${SUDO:-} firewall-cmd --permanent --query-port="$port/tcp" >/dev/null 2>&1; then
                    continue
                fi
                ${SUDO:-} firewall-cmd --permanent --add-port="$port/tcp" >/dev/null
                ;;
            *) return 1 ;;
        esac
        printf '%s %s\n' "$kind" "$port" | ${SUDO:-} tee -a "$HARMONY_FW_RECORD" >/dev/null
    done
    if [ "$kind" = "firewalld" ]; then
        ${SUDO:-} firewall-cmd --reload >/dev/null
    fi
}
harmony_fw_remove_recorded() {
    local kind port extra seen=" " reload=false
    if ! ${SUDO:-} test -f "$HARMONY_FW_RECORD"; then
        return 0
    fi
    while read -r kind port extra || [ -n "$kind" ]; do
        [ -z "$extra" ] || continue
        case "$kind" in ufw|firewalld) ;; *) continue ;; esac
        case "$port" in ''|*[!0-9]*|0*) continue ;; esac
        [ "${#port}" -le 5 ] && [ "$port" -le 65535 ] || continue
        case "$seen" in *" $kind:$port "*) continue ;; esac
        seen="$seen$kind:$port "
        echo "Removing firewall rule: $kind TCP $port"
        case "$kind" in
            ufw) ${SUDO:-} ufw --force delete allow "$port/tcp" >/dev/null || true ;;
            firewalld)
                ${SUDO:-} firewall-cmd --permanent --remove-port="$port/tcp" >/dev/null || true
                reload=true
                ;;
        esac
    done < <(${SUDO:-} cat "$HARMONY_FW_RECORD")
    if [ "$reload" = true ]; then
        ${SUDO:-} firewall-cmd --reload >/dev/null || true
    fi
    ${SUDO:-} rm -f "$HARMONY_FW_RECORD"
}
# <<< harmony-firewall

# A Harmony agent on this host keeps its identity and trust in the same
# directories the server uses, so a purge must leave those files alone.
agent_installed() {
    local p
    for p in "$CONFIG_DIR/agent.json" "$CONFIG_DIR/trust" "$AGENT_DIR/harmony-agent" \
        "$SYSTEMD_DIR/harmony-agent.service" "$SYSTEMD_DIR/harmony-agent-enroll.service"; do
        if ${SUDO:-} test -e "$p" || ${SUDO:-} test -L "$p"; then
            return 0
        fi
    done
    return 1
}

# purge_dir_keeping DIR NAME...: remove every entry of DIR except the named
# agent-owned ones, then DIR itself if that leaves it empty. find never follows
# a symlink, and a symlinked DIR is skipped.
purge_dir_keeping() {
    local dir="$1" name
    shift
    if ! ${SUDO:-} test -d "$dir" || ${SUDO:-} test -L "$dir"; then
        return 0
    fi
    local args=()
    for name in "$@"; do
        args+=(! -name "$name")
    done
    ${SUDO:-} find "$dir" -mindepth 1 -maxdepth 1 "${args[@]}" -exec rm -rf -- {} +
    ${SUDO:-} rmdir "$dir" 2>/dev/null || true
}

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

    # A purge never follows a symlink out of /etc/harmony: refuse before
    # anything is stopped or removed.
    if { $SUDO test -L "$CONFIG_DIR" || { $SUDO test -e "$CONFIG_DIR" && ! $SUDO test -d "$CONFIG_DIR"; }; } && [ "$purge" = true ]; then
        fail "$CONFIG_DIR is a symlink or not a directory; refusing to purge. Nothing was removed."
    fi

    # Remove the signed-update controller first so nothing restarts the
    # service mid-uninstall. Order matters: stop new activations (timer +
    # path), wait for a running updater to finish (stopping a oneshot blocks
    # until it exits), and only THEN decide whether an interrupted
    # activation blocks the uninstall.
    $SUDO systemctl disable --now harmony-updater.timer 2>/dev/null || true
    $SUDO systemctl disable --now harmony-updater.path 2>/dev/null || true
    $SUDO systemctl stop harmony-updater.service 2>/dev/null || true
    if $SUDO test -f "$DATA_DIR/updates/activation.json" 2>/dev/null; then
        $SUDO systemctl enable --now harmony-updater.timer 2>/dev/null || true
        $SUDO systemctl enable --now harmony-updater.path 2>/dev/null || true
        fail "Interrupted update recovery is pending; resolve it before uninstalling: $DATA_DIR/updates/activation.json (run: sudo /usr/local/bin/harmony-update run)"
    fi
    if [ -f "$SYSTEMD_DIR/harmony-updater.service" ] || [ -f "$SYSTEMD_DIR/harmony-updater.timer" ] || [ -f "$SYSTEMD_DIR/harmony-updater.path" ]; then
        log "Removing update controller units..."
        $SUDO rm -f "$SYSTEMD_DIR/harmony-updater.service" "$SYSTEMD_DIR/harmony-updater.timer" "$SYSTEMD_DIR/harmony-updater.path"
        $SUDO systemctl daemon-reload
        $SUDO systemctl reset-failed harmony-updater.service 2>/dev/null || true
    fi
    if [ -f "$INSTALL_DIR/harmony-update" ]; then
        log "Removing updater binary..."
        $SUDO rm -f "$INSTALL_DIR/harmony-update"
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
        $SUDO rm -f "$SYSTEMD_DIR/harmony-server.service.d/20-low-ports.conf"
        $SUDO rmdir "$SYSTEMD_DIR/harmony-server.service.d" 2>/dev/null || true
        $SUDO systemctl daemon-reload
    fi

    if [ -f "$INSTALL_DIR/$BINARY_NAME" ]; then
        log "Removing binary..."
        $SUDO rm -f "$INSTALL_DIR/$BINARY_NAME"
    fi

    # Remove exactly the firewall rules the install recorded (ADR 0263 W2).
    harmony_fw_remove_recorded

    if [ "$purge" = true ]; then
        log ""
        # A local agent provisioned by the server package is removed on purge;
        # an independently installed agent (no marker file) is left alone.
        if [ -f "$CONFIG_DIR/local-agent.provisioned" ]; then
            log "Removing the provisioned local agent..."
            $SUDO systemctl stop harmony-agent 2>/dev/null || true
            $SUDO systemctl disable harmony-agent 2>/dev/null || true
            $SUDO systemctl disable --now harmony-agent-enroll 2>/dev/null || true
            $SUDO rm -f "$SYSTEMD_DIR/harmony-agent.service" "$SYSTEMD_DIR/harmony-agent-enroll.service" "$AGENT_DIR/harmony-agent" "$CONFIG_DIR/agent.json" "$CONFIG_DIR/local-agent.provisioned"
            if $SUDO test -L "$CONFIG_DIR/trust"; then
                $SUDO rm -f "$CONFIG_DIR/trust"
            else
                $SUDO rm -rf "$CONFIG_DIR/trust"
            fi
            $SUDO rmdir "$AGENT_DIR" 2>/dev/null || true
            $SUDO systemctl daemon-reload
        fi
        if agent_installed; then
            log "Purging server data, config, and logs (the Harmony agent's files are kept)..."
            purge_dir_keeping "$CONFIG_DIR" agent.json trust 'enroll*.token'
            purge_dir_keeping "$DATA_DIR" harmony-agent-state.db harmony-agent-state.db-journal \
                harmony-agent-state.db-wal harmony-agent-state.db-shm discovery-report.json harmony-audit.log update
            purge_dir_keeping "$LOG_DIR" harmony-agent.log harmony-audit.log
            log "KEPT the Harmony agent's configuration (agent.json, trust/) in $CONFIG_DIR: an agent is installed on this host."
            log "To remove the agent too, run its uninstaller from the Harmony server that manages it:"
            log "  curl -sSL http://<server>/uninstall.sh | sudo bash -s -- --yes"
        else
            log "Purging all data, config, and logs..."
            $SUDO rm -rf "$CONFIG_DIR" "$DATA_DIR" "$LOG_DIR"
        fi
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
