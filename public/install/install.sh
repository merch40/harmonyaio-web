#!/usr/bin/env bash
# Harmony AIO Server - hosted one-liner installer (Linux, amd64, systemd)
#
#   curl -fsSL https://harmonyaio.com/install.sh | bash
#
# Resolves the latest signed release for a channel through the
# harmonyaio.com release resolver, downloads the tarball from the update
# origin, verifies its SHA-256 and size against the signed manifest values,
# then runs the tarball's bundled install.sh and starts the service.
#
# Trust boundary: when started without root, the download happens as the
# invoking user, but the hash verification, extraction, and installation
# all run inside one root-owned temporary directory. Nothing root executes
# is writable by the invoking user after it has been verified.
#
# Environment overrides:
#   HARMONY_CHANNEL       release channel (resolver default when unset)
#   HARMONY_REINSTALL=1   allow in-place reinstall/upgrade over an existing install
#   HARMONY_NO_START=1    install and enable, but do not start the service
#   HARMONY_DRYRUN=1      resolve, download, verify, and extract only; install
#                         nothing and touch no system state
#   HARMONY_RESOLVER_URL  alternate resolver endpoint (testing)
#   HARMONY_ARTIFACT_URL / HARMONY_ARTIFACT_SHA256
#                         bypass the resolver with an explicit artifact (testing,
#                         air-gapped staging); both must be set together
#   HARMONY_ALLOW_HTTP=1  permit plain-http artifact URLs (testing only)
#
# This script never handles secrets. The server prints its one-time setup
# token to the systemd journal on first start.
set -euo pipefail

RESOLVER_URL="${HARMONY_RESOLVER_URL:-https://harmonyaio.com/api/releases/latest}"
BINARY_PATH="/usr/local/bin/harmony-server"
SERVICE_NAME="harmony-server"
SERVICE_UNIT="/etc/systemd/system/harmony-server.service"
DASHBOARD_PORT="8420"
# Matches internal/updatechannel MaxArtifactBytes; download cap when the
# resolver did not supply an exact size.
MAX_ARTIFACT_BYTES=536870912

log()  { printf '%s\n' "$*"; }
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

fetch_stdout() {
    if have curl; then
        curl -fsSL "$1"
    elif have wget; then
        wget -qO- "$1"
    else
        fail "curl or wget is required."
    fi
}

# fetch_file url dest max_bytes
# The transfer is capped BEFORE the hash check so a hostile origin cannot
# fill the disk; an over-cap transfer is caught here or by the exact size
# comparison afterwards.
fetch_file() {
    local url="$1" dest="$2" max="$3"
    if have curl; then
        curl -fSL --progress-bar --max-filesize "$max" -o "$dest" "$url" || \
            fail "Download failed or exceeded the ${max}-byte cap."
    elif have wget; then
        # wget has no single-file size cap; bound the stream instead.
        wget -qO- "$url" | head -c "$((max + 1))" > "$dest" || \
            fail "Download failed."
    else
        fail "curl or wget is required."
    fi
}

