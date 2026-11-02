@echo off
rem 启动 QQ 私信桥
rem
rem 需要先准备好：
rem   1. DSH 运行时 —— 把路径填进 config.json 的 dshExe
rem   2. NapCat —— QQ 协议端点，默认 ws://127.0.0.1:36199
rem
rem 本脚本用相对路径，跟着仓库走就能跑。

setlocal EnableDelayedExpansion
cd /d "%~dp0"
title qq-bridge

rem 用 DSH 运行时自带的 node（Electron 的 node 模式）。
rem WebSocket 和 child_process 都是内置的，不需要装包。
set ELECTRON_RUN_AS_NODE=1

rem 默认她一句话都不垫，答完直接说。
rem 想恢复旧行为（先应一声 + 每 90 秒报进度）就设 AYAN_ACK=on。
rem set AYAN_ACK=on

if not exist "config.json" (
  echo.
  echo   还没有 config.json。先复制一份改一下：
  echo.
  echo     copy config.example.json config.json
  echo.
  pause
  exit /b 1
)

rem 从 config.json 取 dshExe。
rem 必须开 EnableDelayedExpansion —— 否则下面的 if 块里 !DSH_EXE! 会在
rem 解析时就展开成空，判断永远成立不了。
set "DSH_EXE="
for /f "usebackq delims=" %%i in (`node -e "import('./config.mjs').then(m=>console.log(m.config.dshExe||''))"`) do set "DSH_EXE=%%i"

if "!DSH_EXE!"=="" (
  echo   config.json 里的 dshExe 没填。
  pause
  exit /b 1
)

rem 已经在跑就别再起一个 —— 同一个 QQ 号开两个实例会互相顶号。
powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 3002 -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
if %errorlevel%==0 (
  echo bridge is already running - opening the console.
  start "" "http://127.0.0.1:3002/"
  timeout /t 2 /nobreak >nul
  exit /b 0
)

echo   启动，控制台 http://127.0.0.1:3002/
"!DSH_EXE!" "%~dp0bridge.mjs"

echo.
echo bridge stopped. press any key to close.
pause >nul
