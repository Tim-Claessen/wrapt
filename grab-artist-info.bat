@echo off
REM ===========================================================================
REM  Spotify artist-information grabber
REM
REM  Drains the import enrichment backlog: for every imported track still
REM  missing its details, it looks the track up on Spotify and fills in the
REM  artist ids/names, album art, and true duration.
REM
REM  Reads creds from .dev.vars (must sit in the repo root next to package.json).
REM  Idempotent and resumable - safe to cancel (Ctrl-C, or just closing this window)
REM  and run again anytime; nothing is lost.
REM  Only one copy runs at a time. The lock lives in a temp folder tagged with the
REM  owning process's PID, so if a run gets killed instead of exiting cleanly, the
REM  next run notices the owner is gone and clears the lock itself - no manual
REM  deleting a folder in %TEMP%.
REM  It also gives up and auto-closes if 10 minutes pass without resolving anything.
REM ===========================================================================
setlocal
title Spotify artist info grabber

REM Run from this file's own folder (the repo root), so .dev.vars + scripts\ resolve.
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js was not found on your PATH.
  echo Install Node 22+ ^(https://nodejs.org^) and try again.
  echo.
  pause
  exit /b 1
)

if not exist ".dev.vars" (
  echo ERROR: .dev.vars not found in "%cd%".
  echo Keep this .bat in the wrapt repo root, next to package.json.
  echo.
  pause
  exit /b 1
)

echo Grabbing Spotify artist info ^(draining the enrichment backlog^)...
echo   - reads .dev.vars   - idempotent   - resumable
echo.
echo To cancel: press Ctrl+C ^(if cmd asks "Terminate batch job", answer Y^),
echo or just close this window. Either way it's safe - re-run anytime.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\run-artist-grabber.ps1"
set EXITCODE=%errorlevel%

if "%EXITCODE%"=="2" (
  echo.
  pause
  exit /b %EXITCODE%
)

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
  echo Stopped ^(code %EXITCODE%^) - if you cancelled, that's expected. Just re-run to resume.
)
pause
exit /b %EXITCODE%
