$path = "C:\Dev\harmonyaio-web\public\architecture.html"
$bytes = [System.IO.File]::ReadAllBytes($path)
$text = [System.Text.Encoding]::UTF8.GetString($bytes)

$oldTitle = '<title>Harmony AIO - Architecture Overview</title>'
$newBlock = '<title>Harmony AIO - Architecture Overview</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <meta name="description" content="Harmony AIO parent/child AI architecture: autonomous IT infrastructure that deploys lightweight agents, correlates findings, and orchestrates real fixes across your entire fleet.">'

if ($text.Contains($oldTitle)) {
    $text = $text.Replace($oldTitle, $newBlock)
    [System.IO.File]::WriteAllText($path, $text, [System.Text.Encoding]::UTF8)
    Write-Host "OK: meta tags added"
} else {
    Write-Host "Title not found - raw check:"
    $idx = $text.IndexOf('<title>')
    Write-Host $text.Substring($idx, 60)
}
