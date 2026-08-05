@echo off
setlocal
cd /d "%~dp0"

netstat -ano | findstr /R /C:":5173 .*LISTENING" >nul
if not errorlevel 1 (
  echo Shizhi Xueban is already running.
  start "" "http://127.0.0.1:5173/"
  exit /b 0
)

if not exist "%~dp0start-dev.ps1" (
  echo Missing start-dev.ps1 in the project folder.
  pause
  exit /b 1
)

start "Shizhi Xueban Dev" powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-dev.ps1"
echo Starting frontend and local API proxy...
timeout /t 3 /nobreak >nul
start "" "http://127.0.0.1:5173"
exit /b 0
