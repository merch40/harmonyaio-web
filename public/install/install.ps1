# install.ps1 -- Harmony AIO Agent installer for Windows
#
# Installs the harmony-agent binary as a Windows service, writes agent.json
# next to the binary so the agent knows which server to call, and leaves a
# persistent log at $env:ProgramData\Harmony\install.log.
#
# Server URL precedence (highest to lowest):
#   1. -ServerUrl command-line argument
#   2. $env:HARMONY_SERVER environment variable
#   3. Worker-injected default (when served from harmonyaio.com with ?server=)
#
# Binary source: if neither -BinaryPath nor -BinaryUrl is given, defaults to
# ${ServerUrl}/api/agent/download.
#
# Simplest invocation (Worker-injected server URL via harmonyaio.com):
#   iwr "https://harmonyaio.com/install.ps1?server=http://your-harmony-server:8420" | iex
#
# With an env var:
#   $env:HARMONY_SERVER = 'http://192.168.50.115:8420'
#   iwr https://harmonyaio.com/install.ps1 | iex
#
# With explicit args (dev / testing):
#   .\install.ps1 -ServerUrl http://192.168.50.115:8420 -BinaryPath C:\tmp\harmony-agent.exe

[CmdletBinding()]
param(
    # Worker-injected default.  When this script is served from harmonyaio.com,
    # the Cloudflare Worker replaces the placeholder below with the value of
    # the ?server= query string after sanitization.  Anything left as the
    # literal placeholder token is treated as unset and we fall through to
    # $env:HARMONY_SERVER.
    [string]$ServerUrl = '__HARMONY_SERVER_URL__',

    [string]$BinaryPath = '',

    [string]$BinaryUrl = '',

    [switch]$Force,

    [string]$ServiceName = 'HarmonyAgent',

    [string]$InstallDir = (Join-Path $env:ProgramFiles 'Harmony')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

$BinaryDest  = Join-Path $InstallDir 'harmony-agent.exe'
$ConfigDest  = Join-Path $InstallDir 'agent.json'
$LogDir      = Join-Path $env:ProgramData 'Harmony'
$LogPath     = Join-Path $LogDir 'install.log'

# ---------------------------------------------------------------------------
# Logging helpers
# ---------------------------------------------------------------------------

function Write-Log {
    param(
        [string]$Level,
        [string]$Message
    )
    $ts   = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    $line = "[harmony-install] $ts [$Level] $Message"

    # Append to persistent log (create directory/file as needed).
    if (-not (Test-Path $LogDir)) {
        New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
    }
    Add-Content -Path $LogPath -Value $line -Encoding UTF8 -ErrorAction SilentlyContinue

    switch ($Level) {
        'ERROR'   { Write-Host $line -ForegroundColor Red }
        'WARN'    { Write-Host $line -ForegroundColor Yellow }
        'SUCCESS' { Write-Host $line -ForegroundColor Green }
        default   { Write-Host $line -ForegroundColor Cyan }
    }
}

function Log-Info    { param([string]$m); Write-Log 'INFO'    $m }
function Log-Warn    { param([string]$m); Write-Log 'WARN'    $m }
function Log-Error   { param([string]$m); Write-Log 'ERROR'   $m }
function Log-Success { param([string]$m); Write-Log 'SUCCESS' $m }

# ---------------------------------------------------------------------------
# Rollback state
# ---------------------------------------------------------------------------

$CreatedFiles   = [System.Collections.Generic.List[string]]::new()
$ServiceCreated = $false
$ServiceStarted = $false

function Invoke-Rollback {
    Log-Warn 'Rolling back installation...'

    if ($ServiceStarted) {
        Log-Info "Stopping service $ServiceName ..."
        try { Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue } catch {}
    }

    if ($ServiceCreated) {
        Log-Info "Removing service $ServiceName ..."
        try {
            $svc = Get-WmiObject -Class Win32_Service -Filter "Name='$ServiceName'" -ErrorAction SilentlyContinue
            if ($svc) { $svc.Delete() | Out-Null }
        } catch {}
        # sc.exe delete as fallback
        try { sc.exe delete $ServiceName | Out-Null } catch {}
    }

    foreach ($f in $CreatedFiles) {
        if (Test-Path $f) {
            Log-Info "Removing $f"
            try { Remove-Item -Path $f -Force -ErrorAction SilentlyContinue } catch {}
        }
    }

    # Remove install dir if now empty.
    if (Test-Path $InstallDir) {
        $remaining = Get-ChildItem -Path $InstallDir -ErrorAction SilentlyContinue
        if (-not $remaining) {
            try { Remove-Item -Path $InstallDir -Force -ErrorAction SilentlyContinue } catch {}
        }
    }

    Log-Warn 'Rollback complete.  Nothing was installed.'
}

# ---------------------------------------------------------------------------
# Pre-flight checks
# ---------------------------------------------------------------------------

# Must run as Administrator.
$currentPrincipal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host '[harmony-install] ERROR: This script must be run as Administrator.' -ForegroundColor Red
    exit 1
}

