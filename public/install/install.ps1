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
            -InstallDir $installDir -ServiceName $serviceName -LegacyTaskName $legacyTaskName -FinalizeOnly
        if ($LASTEXITCODE -ne 0) {
            Write-Host 'Service finalization failed; rolling back the prepared service...' -ForegroundColor Yellow
            & $winPowerShell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $payload 'install.ps1') `
                -InstallDir $installDir -ServiceName $serviceName -RollbackPrepared | Out-Null
            throw 'Harmony service startup or health verification failed. The prepared service was rolled back.'
        }
    } finally {
        Remove-Item -LiteralPath $workDir -Recurse -Force -ErrorAction SilentlyContinue
    }

    # --- Report -----------------------------------------------------------------
    # Best-effort: surface the one-time setup token from the protected server
    # log. It is reissued on every start until setup completes.
    $setupToken = $null
    $serverLog = Join-Path $installDir 'logs\server.log'
    for ($attempt = 0; $attempt -lt 10 -and -not $setupToken; $attempt++) {
        Start-Sleep -Seconds 1
        if (Test-Path -LiteralPath $serverLog) {
            $match = Select-String -LiteralPath $serverLog -Pattern 'HARMONY INITIAL SETUP TOKEN' -Context 0, 1 |
                Select-Object -Last 1
            if ($match -and $match.Context.PostContext.Count -ge 1) {
                $setupToken = $match.Context.PostContext[0].Trim()
            }
        }
    }

    Write-Host ''
    Write-Host ("=== Harmony AIO Server v{0} installed ===" -f $release.version) -ForegroundColor Green
    Write-Host ''
    Write-Host ("  Service:    {0} (automatic, delayed start)" -f $serviceName)
    Write-Host ("  Dashboard:  http://localhost:{0}" -f $dashboardPort)
    if ($setupToken) {
        Write-Host ("  Setup:      http://localhost:{0}/setup" -f $dashboardPort)
        Write-Host ("  Setup token: {0}" -f $setupToken)
    } else {
        Write-Host '  First-run setup token (printed to the server log on startup):'
        Write-Host ("    Select-String -Path '{0}' -Pattern 'HARMONY INITIAL SETUP TOKEN' -Context 0,1" -f $serverLog)
    }
    Write-Host ''
    Write-Host '  Windows Firewall was opened for TCP 8420 on Domain and Private profiles.'
    Write-Host '  Uninstall: irm https://harmonyaio.com/uninstall.ps1 | iex'
    Write-Host ''
}
