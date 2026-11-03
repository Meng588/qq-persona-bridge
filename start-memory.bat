@echo off
rem Memory service - SQLite + keyword recall, pure Python standard library.
rem
rem Listens on 127.0.0.1:8790 by default, database at memory/memory.db.
rem
rem Environment:
rem   MEM_PORT        port, default 8790
rem   MEM_DB          database path, default <this dir>/memory/memory.db
rem   MEM_HOST        bind address, default 127.0.0.1
rem   MEM_EMBED_URL   vector service (optional, leave empty for keyword only)
rem
rem ASCII only: a .bat without a BOM is parsed in the system codepage.

setlocal
cd /d "%~dp0"

set "PY="
for %%c in (python.exe python3.exe py.exe) do (
  where %%c >nul 2>nul && if not defined PY set "PY=%%c"
)

if not defined PY (
  echo.
  echo   python not found.
  echo.
  echo   Install Python 3.8 or newer - no packages needed:
  echo     https://www.python.org/downloads/
  echo   Tick "Add Python to PATH" during install.
  echo.
  pause
  exit /b 1
)

rem keep Chinese text intact when writing to the database
set "PYTHONIOENCODING=utf-8"

if not defined MEM_DB set "MEM_DB=%~dp0memory\memory.db"

echo   memory service starting on http://127.0.0.1:8790
echo   keep this window open - closing it stops memory
echo.
"%PY%" "memory\memory_service.py"
