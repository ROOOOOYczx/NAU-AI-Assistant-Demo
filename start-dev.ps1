$projectRoot = $PSScriptRoot
$localNodeCandidates = @(
  (Join-Path $projectRoot '.tools\node\node.exe'),
  (Join-Path $projectRoot '.tools\node\bin\node.exe'),
  (Join-Path $projectRoot 'runtime\node.exe')
)
$userProfile = [Environment]::GetFolderPath('UserProfile')
$codexRuntimeRoot = Join-Path $userProfile '.cache\codex-runtimes'
$codexNodeCandidates = if (Test-Path $codexRuntimeRoot) {
  Get-ChildItem -LiteralPath $codexRuntimeRoot -Filter 'node.exe' -File -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match '\\dependencies\\node\\bin\\node\.exe$' } |
    Select-Object -ExpandProperty FullName
} else {
  @()
}
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
$nodeCandidates = @($localNodeCandidates) + @($codexNodeCandidates)
$nodePath = if ($nodeCommand) { $nodeCommand.Source } else { $nodeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1 }
$proxyProcess = $null

if (-not $nodePath) {
  Write-Error 'Node.js was not found. Install Node.js 20+ or place a portable runtime in .tools\node or runtime.'
  exit 1
}

$nodeDirectory = Split-Path -Parent $nodePath
$env:Path = "$nodeDirectory;$env:Path"

try {
  $nodeVersion = [version]((& $nodePath --version).TrimStart('v'))
  if ($nodeVersion.Major -lt 20) {
    Write-Error "Node.js $nodeVersion found. Node.js 20 or newer is required."
    exit 1
  }
} catch {
  Write-Error 'Could not determine the Node.js version.'
  exit 1
}

$pnpmCommand = Get-Command pnpm.cmd -ErrorAction SilentlyContinue | Select-Object -First 1
$npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue | Select-Object -First 1
$packageManager = $null
$packageManagerArgs = @()

if ($pnpmCommand) {
  $packageManager = $pnpmCommand.Source
  $packageManagerArgs = @('exec', 'vite', '--host', '127.0.0.1', '--port', '5173', '--strictPort')
} elseif ($npmCommand) {
  $packageManager = $npmCommand.Source
  $packageManagerArgs = @('exec', '--', 'vite', '--host', '127.0.0.1', '--port', '5173', '--strictPort')
} else {
  $localNpm = @(
    (Join-Path $nodeDirectory 'npm.cmd'),
    (Join-Path (Split-Path -Parent $nodeDirectory) 'npm.cmd')
  ) | Where-Object { Test-Path $_ } | Select-Object -First 1
  if ($localNpm) {
    $packageManager = $localNpm
    $packageManagerArgs = @('exec', '--', 'vite', '--host', '127.0.0.1', '--port', '5173', '--strictPort')
  }
}

if (-not $packageManager) {
  Write-Error 'pnpm or npm was not found. Install Node.js 20+; npm is normally included.'
  exit 1
}

Set-Location $projectRoot
if (-not (Test-Path (Join-Path $projectRoot 'node_modules\vite'))) {
  Write-Host 'First run: installing project dependencies...' -ForegroundColor Cyan
  if ([IO.Path]::GetFileName($packageManager) -ieq 'pnpm.cmd') {
    & $packageManager install --frozen-lockfile
  } else {
    & $packageManager install --no-audit --no-fund
  }
  if ($LASTEXITCODE -ne 0) {
    Write-Error 'Dependency installation failed. Check your network connection and try again.'
    exit 1
  }
}

$viteCommand = Join-Path $projectRoot 'node_modules\.bin\vite.cmd'
if (-not (Test-Path $viteCommand)) {
  Write-Error 'Vite was not found after dependency installation.'
  exit 1
}

$proxyArguments = @("server.mjs")
$proxyProcess = Start-Process -WindowStyle Hidden -PassThru -FilePath $nodePath -ArgumentList $proxyArguments -WorkingDirectory $projectRoot

try {
  & $viteCommand --host 127.0.0.1 --port 5173 --strictPort
} finally {
  if ($proxyProcess -and -not $proxyProcess.HasExited) {
    Stop-Process -Id $proxyProcess.Id -Force -ErrorAction SilentlyContinue
  }
}
