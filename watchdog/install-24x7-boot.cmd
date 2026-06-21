@echo off
REM One-click: make the auto-heal watchdog run 24x7 (whether logged on or not).
REM Double-click this; it will ask for admin (UAC) and register the boot task.
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Admin rights chahiye -- UAC prompt aa raha hai...
  powershell -NoProfile -Command "Start-Process -FilePath cmd -ArgumentList '/c',[char]34+'%~f0'+[char]34 -Verb RunAs"
  exit /b
)
echo Registering 24x7 boot-level auto-heal task...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-24x7-boot.ps1"
echo.
pause
