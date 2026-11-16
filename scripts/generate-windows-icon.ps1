$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$assetDirectory = Join-Path $PSScriptRoot '..\src\assets'
$sourcePath = Join-Path $assetDirectory 'medilogix-logo.png'
$pngPath = Join-Path $assetDirectory 'medilogix-symbol.png'
$icoPath = Join-Path $assetDirectory 'medilogix-symbol.ico'
$source = [System.Drawing.Bitmap]::new($sourcePath)
$icon = [System.Drawing.Bitmap]::new(256, 256, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)

# Keep only the cyan/green swoosh pixels from the supplied logo; the wordmark
# is intentionally excluded so the mark stays legible at Windows taskbar size.
$cropLeft = 18; $cropTop = 0; $cropWidth = 120; $cropHeight = 80
$targetWidth = 220; $targetHeight = 147; $targetLeft = 18; $targetTop = 54
for ($y = 0; $y -lt $targetHeight; $y++) {
  for ($x = 0; $x -lt $targetWidth; $x++) {
    $sourceX = $cropLeft + [int]([Math]::Floor($x * $cropWidth / $targetWidth))
    $sourceY = $cropTop + [int]([Math]::Floor($y * $cropHeight / $targetHeight))
    $pixel = $source.GetPixel($sourceX, $sourceY)
    $color = $null
    if ($pixel.B -gt ($pixel.G + 5) -and $pixel.G -gt ($pixel.R + 15)) {
      $alpha = [Math]::Min(255, [Math]::Max(0, [int]((255 - $pixel.R) * 255 / 240)))
      $color = [System.Drawing.Color]::FromArgb($alpha, 18, 176, 224)
    } elseif ($pixel.G -gt ($pixel.B + 8) -and $pixel.G -gt ($pixel.R + 12)) {
      $alpha = [Math]::Min(255, [Math]::Max(0, [int]((255 - $pixel.R) * 255 / 255)))
      $color = [System.Drawing.Color]::FromArgb($alpha, 0, 169, 93)
    }
    if ($color -and $alpha -gt 0) { $icon.SetPixel($targetLeft + $x, $targetTop + $y, $color) }
  }
}
$source.Dispose()
$icon.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)
$icon.Dispose()

# Windows supports a 256x256 PNG image inside an ICO container.
$pngBytes = [System.IO.File]::ReadAllBytes($pngPath)
$stream = [System.IO.File]::Open($icoPath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
try {
  $writer = [System.IO.BinaryWriter]::new($stream)
  $writer.Write([UInt16]0) # reserved
  $writer.Write([UInt16]1) # icon resource
  $writer.Write([UInt16]1) # image count
  $writer.Write([Byte]0)   # width 256 is encoded as 0
  $writer.Write([Byte]0)   # height 256 is encoded as 0
  $writer.Write([Byte]0)   # palette
  $writer.Write([Byte]0)   # reserved
  $writer.Write([UInt16]1) # color planes
  $writer.Write([UInt16]32)
  $writer.Write([UInt32]$pngBytes.Length)
  $writer.Write([UInt32]22) # header size (6) + directory entry (16)
  $writer.Write($pngBytes)
  $writer.Dispose()
} finally {
  $stream.Dispose()
}

Write-Output "Created $pngPath and $icoPath"
