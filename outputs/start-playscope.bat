@echo off
cd /d "%~dp0.."
echo PlayScope baslatiliyor...
echo.
node outputs\playscope-server.js
pause
