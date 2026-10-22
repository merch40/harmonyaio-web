# Harmony AIO Server - hosted one-liner installer (Windows, amd64)
#
#   irm https://harmonyaio.com/install.ps1 | iex
#
# Resolves the latest signed release for a channel through the harmonyaio.com
# release resolver, downloads the release ZIP from the update origin, verifies
# its SHA-256 and size against the signed manifest values, then drives the
# package's own install.ps1 exactly the way the NSIS setup executable does
# (prepare with -OpenFirewall -NoStart, then -FinalizeOnly to start and
# health-check the native Windows service).
#
# Environment overrides (parameters cannot be passed through `| iex`):
#   HARMONY_CHANNEL       release channel (resolver default when unset)
#   HARMONY_REINSTALL=1   allow reinstall over an existing HarmonyAIOServer service
#   HARMONY_RESOLVER_URL  alternate resolver endpoint (testing)
#   HARMONY_ARTIFACT_URL / HARMONY_ARTIFACT_SHA256
#                         bypass the resolver with an explicit artifact (testing)
#   HARMONY_DRYRUN=1      resolve, download, verify, and extract only; install
#                         nothing and touch no system state
#   HARMONY_NO_LOCAL_AGENT=1
#                         skip provisioning the local Harmony agent on this
#                         host after the server starts
#
# Run from an elevated PowerShell session (5.1 or 7+). The inner package
# installer always executes under 64-bit Windows PowerShell 5.1, matching the
# setup executable's service and trust contract.
& {
    $ErrorActionPreference = 'Stop'

    $serviceName = 'HarmonyAIOServer'
    $legacyTaskName = 'Harmony AIO Server'
    $installDir = Join-Path $env:ProgramData 'Harmony AIO'
    $dashboardPort = 8420
    $defaultResolver = 'https://harmonyaio.com/api/releases/latest'

    # The server (service working directory = $installDir) writes its one-time
    # setup token to this SYSTEM/Administrators-only file on a start that
    # still needs setup, reuses it across restarts, and deletes it when setup
    # completes. It is never printed to logs\server.log (ADR 0243).
    $setupTokenFile = Join-Path $installDir 'data\setup-token'

    # Returns $true when the setup-token file at $Path holds one well-formed
    # token (43 base64url characters, optional LF or CRLF ending) on exactly
    # one line. The file's content is never assigned to a variable: only its
    # byte length and line count are kept, and Select-String -Quiet matches it
    # in place, so even Set-PSDebug -Trace cannot show the token (ADR 0243).
    # No log is ever read.
    function Test-HarmonySetupTokenFileReady([string]$Path) {
        try {
            if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
            $length = (Get-Item -LiteralPath $Path).Length
            if ($length -lt 43 -or $length -gt 45) { return $false }
            $lines = (Get-Content -LiteralPath $Path | Measure-Object).Count
            if ($lines -ne 1) { return $false }
            return [bool](Select-String -LiteralPath $Path -Pattern '^[A-Za-z0-9_-]{43}$' -CaseSensitive -Quiet)
        } catch {
            return $false
        }
    }

    # Asks the running server whether first-run setup is still required
    # (GET /api/setup/status, unauthenticated). Returns 'required',
    # 'complete', or $null when no URL answers. The server arms or regenerates
    # the token file before it serves HTTP, so 'required' means the file is
    # current. Loopback only, so a self-signed certificate is accepted.
    function Get-HarmonySetupState([string[]]$BaseUrls) {
        foreach ($base in $BaseUrls) {
            if (-not $base) { continue }
            $previous = [System.Net.ServicePointManager]::ServerCertificateValidationCallback
            try {
                $params = @{ UseBasicParsing = $true; Uri = ($base + '/api/setup/status'); TimeoutSec = 3 }
                if ($PSVersionTable.PSVersion.Major -ge 6) {
                    $params['SkipCertificateCheck'] = $true
                } else {
                    [System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
                }
                $resp = Invoke-WebRequest @params
                $body = $resp.Content | ConvertFrom-Json
                if ($body.required -eq $true) { return 'required' }
                if ($body.required -eq $false) { return 'complete' }
            } catch {
            } finally {
                [System.Net.ServicePointManager]::ServerCertificateValidationCallback = $previous
            }
        }
        return $null
    }

    # The installer's final setup report. Waits (bounded) for the server to
    # answer its setup status, then prints the setup URL, the token file's
    # PATH and the elevated command to read it - never the token, which would
    # land in PowerShell transcripts and remote-execution logs. A server whose
    # setup is already complete gets no token path at all.
    function Write-HarmonySetupReport([string]$TokenFile, [int]$TimeoutSeconds, [string]$SetupUrl, [string[]]$BaseUrls) {
        $state = $null
        for ($waited = 0; ; $waited++) {
            $state = Get-HarmonySetupState $BaseUrls
            if ($state -eq 'required' -and (Test-HarmonySetupTokenFileReady $TokenFile)) { break }
            if ($state -eq 'complete') { break }
            if ($waited -ge $TimeoutSeconds) { $state = 'timeout'; break }
            Start-Sleep -Seconds 1
        }
        Write-Host ("  Setup:      {0}" -f $SetupUrl)
        if ($state -eq 'complete') {
            Write-Host '  First-run setup is already complete; sign in with your owner account.'
            return
        }
        if ($state -eq 'required') {
            Write-Host ("  Setup token file (Administrators-only, never in the server log): {0}" -f $TokenFile)
        } else {
            Write-Host ("  The server did not confirm its setup status within {0}s." -f $TimeoutSeconds)
            Write-Host ("  If setup is still required, the setup token file is: {0}" -f $TokenFile)
        }
        Write-Host '  Read the token from an elevated PowerShell:'
        Write-Host ("    Get-Content -LiteralPath '{0}'" -f $TokenFile)
        Write-Host '  The installer does not print the token itself: it would land in terminal transcripts and logs.'
    }

    # Test entry point (packaging/webinstall tests): run the shipped final
    # setup report against the given token file and status base URL (waiting
    # HARMONY_INSTALL_TEST_SETUP_TIMEOUT seconds, default 0); install nothing.
    if ($env:HARMONY_INSTALL_TEST_SETUP_REPORT_TOKEN_FILE) {
        $testTimeout = 0
        if ($env:HARMONY_INSTALL_TEST_SETUP_TIMEOUT) { $testTimeout = [int]$env:HARMONY_INSTALL_TEST_SETUP_TIMEOUT }
        Write-HarmonySetupReport $env:HARMONY_INSTALL_TEST_SETUP_REPORT_TOKEN_FILE $testTimeout 'http://localhost:8420/setup' @($env:HARMONY_INSTALL_TEST_SETUP_STATUS_URL)
        return
    }

    Write-Host '=== Harmony AIO Server Installer ===' -ForegroundColor Cyan
    Write-Host ''

    $dryRun = ($env:HARMONY_DRYRUN -eq '1')

    # --- Platform and privilege checks -----------------------------------
    if (-not [Environment]::Is64BitOperatingSystem) {
        throw 'Harmony AIO Server requires 64-bit Windows.'
    }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if (-not $dryRun -and -not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'This installer must run from an elevated PowerShell session. Open PowerShell as Administrator and re-run: irm https://harmonyaio.com/install.ps1 | iex'
    }

    # The inner installer requires 64-bit Windows PowerShell 5.1. Sysnative
    # escapes WOW64 redirection if this outer session is a 32-bit host.
    $winPowerShell = if ([Environment]::Is64BitProcess) {
        Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    } else {
        Join-Path $env:SystemRoot 'Sysnative\WindowsPowerShell\v1.0\powershell.exe'
    }
    if (-not (Test-Path -LiteralPath $winPowerShell)) {
        throw 'The required 64-bit Windows PowerShell 5.1 host is unavailable.'
    }

    # TLS 1.2 for Windows PowerShell 5.1 downloads. This is the one piece of
    # session state the script changes (additive only), including in dry-run,
    # because the dry-run download needs it too.
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    # --- Existing installation gate ---------------------------------------
    # A reinstall over a registered service first runs the verified payload's
    # own trusted uninstaller (non-purge: data, config, logs, and update
    # state are preserved) because the packaged installer refuses, by
    # design, to prepare while a Harmony service or runtime files exist.
    $existing = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
    $reinstall = [bool]$existing -and -not $dryRun
    if ($reinstall -and $env:HARMONY_REINSTALL -ne '1') {
        throw ("An existing '{0}' service was detected. Installed servers upgrade through the signed update channel " +
            "(dashboard: Settings > System > Updates). To force a reinstall over this installation anyway, set " +
            "`$env:HARMONY_REINSTALL='1' and re-run.") -f $serviceName
    }

    # --- Resolve the release -----------------------------------------------
    $release = $null
    if ($env:HARMONY_ARTIFACT_URL -or $env:HARMONY_ARTIFACT_SHA256) {
        if (-not ($env:HARMONY_ARTIFACT_URL -and $env:HARMONY_ARTIFACT_SHA256)) {
            throw 'HARMONY_ARTIFACT_URL and HARMONY_ARTIFACT_SHA256 must be set together.'
        }
        $release = [pscustomobject]@{
            channel = 'manual'; version = 'manual'
            url = $env:HARMONY_ARTIFACT_URL; sha256 = $env:HARMONY_ARTIFACT_SHA256; size = 0
        }
        Write-Host 'Using explicit artifact override (resolver bypassed).'
    } else {
        $resolver = if ($env:HARMONY_RESOLVER_URL) { $env:HARMONY_RESOLVER_URL } else { $defaultResolver }
        $uri = $resolver + '?os=windows'
        if ($env:HARMONY_CHANNEL) {
            if ($env:HARMONY_CHANNEL -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$') {
                throw 'Invalid HARMONY_CHANNEL value.'
            }
            $uri += '&channel=' + [Uri]::EscapeDataString($env:HARMONY_CHANNEL)
        }
        Write-Host 'Resolving latest release...'
        $release = Invoke-RestMethod -UseBasicParsing -Uri $uri
    }

    if (-not $release.version -or -not $release.url -or -not $release.sha256) {
        throw "Unexpected resolver response: $($release | ConvertTo-Json -Compress -Depth 3)"
    }
    if ($release.sha256 -notmatch '^[0-9a-fA-F]{64}$') { throw 'Resolver returned an invalid sha256.' }
    # Scheme whitelist: https always; http only behind the explicit testing
    # flag; every other scheme (file:, UNC, ...) is refused outright.
    if ($release.url -notmatch '^https://') {
        if ($release.url -notmatch '^http://' -or $env:HARMONY_ALLOW_HTTP -ne '1') {
            throw 'Refusing a non-HTTPS artifact URL (set HARMONY_ALLOW_HTTP=1 only for local http testing).'
        }
    }

    Write-Host ("  Channel: {0}" -f $release.channel)
    Write-Host ("  Version: {0}" -f $release.version)
    Write-Host ("  Source:  {0}" -f $release.url)
    Write-Host ''

    # --- Download and verify -------------------------------------------------
    $workDir = Join-Path $env:TEMP ('harmony-install-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
    New-Item -ItemType Directory -Path $workDir -Force | Out-Null
    try {
        $zipPath = Join-Path $workDir (Split-Path -Leaf ([Uri]$release.url).AbsolutePath)
        Write-Host 'Downloading...'
        $previousProgress = $ProgressPreference
        $ProgressPreference = 'SilentlyContinue'
        try {
            Invoke-WebRequest -UseBasicParsing -Uri $release.url -OutFile $zipPath
        } finally {
            $ProgressPreference = $previousProgress
        }

        Write-Host 'Verifying SHA-256...'
        $actual = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actual -ne $release.sha256.ToLowerInvariant()) {
            throw "SHA-256 mismatch: expected $($release.sha256), got $actual. Aborting."
        }
        if ($release.size -gt 0 -and (Get-Item -LiteralPath $zipPath).Length -ne [int64]$release.size) {
            throw "Size mismatch: expected $($release.size) bytes. Aborting."
        }
        Write-Host 'Verified.'

        Write-Host 'Extracting...'
        $extractDir = Join-Path $workDir 'payload'
        Expand-Archive -LiteralPath $zipPath -DestinationPath $extractDir -Force
        $payloadRoot = Get-ChildItem -LiteralPath $extractDir -Directory |
            Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'install.ps1') } |
            Select-Object -First 1
        if (-not $payloadRoot) { throw 'Package layout unexpected: bundled install.ps1 not found.' }
        $payload = $payloadRoot.FullName

        if ($dryRun) {
            $binaryPresent = Test-Path -LiteralPath (Join-Path $payload 'harmony-server.exe')
            Write-Host ''
            Write-Host ("=== Dry run complete: v{0} resolved, downloaded, verified, and extracted ===" -f $release.version) -ForegroundColor Green
            Write-Host ("    Package: {0} (harmony-server.exe present: {1})" -f $payloadRoot.Name, $binaryPresent)
            return
        }

        # --- Reinstall: tear down with the verified payload's own helper -----
        if ($reinstall) {
            $payloadUninstall = Join-Path $payload 'uninstall.ps1'
            if (-not (Test-Path -LiteralPath $payloadUninstall)) {
                throw 'Verified package does not contain uninstall.ps1; cannot reinstall safely.'
            }
            Write-Host 'Removing the existing installation (state is preserved)...'
            & $winPowerShell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $payloadUninstall `
                -InstallDir $installDir -ServiceName $serviceName -LegacyTaskName $legacyTaskName `
                -UpdateTaskName 'Harmony AIO Dogfood Updates'
            if ($LASTEXITCODE -ne 0) {
                throw "Existing-installation teardown failed with exit code $LASTEXITCODE. Nothing new was installed."
            }
        }

        # --- Prepare, then finalize, exactly like the setup executable -------
        Write-Host 'Preparing the native Windows service...'
        & $winPowerShell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $payload 'install.ps1') `
            -PackageRoot $payload -InstallDir $installDir -ServiceName $serviceName `
            -LegacyTaskName $legacyTaskName -OpenFirewall -NoStart
        if ($LASTEXITCODE -ne 0) {
            throw "Package installer preparation failed with exit code $LASTEXITCODE."
        }

        Write-Host 'Starting and health-checking the service...'
        & $winPowerShell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $payload 'install.ps1') `
            -InstallDir $installDir -ServiceName $serviceName -LegacyTaskName $legacyTaskName -FinalizeOnly `
            -SkipSetupReport
        if ($LASTEXITCODE -ne 0) {
            Write-Host 'Service finalization failed; rolling back the prepared service...' -ForegroundColor Yellow
            & $winPowerShell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $payload 'install.ps1') `
                -InstallDir $installDir -ServiceName $serviceName -RollbackPrepared | Out-Null
            throw 'Harmony service startup or health verification failed. The prepared service was rolled back.'
        }

        Write-Host 'Enabling signed server update checks...'
        & $winPowerShell -NoProfile -NonInteractive -ExecutionPolicy Bypass `
            -File (Join-Path $payload 'register-dogfood-updates.ps1') `
            -InstallDir $installDir -ServerServiceName $serviceName `
            -LegacyServerTaskName $legacyTaskName
        if ($LASTEXITCODE -ne 0) {
            Write-Host "WARNING: server installation succeeded, but signed updater registration failed (exit $LASTEXITCODE)." -ForegroundColor Yellow
            Write-Host "         Settings > System > Updates will explain the missing prerequisite."
        }
    } finally {
        Remove-Item -LiteralPath $workDir -Recurse -Force -ErrorAction SilentlyContinue
    }

    # --- Local agent --------------------------------------------------------
    # The installed package ships bin\provision-local-agent.ps1: it installs a
    # Harmony agent on this host so the new server can monitor its own machine
    # and map the network. It enrolls itself once first-run setup creates the
    # first tenant (ADR 0262 CX5B); there is no approval step.
    $localAgentNote = 'not installed'
    $provisionScript = Join-Path $installDir 'bin\provision-local-agent.ps1'
    if ($env:HARMONY_NO_LOCAL_AGENT -eq '1') {
        Write-Host 'HARMONY_NO_LOCAL_AGENT=1 set: skipping local agent provisioning.'
        $localAgentNote = 'skipped (HARMONY_NO_LOCAL_AGENT=1)'
    } elseif (Test-Path -LiteralPath $provisionScript) {
        Write-Host 'Provisioning the local Harmony agent for this host...'
        & $winPowerShell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $provisionScript -ServerRoot $installDir
        if ($LASTEXITCODE -eq 0) {
            $localAgentNote = 'installed (enrolls itself once setup creates the first tenant)'
        } else {
            Write-Host 'WARNING: local agent provisioning failed; the server install is unaffected.' -ForegroundColor Yellow
            Write-Host ("         Re-run later, elevated: powershell -ExecutionPolicy Bypass -File `"{0}`"" -f $provisionScript)
            $localAgentNote = 'failed (see warning above)'
        }
    }

    # --- Report -----------------------------------------------------------------
    Write-Host ''
    Write-Host ("=== Harmony AIO Server v{0} installed ===" -f $release.version) -ForegroundColor Green
    Write-Host ''
    Write-Host ("  Service:    {0} (automatic, delayed start)" -f $serviceName)
    Write-Host ("  Dashboard:  http://localhost:{0}" -f $dashboardPort)
    Write-Host ("  Local agent: {0}" -f $localAgentNote)
    # Fenced on the server's own setup status (it arms the token file before
    # serving HTTP), never on the file's mere existence: a stale or not-yet-
    # regenerated file is never presented as current.
    Write-HarmonySetupReport $setupTokenFile 60 ("http://localhost:{0}/setup" -f $dashboardPort) @(("http://127.0.0.1:{0}" -f $dashboardPort), 'https://127.0.0.1:8443')
    Write-Host ''
    Write-Host ("  Setup token file: {0}" -f $setupTokenFile)
    Write-Host ("  By hostname: http://{0}:{1}/setup" -f [System.Net.Dns]::GetHostName(), $dashboardPort)
    Write-Host '  If your browser refuses the hostname because of an older certificate, use the IP address.'
    Write-Host '  Windows Firewall was opened for TCP 8420 and 8444 on Domain and Private profiles.'
    Write-Host '  Uninstall: irm https://harmonyaio.com/uninstall.ps1 | iex'
    Write-Host ''
}
