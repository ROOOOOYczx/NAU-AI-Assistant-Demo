@echo off
setlocal

set "FOUND=0"
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:":5173 .*LISTENING"') do (
  set "FOUND=1"
  echo Stopping frontend service PID %%P on port 5173...
  taskkill /PID %%P /T /F >nul 2>&1
)

for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:":8787 .*LISTENING"') do (
  set "FOUND=1"
  echo Stopping local API proxy PID %%P on port 8787...
  taskkill /PID %%P /T /F >nul 2>&1
)

if "%FOUND%"=="0" echo No Shizhi Xueban service is running.
if not "%FOUND%"=="0" echo Shizhi Xueban services stopped.
pause
