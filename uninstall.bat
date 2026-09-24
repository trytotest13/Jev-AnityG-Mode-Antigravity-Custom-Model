@echo off
setlocal EnableExtensions
title Jev AnityG-Mode Uninstaller
cd /d "%~dp0"

set "RES=%LOCALAPPDATA%\Programs\Antigravity2\resources"
if not exist "%RES%\app.asar" set "RES=%LOCALAPPDATA%\Programs\antigravity\resources"
if defined AGY_INSTALL_DIR set "RES=%AGY_INSTALL_DIR%\resources"
rem -- New IDE 2.5.x has no asar: uninstall = remove setting + stop proxy.
if not exist "%RES%\app.asar" if exist "%LOCALAPPDATA%\Programs\Antigravity IDE\resources\app\out\main.js" goto :uninstall_ide
if defined AGY_INSTALL_DIR if not exist "%RES%\app.asar" if exist "%AGY_INSTALL_DIR%\resources\app\out\main.js" goto :uninstall_ide
set "ASAR=%RES%\app.asar"
set "ASAR_BAK=%ASAR%.backup"
set "UNP=%RES%\app.asar.unpacked"
set "UNP_BAK=%ASAR%.backup.unpacked"
set "LS=%RES%\bin\language_server.exe"
set "LS_BAK=%LS%.bak"

echo ============================================
echo   Jev AnityG-Mode - Uninstall
echo   Restores original Antigravity files.
echo ============================================
echo.

rem -- 1. Close Antigravity ----------------------------------------
echo [1/4] Closing Antigravity...
taskkill /F /IM Antigravity.exe >nul 2>nul
taskkill /F /IM language_server.exe >nul 2>nul
timeout /t 3 /nobreak >nul
echo    OK

rem -- 2. Restore app.asar from backup -----------------------------
echo [2/4] Restoring original app.asar...
if exist "%ASAR_BAK%" (
    copy /Y "%ASAR_BAK%" "%ASAR%" >nul
    echo    OK - app.asar restored from backup.
) else (
    echo    NOTE: no app.asar.backup found - asar left as-is.
)
if exist "%UNP_BAK%" (
    if exist "%UNP%" rd /s /q "%UNP%"
    robocopy "%UNP_BAK%" "%UNP%" /E /NFL /NDL /NJH /NJS >nul
    echo    OK - app.asar.unpacked restored.
)

rem -- 3. Restore language_server.exe ------------------------------
echo [3/4] Restoring language_server.exe...
if exist "%LS_BAK%" (
    copy /Y "%LS_BAK%" "%LS%" >nul
    echo    OK - language_server.exe restored from backup.
) else (
    echo    No .bak backup - trying in-place reverse patch...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "$p=('%RES%\bin\language_server.exe'); if(!(Test-Path $p)){ Write-Host '   skip: binary not found'; exit 0 }; $t=[IO.File]::ReadAllText($p,[Text.Encoding]::ASCII); $o=$t.IndexOf('http://localhost:50999/v1internal/xxxxxxx'); if($o -ge 0){ $b=[IO.File]::ReadAllBytes($p); $r=[Text.Encoding]::ASCII.GetBytes('https://daily-cloudcode-pa.googleapis.com'); [Array]::Copy($r,0,$b,$o,$r.Length); [IO.File]::WriteAllBytes($p,$b); Write-Host '   OK - patched URL reversed.' } else { Write-Host '   OK - binary already clean.' }"
)

rem -- 4. Restart Antigravity --------------------------------------
echo [4/4] Starting Antigravity...
if exist "%RES%\..\Antigravity.exe" start "" "%RES%\..\Antigravity.exe"

echo.
echo ============================================
echo   Uninstall complete - originals restored.
echo   Backups were kept next to the originals,
echo   so install.bat can re-apply the mod later:
echo     %ASAR_BAK%
echo     %LS_BAK%
echo ============================================
pause
exit /b 0

:uninstall_ide
echo ============================================
echo   Jev AnityG-Mode - Uninstall (Antigravity IDE 2.5.x^)
echo   Removes the cloudCodeUrl setting, stops the proxy.
echo ============================================
echo.
echo [1/3] Closing IDE and proxy...
taskkill /F /IM "Antigravity IDE.exe" >nul 2>nul
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*proxy-standalone.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
timeout /t 3 /nobreak >nul
echo    OK
echo [2/3] Removing jetski.cloudCodeUrl setting...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$s=\"$env:APPDATA\Antigravity IDE\User\settings.json\"; $b=\"$s.jev.bak\"; if(-not(Test-Path $b)){ $b=\"$s.anityg.bak\" }; if(Test-Path $b){ Copy-Item $b $s -Force; Write-Host '   OK - settings.json restored from backup.' } elseif(Test-Path $s){ try{ $j=Get-Content $s -Raw | ConvertFrom-Json; if($j.PSObject.Properties['jetski.cloudCodeUrl']){ $j.PSObject.Properties.Remove('jetski.cloudCodeUrl'); ($j | ConvertTo-Json -Depth 20) | Set-Content $s -Encoding UTF8; Write-Host '   OK - key removed.' } else { Write-Host '   OK - key not present.' } }catch{ Write-Host '   NOTE: settings.json is not valid JSON - left as-is.' } } else { Write-Host '   OK - no settings.json.' }"
echo [3/3] Starting IDE...
if exist "%LOCALAPPDATA%\Programs\Antigravity IDE\Antigravity IDE.exe" start "" "%LOCALAPPDATA%\Programs\Antigravity IDE\Antigravity IDE.exe"
if defined AGY_INSTALL_DIR if exist "%AGY_INSTALL_DIR%\Antigravity IDE.exe" start "" "%AGY_INSTALL_DIR%\Antigravity IDE.exe"
echo.
echo ============================================
echo   Uninstall complete - IDE talks to Google directly again.
echo ============================================
pause
