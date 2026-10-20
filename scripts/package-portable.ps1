<#
.SYNOPSIS
  Builds Vellum in release mode and assembles the portable distribution folder:

    dist/Vellum/
      Vellum.exe
      plugins/providers|skins|modules/...
      portable.flag          (only with -Portable)

.EXAMPLE
  ./scripts/package-portable.ps1
  ./scripts/package-portable.ps1 -Portable -SkipBuild
#>
param(
  # Also create portable.flag so the packaged copy keeps its data in ./data.
  [switch]$Portable,
  # Reuse the existing release binary instead of rebuilding.
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$out = Join-Path $repo 'dist\Vellum'
$targetDir = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { Join-Path $repo 'src-tauri\target' }
$exe = Join-Path $targetDir 'release\vellum.exe'

# rustup installs cargo here; a terminal opened before the install may not have it on PATH yet.
$cargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
if ((Test-Path $cargoBin) -and -not ($env:Path -split ';' -contains $cargoBin)) { $env:Path = "$cargoBin;$env:Path" }

Push-Location $repo
try {
  if (-not $SkipBuild) {
    # Native tools log progress to stderr; in Windows PowerShell that must not count as failure.
    # Success is judged by exit codes instead.
    $ErrorActionPreference = 'Continue'
    if (-not (Test-Path (Join-Path $repo 'node_modules'))) { npm install --no-audit --no-fund; if ($LASTEXITCODE) { throw 'npm install failed' } }
    # Builds the shell (beforeBuildCommand) and the exe with the shell embedded; no installer.
    npx tauri build --no-bundle
    if ($LASTEXITCODE) { throw "tauri build failed ($LASTEXITCODE)" }
    # The mock provider's art is generated, not committed.
    if (-not (Test-Path (Join-Path $repo 'plugins\providers\mock\art'))) {
      cargo run --manifest-path src-tauri/Cargo.toml --release --example make_mock_art
      if ($LASTEXITCODE) { throw "mock art generation failed ($LASTEXITCODE)" }
    }
    $ErrorActionPreference = 'Stop'
  }
  if (-not (Test-Path $exe)) { throw "Release binary not found at $exe" }

  if (Test-Path $out) { Remove-Item $out -Recurse -Force }
  New-Item -ItemType Directory -Force $out | Out-Null
  Copy-Item $exe (Join-Path $out 'Vellum.exe')

  # Ship exactly the plugin types from the spec; anything else in plugins/ stays behind.
  foreach ($kind in 'providers', 'skins', 'modules') {
    $dest = Join-Path $out "plugins\$kind"
    New-Item -ItemType Directory -Force $dest | Out-Null
    Get-ChildItem (Join-Path $repo "plugins\$kind") -Directory |
      Where-Object { -not $_.Name.StartsWith('.') } |
      ForEach-Object { Copy-Item $_.FullName (Join-Path $dest $_.Name) -Recurse }
  }

  if ($Portable) { New-Item -ItemType File (Join-Path $out 'portable.flag') | Out-Null }

  Write-Host "Packaged to $out"
  Get-ChildItem $out -Recurse -Directory | ForEach-Object { $_.FullName.Substring($out.Length + 1) } | Sort-Object
} finally {
  Pop-Location
}
