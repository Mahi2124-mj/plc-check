@echo off
title MES Port Watchdog (real services)
cd /d "%~dp0"
echo =====================================================
echo     MES PORT WATCHDOG  -  apni service auto-heal
echo =====================================================
echo.
where python >nul 2>nul
if errorlevel 1 (
  echo  [!] Python install nahi hai. https://www.python.org/downloads/
  pause
  exit /b
)
echo  Checking psutil (one-time)...
python -m pip install --quiet psutil
echo.
echo  watchdog.config.json se services load ho rahi hain.
echo  ^(pehle config edit karke apni service enable karna^)
echo.
echo  Stop: is window mein Ctrl+C dabao.
echo.
python port_watchdog.py --daemon --config watchdog.config.json
pause
