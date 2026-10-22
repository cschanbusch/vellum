# Vellum Game Launcher

One library for the games you have installed from Steam and the Epic Games Launcher (GOG and
games you add yourself are next), in a launcher whose whole look is a plugin you can swap, edit or
write from scratch.

Vellum never replaces a store: every game launches through its own store's client, so DRM,
anti-cheat, cloud saves and overlays behave exactly as they normally do. It reads the stores' local
files to find your games and never writes to them, logs in to anything, or sends your library
anywhere.

> **Status: pre-release (0.x).** Vellum is in active development and used daily on Windows 11, but
> it is not feature-complete. See [ROADMAP.md](ROADMAP.md) for what is done and what comes next.

## What it does today

- **One library across stores.** Installed games from Steam (every library folder, every account
  on the PC, collections, demos and soundtracks told apart) and the Epic Games Launcher. Store
  metadata (developer, genres, release date) and Steam playtime are read from the stores' local
  caches. GOG Galaxy and custom entries are planned; their providers are placeholders for now.
- **Launch through the store.** Play (and, where the store supports them, its own actions such as
  properties or uninstall) is handed to the store's client. Vellum records when you last launched each game.
- **Skins change everything visual.** A skin is a folder of plain HTML, CSS and JavaScript: layout,
  typography, how art is used, animation, sound, even the window frame. No rebuild of the app is
  needed, and a dev harness runs a skin in a browser with a mock library.
- **Views.** Three built-in views (List, Covers with collapsible shelves, Spotlight) that every skin
  restyles, plus views that skins add themselves.
- **Art.** Covers, hero banners, logos, headers and icons from the stores' local caches, resized
  and cached, with generated placeholders where a store has none. Skins can ask for art redrawn as
  a pencil sketch or a watercolor.
- **Keyboard first.** Every view is driven by spatial keyboard navigation through the same input
  model a controller will use (see the roadmap: controller polling is not wired up yet).