# Apply the fallback chain for the server URL.  If -ServerUrl wasn't passed
# and the Worker left the placeholder in place, check the environment
# variable.  If that's also empty, blank $ServerUrl so the validation below
# trips the clean error path.
if ($ServerUrl -eq '__HARMONY_SERVER_URL__') {
    if (-not [string]::IsNullOrWhiteSpace($env:HARMONY_SERVER)) {
        $ServerUrl = $env:HARMONY_SERVER
    } else {
        $ServerUrl = ''
    }
}

if ([string]::IsNullOrWhiteSpace($ServerUrl)) {
    Write-Host '[harmony-install] ERROR: Server URL is required.  Provide one of:' -ForegroundColor Red
    Write-Host '  -ServerUrl http://your-harmony-server:8420' -ForegroundColor Red
    Write-Host '  $env:HARMONY_SERVER = "http://your-harmony-server:8420" (before running)' -ForegroundColor Red
    Write-Host '  Or the pre-configured URL:' -ForegroundColor Red
    Write-Host '  iwr "https://harmonyaio.com/install.ps1?server=http://your-harmony-server:8420" | iex' -ForegroundColor Red
    exit 1
}

# Default the binary source to the server's agent download endpoint if the
# caller didn't pin a local path or an explicit URL.  This is the hands-off
# path that makes the one-liner work: the agent always ships alongside the
# server it reports to.
if (-not [string]::IsNullOrWhiteSpace($BinaryPath) -and -not [string]::IsNullOrWhiteSpace($BinaryUrl)) {
    Write-Host '[harmony-install] ERROR: -BinaryPath and -BinaryUrl are mutually exclusive.' -ForegroundColor Red
    exit 1
}

if ([string]::IsNullOrWhiteSpace($BinaryPath) -and [string]::IsNullOrWhiteSpace($BinaryUrl)) {
    $BinaryUrl = ($ServerUrl.TrimEnd('/')) + '/api/agent/download'
}

# ---------------------------------------------------------------------------
# Idempotency check
# ---------------------------------------------------------------------------

if (-not $Force) {
    $existingSvc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($existingSvc -and $existingSvc.Status -eq 'Running') {
        if (Test-Path $ConfigDest) {
            try {
                $cfg         = Get-Content -Path $ConfigDest -Raw | ConvertFrom-Json
                $existingUrl = $cfg.server_url
            } catch {
                $existingUrl = ''
            }

            if ($existingUrl -eq $ServerUrl) {
                Log-Success "harmony-agent is already installed and running with the correct server URL.  Nothing to do."
                Log-Info    "Run with -Force to reinstall."
                exit 0
            } else {
                Log-Warn "Service is running but server URL has changed ($existingUrl -> $ServerUrl).  Use -Force to update."
                exit 0
            }
        }
    }
}

# ---------------------------------------------------------------------------
# Header
# ---------------------------------------------------------------------------

Write-Host ''
Write-Host '=== Harmony AIO Agent Installer (Windows) ===' -ForegroundColor Cyan
Log-Info "Starting installation"
Log-Info "Server URL:   $ServerUrl"
Log-Info "Service name: $ServiceName"
Log-Info "Install dir:  $InstallDir"
Log-Info "Log file:     $LogPath"
Write-Host ''

