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
| Build the portable folder | `./scripts/package-portable.ps1` (add `-Portable` for `portable.flag`) |
| Developer mode for one run | `Vellum.exe --dev` |
| List plugins without a window | `Vellum.exe --print-plugins --out plugins.json` |
| Diagnostics report (structure only) | `Vellum.exe --diagnose --out report.json` |

## Layout

```
src-tauri/   Rust backend (plugin discovery, settings, platform layer, …)
shell/       Host UI (TypeScript + Lit), embedded in the exe; shell/harness is the skin dev harness
sdk/         Skin SDK, kit components, built-in views and sdk.css
plugins/     Shipped plugins, copied beside the exe
tests/       Fixtures, dev-only plugins (broken examples and test skins), e2e tests
spikes/      Phase 0 experiments (throwaway; results in docs/decisions.md)
scripts/     Packaging, the skin dev harness, mock art
```