- **Portable.** The launcher is a folder. Drop a `portable.flag` beside the exe and all settings
  and caches live in `data\` next to it.
- **Remembers itself.** The window reopens where you left it, at the same size and state.

### Shipped skins

| Skin | Style |
| --- | --- |
| Basis (core) | The default: List, Covers and Spotlight on the SDK's own layout; the reference for skin authors |
| Synthwave | Neon sunset, chrome type and an endless moving grid |
| Frutiger Aero | Glossy glass, sky, grass and drifting bubbles |
| Gridline | Neon red on black: light cycles, angled panels and glowing edges |
| Calling Card | Red, black and white menus with ransom-note type (fan-made, in the style of Persona 5) |
| FICSIT Terminal | An industrial library terminal (fan-made, in the style of Satisfactory) |
| Frontier | Smoke, brush strokes and wood type (fan-made, in the style of Red Dead Redemption 2), with a Catalogue view: the library as a mail-order book you page through |
| Grand Tour | An early-2000s racing showroom: a Garage view where every game gets a 3D case on a turntable, with wear and tear, a pit-service minigame and synthesized engine sounds |

The fan-made skins use no original game assets. Basis, Synthwave, Frutiger Aero and Gridline ship
with the launcher. The showcase skins (Calling Card, FICSIT Terminal, Frontier and Grand Tour) are
published separately in [vellum-skins](https://github.com/cschanbusch/vellum-skins): from Vellum
0.2.1, download them in Settings → **Get skins** (or by hand from that repository's releases).
Their source is in this repository under their own licence (see [LICENSING.md](LICENSING.md)).

## Install

Vellum needs no installer and no admin rights.

1. Download `Vellum-Game-Launcher-<version>-windows-x64.zip` from the
   [Releases](../../releases) page.
2. **Before extracting,** right-click the zip → **Properties** → tick **Unblock** → **OK**. Vellum
   isn't code-signed yet, and this stops Windows SmartScreen from warning about it. (If you skip
   it and see "Windows protected your PC", choose **More info → Run anyway**.)
3. Extract the zip to a folder you own, such as `Documents\Vellum` or `D:\Games\Vellum`.
   **Not `Program Files`:** Vellum installs updates into its own folder, which Program Files
   doesn't allow without admin rights.
4. Run **`Vellum Game Launcher.exe`** in the top of the extracted `Vellum` folder (the app itself
   lives in `versions\<version>\`; always start it from the top). Steam and Epic are found
   automatically; if a store is installed somewhere unusual, Vellum asks you to point at it.

**Requirements:** Windows 10 or 11 (64-bit) and Microsoft's WebView2 runtime, which Windows 11
includes and nearly every Windows 10 PC already has through Edge. If it's missing, Vellum says so
and offers Microsoft's download page.

**Updating:** Settings → **Versions** lists the releases on GitHub. Download one, then **Switch
to** it; Vellum restarts into it, keeps the previous version to fall back to, and goes back to it
by itself if the new one fails to start. Old versions can be removed there too. To update by
hand instead, extract a newer release's zip over your Vellum folder.

**Your data:** settings and the library cache live in `%APPDATA%\Vellum`. Put an empty file
named `portable.flag` beside `Vellum Game Launcher.exe` to keep everything in a `data` folder
there instead, so the whole folder can move to another PC.

**Uninstalling:** delete the Vellum folder, and `%APPDATA%\Vellum` unless you used
`portable.flag`. Vellum writes nothing to the registry or the Start menu.

## How it is built

Vellum is a [Tauri 2](https://tauri.app) app: a Rust backend and a TypeScript (Lit) shell rendered
by WebView2, compiled into one exe. Everything else is a plugin folder beside it:

| Plugin type | What it is | Isolation |
| --- | --- | --- |
| **Providers** | Find a store's installed games and launch them. Plain JavaScript run in an embedded QuickJS sandbox, with a small host API scoped to the store's own folders. | No network, no file access outside declared locations |
| **Skins** | The entire visual layer: HTML, CSS and JS, using the Vellum SDK and its kit of components. | A sandboxed iframe on its own origin with a strict CSP; talks to the shell only through the SDK |
| **Modules** | Small quality-of-life features (Quick Launch, Random Pick; hosting them arrives in Phase 6). | Sandboxed like skins, with declared permissions |

Providers know nothing about skins, and skins know nothing about stores: a skin sees one merged
library with art URLs on its own origin. The full specification is
[vellum_design_overview.md](vellum_design_overview.md); choices made while building it are in
[docs/decisions.md](docs/decisions.md), and skin authors start with
[docs/skin-authoring.md](docs/skin-authoring.md).

### Current design state

| Area | State |
| --- | --- |
| Plugin discovery, manifests, settings, portable mode, logging | Done |
| Provider host (QuickJS), location detection and prompts, `--diagnose` | Done |
| Steam and Epic providers | Done (installed games; local metadata; Steam playtime) |
| GOG and custom-games providers | Planned (Phase 5; placeholders for now) |
| Modules (Quick Launch, Random Pick) | Planned (Phase 6; placeholders for now) |
| Version management from GitHub releases | Done |
| Skin catalog (Settings → Get skins, from `vellum-skins`) | Done (0.2.1, unreleased) |
| Library model, search, filters, sorting, groups, favorites, tags | Done |
| Skin system: protocol, CSP, SDK, kit components, tokens, options, dev mode, hot reload | Done |
| Views: List, Covers (shelves), Spotlight, and skin-defined views with placement and hotkeys | Done |
| Art pipeline: local candidates, resizing, caching, placeholders, art styles | Done (local sources only) |
| Remote art (Steam CDN, SteamGridDB), Change art dialog | Planned (Phase 4) |
| Merging one game owned on several stores | Planned (Phase 5) |
| Controller input, couch mode polish, `.vplugin` install, global hotkeys | Partly done (Phase 6) |
| Further stores (Ubisoft Connect, Battle.net, EA app, Xbox) | Planned (Phase 7) |

## Developing

### Prerequisites

- Rust (stable, via rustup) and the Visual Studio C++ Build Tools ("Desktop development with C++")
- Node.js 20+ and npm
- WebView2 runtime (preinstalled on Windows 11)

### Commands

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
| Rebuild Grand Tour's bundled three.js | `node scripts/vendor-three.mjs` |
| Publish the showcase skins to the catalog | `node scripts/publish-skins.mjs` (bump a skin's version to publish a change; `--dry-run` builds the zips only) |
| Build the portable folder | `./scripts/package-portable.ps1` (add `-Portable` for `portable.flag`, `-NoExtras` to leave out the extras, `-Zip` for the release zip) |
| Developer mode for one run | `"Vellum Game Launcher.exe" --dev` |
| List plugins without a window | `"Vellum Game Launcher.exe" --print-plugins --out plugins.json` |
| Diagnostics report (structure only) | `"Vellum Game Launcher.exe" --diagnose --out report.json` |

The end-to-end tests run in two Playwright projects: Grand Tour's (which draw its cases in WebGL)
on the GPU, everything else on Chromium's software renderer, which the performance budgets were
measured on.

### Plugins and the release download

`plugins/` holds the core plugins and `extras/` the optional ones; debug builds load both, and
`dist\Vellum` gets them all. The release download, `Vellum-Game-Launcher-<version>-windows-x64.zip`,
holds only what's ready to ship: the Steam and Epic providers and the Basis, Synthwave, Frutiger
Aero and Gridline skins. `package-portable.ps1 -Zip` leaves out the placeholder plugins (GOG,
Custom, both modules), the mock provider and the showcase skins; `-ZipWithout <names>` changes the
list.

### Layout

```
src-tauri/   Rust backend (plugin discovery, settings, provider host, library, art, platform layer)
shell/       Host UI (TypeScript + Lit), embedded in the exe; shell/harness is the skin dev harness
sdk/         Skin SDK, kit components, built-in views and sdk.css
plugins/     Core plugins (store providers, the default Basis skin), copied beside the exe
extras/      Optional plugins (the other skins, QoL modules, the mock provider); same layout as plugins/
tests/       Fixtures, dev-only plugins (broken examples and test skins), e2e tests
spikes/      Phase 0 experiments (throwaway; results in docs/decisions.md)
scripts/     Packaging, the skin dev harness, mock art, vendoring
docs/        Decisions log, skin authoring guide, open issues
```

## Licence

Vellum is made of parts under different licences; [LICENSING.md](LICENSING.md) has the full map.

- **The launcher** is free software under [GPL-3.0-only](LICENSE), with a
  [plugin exception](LICENSE-EXCEPTION.md): plugins may use any licence, including paid ones.
  Closed-source or paid redistribution of Vellum itself needs a commercial licence.
- **The SDK and the default skins** (Basis, Synthwave, Gridline, Frutiger Aero) are under
  Apache-2.0: free for anything, including starting your own skin, as long as you keep their
  NOTICE ("Based on the default skins of Vellum Game Launcher").
- **The store providers and the modules** are under MIT-0: completely free, no conditions.
- **The showcase skins** (FICSIT Terminal, Calling Card, Frontier, Grand Tour) are
  source-available under PolyForm Strict: use them, learn from them and change them for yourself,
  but ask before redistributing them.
- **The name:** forks may call themselves Vellum with a qualifier; see [TRADEMARKS.md](TRADEMARKS.md).

Contributions are welcome under the terms in [CONTRIBUTING.md](CONTRIBUTING.md). For permissions
and commercial licences, contact Charles Schanbusch: charlieschanbusch@gmail.com, or
@orcinusprime on Discord.
