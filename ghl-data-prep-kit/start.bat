@echo off
REM GHL Data Prep Kit launcher (Windows)
REM Drop CSV files into the inbox folder, double-click this file, collect results from outbox\<timestamp>
REM Optional from a terminal: start.bat "tag1,tag2" "Lead Source" 50   (last value = max MB per file, default 30)
set MB=%~3
if "%MB%"=="" set MB=30
cd /d "%~dp0"
setlocal enabledelayedexpansion
set FILES=
for %%F in (inbox\*.csv inbox\*.tsv inbox\*.txt) do set FILES=!FILES! "%%F"
if "!FILES!"=="" (
  echo No files in inbox. Opening the browser kit instead.
  start "" "web\ghl-data-prep-kit.html"
  exit /b 0
)
for /f %%T in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd_HHmmss"') do set TS=%%T
where py >nul 2>nul && (set PY=py) || (set PY=python)
%PY% engine\ghl_prepkit.py run !FILES! --outdir "outbox\!TS!" --tags "%~1" --source "%~2" --max-mb %MB%
echo.
echo Done. Files are in outbox\!TS!
pause
