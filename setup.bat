@echo off
rem Environment check - run this first, it tells you what is missing.
rem
rem ASCII only: a .bat without a BOM is parsed in the system codepage,
rem and UTF-8 Chinese in a .bat turns into garbage on a GBK console.

setlocal EnableDelayedExpansion
cd /d "%~dp0"
title setup

echo.
echo ============================================
echo   qq-persona-bridge   environment check
echo ============================================
echo.

set "MISSING=0"
set "WARN=0"

rem -- 1) Node.js --------------------------------
echo [1/5] Node.js
where node >nul 2>nul
if errorlevel 1 (
  echo    X  node not found
  echo      install https://nodejs.org/  18 or newer
  set /a MISSING+=1
) else (
  for /f "delims=" %%v in ('node --version 2^>nul') do echo    OK %%v
)

rem -- 2) Python (memory service) -----------------
echo.
echo [2/5] Python  (needed by the memory service)
set "PY="
for %%c in (python.exe python3.exe py.exe) do (
  where %%c >nul 2>nul && if not defined PY set "PY=%%c"
)
if not defined PY (
  echo    X  python not found
  echo      install https://www.python.org/downloads/  3.8+  tick "Add to PATH"
  echo      optional: without it you just get no memory feature
  set /a WARN+=1
) else (
  for /f "delims=" %%v in ('%PY% --version 2^>^&1') do echo    OK %%v
)

rem -- 3) config.json -----------------------------
echo.
echo [3/5] config.json
if exist "config.json" (
  echo    OK config.json found
) else (
  echo    X  config.json missing
  echo      copy config.example.json config.json
  set /a MISSING+=1
)

rem -- 4) model backend ---------------------------
echo.
echo [4/5] model backend
if not exist "config.json" (
  echo    - skipped, no config.json yet
  goto :qnapcat
)

for /f "usebackq delims=" %%i in (`node -e "const c=require('./config.json');console.log([c.llmProvider||'dsh',c.llmBase||'-',c.llmModel||'-',c.dshExe||'-',c.llmCliCmd||'-'].join('|'))"`) do set "BRAIN=%%i"
for /f "tokens=1,2,3,4,5 delims=|" %%a in ("!BRAIN!") do (
  set "PROV=%%a"
  set "BASE=%%b"
  set "MODEL=%%c"
  set "DSHEXE=%%d"
  set "CLICMD=%%e"
)
echo    provider: !PROV!

if /i "!PROV!"=="dsh" (
  if "!DSHEXE!"=="-" (
    echo    X  llmProvider is dsh but dshExe is empty
    echo       either fill dshExe, or set llmProvider to openai
    set /a MISSING+=1
  ) else (
    if exist "!DSHEXE!" (
      echo    OK DSH: !DSHEXE!
    ) else (
      echo    X  DSH path does not exist: !DSHEXE!
      set /a MISSING+=1
    )
  )
)

if /i "!PROV!"=="openai" (
  if "!BASE!"=="-" (
    echo    X  llmBase is empty
    set /a MISSING+=1
  ) else (
    echo    OK endpoint: !BASE!
  )
  if "!MODEL!"=="-" (
    echo    X  llmModel is empty
    set /a MISSING+=1
  ) else (
    echo    OK model: !MODEL!
  )
)

if /i "!PROV!"=="cli" (
  if "!CLICMD!"=="-" (
    echo    X  llmCliCmd is empty
    set /a MISSING+=1
  ) else (
    echo    OK command: !CLICMD!
  )
)

:qnapcat
rem -- 5) NapCat ---------------------------------
echo.
echo [5/5] NapCat  (QQ protocol endpoint)
powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 36199 -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
if errorlevel 1 (
  echo    X  nothing listening on 36199 - NapCat is not running
  echo      install and start NapCat, it uses that port by default
  echo      https://github.com/NapNeko/NapCatQQ
  set /a WARN+=1
) else (
  echo    OK NapCat on 36199
)

echo.
echo ============================================
if %MISSING%==0 (
  if %WARN%==0 (
    echo   All good. Run start-ayan.bat to launch.
  ) else (
    echo   Required items OK. %WARN% optional item^(s^) missing.
  )
) else (
  echo   %MISSING% required item^(s^) missing - see the X marks above.
)
echo ============================================
echo.
echo Start order, one window each:
echo   1. NapCat            (install it yourself)
echo   2. start-memory.bat  memory service
echo   3. start-tts.bat     voice (optional, needs Breeze-TTS)
echo   4. start-ayan.bat    the bridge
echo.
pause
