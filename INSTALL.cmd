@echo off
title PLC + Camera Tool  --  One-Click Installer
cd /d "%~dp0"
echo ============================================================
echo   PLC + CAMERA TOOL  --  ONE-CLICK INSTALLER
echo ============================================================
echo.
where node >nul 2>nul
if errorlevel 1 ( echo  [!] Node.js install nahi hai:  https://nodejs.org  & pause & exit /b )
where python >nul 2>nul
if errorlevel 1 ( echo  [!] Python install nahi hai:  https://www.python.org/downloads/  & pause & exit /b )
echo  [1/2] Watchdog deps (psutil) install ho rahe hain...
python -m pip install --quiet psutil
echo  [2/2] Auto-heal watchdog + alert notifier register ho rahe hain (logon auto-start)...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0watchdog\install-tasks.ps1"
echo.
echo ============================================================
echo  DONE.  Watchdog :3000 server ko khud start + guard karega.
echo  Tool kholo:  http://localhost:3000
echo.
echo  TRUE 24x7 (login se pehle bhi) chahiye to ek baar yeh chalao:
echo     watchdog\install-24x7-boot.cmd      (Run as administrator)
echo ============================================================
echo.
pause
