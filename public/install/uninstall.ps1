# Harmony AIO Server - hosted one-liner uninstaller (Windows)
#
#   irm https://harmonyaio.com/uninstall.ps1 | iex
#
# The installed tree deliberately does not ship an uninstall helper, so this
# script downloads the current signed release ZIP, verifies its SHA-256 and
# size against the signed manifest, and runs the packaged trusted
# uninstaller from the verified payload - the same helper the setup
# executable embeds. That helper validates ownership of the protected
# install root and removes the SYSTEM update task before the service.
#
# If the release cannot be downloaded (offline host), a minimal fallback
# removes the service, the named scheduled tasks, and the firewall rule.
# The fallback never recursively deletes the install tree: purge requires
# the verified helper's reparse-point and ownership guards.
#
# Data, configuration, logs, and update state are preserved unless
# HARMONY_PURGE=1 is set, which permanently deletes them.
#
# Environment overrides: HARMONY_PURGE, HARMONY_CHANNEL,
# HARMONY_RESOLVER_URL, HARMONY_ARTIFACT_URL / HARMONY_ARTIFACT_SHA256,
# HARMONY_ALLOW_HTTP (same semantics as install.ps1).
& {
    $ErrorActionPreference = 'Stop'

    $serviceName = 'HarmonyAIOServer'
    $legacyTaskName = 'Harmony AIO Server'
    $updateTaskName = 'Harmony AIO Dogfood Updates'
    $firewallRuleName = 'Harmony AIO Server TCP 8420'
    $installDir = Join-Path $env:ProgramData 'Harmony AIO'
    $defaultResolver = 'https://harmonyaio.com/api/releases/latest'

    Write-Host '=== Harmony AIO Server Uninstaller ===' -ForegroundColor Cyan
    Write-Host ''

    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'This uninstaller must run from an elevated PowerShell session.'
    }

    $winPowerShell = if ([Environment]::Is64BitProcess) {
        Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    } else {
        Join-Path $env:SystemRoot 'Sysnative\WindowsPowerShell\v1.0\powershell.exe'
    }
    if (-not (Test-Path -LiteralPath $winPowerShell)) {
        throw 'The required 64-bit Windows PowerShell 5.1 host is unavailable.'
    }

    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    $purge = ($env:HARMONY_PURGE -eq '1')

    # --- Obtain the trusted uninstall helper from a verified release --------
    $helperPath = $null
    $workDir = Join-Path $env:TEMP ('harmony-uninstall-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
    try {
        try {
            $release = $null
            if ($env:HARMONY_ARTIFACT_URL -and $env:HARMONY_ARTIFACT_SHA256) {
                $release = [pscustomobject]@{
                    version = 'manual'; url = $env:HARMONY_ARTIFACT_URL
                    sha256 = $env:HARMONY_ARTIFACT_SHA256; size = 0
                }
            } else {
                $resolver = if ($env:HARMONY_RESOLVER_URL) { $env:HARMONY_RESOLVER_URL } else { $defaultResolver }
                $uri = $resolver + '?os=windows'
                if ($env:HARMONY_CHANNEL) {
                    if ($env:HARMONY_CHANNEL -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$') {
                        throw 'Invalid HARMONY_CHANNEL value.'
                    }
                    $uri += '&channel=' + [Uri]::EscapeDataString($env:HARMONY_CHANNEL)
                }
                Write-Host 'Fetching the current signed release to obtain the trusted uninstall helper...'
                $release = Invoke-RestMethod -UseBasicParsing -Uri $uri
            }

            if (-not $release.url -or $release.sha256 -notmatch '^[0-9a-fA-F]{64}$') {
                throw 'Resolver response is missing url/sha256.'
            }
            if ($release.url -notmatch '^https://') {
                if ($release.url -notmatch '^http://' -or $env:HARMONY_ALLOW_HTTP -ne '1') {
                    throw 'Refusing a non-HTTPS artifact URL.'
                }
            }

            New-Item -ItemType Directory -Path $workDir -Force | Out-Null
            $zipPath = Join-Path $workDir 'release.zip'
            $previousProgress = $ProgressPreference
            $ProgressPreference = 'SilentlyContinue'
            try {
                Invoke-WebRequest -UseBasicParsing -Uri $release.url -OutFile $zipPath
            } finally {
                $ProgressPreference = $previousProgress
            }
            $actual = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($actual -ne $release.sha256.ToLowerInvariant()) {
                throw "Release SHA-256 mismatch: expected $($release.sha256), got $actual."
            }
            if ($release.size -gt 0 -and (Get-Item -LiteralPath $zipPath).Length -ne [int64]$release.size) {
                throw "Release size mismatch: expected $($release.size) bytes."
            }
            $extractDir = Join-Path $workDir 'payload'
            Expand-Archive -LiteralPath $zipPath -DestinationPath $extractDir -Force
            $payloadRoot = Get-ChildItem -LiteralPath $extractDir -Directory |
                Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'uninstall.ps1') } |
                Select-Object -First 1
            if (-not $payloadRoot) { throw 'Verified package does not contain uninstall.ps1.' }
            $helperPath = Join-Path $payloadRoot.FullName 'uninstall.ps1'
        } catch {
            Write-Host ("Could not obtain the verified uninstall helper: {0}" -f $_.Exception.Message) -ForegroundColor Yellow
            $helperPath = $null
        }

        if ($helperPath) {
            Write-Host 'Running the verified trusted uninstall helper...'
            $helperArgs = @(
                '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $helperPath,
                '-InstallDir', $installDir, '-ServiceName', $serviceName,
                '-LegacyTaskName', $legacyTaskName, '-UpdateTaskName', $updateTaskName
            )
            if ($purge) { $helperArgs += '-Purge' }
            & $winPowerShell @helperArgs
            if ($LASTEXITCODE -ne 0) {
                throw "The trusted uninstall helper failed with exit code $LASTEXITCODE."
            }
        } else {
            # --- Minimal offline fallback ---------------------------------
            Write-Host 'Falling back to minimal controller removal (no files are deleted).' -ForegroundColor Yellow

            foreach ($taskName in @($updateTaskName, $legacyTaskName)) {
                $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
                if ($task) {
                    Write-Host "Removing scheduled task '$taskName'..."
                    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
                }
            }

            $service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
            if ($service) {
                if ($service.Status -ne 'Stopped') {
                    Write-Host "Stopping $serviceName..."
                    Stop-Service -Name $serviceName -Force
                }
                Write-Host "Removing service $serviceName..."
                & sc.exe delete $serviceName | Out-Null
                if ($LASTEXITCODE -ne 0) {
                    throw "sc.exe delete $serviceName failed with exit code $LASTEXITCODE."
                }
            } else {
                Write-Host "Service $serviceName is not installed."
            }

            $rule = Get-NetFirewallRule -DisplayName $firewallRuleName -ErrorAction SilentlyContinue
            if ($rule) {
                Write-Host "Removing firewall rule '$firewallRuleName'..."
                $rule | Remove-NetFirewallRule
            }

            if (Test-Path -LiteralPath $installDir) {
                Write-Host ''
                Write-Host "NOTE: program files, data, configuration, and logs remain at: $installDir" -ForegroundColor Yellow
                if ($purge) {
                    Write-Host 'Purge was NOT performed: it requires the verified helper (re-run online),' -ForegroundColor Yellow
                    Write-Host 'or delete the directory manually after confirming it contains no junctions.' -ForegroundColor Yellow
                }
            }
        }
    } finally {
        if (Test-Path -LiteralPath $workDir) {
            Remove-Item -LiteralPath $workDir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    Write-Host ''
    if (-not $purge) {
        Write-Host 'Data, configuration, logs, and update state were preserved.'
        Write-Host "To remove everything: `$env:HARMONY_PURGE='1'; irm https://harmonyaio.com/uninstall.ps1 | iex"
        Write-Host ''
    }
    Write-Host '=== Uninstall complete ===' -ForegroundColor Green
}
