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
#   HARMONY_NO_TLS=1      first boot serves plain HTTP on 8420 instead of the
#                         default HTTPS (self-signed) on 8443
#   HARMONY_OPEN_FIREWALL=1|0
#                         open the dashboard port in ufw/firewalld without
#                         asking (1) or never touch the firewall (0); unset
#                         prompts when a terminal is available
#   HARMONY_NO_LOCAL_AGENT=1
#                         skip provisioning the local Harmony agent on this
#                         host after the server starts
#   HARMONY_DRYRUN=1      resolve, download, verify, and extract only; install
#                         nothing and touch no system state
#   HARMONY_RESOLVER_URL  alternate resolver endpoint (testing)
#   HARMONY_ARTIFACT_URL / HARMONY_ARTIFACT_SHA256
#                         bypass the resolver with an explicit artifact (testing,
#                         air-gapped staging); both must be set together
#   HARMONY_ALLOW_HTTP=1  permit plain-http artifact URLs (testing only)
#
# This script never handles secrets of its own. On first start the server
# writes its one-time setup token to the root/service-only file
# /var/lib/harmony/data/setup-token (never to the journal); this script
# prints that file's path and the command to read it, never the token
# (ADR 0243).
set -euo pipefail

RESOLVER_URL="${HARMONY_RESOLVER_URL:-https://harmonyaio.com/api/releases/latest}"
BINARY_PATH="/usr/local/bin/harmony-server"
SERVICE_NAME="harmony-server"
SERVICE_UNIT="/etc/systemd/system/harmony-server.service"
# The unit's WorkingDirectory is /var/lib/harmony; the server keeps its data
# in ./data there.
SETUP_TOKEN_FILE="/var/lib/harmony/data/setup-token"
DASHBOARD_PORT="8420"
TLS_PORT="8443"

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
# Matches internal/updatechannel MaxArtifactBytes; download cap when the
# resolver did not supply an exact size.
MAX_ARTIFACT_BYTES=536870912

log()  { printf '%s\n' "$*"; }
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

# have_tty reports whether this process can actually talk to a controlling
# terminal.
#
# Do NOT use `[ -r /dev/tty ] && [ -w /dev/tty ]`: test only performs an
# access() check against the device node, which succeeds on permissions alone
# even when the process has no controlling terminal. Opening it is what fails
# (ENXIO). Under `curl ... | bash` from cloud-init, CI, or a remote exec there is
# no controlling terminal, so the naive guard reports a TTY, the interactive
# branch runs, and the first write to /dev/tty kills the script under set -e -
# leaving the unit installed and enabled but never started.
#
# `[ -t 0 ]` is also wrong here: under `curl | bash` stdin is the pipe even in
# a fully interactive session, so it would suppress prompts that genuinely can
# be shown. Opening /dev/tty is the only test that distinguishes the two.
have_tty() {
    { : >/dev/tty; } 2>/dev/null && { : </dev/tty; } 2>/dev/null
}

fetch_stdout() {
    if have curl; then
        curl -fsSL "$1"
    elif have wget; then
        wget -qO- "$1"
    else
        fail "curl or wget is required."
    fi
}

# fetch_resolver surfaces the resolver's own error body instead of curl's
# opaque "(22) ... 404": an empty channel answers with a clear JSON message
# that the operator should actually see.
fetch_resolver() {
    local url="$1" out status body
    if have curl; then
        out="$(curl -sSL -w '\n%{http_code}' "$url")" || fail "Could not reach the release resolver at $url"
        status="${out##*$'\n'}"
        body="${out%$'\n'*}"
    elif have wget; then
        body="$(wget -qO- "$url")" || fail "Release resolver request failed at $url (channel may have no published releases yet)."
        status="200"
    else
        fail "curl or wget is required."
    fi
    if [ "$status" != "200" ]; then
        local errmsg
        errmsg="$(json_str "$body" error)"
        fail "${errmsg:-Release resolver returned HTTP $status at $url}"
    fi
    printf '%s' "$body"
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

# setup_token_file_ready <sudo> <path>
#
# Succeeds when the server's setup-token file holds exactly one line that is
# one well-formed token (43 base64url characters, LF or CRLF ending). The
# file's content is never read into a shell variable or command argument:
# grep matches it in place and only a line count is captured, so even
# `set -x` tracing cannot show the token (ADR 0243).
setup_token_file_ready() {
    local sudo="$1" path="$2"
    $sudo test -s "$path" 2>/dev/null || return 1
    [ "$($sudo grep -c '' "$path" 2>/dev/null)" = "1" ] || return 1
    $sudo grep -qxE '[A-Za-z0-9_-]{43}'$'\r''?' "$path" 2>/dev/null
}

# setup_status_state <base-url>...
#
# Asks the running server whether first-run setup is still required
# (GET /api/setup/status, unauthenticated). Prints "required", "complete",
# or nothing when no URL answers. The server arms or regenerates the token
# file before it serves HTTP, so "required" means the file is current.
setup_status_state() {
    local url body
    for url in "$@"; do
        body=""
        if have curl; then
            body="$(curl -fsSk --max-time 3 "$url/api/setup/status" 2>/dev/null)" || body=""
        elif have wget; then
            body="$(wget -qO- --no-check-certificate -T 3 -t 1 --max-redirect=0 "$url/api/setup/status" 2>/dev/null)" || body=""
        fi
        body="$(printf '%s' "$body" | tr -d ' \t\r\n')"
        case "$body" in
            *'"required":true'*)  printf 'required\n'; return 0 ;;
            *'"required":false'*) printf 'complete\n'; return 0 ;;
        esac
    done
}

