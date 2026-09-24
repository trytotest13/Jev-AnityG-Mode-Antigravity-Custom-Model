# Jev AnityG-Mode deploy for the NEW "Antigravity IDE" 2.5.x packaging (VS Code fork).
# No asar repack, no binary patch: the IDE reads its Cloud Code endpoint from
# the `jetski.cloudCodeUrl` setting and passes it to the language server via
# --cloud_code_endpoint, so we just point that setting at our standalone proxy
# (proxy-standalone.js, no Electron) and restart the IDE.
# Run from this script's own directory (install.bat does build + calls this).

Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  Jev AnityG-Mode Deploy (Antigravity IDE 2.5.x)" -ForegroundColor Yellow
Write-Host "============================================" -ForegroundColor Cyan

$ProjectDir = $PSScriptRoot
$candidates = @()
if ($env:AGY_INSTALL_DIR) { $candidates += $env:AGY_INSTALL_DIR }
$candidates += "$env:LOCALAPPDATA\Programs\Antigravity IDE"
$candidates += "$env:LOCALAPPDATA\Programs\Antigravity"
$candidates += "$env:LOCALAPPDATA\Programs\Antigravity2"
$candidates += "$env:LOCALAPPDATA\Programs\antigravity"

$IdeDir = $null
$IdeExe = $null
foreach ($dir in $candidates) {
    if (Test-Path $dir) {
        $e1 = Join-Path $dir "Antigravity IDE.exe"
        $e2 = Join-Path $dir "Antigravity.exe"
        if (Test-Path $e1) { $IdeDir = $dir; $IdeExe = $e1; break }
        if (Test-Path $e2) { $IdeDir = $dir; $IdeExe = $e2; break }
    }
}

if (-not $IdeExe) { Write-Host "[ERROR] Antigravity IDE executable not found." -ForegroundColor Red; exit 1 }

$LsBinCandidates = @(
    (Join-Path $IdeDir "resources\app\extensions\antigravity\bin\language_server_windows_x64.exe"),
    (Join-Path $IdeDir "resources\bin\language_server_windows_x64.exe"),
    (Join-Path $IdeDir "resources\bin\language_server.exe")
)
$LsBin = $LsBinCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1

$ProxyJs = Join-Path $ProjectDir "proxy-standalone.js"
$DistProxy = Join-Path $ProjectDir "dist\proxy.js"

if (-not (Test-Path $DistProxy)) {
    Write-Host "[ERROR] dist/proxy.js missing - run `npm run build` first (install.bat does this)." -ForegroundColor Red
    exit 1
}

# 1. Close old proxy. The IDE itself is only killed and restarted at the very
#    last step, so closing this window mid-deploy can never leave it closed.
Write-Host "[1/6] Closing old Jev AnityG-Mode proxy..." -ForegroundColor Yellow
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*proxy-standalone.js*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2
Write-Host "   OK" -ForegroundColor Green

