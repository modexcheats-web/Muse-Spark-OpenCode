param(
  [switch]$DryRun,
  [switch]$CloseBrowsers,
  [string]$Cookies,
  [string]$HatchSess,
  [string]$ProxyUrl,
  [switch]$NoStart,
  [switch]$NoProvider,
  [switch]$Smoke,
  [switch]$CheckThreads
)

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$Installer = Join-Path $PSScriptRoot 'install.js'

Write-Host ''
Write-Host 'Muse Spark -> OpenCode' -ForegroundColor Cyan
Write-Host "Proxy: $Root"
Write-Host ''

function Find-Node {
  $candidates = @()
  $command = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($command) { $candidates += $command.Source }
  $candidates += @(
    (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'),
    (Join-Path $env:ProgramFiles 'nodejs\node.exe')
  )
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
  }
  return $null
}

$Node = Find-Node
if (-not $Node) {
  throw 'Node.js nao encontrado. Instale Node.js 22.5+ (recomendado: 26) e rode de novo.'
}

$versionOk = $true
try {
  & $Node -e "process.exit(Number(process.versions.node.split('.')[0]) < 20 ? 1 : 0)" | Out-Null
  if ($LASTEXITCODE -ne 0) { $versionOk = $false }
} catch {
  $versionOk = $false
}
if (-not $versionOk) {
  throw "Node.js 20+ e necessario. Encontrado: $(& $Node --version)"
}

Write-Host "Node: $(& $Node --version) ($Node)"
Write-Host ''

$installArgs = @($Installer)
if ($DryRun) { $installArgs += '--dry-run' }
if ($CloseBrowsers) { $installArgs += '--close-browsers' }
if ($NoStart) { $installArgs += '--no-start' }
if ($NoProvider) { $installArgs += '--no-provider' }
if ($Smoke) { $installArgs += '--smoke' }
if ($CheckThreads) { $installArgs += '--check-threads' }
if ($Cookies) { $installArgs += @('--cookies', $Cookies) }
if ($HatchSess) { $installArgs += @('--hatch-sess', $HatchSess) }
if ($ProxyUrl) { $installArgs += @('--proxy-url', $ProxyUrl) }

& $Node @installArgs
$exitCode = $LASTEXITCODE
if ($exitCode -eq 0) {
  Write-Host ''
  Write-Host 'Pronto. Abra o OpenCode e selecione Muse Spark em /models.' -ForegroundColor Green
} else {
  Write-Host ''
  Write-Host "O instalador terminou com codigo $exitCode." -ForegroundColor Red
}
exit $exitCode
