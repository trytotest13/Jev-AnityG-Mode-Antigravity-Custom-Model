@echo off
rem Jev AnityG-Mode - double-click launcher for the model dashboard.
rem Starts the proxy if it is not running, then opens the dashboard
rem in your default browser. Same as the "Jev AnityG-Mode Dashboard" desktop shortcut.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0open-dashboard.ps1"
