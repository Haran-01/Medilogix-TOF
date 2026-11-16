$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $projectRoot '.env'
$sourcePath = Join-Path $projectRoot 'mobile-viewer'
$outputPath = Join-Path $projectRoot 'release\mobile-viewer'

if (-not (Test-Path -LiteralPath $envPath -PathType Leaf)) {
  throw 'The root .env file is missing. Add SUPABASE_URL and SUPABASE_ANON_KEY, then build again.'
}

$envLines = Get-Content -LiteralPath $envPath
function Read-EnvValue([string] $name) {
  $line = $envLines | Where-Object { $_ -match "^\s*$([regex]::Escape($name))\s*=" } | Select-Object -First 1
  if (-not $line) { return '' }
  $value = ($line -replace "^\s*$([regex]::Escape($name))\s*=", '').Trim()
  if ($value.Length -ge 2 -and (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'")))) {
    $value = $value.Substring(1, $value.Length - 2)
  }
  return $value
}

$supabaseUrl = Read-EnvValue 'SUPABASE_URL'
$anonKey = Read-EnvValue 'SUPABASE_ANON_KEY'
if (-not $supabaseUrl -or -not $anonKey) {
  throw 'The root .env file must contain SUPABASE_URL and SUPABASE_ANON_KEY.'
}
if ($supabaseUrl -notmatch '^https://') {
  throw 'SUPABASE_URL must use HTTPS for the published mobile viewer.'
}

New-Item -ItemType Directory -Path $outputPath -Force | Out-Null
foreach ($file in @('index.html', 'styles.css', 'app.js', 'manifest.webmanifest')) {
  Copy-Item -LiteralPath (Join-Path $sourcePath $file) -Destination (Join-Path $outputPath $file) -Force
}
Copy-Item -LiteralPath (Join-Path $projectRoot 'src\assets\medilogix-symbol.png') -Destination (Join-Path $outputPath 'medilogix-symbol.png') -Force
Copy-Item -LiteralPath (Join-Path $projectRoot 'src\assets\medilogix-logo.png') -Destination (Join-Path $outputPath 'medilogix-logo.png') -Force

$publicConfig = @{ url = $supabaseUrl.TrimEnd('/'); anonKey = $anonKey } | ConvertTo-Json -Compress
Set-Content -LiteralPath (Join-Path $outputPath 'config.js') -Value "window.MEDILOGIX_CONFIG = Object.freeze($publicConfig);" -Encoding utf8

Write-Output "Mobile Recordings site built at: $outputPath"
Write-Output 'Publish the contents of that folder to an HTTPS static web host.'
