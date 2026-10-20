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
| Front-end tests | `npm test` |
| Type-check the SDK and shell | `npm run typecheck` |
| Build the SDK and shell only | `npm run build:web` |
| Build the portable folder | `./scripts/package-portable.ps1` (add `-Portable` for `portable.flag`) |
| List plugins without a window | `Vellum.exe --print-plugins --out plugins.json` |
| Diagnostics report (structure only) | `Vellum.exe --diagnose --out report.json` |

## Layout

```
src-tauri/   Rust backend (plugin discovery, settings, platform layer, …)
shell/       Host UI (TypeScript + Lit), embedded in the exe
sdk/         Skin SDK, kit components and built-in views (Phase 2–3)
plugins/     Shipped plugins, copied beside the exe
tests/       Fixtures, including deliberately broken dev-only plugins
spikes/      Phase 0 experiments (throwaway; results in docs/decisions.md)
scripts/     Packaging
```
