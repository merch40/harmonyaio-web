# Apply the Harmony license worker schema to the configured D1 database.
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $PSScriptRoot
Push-Location $here
try {
    wrangler d1 execute harmony-license --file=schema/001_initial.sql @args
    wrangler d1 execute harmony-license --file=schema/002_seed_pa.sql @args
    Write-Host "Schema applied."
} finally {
    Pop-Location
}