# report_setup_token <sudo> <token-file> <timeout-seconds> <setup-url> <base-url>...
#
# The installer's final setup report. It waits (bounded) for the server to
# answer its setup status, then prints the setup URL, the token file's PATH
# and the elevated command to read it - never the token, which would land in
# terminal transcripts, cloud-init and CI logs. A server whose setup is
# already complete gets no token path at all.
report_setup_token() {
    local sudo="$1" path="$2" timeout="$3" setup_url="$4"
    shift 4
    local waited=0 state=""
    while :; do
        state="$(setup_status_state "$@")"
        if [ "$state" = "required" ]; then
            setup_token_file_ready "$sudo" "$path" && break
        elif [ "$state" = "complete" ]; then
            break
        fi
        if [ "$waited" -ge "$timeout" ]; then
            state="timeout"
            break
        fi
        sleep 1
        waited=$((waited + 1))
    done

    log "  Setup:      $setup_url"
    case "$state" in
        complete)
            log "  First-run setup is already complete; sign in with your owner account."
            return 0
            ;;
        required)
            log "  Setup token file (root-only, never in the journal): $path"
            ;;
        *)
            log "  The server did not confirm setup status within ${timeout}s."
            log "  If setup is still required, the setup token file is: $path"
            ;;
    esac
    log "  Read the token with:"
    log "    sudo cat $path"
    log "  The installer does not print the token itself: it would land in terminal transcripts and logs."
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
    # When this script is piped into bash, stdin is the script itself, so a
    # sudo password prompt must go through /dev/tty. Validate that upfront
    # and fail fast with the pipe-through-sudo alternative when there is no
    # terminal to prompt on (CI, provisioning tools, ssh without a tty).
    local SUDO=""
    if [ "$dryrun" = false ] && [ "$(id -u)" -ne 0 ]; then
        have sudo || fail "Run as root, or install sudo: curl -fsSL https://harmonyaio.com/install.sh | sudo bash"
        SUDO="sudo"
        if ! sudo -n true 2>/dev/null; then
            if have_tty; then
                log "Root privileges are required; sudo will now ask for your password."
                sudo -v < /dev/tty || fail "sudo authentication failed."
            else
                fail "sudo needs a password but no terminal is available to prompt on. Re-run as: curl -fsSL https://harmonyaio.com/install.sh | sudo bash"
            fi
        fi
    fi

    # --- Existing installation gate --------------------------------------
    local fresh_install=true
    if [ "$dryrun" = false ] && { [ -e "$BINARY_PATH" ] || [ -e "$SERVICE_UNIT" ]; }; then
        fresh_install=false
        if [ "${HARMONY_REINSTALL:-}" = "1" ]; then
            log "Existing installation detected; HARMONY_REINSTALL=1 set, continuing with in-place reinstall."
        elif have_tty; then
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
        response="$(fetch_resolver "$resolver")"
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
    # New installs default to first-boot HTTPS (self-signed) via the server's
    # HARMONY_BOOTSTRAP_TLS seed; it only applies while no runtime config
    # exists, so reinstalls keep whatever posture the operator configured.
    local enable_tls="0"
    if [ "$fresh_install" = true ] && [ "${HARMONY_NO_TLS:-}" != "1" ]; then
        enable_tls="1"
    fi

    log "Extracting and installing (root)..."
    $SUDO bash -s -- "$artifact" "$sha256" "$SERVICE_NAME" "$enable_tls" <<'ROOTEOF'
