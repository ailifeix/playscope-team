@echo off
setlocal
cd /d "%~dp0.."
if not exist Screenshots mkdir Screenshots
echo PlayScope YouTube + Scrumball screenshot capture
echo.
set /p TARGET_URL=Paste YouTube link: 
if "%TARGET_URL%"=="" (
  echo No link entered.
  pause
  exit /b 1
)
echo.
echo Opening the YouTube link. Let Scrumball load, then the tool will capture the right-side panel.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0playscope-capture-screen.ps1" -OutputRoot "%CD%\Screenshots" -Url "%TARGET_URL%" -WaitSeconds 15 -CropMode ScrumballPanel -CropRightPercent 42 -CropTopPixels 70 -OpenFolder
pause
