@echo off
rem Breeze TTS 常驻服务器
rem
rem 启动一次之后一直用，不再每条语音都重新加载模型。
rem
rem 需要先装 Breeze-TTS-2（Apache-2.0）：
rem   https://github.com/HoppouAI/Breeze-TTS-2.cpp
rem 然后把 breeze-server.exe 和模型路径填进 config.json 的
rem ttsCli / ttsModel / ttsVoicesDir。
rem
rem 提示：模型超过显存时会走 CPU 混合推理，短句要好几秒。
rem 有独显会快很多。

setlocal
cd /d "%~dp0"
title ayan-tts

if not exist "config.json" (
  echo   还没有 config.json。先复制一份改一下。
  pause
  exit /b 1
)

for /f "usebackq delims=" %%i in (`node -e "import('./config.mjs').then(m=>{const c=m.config;console.log(c.ttsCli||'');console.log(c.ttsModel||'');console.log(c.ttsVoicesDir||'');})"`) do set TTS_LINE=%%i

echo   读取配置...
node -e "import('./config.mjs').then(m=>{const c=m.config;if(!c.ttsCli||!c.ttsModel){console.error('config.json 里的 ttsCli / ttsModel 没填');process.exit(1)};console.log(c.ttsCli);console.log(c.ttsModel);console.log(c.ttsVoicesDir||'')})" > "%TEMP%\ayan-tts-cfg.txt" 2>nul

if errorlevel 1 (
  echo   config.json 里的 ttsCli / ttsModel 没填。
  pause
  exit /b 1
)

set /p TTS_CLI=<"%TEMP%\ayan-tts-cfg.txt"
set /p TTS_MODEL=<"%TEMP%\ayan-tts-cfg.txt" & rem 读第二行
for /f "skip=1" %%i in ('type "%TEMP%\ayan-tts-cfg.txt"') do (
  if not defined TTS_MODEL set TTS_MODEL=%%i
)
for /f "skip=2" %%i in ('type "%TEMP%\ayan-tts-cfg.txt"') do (
  if not defined TTS_VOICES set TTS_VOICES=%%i
)

echo   启动 TTS 服务器...
"%TTS_CLI%" "%TTS_MODEL%" --host 127.0.0.1 --port 8137 --ws-port 8138 --voices-dir "%TTS_VOICES%"
