@echo off
rem Breeze TTS 常驻服务器
rem
rem 启动一次之后一直用，之后每条语音只算推理，不再重新加载模型。
rem
rem 需要先装 Breeze-TTS-2（Apache-2.0）：
rem   https://github.com/HoppouAI/Breeze-TTS-2.cpp
rem 然后把 breeze-server（或 breeze-cli）路径、模型路径、音色目录填进
rem config.json 的 ttsCli / ttsModel / ttsVoicesDir。
rem
rem 提示：模型超过显存时会走 CPU 混合推理，短句要好几秒。
rem 有独显会快很多。

setlocal EnableDelayedExpansion
cd /d "%~dp0"
title qq-bridge-tts

if not exist "config.json" (
  echo   还没有 config.json。先复制一份改一下：
  echo     copy config.example.json config.json
  pause
  exit /b 1
)

rem 三个值用 | 分隔读回来。
rem 注意：必须开 EnableDelayedExpansion，且在 for 块外先赋值 ——
rem 否则块里的 %VAR% 会在解析时就展开成空。
set "TTS_CFG="
for /f "usebackq delims=" %%i in (`node -e "import('./config.mjs').then(m=>{const c=m.config;if(!c.ttsCli||!c.ttsModel){process.exit(1)}console.log([c.ttsCli,c.ttsModel,c.ttsVoicesDir||''].join('|'))})"`) do set "TTS_CFG=%%i"

if "!TTS_CFG!"=="" (
  echo   config.json 里的 ttsCli / ttsModel 没填。
  pause
  exit /b 1
)

set "TTS_CLI="
set "TTS_MODEL="
set "TTS_VOICES="
for /f "tokens=1* delims=|" %%a in ("!TTS_CFG!") do set "TTS_CLI=%%a"
for /f "tokens=2* delims=|" %%a in ("!TTS_CFG!") do set "TTS_MODEL=%%a"
for /f "tokens=3* delims=|" %%a in ("!TTS_CFG!") do set "TTS_VOICES=%%a"

echo   启动 TTS 服务器...
echo   模型: !TTS_MODEL!
"!TTS_CLI!" "!TTS_MODEL!" --host 127.0.0.1 --port 8137 --ws-port 8138 --voices-dir "!TTS_VOICES!"
