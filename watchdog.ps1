# qq-persona-bridge watchdog - keeps the QQ bridge alive.
# ASCII only: a .ps1 without a BOM is parsed in the system codepage.
# Written for Windows PowerShell 5.1 (Task Scheduler default): no PS7-only syntax.
#
# Every run:
#   1) bridge listening on 3002?  if not -> restart it (hidden)
#   2) NapCat listening on 36199? if not -> log once on transition
#   3) headless runs older than 15 min -> kill
#
# Manual: powershell -NoProfile -ExecutionPolicy Bypass -File .\watchdog.ps1

$ErrorActionPreference = 'Continue'

$Dir       = $PSScriptRoot
$Bridge    = Join-Path $Dir 'bridge.mjs'
$Notify    = Join-Path $Dir 'notify.mjs'
$Log       = Join-Path $Dir 'watchdog.log'
$StateFile = Join-Path $Dir 'watchdog-state.txt'

# Read config.json for the runtime path and the NapCat launcher.
$Cfg = @{}
try {
  $raw = Get-Content (Join-Path $Dir 'config.json') -Raw -ErrorAction Stop | ConvertFrom-Json
  foreach ($p in $raw.PSObject.Properties) {
    if ($p.Name -notlike '_*' -and $p.Value) { $Cfg[$p.Name] = [string]$p.Value }
  }
} catch { }

$Exe       = if ($Cfg['dshExe']) { $Cfg['dshExe'] } else { 'DeepSeek Harness.exe' }
$NapCatBat = $Cfg['napcatStartCmd']

# NapCat dropped -> try to bring it back (login state usually persists).
# Set to $false if you manage NapCat some other way.
$RestartNapCat = $true
$ZombieMinutes = 15

function Write-Log([string]$Message) {
  $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
  "$stamp  $Message" | Out-File -FilePath $Log -Append -Encoding utf8
  try {
    if ((Get-Item $Log).Length -gt 200KB) {
      $tail = Get-Content $Log -Tail 300
      $tail | Set-Content $Log -Encoding utf8
    }
  } catch { }
}

function Test-Port([int]$Port) {
  $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  if ($conn) { return $true }
  return $false
}

function Get-Flag([string]$Name) {
  if (-not (Test-Path $StateFile)) { return $false }
  $lines = Get-Content $StateFile -ErrorAction SilentlyContinue
  foreach ($line in $lines) {
    if ($line -eq ($Name + '=1')) { return $true }
  }
  return $false
}

function Set-Flag([string]$Name, [bool]$On) {
  $kept = @()
  if (Test-Path $StateFile) {
    $lines = Get-Content $StateFile -ErrorAction SilentlyContinue
    foreach ($line in $lines) {
      if (-not $line.StartsWith($Name + '=')) { $kept += $line }
    }
  }
  if ($On) { $kept += ($Name + '=1') } else { $kept += ($Name + '=0') }
  try { $kept | Set-Content $StateFile -Encoding utf8 } catch { }
}

function Send-Notify([string]$Code) {
  if (-not (Test-Path $Notify)) { return }
  $env:ELECTRON_RUN_AS_NODE = '1'
  & $Exe $Notify $Code 2>&1 | Out-Null
}

# --- 1) bridge ---------------------------------------------------------------
$bridgeUp = Test-Port 3002
if (-not $bridgeUp) {
  $running = Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine -match 'bridge\.mjs' }
  if ($running) {
    foreach ($p in $running) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 2
  }
  $env:ELECTRON_RUN_AS_NODE = '1'
  Start-Process -FilePath $Exe -ArgumentList $Bridge -WindowStyle Hidden
  Start-Sleep -Seconds 6
  if (Test-Port 3002) {
    Write-Log 'bridge was down -> restarted OK'
    # Auto recovery stays quiet: log only, no QQ message.
    # The only thing that really needs a human is NapCat dropping its login.
  } else {
    Write-Log 'bridge was down -> restart FAILED'
  }
}

# --- 2) NapCat ---------------------------------------------------------------
if (-not (Test-Port 36199)) {
  if (-not (Get-Flag 'napcatDown')) {
    Set-Flag 'napcatDown' $true
    Write-Log 'napcat is not listening on 36199'
    Send-Notify 'napcat-down'
  }
  if ($RestartNapCat -and $NapCatBat -and (Test-Path $NapCatBat)) {
    Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', $NapCatBat -WindowStyle Hidden
    Write-Log 'attempted to start NapCat'
  }
} else {
  if (Get-Flag 'napcatDown') {
    Set-Flag 'napcatDown' $false
    Write-Log 'napcat is back'
  }
}

# --- 3) zombie headless runs -------------------------------------------------
try {
  $cutoff = (Get-Date).AddMinutes(-$ZombieMinutes)
  $zombies = Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine -match 'headless' -and $_.CreationDate -lt $cutoff }
  foreach ($z in $zombies) {
    Stop-Process -Id $z.ProcessId -Force -ErrorAction SilentlyContinue
    Write-Log ('killed zombie headless pid=' + $z.ProcessId)
    Send-Notify 'killed-zombie'
  }
} catch { }
