<#
.SYNOPSIS
  Builds Vellum in release mode and assembles the portable distribution folder, laid out for
  version management (src-tauri/src/versions.rs):

    dist/Vellum/
      Vellum Game Launcher.exe     the starter (starter/): launches the active version
      active.json                  which version starts
      portable.flag                (only with -Portable)
      versions/<version>/
        Vellum Game Launcher.exe   the app
        plugins/providers|skins|modules/...   core plugins from plugins/, plus extras/ unless -NoExtras

  dist\Vellum gets every plugin from plugins/ and extras/. The release zip (-Zip) uses the same
  layout, so Vellum's Versions page installs a release straight from it, but holds only what is
  ready to ship: everything except the plugins named in -ZipWithout.

.EXAMPLE
  ./scripts/package-portable.ps1
  ./scripts/package-portable.ps1 -Portable -SkipBuild
  ./scripts/package-portable.ps1 -SkipBuild -Zip     # also writes the release zip
#>
param(
  # Also create portable.flag so the packaged copy keeps its data in ./data.
  [switch]$Portable,
  # Reuse the existing release binary instead of rebuilding.
  [switch]$SkipBuild,
  # Leave the extras out of dist\Vellum.
  [switch]$NoExtras,
  # Also write dist\Vellum-Game-Launcher-<version>-windows-x64.zip: the starter, the app and the
  # plugins ready to ship.
  [switch]$Zip,
  # Plugin folder names to leave out of the release zip (dist\Vellum keeps them). The default
  # leaves out what doesn't work yet (the GOG and Custom provider stubs, the module placeholders,
  # which wait for module hosting in Phase 6), the mock provider (a development tool) and the
  # showcase skins, which aren't distributed in releases.
  [string[]]$ZipWithout = @('gog', 'custom', 'mock', 'quick-launch', 'random-pick', 'frontier', 'ficsit', 'redline', 'calling-card')
)

