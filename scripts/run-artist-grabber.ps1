# Runs the enrichment backfill under a cross-process lock, called by grab-artist-info.bat.
#
# The lock is a folder in %TEMP% tagged with this run's PID. try/finally removes it on a normal
# exit *and* on Ctrl+C (PowerShell unwinds finally blocks on a break). If the window gets closed
# instead (no chance for finally to run), the lock is left behind - the next run detects that its
# owning PID is dead and clears it automatically, so it never needs a manual delete.
#
# Exit codes: 0/1/3 pass through from backfill-enrichment.mjs; 2 = another copy is already running.

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

$lockDir = Join-Path $env:TEMP 'wrapt-artist-grabber.lock'
$pidFile = Join-Path $lockDir 'owner.pid'

function Test-LockStale {
    $ownerId = Get-Content $pidFile -ErrorAction SilentlyContinue
    if (-not $ownerId) { return $true }
    return -not (Get-Process -Id ([int]$ownerId) -ErrorAction SilentlyContinue)
}

if ((Test-Path $lockDir) -and (Test-LockStale)) {
    Write-Host "Found a lock left over from a run that didn't shut down cleanly (e.g. the window was closed) - clearing it."
    Remove-Item -Recurse -Force $lockDir -ErrorAction SilentlyContinue
}

try {
    New-Item -ItemType Directory -Path $lockDir -ErrorAction Stop | Out-Null
} catch {
    Write-Host "Another window already appears to be running this script."
    exit 2
}
Set-Content -Path $pidFile -Value $PID

try {
    & node scripts\backfill-enrichment.mjs
    exit $LASTEXITCODE
} finally {
    Remove-Item -Recurse -Force $lockDir -ErrorAction SilentlyContinue
}
