@echo off
rem CLI pairing (QR in terminal + Y/n confirm). Fallback for the in-DSH dialog.
rem Relay URL / pairing URL / tunnel key come from ..\.env (see ..\.env.example).
setlocal
set "DSH2PHONE_ENV_FILE=%~dp0..\.env"
title dsh2phone pairing
node "%~dp0src\tunnel.mjs" pair
pause
