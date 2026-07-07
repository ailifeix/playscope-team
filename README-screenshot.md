# PlayScope Local Screenshot Capture

Use `scripts\start-screenshot-capture.bat` for a one-click full-screen capture.

Use `scripts\capture-youtube-scrumball.bat` when you have a YouTube link. It opens the link, waits for Scrumball to load, saves the full screen, and also saves a right-side crop as `scrumball-panel.png`.

Files are saved like this:

`Screenshots\2026-07-07\153012\full-screen.png`
`Screenshots\2026-07-07\153012\scrumball-panel.png`
`Screenshots\2026-07-07\153012\source-url.txt`

Advanced examples:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\playscope-capture-screen.ps1 -OpenFolder
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\playscope-capture-screen.ps1 -Url "https://www.youtube.com/@channel" -WaitSeconds 15 -CropMode ScrumballPanel -OpenFolder
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\playscope-capture-screen.ps1 -Url "https://www.youtube.com/@channel" -CropMode ScrumballPanel -CropRightPercent 50 -CropTopPixels 90
```