# From here on, all errors go through the catch block for rollback.
try {

    # -----------------------------------------------------------------------
    # Step 1: Acquire binary
    # -----------------------------------------------------------------------

    Log-Info 'Step 1/6: Acquiring binary...'

    $StagingBinary = ''

    if (-not [string]::IsNullOrWhiteSpace($BinaryPath)) {
        if (-not (Test-Path $BinaryPath)) {
            throw "Binary not found at $BinaryPath"
        }
        $StagingBinary = $BinaryPath
        Log-Info "Using local binary: $BinaryPath"
    } else {
        # Download binary to a temp file.
        $StagingBinary = [System.IO.Path]::GetTempFileName() + '.exe'
        $CreatedFiles.Add($StagingBinary)

        Log-Info "Downloading binary from $BinaryUrl ..."
        $ProgressPreference = 'SilentlyContinue'
        Invoke-WebRequest -Uri $BinaryUrl -OutFile $StagingBinary -UseBasicParsing
        $ProgressPreference = 'Continue'
        Log-Info "Download complete."
    }

    # Basic sanity check: Windows PE header starts with 'MZ'.
    $magicBytes = [System.IO.File]::ReadAllBytes($StagingBinary)[0..1]
    if ($magicBytes[0] -ne 77 -or $magicBytes[1] -ne 90) {
        Log-Warn "Binary does not start with MZ magic bytes -- may not be a valid Windows PE executable.  Proceeding anyway."
    }

    # -----------------------------------------------------------------------
    # Step 2: Create install directory
    # -----------------------------------------------------------------------

    Log-Info "Step 2/6: Creating install directory $InstallDir ..."

    if (-not (Test-Path $InstallDir)) {
        New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    }

    # -----------------------------------------------------------------------
    # Step 3: Copy binary
    # -----------------------------------------------------------------------

    Log-Info "Step 3/6: Installing binary to $BinaryDest ..."

    $binaryIsNew = -not (Test-Path $BinaryDest)

    Copy-Item -Path $StagingBinary -Destination $BinaryDest -Force

    if ($binaryIsNew) {
        $CreatedFiles.Add($BinaryDest)
    }

    # Size for confirmation.
    $sizeMB = [math]::Round((Get-Item $BinaryDest).Length / 1MB, 2)
    Log-Info "Binary installed ($sizeMB MB)."

    # Clean up temp download file.
    if (-not [string]::IsNullOrWhiteSpace($BinaryUrl) -and (Test-Path $StagingBinary) -and $StagingBinary -ne $BinaryDest) {
        Remove-Item -Path $StagingBinary -Force -ErrorAction SilentlyContinue
        $CreatedFiles.Remove($StagingBinary) | Out-Null
    }

    # -----------------------------------------------------------------------
    # Step 4: Write agent.json next to the binary
    # -----------------------------------------------------------------------
    # resolveServerURL() in main.go checks <exeDir>/agent.json on all platforms.

    Log-Info "Step 4/6: Writing $ConfigDest ..."

    $configIsNew = -not (Test-Path $ConfigDest)
    $configJson  = "{`"server_url`":`"$ServerUrl`"}"
    Set-Content -Path $ConfigDest -Value $configJson -Encoding UTF8

    if ($configIsNew) {
        $CreatedFiles.Add($ConfigDest)
    }

    Log-Info "agent.json written (server_url: $ServerUrl)."

    # -----------------------------------------------------------------------
    # Step 5: Create Windows service
    # -----------------------------------------------------------------------

    Log-Info "Step 5/6: Creating Windows service '$ServiceName' ..."

    $existingSvc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($existingSvc) {
        if ($Force) {
            Log-Info "Removing existing service $ServiceName for reinstall..."
            if ($existingSvc.Status -eq 'Running') {
                Stop-Service -Name $ServiceName -Force
            }
            $wmiSvc = Get-WmiObject -Class Win32_Service -Filter "Name='$ServiceName'" -ErrorAction SilentlyContinue
            if ($wmiSvc) { $wmiSvc.Delete() | Out-Null }
            # Brief pause so SCM registers the deletion.
            Start-Sleep -Seconds 2
        } else {
            Log-Info "Service $ServiceName already exists.  Updating binary path and config only."
        }
    }

    if (-not (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue)) {
        New-Service `
            -Name        $ServiceName `
            -BinaryPathName "`"$BinaryDest`"" `
            -DisplayName 'Harmony AIO Agent' `
            -Description 'Harmony AIO monitoring and remediation agent' `
            -StartupType Automatic | Out-Null

        $ServiceCreated = $true
        Log-Info "Service '$ServiceName' created."
    } else {
        Log-Info "Service '$ServiceName' already exists; skipping creation."
    }

    # -----------------------------------------------------------------------
    # Step 6: Start service and verify
    # -----------------------------------------------------------------------

    Log-Info "Step 6/6: Starting service '$ServiceName' ..."

    Start-Service -Name $ServiceName
    $ServiceStarted = $true
    Log-Info "Start command issued."

    # Poll for up to 30 seconds.
    Log-Info "Waiting for service to reach Running state (up to 30s) ..."
    $deadline = (Get-Date).AddSeconds(30)
    $active   = $false

    while ((Get-Date) -lt $deadline) {
        $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
        if ($svc -and $svc.Status -eq 'Running') {
            $active = $true
            break
        }
        Start-Sleep -Seconds 2
    }

    if (-not $active) {
        throw "Service '$ServiceName' did not reach Running state within 30 seconds."
    }

    Log-Success "Service '$ServiceName' is Running."

} catch {
    Log-Error "Installation failed: $_"
    Invoke-Rollback
    exit 1
}

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------

Write-Host ''
Log-Success '=== Installation complete ==='
Log-Success "  Binary:      $BinaryDest"
Log-Success "  Config:      $ConfigDest"
Log-Success "  Service:     $ServiceName (Running, Automatic)"
Log-Success "  Log file:    $LogPath"
Write-Host ''
Log-Info "The agent will phone home to $ServerUrl on its next heartbeat (within 30s)."
Log-Info "To check status:  Get-Service -Name $ServiceName"
Log-Info "To view logs:     Get-EventLog -LogName Application -Source $ServiceName -Newest 20"
Write-Host ''
