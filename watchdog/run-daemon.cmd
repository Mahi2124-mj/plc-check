@echo off
REM Runs the auto-heal watchdog daemon in a forever-loop so that if the daemon
REM itself ever crashes, it is restarted within ~3s. Output -> logs\watchdog-daemon.log
cd /d "%~dp0"
if not exist "..\logs" md "..\logs"
:loop
echo [%date% %time%] watchdog daemon starting >> "..\logs\watchdog-daemon.log"
python port_watchdog.py --daemon --config watchdog.config.json >> "..\logs\watchdog-daemon.log" 2>&1
echo [%date% %time%] daemon exited (code %errorlevel%) - restarting in 3s >> "..\logs\watchdog-daemon.log"
timeout /t 3 /nobreak >nul
goto loop
