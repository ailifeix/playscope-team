@echo off
setlocal
cd /d "%~dp0.."
if not exist Screenshots mkdir Screenshots
echo PlayScope screenshot capture
echo.
echo This takes a full-screen screenshot and saves it under Screenshots\YYYY-MM-DD\HHmmss.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0playscope-capture-screen.ps1" -OutputRoot "%CD%\Screenshots" -OpenFolder
pause
