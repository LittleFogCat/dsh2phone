@echo off
rem dsh2phone tunnel (main process).
rem Endpoints, upstream port and the tunnel key all come from ..\.env
rem (template: ..\.env.example) — this launcher stores no secrets.
setlocal
set "DSH2PHONE_ENV_FILE=%~dp0..\.env"
title dsh2phone tunnel
node "%~dp0src\tunnel.mjs"
pause
