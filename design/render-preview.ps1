Add-Type -AssemblyName System.Drawing
$width = 1646; $height = 941
$bitmap = [System.Drawing.Bitmap]::new($width, $height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$graphics.Clear([System.Drawing.ColorTranslator]::FromHtml('#f4f7fb'))

function Brush($hex) { return [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml($hex)) }
function Pen($hex, [single]$w = 1) { return [System.Drawing.Pen]::new([System.Drawing.ColorTranslator]::FromHtml($hex), $w) }
function Font([single]$size, [System.Drawing.FontStyle]$style = [System.Drawing.FontStyle]::Regular) { return [System.Drawing.Font]::new('Segoe UI', $size, $style, [System.Drawing.GraphicsUnit]::Pixel) }
function Text($value, [single]$x, [single]$y, [single]$size, $color, [System.Drawing.FontStyle]$style = [System.Drawing.FontStyle]::Regular) {
  $graphics.DrawString($value, (Font $size $style), (Brush $color), $x, $y)
}
function Box([single]$x, [single]$y, [single]$w, [single]$h, $fill, $stroke, [single]$radius = 8) {
  $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $d = $radius * 2
  $path.AddArc($x, $y, $d, $d, 180, 90); $path.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $path.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90); $path.AddArc($x, $y + $h - $d, $d, $d, 90, 90); $path.CloseFigure()
  $graphics.FillPath((Brush $fill), $path); $graphics.DrawPath((Pen $stroke), $path); $path.Dispose()
}

# Header
$graphics.FillRectangle((Brush '#1c1c1c'), 0, 0, $width, 8)
$graphics.FillRectangle((Brush '#ffffff'), 0, 8, $width, 92)
$graphics.DrawLine((Pen '#e4eaf1'), 0, 99, $width, 99)
$logo = [System.Drawing.Image]::FromFile((Join-Path $PSScriptRoot '..\src\assets\medilogix-logo.png'))
$graphics.DrawImage($logo, 67, 27, 174, 56); $logo.Dispose()
Text 'Live readings' 350 39 16 '#718096'
Text 'Recordings' 488 39 16 '#182b43'
Box 582 42 24 24 '#f0f3f7' '#f0f3f7' 12
Text '44' 589 46 13 '#718096'
$graphics.FillRectangle((Brush '#159b70'), 485, 97, 121, 2)
Box 1479 34 122 43 '#f8fbf9' '#dbe8df' 22
Box 1487 41 29 29 '#dff2e8' '#dff2e8' 15
Text 'HS' 1494 48 12 '#16805a' ([System.Drawing.FontStyle]::Bold)
Text 'Haran S' 1526 45 15 '#16805a'

# Main heading and actions
Text 'YOUR RECORDS' 47 149 12 '#74849a' ([System.Drawing.FontStyle]::Bold)
Text 'Recordings' 47 174 36 '#142841' ([System.Drawing.FontStyle]::Bold)
Text 'Open a date folder to find and review a patient record.' 47 224 15 '#78889d'
Box 1296 175 176 44 '#15966c' '#15966c' 8
Text '+' 1316 184 20 '#ffffff'
Text 'Import records' 1344 187 15 '#ffffff'
Box 1482 175 119 44 '#ffffff' '#dce4ee' 8
Text 'Refresh' 1501 187 15 '#51637a'

# Search and count
Box 47 261 1554 54 '#ffffff' '#d7e0ea' 9
$graphics.DrawEllipse((Pen '#728399' 1.5), 69, 281, 12, 12)
$graphics.DrawLine((Pen '#728399' 1.5), 79, 292, 84, 297)
Text 'Search dates, patient names, ages, or genders' 100 277 16 '#8291a5'
Text 'Search all recordings' 1468 281 12 '#78889d'
Text '16 date folders - 44 recordings' 50 320 12 '#75859b'

# Patient folders panel
Box 47 355 1554 472 '#ffffff' '#e0e7ef' 13
Text 'Patient recordings' 75 382 19 '#1b2f49' ([System.Drawing.FontStyle]::Bold)
Text 'Each patient recording is stored and reviewed independently under your account.' 75 412 14 '#7b899d'
Box 1364 385 208 43 '#ffffff' '#dce4ee' 8
Text 'Open recordings folder' 1383 397 15 '#51637a'

$counts = @(3,2,4,3,1,5,2,3,4,2,3,1,2,4,3,2)
$start = [datetime]'2026-11-02'
$cardWidth = 366
$cardHeight = 78
$gap = 12
for ($i = 0; $i -lt $counts.Count; $i++) {
  $column = $i % 4; $row = [math]::Floor($i / 4)
  $x = 73 + ($cardWidth + $gap) * $column
  $y = 455 + ($cardHeight + $gap) * $row
  Box $x $y $cardWidth $cardHeight '#fbfcfd' '#e0e7ef' 9
  $ix = $x + 22; $iy = $y + 25
  $folderPen = Pen '#159b70' 2
  $graphics.DrawLines($folderPen, [System.Drawing.PointF[]]@(
    [System.Drawing.PointF]::new($ix, $iy + 4), [System.Drawing.PointF]::new($ix, $iy + 1), [System.Drawing.PointF]::new($ix + 9, $iy + 1), [System.Drawing.PointF]::new($ix + 13, $iy + 5), [System.Drawing.PointF]::new($ix + 27, $iy + 5), [System.Drawing.PointF]::new($ix + 27, $iy + 22), [System.Drawing.PointF]::new($ix + 1, $iy + 22), [System.Drawing.PointF]::new($ix + 1, $iy + 4)
  )); $folderPen.Dispose()
  $date = $start.AddDays(-$i).ToString('yyyy-MM-dd')
  Text $date ($x + 64) ($y + 20) 14 '#233850' ([System.Drawing.FontStyle]::Bold)
  $label = if ($counts[$i] -eq 1) { '1 recording' } else { "$($counts[$i]) recordings" }
  Text $label ($x + 64) ($y + 43) 12 '#738299'
  $graphics.DrawLine((Pen '#8190a3' 1.4), ($x + $cardWidth - 25), ($y + 34), ($x + $cardWidth - 19), ($y + 40))
  $graphics.DrawLine((Pen '#8190a3' 1.4), ($x + $cardWidth - 19), ($y + 40), ($x + $cardWidth - 25), ($y + 46))
}

# Privacy note and footer
Text 'Your records are saved on this computer. Sign in to back them up to your account.' 50 850 12 '#78889d'
$graphics.FillRectangle((Brush '#ffffff'), 0, 892, $width, 49)
$graphics.DrawLine((Pen '#e4eaf1'), 0, 892, $width, 892)
Text 'MedilogiX' 47 909 11 '#8390a2' ([System.Drawing.FontStyle]::Bold)

$bitmap.Save((Join-Path $PSScriptRoot 'multiple-folder-layout.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose(); $bitmap.Dispose()
