@echo off
setlocal
cd /d "%~dp0.."
echo Starting PlayScope Local Agent...
echo Keep this window open while using Render auto Scrumball capture.
echo.
node scripts\playscope-local-agent.js
pause

