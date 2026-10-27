@echo off
rem Device management: devices.cmd list | deny <id> | allow <id> | remove <id> | panic
rem Relay URL and tunnel key come from ..\.env (see ..\.env.example).
setlocal
set "DSH2PHONE_ENV_FILE=%~dp0..\.env"
if "%1"=="" (node "%~dp0src\tunnel.mjs" devices) else (node "%~dp0src\tunnel.mjs" %1 %2)
pause
