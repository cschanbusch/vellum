# Vellum

A Windows game launcher where store providers, skins and QoL modules are all plugins. The full specification is in [vellum_design_overview.md](vellum_design_overview.md); choices made while building it are in [docs/decisions.md](docs/decisions.md).

## Prerequisites

- Rust (stable, via rustup) and the Visual Studio C++ Build Tools ("Desktop development with C++")
- Node.js 20+ and npm
- WebView2 runtime (preinstalled on Windows 11)

## Commands

| Task | Command |
| --- | --- |
| Install JS dependencies | `npm install` |
| Run the app with hot reload | `npm run dev` |
| Rust tests | `cargo test --manifest-path src-tauri/Cargo.toml` |
| Front-end unit tests | `npm test` |
| End-to-end tests (Playwright, no Rust needed) | `npx playwright install chromium` once, then `npm run test:e2e` |
| Skin dev harness | `npm run dev:skin -- <skin folder>` (see [docs/skin-authoring.md](docs/skin-authoring.md)) |
| Generate mock art (once) | `npm run mock-art` |
| Type-check the SDK and shell | `npm run typecheck` |
| Build the SDK and shell only | `npm run build:web` |
| Build the portable folder | `./scripts/package-portable.ps1` (add `-Portable` for `portable.flag`, `-NoExtras` to leave out the extras, `-Zip` for the core and extras release zips) |
| Developer mode for one run | `"Vellum Game Launcher.exe" --dev` |
| List plugins without a window | `"Vellum Game Launcher.exe" --print-plugins --out plugins.json` |
| Diagnostics report (structure only) | `"Vellum Game Launcher.exe" --diagnose --out report.json` |

## Core and extras

A release has two downloads. `Vellum-Game-Launcher-<version>-windows-x64.zip` is the launcher with the core plugins: the Steam, Epic, GOG and custom-games providers and the default Basis skin. `Vellum-Game-Launcher-<version>-extras.zip` is optional and holds everything else: the other skins (Synthwave, Frutiger Aero, Gridline, Calling Card, FICSIT Terminal, Frontier, Grand Tourer), the Quick Launch and Random Pick modules, and the mock provider for skin development. Extract it into the same place as the launcher zip and it merges into `Vellum/plugins/`. To drop a single extra later, delete its folder from `plugins/`.

In the repository, debug builds load both `plugins/` and `extras/`.

## Layout

```
src-tauri/   Rust backend (plugin discovery, settings, platform layer, …)
shell/       Host UI (TypeScript + Lit), embedded in the exe; shell/harness is the skin dev harness
sdk/         Skin SDK, kit components, built-in views and sdk.css
plugins/     Core plugins (store providers, the default Basis skin), copied beside the exe
extras/      Optional plugins (the other skins, QoL modules, the mock provider); same layout as plugins/
tests/       Fixtures, dev-only plugins (broken examples and test skins), e2e tests
spikes/      Phase 0 experiments (throwaway; results in docs/decisions.md)
scripts/     Packaging, the skin dev harness, mock art
```
