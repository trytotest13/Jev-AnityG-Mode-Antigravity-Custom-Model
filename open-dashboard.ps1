# Jev AnityG-Mode - direct dashboard launcher.
# Makes sure the proxy is running (starts it if not), then opens the
# model dashboard in the default browser. Used by open-dashboard.bat
# and the "Jev AnityG-Mode Dashboard" desktop shortcut.
#
# The proxy only stays alive while the Antigravity IDE runs (it stops itself
# about a minute after the IDE closes), so when the IDE is not running we
# start it first - otherwise the dashboard would die again right away.
$ErrorActionPreference = 'SilentlyContinue'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$data = Join-Path $env:USERPROFILE '.gemini\antigravity'
$portFile = Join-Path $data 'active_port'
$proxyLog = Join-Path $data 'proxy.log'

# Fail fast with an actionable message instead of a silent hidden-window death.
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host '[ERROR] node.exe not found in PATH. Install Node.js LTS from https://nodejs.org/ and retry.'
    exit 1
}
if (-not (Test-Path (Join-Path $here 'proxy-standalone.js')) -or -not (Test-Path (Join-Path $here 'dist\proxy.js'))) {
    Write-Host "[ERROR] Proxy files missing in $here. Run 'npm install' and 'npx tsc' in the repo, then retry."
    exit 1
}

function Test-Proxy([string]$p) {
    try {
        $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://127.0.0.1:$p/api/models"
        return ($null -ne $r -and $r.StatusCode -lt 500)
    } catch { return $false }
}

$port = $null
if (Test-Path $portFile) {
    $t = (Get-Content $portFile -Raw).Trim()
    if ($t -match '^\d+$' -and (Test-Proxy $t)) { $port = $t }
}
if (-not $port -and (Test-Proxy 50999)) { $port = 50999 }

# IDE down -> start it. Without a running IDE the proxy self-stops (by design),
# so the dashboard would close again moments after opening.
$ide = Get-Process -Name 'Antigravity IDE' -ErrorAction SilentlyContinue
if (-not $ide) {
    $ideExe = Join-Path $env:LOCALAPPDATA 'Programs\Antigravity IDE\Antigravity IDE.exe'
    if (Test-Path $ideExe) {
        Start-Process -FilePath $ideExe
        # give the IDE a moment so the proxy's watchdog sees it right away
        Start-Sleep -Seconds 5
    }
}

if (-not $port) {
    # Proxy down: start it detached with its own hidden console and in-file
    # logging (same mechanism as deploy-ide.ps1). The proxy's IDE watchdog
    # keeps it alive while the IDE runs.
    New-Item -ItemType Directory -Path $data -Force | Out-Null
    Remove-Item $portFile -Force -ErrorAction SilentlyContinue
    $env:ANITYG_PROXY_LOG = $proxyLog
    Start-Process node -ArgumentList "`"$here\proxy-standalone.js`"" -WorkingDirectory $here -WindowStyle Hidden
    for ($i = 0; $i -lt 30 -and -not $port; $i++) {
        Start-Sleep -Milliseconds 500
        if (Test-Path $portFile) {
            $t = (Get-Content $portFile -Raw).Trim()
            if ($t -match '^\d+$' -and (Test-Proxy $t)) { $port = $t }
        }
    }
}

if (-not $port) {
    Write-Host "[ERROR] Jev AnityG-Mode proxy did not start - check $proxyLog"
    Write-Host 'Hint: make sure the Antigravity IDE is running (the proxy stops itself when the IDE closes).'
    exit 1
}
Start-Process "http://127.0.0.1:$port/dashboard"
