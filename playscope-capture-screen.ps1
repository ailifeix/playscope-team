param(
  [string]$OutputRoot = "Screenshots",
  [string]$Url = "",
  [int]$WaitSeconds = 12,
  [int]$RepeatSeconds = 0,
  [int]$Count = 1,
  [ValidateSet("None", "RightPanel", "ScrumballPanel")]
  [string]$CropMode = "None",
  [int]$CropRightPercent = 42,
  [int]$CropTopPixels = 70,
  [int]$CropBottomPixels = 20,
  [switch]$OpenFolder
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function New-ScreenshotFolder {
  param([string]$Base)
  if (-not (Test-Path -LiteralPath $Base)) {
    New-Item -ItemType Directory -Force -Path $Base | Out-Null
  }
  $basePath = (Resolve-Path -LiteralPath $Base).Path
  $datePart = Get-Date -Format "yyyy-MM-dd"
  $timePart = Get-Date -Format "HHmmss"
  $folder = Join-Path (Join-Path $basePath $datePart) $timePart
  New-Item -ItemType Directory -Force -Path $folder | Out-Null
  return $folder
}

function Open-TargetUrl {
  param([string]$TargetUrl)
  if ([string]::IsNullOrWhiteSpace($TargetUrl)) { return }
  $edgeCandidates = @(
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles(x86)\Microsoft\Edge\Application\msedge.exe"
  )
  $edge = $edgeCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if ($edge) {
    [System.Diagnostics.Process]::Start($edge, "--new-window `"$TargetUrl`"") | Out-Null
  } else {
    [System.Diagnostics.Process]::Start($TargetUrl) | Out-Null
  }
  if ($WaitSeconds -gt 0) { Start-Sleep -Seconds $WaitSeconds }
}

function Save-FullScreenShot {
  param([string]$Folder)
  $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
  if ($bounds.Width -le 0 -or $bounds.Height -le 0) {
    throw "No Windows desktop screen was detected. Run this from your signed-in desktop session."
  }
  $bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bounds.Size)
    $file = Join-Path $Folder "full-screen.png"
    $bitmap.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
    return @{ File = $file; Bounds = $bounds }
  } finally {
    $graphics.Dispose()
    $bitmap.Dispose()
  }
}

function Save-RightPanelCrop {
  param([string]$SourceFile, [string]$Folder)
  if ($CropMode -eq "None") { return "" }
  $source = [System.Drawing.Image]::FromFile($SourceFile)
  try {
    $percent = [Math]::Min(90, [Math]::Max(10, $CropRightPercent))
    $cropWidth = [Math]::Max(1, [int]($source.Width * $percent / 100))
    $cropX = [Math]::Max(0, $source.Width - $cropWidth)
    $cropY = [Math]::Min([Math]::Max(0, $CropTopPixels), $source.Height - 1)
    $cropHeight = [Math]::Max(1, $source.Height - $cropY - [Math]::Max(0, $CropBottomPixels))
    $rect = New-Object System.Drawing.Rectangle $cropX, $cropY, $cropWidth, $cropHeight
    $crop = New-Object System.Drawing.Bitmap $rect.Width, $rect.Height
    $graphics = [System.Drawing.Graphics]::FromImage($crop)
    try {
      $graphics.DrawImage($source, 0, 0, $rect, [System.Drawing.GraphicsUnit]::Pixel)
      $out = Join-Path $Folder "scrumball-panel.png"
      $crop.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
      return $out
    } finally {
      $graphics.Dispose()
      $crop.Dispose()
    }
  } finally {
    $source.Dispose()
  }
}

Open-TargetUrl -TargetUrl $Url

$captures = @()
$total = [Math]::Max(1, $Count)
for ($i = 1; $i -le $total; $i++) {
  $folder = New-ScreenshotFolder -Base $OutputRoot
  if ($Url) { Set-Content -LiteralPath (Join-Path $folder "source-url.txt") -Value $Url -Encoding UTF8 }
  $capture = Save-FullScreenShot -Folder $folder
  if (-not $capture.File -or -not (Test-Path -LiteralPath $capture.File)) {
    throw "Screenshot was not created. Make sure this is running in your signed-in Windows desktop session."
  }
  $captures += $capture.File
  Write-Host "Saved screenshot: $($capture.File)"
  $panelFile = Save-RightPanelCrop -SourceFile $capture.File -Folder $folder
  if ($panelFile) {
    $captures += $panelFile
    Write-Host "Saved Scrumball panel crop: $panelFile"
  }
  $meta = @(
    "createdAt=$(Get-Date -Format o)",
    "url=$Url",
    "cropMode=$CropMode",
    "cropRightPercent=$CropRightPercent",
    "cropTopPixels=$CropTopPixels",
    "cropBottomPixels=$CropBottomPixels"
  )
  Set-Content -LiteralPath (Join-Path $folder "capture-meta.txt") -Value $meta -Encoding UTF8
  if ($OpenFolder) { [System.Diagnostics.Process]::Start("explorer.exe", $folder) | Out-Null }
  if ($RepeatSeconds -gt 0 -and $i -lt $total) { Start-Sleep -Seconds $RepeatSeconds }
}

Write-Host "Done. Files: $($captures.Count)"
