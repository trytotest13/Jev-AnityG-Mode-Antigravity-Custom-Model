@echo off
setlocal EnableExtensions
title Jev AnityG-Mode Installer
cd /d "%~dp0"

echo ============================================
echo   Jev AnityG-Mode - Install / Update Patch
echo   (custom models + Auto Smart Router)
echo ============================================
echo.

rem -- 1. Preflight checks -----------------------------------------
where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js was not found on PATH.
    echo         Install it from https://nodejs.org and run this again.
    pause
    exit /b 1
)

if exist "%LOCALAPPDATA%\Programs\Antigravity2\resources\app.asar" goto :found
if exist "%LOCALAPPDATA%\Programs\antigravity\resources\app.asar" goto :found
if exist "%AGY_INSTALL_DIR%\resources\app.asar" goto :found
rem -- New "Antigravity IDE" 2.5.x packaging (VS Code fork): no app.asar, uses
rem -- jetski.cloudCodeUrl setting + standalone proxy instead. Route to new flow.
if exist "%LOCALAPPDATA%\Programs\Antigravity IDE\resources\app\out\main.js" goto :found_ide
if defined AGY_INSTALL_DIR if exist "%AGY_INSTALL_DIR%\resources\app\out\main.js" goto :found_ide
if not exist "%LOCALAPPDATA%\Programs\antigravity\resources\app.asar" (
    echo [ERROR] Google Antigravity was not found at:
    echo         %LOCALAPPDATA%\Programs\Antigravity2
    echo         %LOCALAPPDATA%\Programs\antigravity
    echo         %LOCALAPPDATA%\Programs\Antigravity IDE
    echo         Install Antigravity first, then run this again.
    pause
    exit /b 1
)
:found

rem -- 2. Dependencies ---------------------------------------------
echo [1/3] Installing dependencies...
call npm install --no-audit --no-fund
if errorlevel 1 (
    echo [ERROR] npm install failed. Check the messages above.
    pause
    exit /b 1
)

rem -- 3. Build ----------------------------------------------------
echo.
echo [2/3] Building...
call npm run build
if errorlevel 1 (
    echo [ERROR] Build failed. Check the messages above.
    pause
    exit /b 1
)

rem -- 4. Deploy into Antigravity ----------------------------------
echo.
echo [3/3] Deploying patch to Antigravity...
echo       ^(backs up app.asar, swaps in the mod, patches language_server^)
powershell -NoProfile -ExecutionPolicy Bypass -File ".\deploy.ps1"
if errorlevel 1 (
    echo [ERROR] Deploy failed. Your original app.asar backup was kept -
    echo         run uninstall.bat to restore, then check the errors above.
    pause
    exit /b 1
)
goto :done

:found_ide
rem -- 2b/3b. Same build, new-IDE deploy (setting + standalone proxy, no asar) --
echo [1/3] Installing dependencies...
call npm install --no-audit --no-fund
if errorlevel 1 (
    echo [ERROR] npm install failed. Check the messages above.
    pause
    exit /b 1
)

echo.
echo [2/3] Building...
call npm run build
if errorlevel 1 (
    echo [ERROR] Build failed. Check the messages above.
    pause
    exit /b 1
)

echo.
echo [3/3] Deploying to Antigravity IDE 2.5.x...
echo       ^(points jetski.cloudCodeUrl at standalone proxy, restarts IDE^)
powershell -NoProfile -ExecutionPolicy Bypass -File ".\deploy-ide.ps1"
if errorlevel 1 (
    echo [ERROR] Deploy failed - run uninstall.bat to remove the setting, then check the errors above.
    pause
    exit /b 1
)

:done

echo.
echo ============================================
echo   DONE - Antigravity is running Jev AnityG-Mode!
echo.
echo   Add models: click "Jev AnityG-Mode Models" in the IDE status bar
echo   ^(or Ctrl+Alt+M, or browser http://127.0.0.1:50999/dashboard^)
echo   - "Auto (Smart Router)" shows up automatically
echo     and picks the right model per request
echo   - The IDE extension also auto-starts the proxy
echo   - The proxy now runs only while the IDE runs:
echo     it stops by itself about a minute after you close the IDE.
echo.
echo   You can close this window now - the patch keeps working.
echo.
echo   Re-run install.bat after every Antigravity update.
echo ============================================
pause
