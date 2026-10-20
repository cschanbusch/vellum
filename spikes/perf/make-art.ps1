# Generates the perf spike's 120 test covers (1200x1800 plus 640 and 320 wide variants)
# into skin/art/. Deterministic: the same seed always produces the same images.
$ErrorActionPreference = 'Stop'
$root = Join-Path $PSScriptRoot 'skin\art'
foreach ($w in 'full', '640', '320') { New-Item -ItemType Directory -Force (Join-Path $root $w) | Out-Null }

Add-Type -AssemblyName System.Drawing
$enc = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object MimeType -eq 'image/jpeg'
$ep = New-Object System.Drawing.Imaging.EncoderParameters 1
$ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality, [long]90)
$rand = New-Object System.Random 42
$font = New-Object System.Drawing.Font 'Segoe UI', 110, ([System.Drawing.FontStyle]::Bold)

for ($i = 0; $i -lt 120; $i++) {
  $b = New-Object System.Drawing.Bitmap 1200, 1800
  $g = [System.Drawing.Graphics]::FromImage($b)
  $g.SmoothingMode = 'AntiAlias'
  $c1 = [System.Drawing.Color]::FromArgb($rand.Next(20, 200), $rand.Next(20, 200), $rand.Next(20, 200))
  $c2 = [System.Drawing.Color]::FromArgb($rand.Next(0, 80), $rand.Next(0, 80), $rand.Next(0, 80))
  $lg = New-Object System.Drawing.Drawing2D.LinearGradientBrush (New-Object System.Drawing.Rectangle 0, 0, 1200, 1800), $c1, $c2, 70.0
  $g.FillRectangle($lg, 0, 0, 1200, 1800)
  for ($k = 0; $k -lt 40; $k++) {
    $a = [System.Drawing.Color]::FromArgb($rand.Next(20, 90), $rand.Next(256), $rand.Next(256), $rand.Next(256))
    $s = $rand.Next(60, 500)
    $g.FillEllipse((New-Object System.Drawing.SolidBrush $a), $rand.Next(-200, 1200), $rand.Next(-200, 1800), $s, $s)
  }
  $g.DrawString(('{0:D3}' -f $i), $font, [System.Drawing.Brushes]::White, 80, 1450)
  $g.Dispose()

  $name = '{0:D3}.jpg' -f $i
  $b.Save((Join-Path $root "full\$name"), $enc, $ep)
  foreach ($w in 640, 320) {
    $h = [int]($w * 1.5)
    $r = New-Object System.Drawing.Bitmap $w, $h
    $rg = [System.Drawing.Graphics]::FromImage($r)
    $rg.InterpolationMode = 'HighQualityBicubic'
    $rg.DrawImage($b, 0, 0, $w, $h)
    $rg.Dispose()
    $r.Save((Join-Path $root "$w\$name"), $enc, $ep)
    $r.Dispose()
  }
  $b.Dispose()
}
Write-Host "Wrote 360 images to $root"
