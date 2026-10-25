# Vellum roadmap

Where Vellum is, and the design for what comes next. The full specification is
[vellum_design_overview.md](vellum_design_overview.md); this file follows its milestones in the
revised order the build has used (rationale in [docs/decisions.md](docs/decisions.md)). Designs for
upcoming phases are the current concepts: they change as each phase is built and checked against
real store installs.

## At a glance

| Phase | Scope | State |
| --- | --- | --- |
| 0 | Architecture spikes (origins, IPC, QuickJS) | Done |
| 1 | Foundation: plugins, settings, portable mode, packaging | Done |
| 2 | Provider host, Steam, library, diagnostics | Done |
| 3 | Skin system, SDK, views, input model, local art | Done |
| 4 | Remote art and metadata | Done (0.4.0) |
| 5 | GOG and Custom providers, merging games across stores, provider authoring guide | Planned (Epic, pulled forward, is done) |
| 6 | Controllers, couch mode, modules, plugin install | Partly done |
| 7 | Further stores | Planned |
| — | Release engineering | Ongoing |

## Done

**Phases 0–3** give a complete launcher for installed games:

- Plugin discovery and manifest validation, enabled state, settings, portable mode, logging.
- The QuickJS provider host with a scoped `ctx` API, location detection and the locate prompt,
  and `--diagnose`, a structure-only report for checking store formats on real installs.
- Providers for Steam and Epic (Epic pulled forward from Phase 5), with local store metadata
  (Steam `appinfo.vdf`, Epic's catalogue cache) and Steam playtime. GOG and Custom are still
  placeholders.
- The library model (entries with `sources[]` from day one, so merging needs no refactor),
  search, filters, sorting, groups, favorites and tags.
- The skin system: the `skin` protocol and CSP, the SDK, kit components, tokens, options, the
  `nav` input model with spatial focus, developer mode with hot reload, and the browser dev harness.
- Built-in List, Covers (with shelves) and Spotlight views; skin views with placement and hotkeys.
- Local art: provider candidates, resizing and caching, placeholders, and art styles (sketch and
  watercolor) drawn by the backend.
- Eight skins, including two with views of their own: Frontier's Catalogue (a paged book) and
  Grand Tour's Garage (3D cases built per game at runtime).
- Window placement restored between runs.
- Version management: Settings → Versions installs GitHub releases side by side, switches between
  them and rolls back a version that won't start (released in 0.2.0).

## Phase 4: remote art and metadata (released in 0.4.0)

**Goal:** every entry has all five art kinds (cover, hero, logo, header, icon) at full resolution,
and what is cached keeps working offline.

**Design:**

- **Resolution order**, first hit wins per entry and kind:
  1. the user's override (a local file, or a SteamGridDB image they chose);
  2. provider candidates (the preferred source first; Steam's custom grid art beats its defaults);
  3. the Steam CDN for entries with a Steam source (library capsule, hero, logo, header);
  4. SteamGridDB, only with the user's own free API key: by Steam appid where there is one,
     otherwise by title, taking the top-rated image of the right dimensions;
  5. a generated placeholder (already built).
- **Downloads** happen only in the backend: at most 4 at once, a 10-second timeout, a 7-day
  negative cache for misses. Originals are cached by a hash of their source; resized variants are
  made on demand. Skins keep using `/__vellum/art/...` on their own origin and never touch the
  network.
- **Change art…** in each entry's context menu: every candidate from every source and
  SteamGridDB per kind, plus **Choose file**. A choice is stored as an override.
- **Steam store metadata** (`appdetails`): developer, publisher, release date, genres and a short
  description. One request every 1.5 s, cached for 30 days, never blocking the UI, and switchable
  off in settings. Provider metadata wins over fetched metadata.
- **Privacy:** both network features are explained in settings; SteamGridDB stays off until a key
  is entered.
- **Cache timing is configurable** in Settings → Art & metadata:
  - "Retry missing art after": 1 day, 7 days (default), 30 days or never, with a **Retry missing
    art now** button that clears the negative cache.
  - "Refresh Steam game details every": 7 days, 30 days (default), 90 days or never, with a
    **Refresh details now** button (still throttled to one request every 1.5 s).
  - Expired details stay in place until a refresh succeeds, so the library still looks complete
    offline. Downloaded art never expires: it is cached by a hash of its source.

**Done when:** every entry shows all five kinds, custom Steam grid art takes precedence, and the
library still looks complete with the network unplugged.

## Phase 5: GOG, custom games, merging and the provider guide

**Goal:** GOG and hand-added games join the library, and a game installed from two stores shows
once and launches through the store you prefer.

**Design:**

- **GOG provider:** installed games from GOG Galaxy's local data (and standalone GOG installers'
  registry entries), launched through Galaxy. Its provider is a placeholder today.
- **Custom games:** add any exe or shortcut by hand, with its own art and arguments. Also a
  placeholder today.

- **Automatic merging** joins two records of the same kind from different providers when their
  normalized titles match exactly (case-folded; ™, ®, © and punctuation removed; whitespace
  collapsed). Words such as "Edition" or "Remastered" are kept: a false merge is worse than a
  missed one. A setting turns automatic merging off.
- **Manual Merge and Unmerge** are stored as overrides and always beat automatic matching.
- **Preferred source** comes from an orderable provider priority list (default Steam, GOG, Epic,
  Custom), with a per-entry override and **Play via…** for the other stores.
- **Entry identity:** because an entry's id is its primary record's id, changing the preferred
  source changes the id. Selection, shelf order, favorites, tags and skin storage must follow the
  merge group; settle the rule in `docs/decisions.md` before building.
- **Source badges and filters** in every view; disabling a provider hides its games and
  re-enabling it restores their favorites and tags.
- **`docs/provider-authoring.md`**: the manifest, the `ctx` API, location resolution and the
  `--diagnose` workflow, using the shipped providers as examples.

**Done when:** a game installed on two stores shows once and launches through the preferred
store, and disabling then re-enabling a provider loses nothing.

## Phase 6: controllers, couch mode, modules and plugin install

**Goal:** every function, including settings, is reachable with a controller alone; plugins can be
installed and shared as files.

**Already done:** the `nav` event model and spatial focus, and couch presentation (F11,
couch-only views, `--v-couch-scale`). The Quick Launch and Random Pick modules exist only as
manifests: Vellum doesn't host module overlays yet.

**Design for the rest:**

- **Controller polling** in the shell with the Gamepad API (standard mapping) every animation
  frame, with key repeat (400 ms delay, 80 ms interval) feeding the existing `nav` stream:
  D-pad and left stick move, A confirms, B goes back, X favorites, Y searches, LB/RB switch views,
  LT/RT page, Menu opens the context menu, View opens settings.
- **On-screen keyboard** (`<vellum-osk>`, themed by tokens) for search in couch mode.
- **Couch mode options:** start in couch mode, enter it when a controller connects, hide the cursor
  after 3 s, and what to do when a game launches (nothing, minimize, or close to tray).
- **SDK additions** asked for by skins: raw analog stick and button state
  (`vellum.input.on("gamepad")`), for example to turn Grand Tour's case with the right stick; and
  skin-declared commands in the manifest, listed and rebindable in Settings → Controls like
  module commands.
- **Global hotkeys** for module commands (off until the user turns them on).
- **`.vplugin` packages:** export any plugin as one file and install it with a permissions prompt
  showing what it declares (locations, network, commands).
- **All settings pages** finished and controller-navigable; `docs/module-authoring.md`.

**Done when:** a controller alone reaches everything, and a provider exported as `.vplugin` works
on a clean copy after re-running location detection.

## Phase 7: further stores

Each store is its own plugin, checked with `--diagnose` on a real install before it is written.

| Store | Installed games | Launch | Confidence |
| --- | --- | --- | --- |
| Ubisoft Connect | Registry install entries plus uninstall entries for titles | `uplay://launch/<id>/0` | Medium |
| Battle.net | `product.db` (protobuf) under ProgramData | `Battle.net.exe --exec="launch <code>"` | Medium |
| EA app | Registry and per-game install data (format to verify) | EA's URI scheme (to verify) | Low |
| Xbox / Microsoft Store | Needs a new host API to list installed app packages | `shell:AppsFolder\<AUMID>` | Medium |

Emulators (a PCSX2 provider listing a ROM folder, for example) fit the same model; Grand Tour
already has a case style ready for PCSX2 games.

## Skins and views

Skins are written against the SDK and the authoring guide alone, which keeps testing the skin
system itself. Concepts on the list:

- **Grand Tour's cases in every view:** a light CSS 3D case (the same printed wraps, with baked
  edge lighting) for Covers and spine-out shelves, the WebGL case in Spotlight, and a slowly
  scrolling "Case wall" view. The Garage already uses the WebGL case.
