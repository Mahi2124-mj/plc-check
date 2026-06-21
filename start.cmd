@echo off
REM Standalone PLC + Camera tool launcher.
REM Starts the Node server and opens the browser to the UI.
cd /d "%~dp0"
start "" http://localhost:3000
node server.js
