@echo off
title PLC + Camera  --  LIVE launcher (auto-heal)
cd /d "%~dp0"
echo ============================================================
echo   PLC + CAMERA  --  LIVE  with AUTO-HEAL WATCHDOG
echo ============================================================
echo.
where python >nul 2>nul
if errorlevel 1 (
  echo  [!] Python install nahi hai.  https://www.python.org/downloads/
  echo      ^(install ke baad "Add Python to PATH" tick karna^)
  pause
  exit /b
)
echo  NOTE: agar :3000 par purana server pehle se chal raha hai to use band
echo  kar do -- warna watchdog use naye code se replace kar dega.
echo.
echo  Auto-heal watchdog ek alag window me start ho raha hai. Woh :3000 par
echo  server ko KHUD start karega aur crash / port-kill par 3-7 sec me
echo  naye PID se revive karega.
echo.
start "PLC Auto-Heal Watchdog" cmd /k "cd /d ""%~dp0watchdog"" && python -m pip install --quiet psutil && python port_watchdog.py --daemon --config watchdog.config.json"
echo  Server ke aane ka intezaar (~6s)...
timeout /t 6 /nobreak >nul
start "" http://localhost:3000
echo.
echo  LIVE!  Watchdog doosri window me chal raha hai (use band karne ko usme Ctrl+C).
echo  Browser: http://localhost:3000   (na khule to 5 sec baad refresh)
echo  Is window ko band kar sakte ho.
timeout /t 6 /nobreak >nul
