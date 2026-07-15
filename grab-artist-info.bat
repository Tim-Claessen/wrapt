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
node scripts\backfill-enrichment.mjs
set EXITCODE=%errorlevel%

echo.
if "%EXITCODE%"=="0" (
  echo Finished. You can close this window.
) else (
  echo Stopped ^(code %EXITCODE%^) - re-run this file anytime to resume.
)
pause
exit /b %EXITCODE%
