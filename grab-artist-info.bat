@echo off
REM ===========================================================================
REM  Spotify artist-information grabber
REM
REM  Drains the import enrichment backlog: for every imported track still
REM  missing its details, it looks the track up on Spotify and fills in the
REM  artist ids/names, album art, and true duration.
REM
REM  Reads creds from .dev.vars (must sit in the repo root next to package.json).
REM  Idempotent and resumable - safe to close (Ctrl-C) and run again anytime.
REM  Only one copy runs at a time (see the lock check below), and it gives up
REM  and auto-closes if 10 minutes pass without resolving anything.
REM ===========================================================================
setlocal
title Spotify artist info grabber

REM Run from this file's own folder (the repo root), so .dev.vars + scripts\ resolve.
cd /d "%~dp0"

REM mkdir is atomic on Windows, so this doubles as a simple cross-process lock:
REM only the window that wins the race to create the folder proceeds.
set "LOCKDIR=%TEMP%\wrapt-artist-grabber.lock"
mkdir "%LOCKDIR%" 2>nul
if errorlevel 1 (
  echo Another window already appears to be running this script.
  echo.
  echo If that's not true ^(e.g. a previous run crashed without cleaning up^),
  echo delete this folder and try again:
  echo   %LOCKDIR%
  echo.
  pause
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js was not found on your PATH.
  echo Install Node 22+ ^(https://nodejs.org^) and try again.
  echo.
  rmdir "%LOCKDIR%" 2>nul
  pause
  exit /b 1
)

if not exist ".dev.vars" (
  echo ERROR: .dev.vars not found in "%cd%".
  echo Keep this .bat in the wrapt repo root, next to package.json.
  echo.
  rmdir "%LOCKDIR%" 2>nul
  pause
  exit /b 1
)

echo Grabbing Spotify artist info ^(draining the enrichment backlog^)...
echo   - reads .dev.vars   - idempotent   - Ctrl-C is safe, just re-run
echo.
node scripts\backfill-enrichment.mjs
set EXITCODE=%errorlevel%

rmdir "%LOCKDIR%" 2>nul

if "%EXITCODE%"=="3" (
  echo.
  echo Stopped: nothing resolved in 10 minutes ^(likely rate-limited or stuck^).
  echo Closing automatically - just re-run this file later to pick up where it left off.
  exit /b %EXITCODE%
)

echo.
if "%EXITCODE%"=="0" (
  echo Finished. You can close this window.
) else (
  echo Stopped with error code %EXITCODE% ^(see messages above^).
)
pause
exit /b %EXITCODE%
