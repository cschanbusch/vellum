<#
.SYNOPSIS
  Builds Vellum in release mode and assembles the portable distribution folder:

    dist/Vellum/
      Vellum Game Launcher.exe
      plugins/providers|skins|modules/...   core plugins from plugins/, plus extras/ unless -NoExtras
      portable.flag          (only with -Portable)

  Core plugins are what the launcher needs on its own (the store providers and the default skin).
  Extras are optional: the other skins, the QoL modules and the mock provider. They install into
  the same plugins folder, so the extras zip is extracted over the main one.

.EXAMPLE
  ./scripts/package-portable.ps1
  ./scripts/package-portable.ps1 -Portable -SkipBuild
  ./scripts/package-portable.ps1 -SkipBuild -Zip     # also writes the two release zips
#>
param(
  # Also create portable.flag so the packaged copy keeps its data in ./data.
  [switch]$Portable,
  # Reuse the existing release binary instead of rebuilding.
  [switch]$SkipBuild,
  # Leave the extras out of dist\Vellum.
  [switch]$NoExtras,
  # Also write dist\Vellum-Game-Launcher-<version>-windows-x64.zip (exe and core plugins) and
  # dist\Vellum-Game-Launcher-<version>-extras.zip (extras only, laid out to extract over it).
  [switch]$Zip
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$out = Join-Path $repo 'dist\Vellum'
# Packaging builds into a target folder of its own. `cargo test --release` and
# `cargo run --release --example ...` rebuild target\release\vellum.exe *without* the embedded
# interface: a dev binary that loads http://localhost:1420 and shows a blank window. They never
# touch this folder, so -SkipBuild can only ever reuse a real `tauri build`.
$baseTarget = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { Join-Path $repo 'src-tauri\target' }
$targetDir = Join-Path $baseTarget 'package'
$exe = Join-Path $targetDir 'release\vellum.exe'

# rustup installs cargo here; a terminal opened before the install may not have it on PATH yet.
$cargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
if ((Test-Path $cargoBin) -and -not ($env:Path -split ';' -contains $cargoBin)) { $env:Path = "$cargoBin;$env:Path" }

# Ship exactly the plugin types from the spec; anything else in plugins/ or extras/ stays behind.
function Copy-Plugins([string]$from, [string]$to) {
  foreach ($kind in 'providers', 'skins', 'modules') {
    $src = Join-Path $from $kind
    $dest = Join-Path $to "plugins\$kind"
    New-Item -ItemType Directory -Force $dest | Out-Null
    if (-not (Test-Path $src)) { continue }
    Get-ChildItem $src -Directory |
      Where-Object { -not $_.Name.StartsWith('.') } |
      ForEach-Object { Copy-Item $_.FullName (Join-Path $dest $_.Name) -Recurse }
  }
}

Push-Location $repo
try {
  if (-not $SkipBuild) {
    # Native tools log progress to stderr; in Windows PowerShell that must not count as failure.
    # Success is judged by exit codes instead.
    $ErrorActionPreference = 'Continue'
    if (-not (Test-Path (Join-Path $repo 'node_modules'))) { npm install --no-audit --no-fund; if ($LASTEXITCODE) { throw 'npm install failed' } }
    # Builds the shell (beforeBuildCommand) and the exe with the shell embedded; no installer.
    $savedTarget = $env:CARGO_TARGET_DIR
    $env:CARGO_TARGET_DIR = $targetDir
    npx tauri build --no-bundle
    $built = $LASTEXITCODE
    $env:CARGO_TARGET_DIR = $savedTarget
    if ($built) { throw "tauri build failed ($built)" }
    $ErrorActionPreference = 'Stop'
  }
  if (-not $SkipBuild -or $Zip) {
    # The mock provider's art is generated, not committed.
    if (-not (Test-Path (Join-Path $repo 'extras\providers\mock\art'))) {
      $ErrorActionPreference = 'Continue'
      cargo run --manifest-path src-tauri/Cargo.toml --release --example make_mock_art
      if ($LASTEXITCODE) { throw "mock art generation failed ($LASTEXITCODE)" }
      $ErrorActionPreference = 'Stop'
    }
  }
  if (-not (Test-Path $exe)) { throw "Release binary not found at $exe" }

  # Empty the folder rather than deleting it: an Explorer window or terminal open in
  # dist\Vellum holds the folder itself and would make removing it fail half-way.
  New-Item -ItemType Directory -Force $out | Out-Null
  Get-ChildItem $out -Force | Remove-Item -Recurse -Force
  Copy-Item $exe (Join-Path $out 'Vellum Game Launcher.exe')

  Copy-Plugins (Join-Path $repo 'plugins') $out
  if (-not $NoExtras) { Copy-Plugins (Join-Path $repo 'extras') $out }

  if ($Portable) { New-Item -ItemType File (Join-Path $out 'portable.flag') | Out-Null }

  if ($Zip) {
    $version = (Get-Content (Join-Path $repo 'src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json).version
    $stage = Join-Path $repo 'dist\.stage'
    if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
    # Core: the exe and the core plugins, in a Vellum folder.
    $core = Join-Path $stage 'core\Vellum'
    New-Item -ItemType Directory -Force $core | Out-Null
    Copy-Item $exe (Join-Path $core 'Vellum Game Launcher.exe')
    if ($Portable) { New-Item -ItemType File (Join-Path $core 'portable.flag') | Out-Null }
    Copy-Plugins (Join-Path $repo 'plugins') $core
    # Extras: the same Vellum\plugins\... layout, so extracting it where the core zip went merges them.
    Copy-Plugins (Join-Path $repo 'extras') (Join-Path $stage 'extras\Vellum')
    $zips = [ordered]@{ core = "Vellum-Game-Launcher-$version-windows-x64.zip"; extras = "Vellum-Game-Launcher-$version-extras.zip" }
    foreach ($part in $zips.Keys) {
      $zipPath = Join-Path $repo "dist\$($zips[$part])"
      if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
      Compress-Archive -Path (Join-Path $stage "$part\Vellum") -DestinationPath $zipPath
      Write-Host "Wrote $zipPath"
    }
    Remove-Item $stage -Recurse -Force
  }

  Write-Host "Packaged to $out"
  Get-ChildItem $out -Recurse -Directory | ForEach-Object { $_.FullName.Substring($out.Length + 1) } | Sort-Object
} finally {
  Pop-Location
}