# 2. Start standalone proxy, read back the actual port (falls back if 50999 busy)
Write-Host "[2/6] Starting standalone proxy (detached - survives this window closing)..." -ForegroundColor Yellow
$PortFile = Join-Path $env:USERPROFILE ".gemini\antigravity\active_port"
# The proxy gets its own hidden console and appends its output to a log file
# from inside node (JEV_PROXY_LOG). Using -RedirectStandardOutput here would
# attach node to THIS console, and closing this window would kill the proxy.
$ProxyLog = Join-Path $env:USERPROFILE ".gemini\antigravity\proxy.log"
$env:JEV_PROXY_LOG = $ProxyLog
if (Test-Path $PortFile) { Remove-Item $PortFile -Force -ErrorAction SilentlyContinue }
Start-Process -FilePath "node" -ArgumentList "`"$ProxyJs`"" -WorkingDirectory $ProjectDir -WindowStyle Hidden
$port = $null
for ($i = 0; $i -lt 30 -and -not $port; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-Path $PortFile) { $port = (Get-Content $PortFile -Raw).Trim() }
}
if (-not $port) { Write-Host "[ERROR] proxy did not start (no active_port file). Run `node proxy-standalone.js` by hand to see the error." -ForegroundColor Red; exit 1 }
$ProxyUrl = "http://127.0.0.1:$port"
Write-Host "   OK - proxy at $ProxyUrl" -ForegroundColor Green

# 3. Point the IDE at the proxy via jetski.cloudCodeUrl (backup once)
Write-Host "[3/6] Writing jetski.cloudCodeUrl setting..." -ForegroundColor Yellow
$SettingsPath = Join-Path $env:APPDATA "Antigravity IDE\User\settings.json"
$SettingsBak = "$SettingsPath.jev.bak"
New-Item -ItemType Directory -Path (Split-Path $SettingsPath) -Force | Out-Null
$settings = New-Object PSObject
if (Test-Path $SettingsPath) {
    $raw = Get-Content $SettingsPath -Raw
    try { $settings = $raw | ConvertFrom-Json } catch {
        try {
            # ponytail: string-aware JSONC strip; URLs inside quotes preserved
            $sb = New-Object System.Text.StringBuilder
            $inStr = $false; $esc = $false; $lineC = $false; $blockC = $false
            for ($i = 0; $i -lt $raw.Length; $i++) {
                $c = $raw[$i]; $n = if ($i + 1 -lt $raw.Length) { $raw[$i + 1] } else { '' }
                if ($lineC) { if ($c -eq "`n") { $lineC = $false; $sb.Append($c) | Out-Null } continue }
                if ($blockC) { if ($c -eq '*' -and $n -eq '/') { $blockC = $false; $i++ } continue }
                if ($inStr) { $sb.Append($c) | Out-Null; if ($esc) { $esc = $false } elseif ($c -eq '\') { $esc = $true } elseif ($c -eq '"') { $inStr = $false } continue }
                if ($c -eq '"') { $inStr = $true; $sb.Append($c) | Out-Null; continue }
                if ($c -eq '/' -and $n -eq '/') { $lineC = $true; $i++; continue }
                if ($c -eq '/' -and $n -eq '*') { $blockC = $true; $i++; continue }
                $sb.Append($c) | Out-Null
            }
            $clean = $sb.ToString() -replace ',(\s*[}\]])', '$1'
            $settings = $clean | ConvertFrom-Json
        } catch {
            Write-Host "[ERROR] settings.json is not valid JSON: $SettingsPath" -ForegroundColor Red; exit 1
        }
    }
    if (-not (Test-Path $SettingsBak)) { Copy-Item $SettingsPath $SettingsBak -Force }
}
$settings | Add-Member -NotePropertyName "jetski.cloudCodeUrl" -NotePropertyValue $ProxyUrl -Force
($settings | ConvertTo-Json -Depth 20) | Set-Content $SettingsPath -Encoding UTF8
Write-Host "   OK - $SettingsPath -> $ProxyUrl" -ForegroundColor Green

# 4. Seed custom_models.json if missing (proxy also creates a default)
Write-Host "[4/6] Checking custom models config..." -ForegroundColor Yellow
$ModelsPath = Join-Path $env:USERPROFILE ".gemini\antigravity\custom_models.json"
if (Test-Path $ModelsPath) { Write-Host "   OK - found $ModelsPath" -ForegroundColor Green }
else { Write-Host "   NOTE - none yet; proxy creates a template on first request. Edit $ModelsPath to add models." -ForegroundColor Gray }