- More fan-made and original skins, written by people other than the core developer, using only
  the authoring guide and the dev harness.

## Release engineering

- **0.2.0** (released): licensing, this README and roadmap, version management, and a single
  release zip with only what works.
- **0.2.1** (released): the skin catalog (Settings → Get skins).
- **0.2.2** (released): rescans that find nothing new no longer redraw the views; updating the
  skin in use from Get skins loads the new version at once. Development continues on `main`.
- **0.3.0** (released): adaptive MIDI music for skins (`vellum.music`: scenes per view that change
  on the beat or bar and pick up where the music is, SoundFonts, a Music volume, music only while
  Vellum has focus), the new app icon, typing no longer jumping into search, and a start-up
  recommendation for Grand Tour.
- **0.4.0** (released): Phase 4. Art from Steam's image servers and SteamGridDB, the Change
  art dialog, Steam store details, Settings → Art and metadata with configurable retry and
  refresh periods, and skin items in the game menu (`vellum.ui.contextMenu(…, items)`).
- **Next:** a changelog.
- **Continuous integration:** run the Rust, unit and end-to-end tests and build the release zips on
  each push to `main`.
- **Later:** code signing, so SmartScreen stops warning; an installer and auto-update remain out of
  scope until the feature set settles.

## Out of scope (for now)

Logging in to any store, showing owned-but-uninstalled games, writing to any store's files,
store browsing, achievements, friends and download progress, game process monitoring, and macOS or
Linux builds.