# Extract a top-level string / number field from a small, flat JSON object.
# First match wins, so later fields can never override security-relevant
# earlier ones. The resolver validates every field it emits against strict
# patterns (no quotes or escapes can appear), and the values are re-checked
# below before use.
json_str() { printf '%s' "$1" | tr -d '\n' | grep -o '"'"$2"'"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n1 | sed 's/.*:[[:space:]]*"//; s/"$//'; }
json_num() { printf '%s' "$1" | tr -d '\n' | grep -o '"'"$2"'"[[:space:]]*:[[:space:]]*[0-9][0-9]*' | head -n1 | sed 's/.*:[[:space:]]*//'; }

sha256_of() {
    if have sha256sum; then
        sha256sum "$1" | awk '{print $1}'
    elif have shasum; then
        shasum -a 256 "$1" | awk '{print $1}'
    else
        fail "sha256sum or shasum is required."
    fi
}

main() {
    log "=== Harmony AIO Server Installer ==="
    log ""

    local dryrun=false
    [ "${HARMONY_DRYRUN:-}" = "1" ] && dryrun=true

    # --- Platform checks -------------------------------------------------
    # A dry run only downloads and extracts, so it may run anywhere bash does.
    local os arch
    os="$(uname -s)"
    arch="$(uname -m)"
    if [ "$dryrun" = false ]; then
        [ "$os" = "Linux" ] || fail "This installer supports Linux only (detected: $os). Windows: irm https://harmonyaio.com/install.ps1 | iex"
        case "$arch" in
            x86_64|amd64) ;;
            *) fail "Unsupported architecture: $arch (amd64 only for now)." ;;
        esac
        have systemctl || fail "systemd is required (systemctl not found)."
    fi
    have tar || fail "tar is required."

    # --- Privileges -------------------------------------------------------
    local SUDO=""
    if [ "$dryrun" = false ] && [ "$(id -u)" -ne 0 ]; then
        if have sudo; then
            SUDO="sudo"
            log "Root privileges are required for installation; sudo will prompt if needed."
        else
            fail "Run as root, or install sudo: curl -fsSL https://harmonyaio.com/install.sh | sudo bash"
        fi
    fi

    # --- Existing installation gate --------------------------------------
    if [ "$dryrun" = false ] && { [ -e "$BINARY_PATH" ] || [ -e "$SERVICE_UNIT" ]; }; then
        if [ "${HARMONY_REINSTALL:-}" = "1" ]; then
            log "Existing installation detected; HARMONY_REINSTALL=1 set, continuing with in-place reinstall."
        elif [ -r /dev/tty ] && [ -w /dev/tty ]; then
            printf 'An existing Harmony server installation was detected.\nReinstall/upgrade in place? Data, config, and logs are preserved. [y/N] ' > /dev/tty
            local answer=""
            read -r answer < /dev/tty || answer=""
            case "$answer" in
                y|Y|yes|YES) ;;
                *) fail "Aborted. Re-run with HARMONY_REINSTALL=1 to skip this prompt." ;;
            esac
        else
            fail "Existing installation detected. Re-run with HARMONY_REINSTALL=1 to reinstall/upgrade in place (data is preserved)."
        fi
    fi

    # --- Resolve the release ----------------------------------------------
    local version="" url="" sha256="" size="" channel_out=""
    if [ -n "${HARMONY_ARTIFACT_URL:-}" ] || [ -n "${HARMONY_ARTIFACT_SHA256:-}" ]; then
        [ -n "${HARMONY_ARTIFACT_URL:-}" ] && [ -n "${HARMONY_ARTIFACT_SHA256:-}" ] || \
            fail "HARMONY_ARTIFACT_URL and HARMONY_ARTIFACT_SHA256 must be set together."
        url="$HARMONY_ARTIFACT_URL"
        sha256="$HARMONY_ARTIFACT_SHA256"
        version="manual"
        channel_out="manual"
        log "Using explicit artifact override (resolver bypassed)."
    else
        local resolver="$RESOLVER_URL?os=linux"
        if [ -n "${HARMONY_CHANNEL:-}" ]; then
            case "$HARMONY_CHANNEL" in
                *[!A-Za-z0-9._-]*) fail "Invalid HARMONY_CHANNEL value." ;;
            esac
            resolver="$resolver&channel=$HARMONY_CHANNEL"
        fi
        log "Resolving latest release..."
        local response
        response="$(fetch_stdout "$resolver")" || fail "Could not reach the release resolver at $resolver"
        version="$(json_str "$response" version)"
        url="$(json_str "$response" url)"
        sha256="$(json_str "$response" sha256)"
        size="$(json_num "$response" size)"
        channel_out="$(json_str "$response" channel)"
        if [ -z "$version" ] || [ -z "$url" ] || [ -z "$sha256" ]; then
            fail "Unexpected resolver response: $response"
        fi
    fi

    case "$version" in
        *[!A-Za-z0-9.+_-]*) fail "Resolver returned an invalid version string." ;;
    esac
    printf '%s' "$sha256" | grep -Eq '^[0-9a-fA-F]{64}$' || fail "Resolver returned an invalid sha256."
    case "$url" in
        https://*) ;;
        http://*)
            [ "${HARMONY_ALLOW_HTTP:-}" = "1" ] || fail "Refusing a non-HTTPS artifact URL (set HARMONY_ALLOW_HTTP=1 only for local testing)."
            ;;
        *) fail "Resolver returned an invalid artifact URL." ;;
    esac
    sha256="$(printf '%s' "$sha256" | tr 'A-F' 'a-f')"

    log "  Channel: ${channel_out:-default}"
    log "  Version: $version"
    log "  Source:  $url"
    log ""

    # --- Download and verify (as the invoking user) ------------------------
    local workdir
    workdir="$(mktemp -d /tmp/harmony-install.XXXXXX)"
    # shellcheck disable=SC2064
    trap "rm -rf '$workdir'" EXIT
    trap 'exit 130' INT TERM

    local cap="$MAX_ARTIFACT_BYTES"
    [ -n "${size:-}" ] && cap="$size"
    local artifact="$workdir/$(basename "$url")"
    log "Downloading..."
    fetch_file "$url" "$artifact" "$cap"

    log "Verifying SHA-256..."
    local actual
    actual="$(sha256_of "$artifact")"
    if [ "$actual" != "$sha256" ]; then
        fail "SHA-256 mismatch: expected $sha256, got $actual. Aborting."
    fi
    if [ -n "${size:-}" ]; then
        local actual_size
        actual_size="$(wc -c < "$artifact" | tr -d '[:space:]')"
        [ "$actual_size" = "$size" ] || fail "Size mismatch: expected $size bytes, got $actual_size. Aborting."
    fi
    log "Verified."

    if [ "$dryrun" = true ]; then
        log "Extracting..."
        tar xzf "$artifact" -C "$workdir"
        local pkgdir
        pkgdir="$(find "$workdir" -mindepth 1 -maxdepth 1 -type d -name 'harmony-server-*' | head -n1)"
        [ -n "$pkgdir" ] && [ -f "$pkgdir/install.sh" ] || fail "Package layout unexpected: bundled install.sh not found."
        log ""
        log "=== Dry run complete: v$version resolved, downloaded, verified, and extracted ==="
        log "    Package: $(basename "$pkgdir") (binary, dashboard/, bin/, install.sh present: yes)"
        [ -f "$pkgdir/harmony-server" ] || log "    WARNING: harmony-server binary missing from package"
        return 0
    fi

    # --- Re-verify, extract, and install inside a root-owned directory -----
    # Root re-hashes its own private copy before extracting, so the invoking
    # user cannot swap bytes between the check above and execution as root.
    log "Extracting and installing (root)..."
    $SUDO bash -s -- "$artifact" "$sha256" "$SERVICE_NAME" <<'ROOTEOF'
