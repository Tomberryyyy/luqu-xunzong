@echo off
setlocal
cd /d "%~dp0"
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"
chcp 65001 >nul
set "APP_PYTHON="
for /d %%D in ("%LOCALAPPDATA%\Python\pythoncore-*") do if exist "%%~fD\python.exe" set "APP_PYTHON=%%~fD\python.exe"
if defined APP_PYTHON goto direct
python -c "import sys; sys.exit(sys.version_info.major != 3)" >nul 2>nul
if not errorlevel 1 goto python
py -3 -c "import sys; sys.exit(sys.version_info.major != 3)" >nul 2>nul
if not errorlevel 1 goto py
 echo Python 3 is required. Please send a screenshot of this window.
set "APP_EXIT=1"
goto done
:direct
"%APP_PYTHON%" launch_windows.py %*
set "APP_EXIT=%errorlevel%"
goto done
:python
python launch_windows.py %*
set "APP_EXIT=%errorlevel%"
goto done
:py
py -3 launch_windows.py %*
set "APP_EXIT=%errorlevel%"
:done
if /i "%~1"=="--check" exit /b %APP_EXIT%
echo.
echo The server has stopped. Press any key to close.
pause >nul
exit /b %APP_EXIT%