$ErrorActionPreference = 'Stop'
# Through `powershell -File`, "a,b,c" arrives as one string; accept either form.
$ZipWithout = @($ZipWithout | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
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
function Copy-Plugins([string]$from, [string]$to, [string[]]$without = @()) {
  foreach ($kind in 'providers', 'skins', 'modules') {
    $src = Join-Path $from $kind
    $dest = Join-Path $to "plugins\$kind"
    New-Item -ItemType Directory -Force $dest | Out-Null
    if (-not (Test-Path $src)) { continue }
    Get-ChildItem $src -Directory |
      Where-Object { -not $_.Name.StartsWith('.') -and $without -notcontains $_.Name } |
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

  # The licences that cover the exe, and the notices for the third-party code built into it.
  $notices = Join-Path $repo 'dist\THIRD-PARTY-NOTICES.txt'
  node (Join-Path $repo 'scripts\third-party-notices.mjs') $notices
  if ($LASTEXITCODE -ne 0) { throw 'third-party-notices.mjs failed' }
  function Copy-Legal([string]$to) {
    foreach ($f in 'LICENSE', 'LICENSE-EXCEPTION.md', 'LICENSING.md', 'TRADEMARKS.md') { Copy-Item (Join-Path $repo $f) $to }
    Copy-Item $notices $to
  }

  # The starter: the small exe at the root that launches the active version (starter/).
  $starterTarget = Join-Path $baseTarget 'starter'
  $starter = Join-Path $starterTarget 'release\vellum-starter.exe'
  if (-not $SkipBuild -or -not (Test-Path $starter)) {
    $ErrorActionPreference = 'Continue'
    # The C runtime linked in, so the starter runs without the Visual C++ Redistributable.
    $savedFlags = $env:RUSTFLAGS
    $env:RUSTFLAGS = '-C target-feature=+crt-static'
    cargo build --release --manifest-path (Join-Path $repo 'starter\Cargo.toml') --target-dir $starterTarget
    $builtStarter = $LASTEXITCODE
    $env:RUSTFLAGS = $savedFlags
    if ($builtStarter) { throw "starter build failed ($builtStarter)" }
    $ErrorActionPreference = 'Stop'
  }

  $version = (Get-Content (Join-Path $repo 'src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json).version

  # The managed layout (src-tauri/src/versions.rs):
  #   Vellum/  starter exe, active.json, licences, [portable.flag]
  #   Vellum/versions/<version>/  the app exe, its plugins and licences
  function Write-Root([string]$to) {
    New-Item -ItemType Directory -Force $to | Out-Null
    Copy-Item $starter (Join-Path $to 'Vellum Game Launcher.exe')
    Copy-Legal $to
    if ($Portable) { New-Item -ItemType File -Force (Join-Path $to 'portable.flag') | Out-Null }
  }
  function Write-Version([string]$to, [bool]$withExtras, [string[]]$without = @()) {
    New-Item -ItemType Directory -Force $to | Out-Null
    Copy-Item $exe (Join-Path $to 'Vellum Game Launcher.exe')
    Copy-Legal $to
    Copy-Plugins (Join-Path $repo 'plugins') $to $without
    if ($withExtras) { Copy-Plugins (Join-Path $repo 'extras') $to $without }
  }
  function Write-Active([string]$root, [string]$previous) {
    $a = [ordered]@{ active = $version; previous = $(if ($previous -and $previous -ne $version) { $previous } else { $null }); trial = $false; failedStarts = 0; rolledBackFrom = $null }
    [IO.File]::WriteAllText((Join-Path $root 'active.json'), ($a | ConvertTo-Json))
  }

  # Refresh dist\Vellum in place. Other installed versions, the user's own plugins and a
  # portable data folder stay; the root files and this version's folder are replaced. (Emptying
  # rather than deleting, since an Explorer window open in it would make removal fail half-way.)
  New-Item -ItemType Directory -Force $out | Out-Null
  # A folder from before version management: its plugins/ held the packaged plugins, not the
  # user's own, so it goes too.
  $keep = if (Test-Path (Join-Path $out 'active.json')) { 'versions', 'plugins', 'data', 'portable.flag', 'active.json' } else { 'data', 'portable.flag' }
  Get-ChildItem $out -Force | Where-Object { $keep -notcontains $_.Name } | Remove-Item -Recurse -Force
  $previous = $null
  if (Test-Path (Join-Path $out 'active.json')) { $previous = (Get-Content (Join-Path $out 'active.json') -Raw | ConvertFrom-Json).active }
  $thisVersion = Join-Path $out "versions\$version"
  if (Test-Path $thisVersion) { Remove-Item $thisVersion -Recurse -Force }
  Write-Root $out
  Write-Version $thisVersion (-not $NoExtras)
  Write-Active $out $previous

  if ($Zip) {
    $stage = Join-Path $repo 'dist\.stage'
    if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
    # One zip: the starter and this version with the plugins ready to ship. Extract it anywhere
    # and run the starter; the updater takes Vellum/versions/<version>/ out of it.
    Write-Root (Join-Path $stage 'Vellum')
    Write-Version (Join-Path $stage "Vellum\versions\$version") $true $ZipWithout
    Write-Active (Join-Path $stage 'Vellum') $null
    $zipPath = Join-Path $repo "dist\Vellum-Game-Launcher-$version-windows-x64.zip"
    if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
    # Windows' tar writes standard zips (forward slashes); Compress-Archive in PowerShell 5.1
    # writes backslashes into entry names.
    tar.exe -a -c -f $zipPath -C $stage Vellum
    if ($LASTEXITCODE) { throw "zip failed ($LASTEXITCODE)" }
    Write-Host "Wrote $zipPath (without: $($ZipWithout -join ', '))"
    Remove-Item $stage -Recurse -Force
  }

  Write-Host "Packaged to $out"
  Get-ChildItem $out -Recurse -Directory | ForEach-Object { $_.FullName.Substring($out.Length + 1) } | Sort-Object
} finally {
  Pop-Location
}