set -euo pipefail
artifact="$1"; expected="$2"; service="$3"; enable_tls="$4"
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
bash "$pkgdir/install.sh" --from-bootstrap
# Low-port drop-in (ADR 0263 s.5.1). Newer tarballs install it themselves;
# writing it here too covers a package built before they did.
install -d -m 755 /etc/systemd/system/harmony-server.service.d
cat > /etc/systemd/system/harmony-server.service.d/20-low-ports.conf <<'DROPIN'
# /etc/systemd/system/harmony-server.service.d/20-low-ports.conf
# Installed by the Harmony installers (ADR 0263 section 5.1): lets the
# unprivileged harmony user bind ports below 1024. NoNewPrivileges=yes stays
# on; ambient capabilities are granted by systemd at exec time.
[Service]
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
DROPIN
chmod 644 /etc/systemd/system/harmony-server.service.d/20-low-ports.conf
systemctl daemon-reload
if [ "$enable_tls" = "1" ] && ! grep -q '^HARMONY_BOOTSTRAP_TLS=' /etc/harmony/harmony.env 2>/dev/null; then
    {
        printf '\n# Added by the hosted installer: first boot enables HTTPS with a\n'
        printf '# self-signed certificate (no effect once runtime config exists).\n'
        printf 'HARMONY_BOOTSTRAP_TLS=1\n'
    } >> /etc/harmony/harmony.env
fi
if ! bash "$pkgdir/register-dogfood-updates.sh"; then
    echo "WARNING: server installation succeeded, but signed updater registration failed." >&2
    echo "         Settings > System > Updates will explain the missing prerequisite." >&2
