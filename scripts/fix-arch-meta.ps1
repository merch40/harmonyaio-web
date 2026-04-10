$path = "C:\Dev\harmonyaio-web\public\architecture.html"
$content = [System.IO.File]::ReadAllText($path) -replace "`r`n","`n"

$old = '  <title>Harmony AIO - Architecture Overview</title>'
$new = '  <title>Harmony AIO — Architecture Overview</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <meta name="description" content="Harmony AIO parent/child AI architecture: autonomous IT infrastructure that deploys lightweight agents, correlates findings, and orchestrates real fixes across your entire fleet.">'

$content = $content.Replace($old, $new)
[System.IO.File]::WriteAllText($path, $content)

if ($content -match "favicon.svg") { Write-Host "OK: favicon added" } else { Write-Host "FAILED" }
if ($content -match 'meta name="description"') { Write-Host "OK: meta description added" } else { Write-Host "FAILED" }
