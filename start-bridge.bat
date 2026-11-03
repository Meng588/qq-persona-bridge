@echo off
rem Start the bridge.
rem
rem Prerequisites:
rem   1. a model backend - set llmProvider in config.json
rem        dsh    needs dshExe + dshCli
rem        openai needs llmBase + llmModel (+ llmKey)
rem        cli    needs llmCliCmd
rem   2. NapCat - QQ protocol endpoint, default ws://127.0.0.1:36199
rem
rem ASCII only: a .bat without a BOM is parsed in the system codepage.

setlocal EnableDelayedExpansion
cd /d "%~dp0"
title qq-persona-bridge

rem DSH runs node in Electron's node mode. Harmless for the other backends.
set ELECTRON_RUN_AS_NODE=1

rem By default she says nothing until the answer is ready.
rem Set QQPB_ACK=on to restore the old behaviour (a quick "one moment"
rem plus progress pings every 90 seconds).
rem set QQPB_ACK=on

if not exist "config.json" (
  echo.
  echo   config.json missing. Copy it first:
  echo.
  echo     copy config.example.json config.json
  echo.
  pause
  exit /b 1
)

rem Already running? Do not start a second one - two instances of the same
rem QQ account kick each other offline.
powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 3002 -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
if %errorlevel%==0 (
  echo bridge is already running - opening the console.
  start "" "http://127.0.0.1:3002/"
  timeout /t 2 /nobreak >nul
  exit /b 0
)

rem Read the backend choice out of config.json.
rem EnableDelayedExpansion is required: inside the if-blocks below,
rem %VAR% would expand at parse time and always look empty.
for /f "usebackq delims=" %%i in (`node -e "const c=require('./config.json');console.log([c.llmProvider||'dsh',c.dshExe||'-'].join('|'))"`) do set "BRAIN=%%i"
for /f "tokens=1,2 delims=|" %%a in ("!BRAIN!") do (
  set "PROV=%%a"
  set "DSH_EXE=%%b"
)

if /i "!PROV!"=="dsh" (
  if "!DSH_EXE!"=="-" (
    echo   llmProvider is dsh but dshExe is empty.
    echo   Fill dshExe, or set llmProvider to openai in config.json.
    pause
    exit /b 1
  )
  if not exist "!DSH_EXE!" (
    echo   DSH not found: !DSH_EXE!
    pause
    exit /b 1
  )
  echo   starting with DSH backend
  echo   console: http://127.0.0.1:3002/
  "!DSH_EXE!" "%~dp0bridge.mjs"
) else (
  echo   starting with !PROV! backend
  echo   console: http://127.0.0.1:3002/
  node "%~dp0bridge.mjs"
)

echo.
echo bridge stopped. press any key to close.
pause >nul
