param(
  [string]$OutputRoot = "Screenshots",
  [string]$Url = "",
  [int]$WaitSeconds = 12,
  [ValidateSet("None", "ScrumballPanel")]
  [string]$CropMode = "ScrumballPanel",
  [int]$CropRightPercent = 42,
  [int]$CropTopPixels = 70,
  [int]$CropBottomPixels = 20,
  [switch]$ClickBeforeCapture,
  [int]$ClickXPercent = 96,
  [int]$ClickYPercent = 8,
  [int]$PostClickWaitSeconds = 4
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class PlayScopeMouse {
  [DllImport("user32.dll")]
  public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")]
  public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
  public const uint LEFTDOWN = 0x0002;
  public const uint LEFTUP = 0x0004;
}
"@

function New-CaptureFolder {
  if (-not (Test-Path -LiteralPath $OutputRoot)) { New-Item -ItemType Directory -Force -Path $OutputRoot | Out-Null }
  $folder = Join-Path (Join-Path (Resolve-Path -LiteralPath $OutputRoot).Path (Get-Date -Format "yyyy-MM-dd")) (Get-Date -Format "HHmmss")
  New-Item -ItemType Directory -Force -Path $folder | Out-Null
  return $folder
}

function Open-TargetUrl {
  if ([string]::IsNullOrWhiteSpace($Url)) { return }
  $edge = @("$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles(x86)\Microsoft\Edge\Application\msedge.exe") | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if ($edge) { [System.Diagnostics.Process]::Start($edge, "--new-window `"$Url`"") | Out-Null } else { [System.Diagnostics.Process]::Start($Url) | Out-Null }
  if ($WaitSeconds -gt 0) { Start-Sleep -Seconds $WaitSeconds }
}

function Invoke-ConfiguredClick {
  if (-not $ClickBeforeCapture) { return }
  $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $x = $bounds.Left + [int]($bounds.Width * ([Math]::Min(100, [Math]::Max(0, $ClickXPercent))) / 100)
  $y = $bounds.Top + [int]($bounds.Height * ([Math]::Min(100, [Math]::Max(0, $ClickYPercent))) / 100)
  [PlayScopeMouse]::SetCursorPos($x, $y) | Out-Null
  Start-Sleep -Milliseconds 200
  [PlayScopeMouse]::mouse_event([PlayScopeMouse]::LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 80
  [PlayScopeMouse]::mouse_event([PlayScopeMouse]::LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
  if ($PostClickWaitSeconds -gt 0) { Start-Sleep -Seconds $PostClickWaitSeconds }
}

function Save-FullScreenShot($Folder) {
  $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
  if ($bounds.Width -le 0 -or $bounds.Height -le 0) { throw "No Windows desktop screen detected." }
  $bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bounds.Size)
    $file = Join-Path $Folder "full-screen.png"
    $bitmap.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
    return $file
  } finally { $graphics.Dispose(); $bitmap.Dispose() }
}

function Save-ScrumballCrop($SourceFile, $Folder) {
  if ($CropMode -eq "None") { return "" }
  $source = [System.Drawing.Image]::FromFile($SourceFile)
  try {
    $cropWidth = [Math]::Max(1, [int]($source.Width * ([Math]::Min(90, [Math]::Max(10, $CropRightPercent))) / 100))
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
    } finally { $graphics.Dispose(); $crop.Dispose() }
  } finally { $source.Dispose() }
}

Open-TargetUrl
Invoke-ConfiguredClick
$folder = New-CaptureFolder
if ($Url) { Set-Content -LiteralPath (Join-Path $folder "source-url.txt") -Value $Url -Encoding UTF8 }
$full = Save-FullScreenShot $folder
Write-Host "Saved screenshot: $full"
$panel = Save-ScrumballCrop $full $folder
if ($panel) { Write-Host "Saved Scrumball panel crop: $panel" }
