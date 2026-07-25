@echo off
cd /d "%~dp0"
echo.
echo  HiveDrop local preview
echo  http://localhost:5050
echo.
start "" "http://localhost:5050"
npx.cmd --yes serve -l 5050
pause