fi
ROOTEOF

    # --- Firewall (ufw / firewalld only; anything else is left alone) -------
    # 8444 is the agent-CA listener agents dial (ADR 0262 CX5A).
    local fw_ports
    fw_ports="$(harmony_fw_plan /etc/harmony/harmony.env)"
    local fw_kind=""
    if have ufw && $SUDO ufw status 2>/dev/null | grep -q '^Status: active'; then
        fw_kind="ufw"
    elif have firewall-cmd && $SUDO firewall-cmd --state >/dev/null 2>&1; then
        fw_kind="firewalld"
    fi
    if [ -z "$fw_kind" ]; then
        log "No active firewall detected (ufw/firewalld); firewall unchanged."
    fi
    if [ -n "$fw_kind" ] && [ "${HARMONY_OPEN_FIREWALL:-}" != "0" ]; then
        local open_fw="${HARMONY_OPEN_FIREWALL:-}"
        if [ -z "$open_fw" ]; then
            if have_tty; then
                printf 'Firewall %s is active. Open TCP %s for the Harmony dashboard? [Y/n] ' "$fw_kind" "$fw_ports" > /dev/tty
                local fw_answer=""
                read -r fw_answer < /dev/tty || fw_answer=""
                case "$fw_answer" in
                    n|N|no|NO) open_fw="0" ;;
                    *) open_fw="1" ;;
                esac
            else
                log "NOTE: $fw_kind is active but no terminal is available to ask about opening TCP $fw_ports."
                log "      Re-run with HARMONY_OPEN_FIREWALL=1, or open the ports manually."
            fi
        fi
        if [ "$open_fw" = "1" ]; then
            harmony_fw_open "$fw_kind" $fw_ports
            log "Opened TCP $fw_ports in $fw_kind."
        fi
    fi

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


    # --- Local agent ---------------------------------------------------------
    # The package ships bin/provision-local-agent.sh: it installs a Harmony
    # agent on this host so the new server can monitor its own machine and map
    # the network. It enrolls itself once first-run setup creates the first
    # tenant (ADR 0262 CX5B); there is no approval step.
    local local_agent="not installed"
    if [ "${HARMONY_NO_LOCAL_AGENT:-}" = "1" ]; then
        log "HARMONY_NO_LOCAL_AGENT=1 set: skipping local agent provisioning."
        local_agent="skipped (HARMONY_NO_LOCAL_AGENT=1)"
    # Test with the SAME privilege that runs the script. /var/lib/harmony is
    # 0750 root:harmony, so an unprivileged `[ -f ... ]` here cannot even
    # traverse into it: the test came back false on every ordinary
    # `curl | bash` install and the whole feature silently never ran, while the
    # file was sitting right there. A guard must not check as a different user
    # than the command it guards.
    elif $SUDO test -f /var/lib/harmony/bin/provision-local-agent.sh; then
        log "Provisioning the local Harmony agent for this host..."
        if $SUDO bash /var/lib/harmony/bin/provision-local-agent.sh; then
            local_agent="installed (enrolls itself once setup creates the first tenant)"
        else
            log "WARNING: local agent provisioning failed; the server install is unaffected."
            log "         Re-run later with: sudo bash /var/lib/harmony/bin/provision-local-agent.sh"
            local_agent="failed (see warning above)"
        fi
    fi

    local host_ip=""
    host_ip="$(hostname -I 2>/dev/null | awk '{print $1}')" || host_ip=""

    # Never advertise a URL nothing is listening on: the TLS bootstrap only
    # takes effect on server builds that honor it, so probe the HTTPS port
    # (pure-bash /dev/tcp, no curl dependency) and report reality.
    local tls_note=""
    if [ "$enable_tls" = "1" ]; then
        local probe_tries=0 tls_live=false
        while [ $probe_tries -lt 10 ]; do
            if (exec 3<>"/dev/tcp/127.0.0.1/$TLS_PORT") 2>/dev/null; then
                exec 3>&- 3<&- 2>/dev/null || true
                tls_live=true
                break
            fi
            probe_tries=$((probe_tries + 1))
            sleep 1
        done
        if [ "$tls_live" = false ]; then
            enable_tls="0"
            tls_note="HTTPS bootstrap was requested, but this server build does not serve it yet; it takes effect automatically after the next server update."
        fi
    fi

    local host_name=""
    host_name="$(hostname -f 2>/dev/null || hostname 2>/dev/null)" || host_name=""
    local dash_url="http://${host_ip:-localhost}:$DASHBOARD_PORT"
    local name_url="http://${host_name:-localhost}:$DASHBOARD_PORT"
    if [ "$enable_tls" = "1" ]; then
        dash_url="https://${host_ip:-localhost}:$TLS_PORT"
        name_url="https://${host_name:-localhost}:$TLS_PORT"
    fi

    log ""
    log "=== Harmony AIO Server v$version installed ==="
    log ""
    log "  Dashboard:  $dash_url"
    log "  Local agent: $local_agent"
    # The unit is Type=simple, so "active" precedes the server's setup-token
    # bootstrap: fence on the server's own setup status, not on the file.
    report_setup_token "$SUDO" "$SETUP_TOKEN_FILE" 60 "$dash_url/setup" \
        "https://127.0.0.1:$TLS_PORT" "http://127.0.0.1:$DASHBOARD_PORT"
    log "  By IP:        $dash_url/setup"
    log "  By hostname:  $name_url/setup"
    log "  Setup token file: $SETUP_TOKEN_FILE (sudo cat it)"
    log "  If your browser refuses the hostname because of an older certificate, use the IP address."
    if [ "$enable_tls" = "1" ]; then
        log ""
        log "  HTTPS uses a self-signed certificate, so your browser will warn on"
        log "  first visit - that's expected. Install a real certificate later in"
        log "  Settings > Security > TLS. Plain http on $DASHBOARD_PORT redirects here."
    elif [ -n "$tls_note" ]; then
        log ""
        log "  NOTE: $tls_note"
    elif [ "$fresh_install" = false ]; then
        log ""
        log "  Reinstall: the server keeps its previously configured TLS posture;"
        log "  the URL above assumes plain HTTP on $DASHBOARD_PORT."
    fi
    log ""
    log "  Optional hardening: set HARMONY_KEY_PASSPHRASE in /etc/harmony/harmony.env,"
    log "  then: sudo systemctl restart $SERVICE_NAME"
    log ""
    log "  Uninstall: curl -fsSL https://harmonyaio.com/uninstall.sh | bash"
}

# HARMONY_INSTALL_SOURCE_ONLY=1 defines the functions without installing
# anything: the test entry point packaging/webinstall tests use to call the
# shipped functions directly (source the script, then call them).
if [ "${HARMONY_INSTALL_SOURCE_ONLY:-}" = "1" ]; then
    return 0 2>/dev/null || exit 0
fi
main "$@"