# 5. Install the Jev AnityG-Mode IDE extension (status-bar button + auto-start proxy)
Write-Host "[5/6] Installing Jev AnityG-Mode IDE extension (Models button in status bar)..." -ForegroundColor Yellow
$ExtSrc = Join-Path $ProjectDir "ide-extension"
if (Test-Path (Join-Path $ExtSrc "extension.js")) {
    $ExtId = "jev.models-0.1.0"
    $ExtDir = Join-Path $env:USERPROFILE ".antigravity-ide\extensions\$ExtId"
    New-Item -ItemType Directory -Path $ExtDir -Force | Out-Null
    Copy-Item (Join-Path $ExtSrc "package.json") $ExtDir -Force
    Copy-Item (Join-Path $ExtSrc "extension.js") $ExtDir -Force
    # marker: lets the extension find + auto-start the proxy
    [IO.File]::WriteAllText((Join-Path $ExtDir "moddir.txt"), $ProjectDir)
    $RegPath = Join-Path $env:USERPROFILE ".antigravity-ide\extensions\extensions.json"
    $RegBak = "$RegPath.jev.bak"
    $entries = @()
    if (Test-Path $RegPath) {
        if (-not (Test-Path $RegBak)) { Copy-Item $RegPath $RegBak -Force }
        try { $entries = Get-Content $RegPath -Raw | ConvertFrom-Json } catch { $entries = @() }
    }
    # Legacy migration: the product used to install as "anityg.models" - drop the
    # old registry entry and folder so the renamed extension never doubles up.
    $LegacyExtDir = Join-Path $env:USERPROFILE ".antigravity-ide\extensions\anityg.models-0.1.0"
    if (Test-Path $LegacyExtDir) { Remove-Item $LegacyExtDir -Recurse -Force -ErrorAction SilentlyContinue }
    $legacyEntries = @($entries | Where-Object { $_.identifier.id -eq "anityg.models" })
    if ($legacyEntries.Count -gt 0) {
        $entries = @($entries | Where-Object { $_.identifier.id -ne "anityg.models" })
        Write-Host "   OK - removed legacy anityg.models extension entry" -ForegroundColor Gray
    }
    if (-not ($entries | Where-Object { $_.identifier.id -eq "jev.models" })) {
        $loc = "/" + ($ExtDir -replace "\\\", "/")
        $meta = [ordered]@{
            installedTimestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
            source = "gallery"; publisherDisplayName = "jev"; targetPlatform = "universal"
            isApplicationScoped = $false; isMachineScoped = $false; isBuiltin = $false
            pinned = $false; preRelease = $false; private = $false
        }
        $entry = [ordered]@{
            identifier = [ordered]@{ id = "jev.models" }
            version = "0.1.0"
            location = [ordered]@{ "`$mid" = 1; path = $loc; scheme = "file" }
            relativeLocation = $ExtId
            metadata = $meta
        }
        $entries = @($entries) + $entry
        ($entries | ConvertTo-Json -Depth 10) | Set-Content $RegPath -Encoding UTF8
    }
    Write-Host "   OK - button + Ctrl+Alt+M open the dashboard inside the IDE" -ForegroundColor Green

    # Desktop shortcut "Jev AnityG-Mode Dashboard" (double-click = open dashboard, starts proxy if needed)
    try {
        if (-not (Test-Path (Join-Path $ProjectDir "icon.ico"))) {
            Add-Type -AssemblyName System.Drawing
            $png = [System.Drawing.Image]::FromFile((Join-Path $ProjectDir "icon.png"))
            $sz = 256; if ($png.Width -lt $sz) { $sz = $png.Width }
            $bmp = New-Object System.Drawing.Bitmap($png, $sz, $sz)
            $ico = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
            $fs = [System.IO.File]::Create((Join-Path $ProjectDir "icon.ico"))
            $ico.Save($fs); $fs.Close(); $png.Dispose(); $bmp.Dispose()
        }
        $ws = New-Object -ComObject WScript.Shell
        $lnk = $ws.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) "Jev AnityG-Mode Dashboard.lnk"))
        $lnk.TargetPath = "wscript.exe"
        $lnk.Arguments = '"' + (Join-Path $ProjectDir "open-dashboard-silent.vbs") + '"'
        $lnk.WorkingDirectory = $ProjectDir
        $lnk.IconLocation = (Join-Path $ProjectDir "icon.ico") + ",0"
        $lnk.Description = "Jev AnityG-Mode: open the model dashboard (starts proxy if needed)"
        $lnk.Save()
        Write-Host "   OK - desktop shortcut 'Jev AnityG-Mode Dashboard' refreshed" -ForegroundColor Green
    } catch {
        Write-Host "   WARN - could not create desktop shortcut: $_" -ForegroundColor Gray
    }
} else {
    Write-Host "   SKIP - ide-extension/ not found in project" -ForegroundColor Gray
}

# 6. Restart IDE - done last on purpose: if anything above fails or the
#    installer window is closed early, the IDE is never left killed.
Write-Host "[6/6] Restarting Antigravity IDE..." -ForegroundColor Yellow
Stop-Process -Name "Antigravity IDE" -Force -ErrorAction SilentlyContinue
Stop-Process -Name "Antigravity" -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3
Start-Process -FilePath $IdeExe
Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  DONE - proxy running, IDE pointed at it." -ForegroundColor Green
Write-Host "  Proxy: $ProxyUrl (proxy-standalone.js)" -ForegroundColor Gray
Write-Host "  Add models: IDE status bar 'Jev AnityG-Mode Models' / Ctrl+Alt+M / browser $ProxyUrl/dashboard" -ForegroundColor Gray
Write-Host "  Models: $ModelsPath" -ForegroundColor Gray
Write-Host "  Setting backed up to: $SettingsBak" -ForegroundColor Gray
Write-Host "  Re-run install.bat after IDE updates." -ForegroundColor Gray
Write-Host "============================================" -ForegroundColor Cyan
