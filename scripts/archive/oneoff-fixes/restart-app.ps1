# DS Drama Studio - one-shot restart (single instance, debug port 9225)
# Usage: powershell -ExecutionPolicy Bypass -File E:\drama-studio\scripts\restart-app.ps1
# Kills all stale electron processes, starts exactly one instance, waits for CDP.
param(
  [int]$Port = 9225,
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$electron = 'E:\drama-studio\node_modules\electron\dist\electron.exe'
$appRoot = 'E:\drama-studio'

# 1. kill stale electron processes (main + renderer + gpu children)
$before = @(Get-Process electron -ErrorAction SilentlyContinue).Count
if ($before -gt 0) {
  Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep 2
}
$after = @(Get-Process electron -ErrorAction SilentlyContinue).Count
Write-Host "[restart] stale electron: $before -> $after"

# 2. free a stuck debug port (orphan listeners can wedge the endpoint)
$conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($conn) {
  $pids = @($conn.OwningProcess | Select-Object -Unique)
  foreach ($p in $pids) {
    $proc = Get-Process -Id $p -ErrorAction SilentlyContinue
    if ($proc -and $proc.ProcessName -match 'electron|ComfyUI|python') {
      Write-Host "[restart] freeing port $Port held by PID=$p ($($proc.ProcessName))"
      Stop-Process -Id $p -Force -ErrorAction SilentlyContinue
      Start-Sleep 1
    }
  }
}

# 3. start the single instance (app has requestSingleInstanceLock)
$p = Start-Process $electron -ArgumentList $appRoot, "--remote-debugging-port=$Port", '--remote-allow-origins=*' -PassThru
Write-Host "[restart] started pid=$($p.Id)"

# 4. wait for CDP to be ready (max 30s)
$ok = $false
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep 1
  try {
    $resp = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json" -TimeoutSec 3
    $pages = @($resp | Where-Object { $_.type -eq 'page' })
    if ($pages.Count -gt 0) {
      Write-Host "[restart] CDP ready: $($pages[0].title) | $($pages[0].url)"
      $ok = $true
      break
    }
  } catch {
    # not ready yet
  }
}
if (-not $ok) {
  Write-Host "[restart] WARN: CDP port $Port not ready in 30s" -ForegroundColor Yellow
}
$mainCount = @(Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -notmatch '--type=' }).Count
Write-Host "[restart] done (electron main processes=$mainCount, expected 1)"