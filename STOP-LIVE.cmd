@echo off
title Stop PLC Auto-Heal Watchdog
echo Stopping the auto-heal watchdog daemon (server will keep running, just no auto-restart)...
powershell -NoProfile -Command "$f=$false; Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*port_watchdog.py*' } | ForEach-Object { $f=$true; Write-Host ('killing watchdog pid ' + $_.ProcessId); Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; if (-not $f) { Write-Host 'no watchdog daemon was running' }"
echo.
echo Auto-heal is now OFF.
timeout /t 4 /nobreak >nul