set -euo pipefail
artifact="$1"; expected="$2"; service="$3"
rootdir="$(mktemp -d /tmp/harmony-install-root.XXXXXX)"
trap 'rm -rf "$rootdir"' EXIT
trap 'exit 130' INT TERM
cp -- "$artifact" "$rootdir/package.tar.gz"
actual="$(sha256sum "$rootdir/package.tar.gz" | awk '{print $1}')"
if [ "$actual" != "$expected" ]; then
    echo "ERROR: root-side SHA-256 mismatch: expected $expected, got $actual. Aborting." >&2
    exit 1
fi
tar xzf "$rootdir/package.tar.gz" -C "$rootdir"
pkgdir="$(find "$rootdir" -mindepth 1 -maxdepth 1 -type d -name 'harmony-server-*' | head -n1)"
if [ -z "$pkgdir" ] || [ ! -f "$pkgdir/install.sh" ]; then
    echo "ERROR: Package layout unexpected: bundled install.sh not found." >&2
    exit 1
fi
if systemctl is-active --quiet "$service" 2>/dev/null; then
    echo "Stopping running service for upgrade..."
    systemctl stop "$service"
fi
bash "$pkgdir/install.sh"
ROOTEOF

    # --- Start and report ---------------------------------------------------
    if [ "${HARMONY_NO_START:-}" = "1" ]; then
        log ""
        log "HARMONY_NO_START=1 set: service installed and enabled but not started."
        log "Start it with: sudo systemctl start $SERVICE_NAME"
        return 0
    fi

    log "Starting $SERVICE_NAME..."
    $SUDO systemctl start "$SERVICE_NAME"

    local tries=0
    while [ $tries -lt 20 ]; do
        if systemctl is-active --quiet "$SERVICE_NAME"; then
            break
        fi
        tries=$((tries + 1))
        sleep 1
    done
    systemctl is-active --quiet "$SERVICE_NAME" || \
        fail "Service did not reach active state. Inspect: sudo journalctl -u $SERVICE_NAME -n 100 --no-pager"

    # Best-effort: surface the one-time setup token from the journal so the
    # operator does not have to dig for it. Reissued on every start until
    # setup completes, so a miss here is only a minor inconvenience.
    sleep 2
    local token=""
    token="$($SUDO journalctl -u "$SERVICE_NAME" -n 300 --no-pager -o cat 2>/dev/null | \
        awk '/HARMONY INITIAL SETUP TOKEN/{getline; gsub(/^[ \t]+|[ \t]+$/, ""); print; exit}')" || token=""

    local host_ip=""
    host_ip="$(hostname -I 2>/dev/null | awk '{print $1}')" || host_ip=""

    log ""
    log "=== Harmony AIO Server v$version installed ==="
    log ""
    log "  Dashboard:  http://${host_ip:-localhost}:$DASHBOARD_PORT"
    if [ -n "$token" ]; then
        log "  Setup:      http://${host_ip:-localhost}:$DASHBOARD_PORT/setup"
        log "  Setup token: $token"
    else
        log "  First-run setup token (printed to the journal on startup):"
        log "    sudo journalctl -u $SERVICE_NAME -o cat | grep -A 1 'HARMONY INITIAL SETUP TOKEN'"
    fi
    log ""
    log "  Optional hardening: set HARMONY_KEY_PASSPHRASE in /etc/harmony/harmony.env,"
    log "  then: sudo systemctl restart $SERVICE_NAME"
    log ""
    log "  Uninstall: curl -fsSL https://harmonyaio.com/uninstall.sh | bash"
}

main "$@"
