@echo off
rem Breeze TTS resident server.
rem
rem Start it once and keep it running - after that every utterance is just
rem inference, the model is not reloaded each time.
rem
rem Requires Breeze-TTS-2 (Apache-2.0):
rem   https://github.com/HoppouAI/Breeze-TTS-2.cpp
rem Then put the breeze-server path, the model path and the voices directory
rem into config.json as ttsCli / ttsModel / ttsVoicesDir.
rem
rem Note: if the model exceeds VRAM it falls back to CPU and takes several
rem seconds per short sentence. A discrete GPU is much faster.
rem
rem ASCII only: a .bat without a BOM is parsed in the system codepage.

setlocal EnableDelayedExpansion
cd /d "%~dp0"
title qq-persona-bridge-tts

if not exist "config.json" (
  echo   config.json missing. Copy it first:
  echo     copy config.example.json config.json
  pause
  exit /b 1
)

rem Read three values joined by |.
rem EnableDelayedExpansion is required - inside a for block %VAR% would
rem expand at parse time and always look empty.
set "TTS_CFG="
for /f "usebackq delims=" %%i in (`node -e "const c=require('./config.json');if(!c.ttsCli||!c.ttsModel){process.exit(1)}console.log([c.ttsCli,c.ttsModel,c.ttsVoicesDir||''].join('|'))"`) do set "TTS_CFG=%%i"

if "!TTS_CFG!"=="" (
  echo   ttsCli / ttsModel are empty in config.json
  pause
  exit /b 1
)

set "TTS_CLI="
set "TTS_MODEL="
set "TTS_VOICES="
for /f "tokens=1* delims=|" %%a in ("!TTS_CFG!") do set "TTS_CLI=%%a"
for /f "tokens=2* delims=|" %%a in ("!TTS_CFG!") do set "TTS_MODEL=%%a"
for /f "tokens=3* delims=|" %%a in ("!TTS_CFG!") do set "TTS_VOICES=%%a"

echo   starting TTS server...
echo   model: !TTS_MODEL!
"!TTS_CLI!" "!TTS_MODEL!" --host 127.0.0.1 --port 8137 --ws-port 8138 --voices-dir "!TTS_VOICES!"
