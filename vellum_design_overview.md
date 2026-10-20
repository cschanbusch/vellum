# Vellum — Game Launcher Design Overview

Oct 19, 2026 · @Charles

## Purpose and scope

Vellum is a Windows game launcher that shows installed games from Steam, Epic, GOG and other stores in one library, and hands every launch back to the store's own client. Its defining feature is that nearly everything is a plugin: store providers, skins (the entire visual layer) and QoL modules can each be added, disabled or copied to another PC as self-contained folders.

Goals:

- One library of installed games across stores, launched through each store's client so DRM and anti-cheat behave normally.
- Skins that can change everything visual: layout, typography, art usage, animation, even the window frame. A new skin is pure HTML/CSS/JS and needs no rebuild of the app.
- High-resolution art everywhere (portrait covers, 4K hero banners, transparent logos), with a consistent look across stores.
- Three built-in views (List, Covers with shelves, Spotlight) plus views that skins add themselves.
- Couch mode with full controller navigation.
- Strict separation: providers know nothing about skins, skins know nothing about stores.

How to use this doc: it is the specification for an agent building the program independently. Build in the milestone order in the Milestones section and meet each milestone's acceptance criteria before moving on. Store file formats described here reflect how the stores have historically worked; they are undocumented and may have changed, so treat them as starting points and confirm them with the diagnostics tool (Testing section). Where this doc is silent, choose the simplest option consistent with the goals and record the choice in `docs/decisions.md`.

"Vellum" is a working name; keep it in one constant so it is easy to rename.

## Technology and build output

Build with **Tauri 2**: a Rust backend plus a TypeScript web UI rendered by Microsoft WebView2. Tauri compiles the backend and embeds all core UI assets into a single `Vellum.exe`, so every core script lives inside the exe while plugins stay as editable folders beside it.

| Layer | Choice | Notes |
| --- | --- | --- |
| Backend | Rust (stable), Tauri 2.x | Library engine, plugin host, file access, art pipeline, custom protocols |
| Provider scripting | Embedded QuickJS via the `rquickjs` crate | Runs provider plugins in a sandbox with a limited host API |
| Core UI | TypeScript, Vite, Lit web components | Shell, skin SDK, built-in views; embedded in the exe at build time |
| Skins | Plain HTML/CSS/JS in plugin folders | May bundle any library they like; no build step required |
| Rendering | WebView2 (Chromium-based) | Preinstalled on Windows 11; Windows 10 may need the Evergreen runtime |

Suggested crates (confirm current versions): `tauri`, `tauri-plugin-dialog` (folder picker), `tauri-plugin-global-shortcut`, `tauri-plugin-single-instance`, `serde`, `serde_json`, `rquickjs`, `rusqlite` with the `bundled` feature, `winreg`, `notify` (file watching), `image` (resizing), `reqwest` with rustls, `zip`, `dirs`, `tokio`, `thiserror`, `tracing`.

Rejected alternatives: Electron would keep core scripts in an `app.asar` beside the exe and costs roughly 150 MB of memory; native WPF or WinUI would make skins far harder to write, since skins need web technology anyway.

### Distribution layout

The finished program is a folder. Do not build an installer or final exe yet, but keep this layout working from the first milestone:

```
Vellum/
  Vellum.exe            core: backend + shell + SDK + built-in views
  plugins/
    providers/          steam/, epic/, gog/, custom/, mock/
    skins/              basis/ (default skin)
    modules/            quick-launch/, random-pick/
  portable.flag         optional: store user data in ./data instead of %APPDATA%
```

Provide `scripts/package-portable.ps1`, which runs the release build and assembles exactly this folder in `dist/Vellum/`. The release build alone (`cargo tauri build` with bundling disabled, or the binary from `target/release`) must be enough to produce `Vellum.exe`.

### Developing off Windows

The agent may be working on Linux or macOS. Put every Windows-only call (registry, `%ProgramData%` paths, launching URIs) behind a `platform` module that returns empty results elsewhere, and rely on the mock provider and file fixtures to exercise everything else.

## Architecture overview

The shell is the only part of the UI that can talk to the backend; skins and modules are sandboxed pages that ask the shell for everything through the SDK.

&#91;embedded content: architecture · window, backend, and what lies outside Vellum\]

The backend reads store data only through the provider host, launches games only through store clients, and is the only part that touches the network. The protocol server delivers each skin's files, the SDK and art to the sandboxed pages.

## Repository layout

One repository, with the Rust backend, the TypeScript front end and the shipped plugins side by side:

```
vellum/
  src-tauri/                 Rust backend
    src/
      main.rs                app setup, windows, protocols, commands
      platform/              registry, env expansion, URI launch (Windows + stubs)
      plugins/               discovery, manifests, enable/disable, .vplugin install
      providers/             QuickJS host, sandboxed host API, scan scheduling
      locations/             resolution chain, validation, user prompts
      library/               game model, merging, search index, change events
      userdata/              settings, favorites, tags, last launched, overrides
      art/                   resolver chain, download, cache, resizing
      protocols/             skin:// and art serving
      formats/               text VDF, binary VDF, ACF helpers
      diagnose/              --diagnose sanitized report
  shell/                     host UI (TypeScript + Lit)
    src/                     state store, skin iframe host, settings, dialogs,
                             input + gamepad, hotkeys, overlays
  sdk/                       skin SDK + kit components + built-in views
    src/
  plugins/                   shipped plugins (copied beside the exe)
    providers/steam|epic|gog|custom|mock/
    skins/basis/
    modules/quick-launch|random-pick/
  docs/
    skin-authoring.md        required: complete guide for writing skins
    provider-authoring.md    required: complete guide for writing providers
    module-authoring.md
    decisions.md
  tests/fixtures/            fake store folders for parser and integration tests
  scripts/package-portable.ps1
```

`shell/` and `sdk/` build with Vite into static bundles that Tauri embeds in the exe. The SDK bundle is served to skins from the exe (see Skin system), never copied into skin folders.

The two authoring guides are deliverables, not extras: future skins and providers will be written by someone other than the original builder, working only from those guides and the shipped examples.

## Plugin system

All three plugin types (providers, skins, modules) share one folder convention, one manifest format and one lifecycle, managed from a single Plugins page in settings.

### Folder and manifest

Every plugin is a folder containing `plugin.json` at its root:

```json
{
  "id": "epic",
  "type": "provider",
  "name": "Epic Games",
  "version": "1.0.0",
  "apiVersion": 1,
  "author": "Vellum",
  "description": "Installed games from the Epic Games Launcher",
  "entry": "provider.js",
  "icon": "icon.svg",
  "provider": { }
}
```

- `id`: lowercase letters, digits and hyphens; unique per type. The folder name should match but the manifest is authoritative.
- `type`: `provider`, `skin` or `module`. The type-specific section (`provider`, `skin` or `module`) is defined in the sections below.
- `apiVersion`: the host API version the plugin targets. The host supports the current version and keeps older versions working where possible; an unsupported version disables the plugin with a clear message.
- `entry`: the main file (`provider.js`, `index.html`, or `module.js`/`index.html`).

Invalid manifests never crash the app. The plugin shows in the Plugins page with its error and stays disabled.

### Discovery and lifecycle

- On startup the host scans `plugins/providers`, `plugins/skins` and `plugins/modules` beside the exe.
- Enabled/disabled state lives in user settings, never in the plugin folder. New providers and modules default to enabled; the mock provider defaults to disabled.
- Exactly one skin is active at a time. If the active skin fails to load, fall back to `basis` and show a notice.
- Enabling, disabling or reloading a plugin takes effect without restarting the app.
- A "Reload plugins" action rescans the folders.

### Packaging and portability

- A plugin can also be distributed as a `.vplugin` file: a zip of the plugin folder. Installing one (file picker or drag onto the window) validates the manifest, shows the plugin's declared permissions, then extracts it into the right folder.
- Plugin folders contain only logic and assets. Machine-specific data (resolved folder paths, per-plugin settings values) lives in user settings keyed by plugin id, so copying a plugin folder to another PC works and the new machine simply re-runs location detection.
- Per-plugin settings: a plugin may declare `settings` in its manifest (same option schema as skin options, see Skin system). The host renders them on the plugin's settings page and passes values to the plugin.

### Isolation

A plugin that throws, times out or returns invalid data is marked with a warning badge and its error is logged. Nothing else in the app is affected: other providers still load, and a broken module never blocks the skin.

## Provider plugins

A provider is a JavaScript ES module run by the backend in its own QuickJS runtime. It can only touch the system through a small host API, and only within the locations its manifest declares.

### Manifest section

```json
"provider": {
  "locations": {
    "root": {
      "label": "Steam installation folder",
      "required": true,
      "registry": [{ "hive": "HKCU", "key": "Software\\Valve\\Steam", "value": "SteamPath" }],
      "defaults": ["%ProgramFiles(x86)%\\Steam", "C:\\Steam"],
      "validate": ["steamapps/libraryfolders.vdf"]
    }
  },
  "derivedLocations": true,
  "registryRead": ["HKCU\\Software\\Valve\\Steam"],
  "uriSchemes": ["steam"],
  "artHosts": ["cdn.cloudflare.steamstatic.com", "shared.steamstatic.com"],
  "capabilities": ["launch", "install", "uninstall", "openStore", "watch"]
}
```

- `locations`: every folder the provider needs. `validate` lists relative paths or globs that must all exist for a candidate folder to be accepted.
- `derivedLocations`: if true, the provider may add folders it discovers inside its data (Steam libraries on other drives). Shown to the user as a permission.
- `registryRead`: key prefixes the provider may read. `uriSchemes`: URI schemes it may open. `artHosts`: hosts its art URLs may point at.
- `capabilities`: which optional functions exist. The UI only offers actions a provider declares.

### Location resolution

Each declared location resolves in this order, stopping at the first candidate that passes `validate`:

1. The path saved in user settings from a previous run.
2. Each `registry` hint, read and normalized (Steam stores forward slashes).
3. Each `defaults` entry, with environment variables expanded.
4. A prompt: "Vellum couldn't find the Steam installation folder", with **Browse**, **Skip for now** and **Disable provider**. Browsing opens a folder picker; a folder that fails validation is rejected with a specific message ("This folder has no steamapps/libraryfolders.vdf").

Prompts never block startup: they queue as a dismissible notice so other providers keep loading. A skipped required location leaves the provider inactive with a warning badge. Resolved paths are canonicalized and saved per provider; settings offer **Re-locate** for each location.

### Module contract

```js
export default {
  scan(ctx) { return { games: [ /* ProviderGame */ ], collections: [ /* optional */ ] }; },
  launch(ctx, game) { ctx.openUri(`steam://rungameid/${game.sourceId}`); },
  install(ctx, game) { },     // optional, per capabilities
  uninstall(ctx, game) { },   // optional
  openStore(ctx, game) { },   // optional
  watch(ctx) { return [{ path: "...", glob: "appmanifest_*.acf" }]; },  // optional
  art(ctx, game) { return [ /* ArtCandidate */ ]; }                       // optional
};
```

`ProviderGame` fields:

| Field | Type | Notes |
| --- | --- | --- |
| `sourceId` | string | Stable id within the store; required |
| `title` | string | Required |
| `kind` | `game` / `tool` / `dlc` / `other` | Non-games hidden by default |
| `installDir` | string | Optional |
| `sizeBytes` | number | Optional |
| `launchData` | object | Opaque; handed back unchanged to `launch` |
| `categories` | string\[\] | The store's own collection names, if any |
| `metadata` | object | Optional `developer`, `publisher`, `releaseDate` (ISO), `genres`, `description` |

`ArtCandidate`: `{ kind: "cover" | "hero" | "logo" | "header" | "icon", file?: absolutePath, url?: string }`, in priority order. Files must be inside allowed locations and URLs must use an `artHosts` host.

### Host API (`ctx`)

All calls are synchronous. Every path is canonicalized and checked against the provider's resolved and derived locations; a violation throws and is logged.

- `ctx.locations.<key>`: resolved absolute path of each declared location.
- `ctx.fs.readText(path)`, `readBytes(path)` (returns `Uint8Array`), `list(dir)` (name, isDir, size, mtime), `glob(dir, pattern)`. `exists(path)` and `stat(path)` are allowed anywhere because they reveal no content.
- `ctx.fs.allow(dir)`: add a derived location (only with `derivedLocations`).
- `ctx.registry.get(hive, key, value)` and `ctx.registry.subkeys(hive, key)`: limited to `registryRead` prefixes.
- `ctx.formats.vdf(text)`, `ctx.formats.binaryVdf(bytes)`: parsers implemented in Rust.
- `ctx.sqlite.query(path, sql, params)`: opens the database read-only and returns rows as objects.
- `ctx.env.expand(str)`, `ctx.openUri(uri)` (scheme must be in `uriSchemes`), `ctx.run(exe, args, cwd)` (exe must be inside an allowed location or the game's `installDir`; returns immediately).
- `ctx.settings` (this provider's settings values) and `ctx.log.info/warn/error`.

Limits: 30 seconds per `scan` call and 256 MB of memory per runtime, enforced with an interrupt handler. No network, timers or module imports beyond files in the provider's own folder.

### Scan scheduling

On startup the host loads the last library snapshot from disk and shows it immediately, then runs all enabled providers in parallel and swaps in fresh results as each finishes. Files returned by `watch` are monitored; changes trigger a debounced (2 second) rescan of that provider only. A manual Refresh rescans everything.

## Store provider reference

Ship five providers: Steam, Epic, GOG, Custom and Mock. All read installed games only; no provider logs in to any account. Formats below must be confirmed against real installs with `--diagnose` before a provider is considered done.

### Steam

**Locations.** `root`: registry `HKCU\Software\Valve\Steam` value `SteamPath`, default `%ProgramFiles(x86)%\Steam`; validate `steamapps/libraryfolders.vdf`. Uses `derivedLocations` for library folders on other drives.

**Installed games.**

1. Parse `<root>/steamapps/libraryfolders.vdf` (text VDF). Each numbered entry under `libraryfolders` has a `path`; allow each path as a derived location.
2. In each library's `steamapps/`, parse every `appmanifest_<appid>.acf` (text VDF, root key `AppState`): `appid`, `name`, `installdir`, `StateFlags`, `SizeOnDisk`.
3. A game is installed when `StateFlags & 4` (fully installed) is set. Install directory is `<library>/steamapps/common/<installdir>`.
4. Mark as `kind: "tool"`: appid 228980 (Steamworks Common Redistributables), names starting with "Proton" or "Steam Linux Runtime", and anything the store metadata later identifies as a tool. A provider setting "Show tools and redistributables" defaults to off.

**Active user.** Folders under `<root>/userdata/` are numeric account ids. With one folder, use it. With several, default to the one whose `config/localconfig.vdf` was modified most recently, and expose a provider setting to choose. Never read `config/loginusers.vdf`, `config/config.vdf` or `ssfn*` files: they hold account and login data. The provider's file scope must explicitly exclude them.

**Collections.** Read `<root>/userdata/<account>/config/cloudstorage/cloud-storage-namespace-1.json`: a JSON array of `[key, entry]` pairs. For keys starting with `user-collections.`, skip entries with `is_deleted`, then parse `entry.value` (a JSON string) into `{ id, name, added: [appid], removed: [appid] }`. Collections with a `filterSpec` are dynamic; skip them in v1 and log their names. Pass memberships to the library as `categories`. The special `favorite` collection maps to a category named "Steam favorites"; `hidden` maps to hidden games when the provider setting "Respect Steam's hidden collection" is on (default on).

**Art candidates, in order.**

1. The user's custom Steam art in `userdata/<account>/config/grid/`: `<appid>p.(png|jpg)` cover, `<appid>_hero.*` hero, `<appid>_logo.*` logo, `<appid>.*` header.
2. Steam's local cache: the per-app folder `appcache/librarycache/<appid>/` (search it recursively for `library_600x900*`, `library_hero*`, `logo*`, `header*`; newer clients may nest files in hashed subfolders), then the older flat names `appcache/librarycache/<appid>_library_600x900.jpg` and siblings.
3. Steam CDN: `https://cdn.cloudflare.steamstatic.com/steam/apps/<appid>/` + `library_600x900_2x.jpg` (cover, 1200 × 1800), `library_hero.jpg`, `logo.png`, `header.jpg`. Some newer titles use hashed CDN paths and will 404 here; the pipeline then moves on.

**Actions.** Launch `steam://rungameid/<appid>`, install `steam://install/<appid>`, uninstall `steam://uninstall/<appid>`, store `steam://store/<appid>`.

**Watch.** `libraryfolders.vdf`, each library's `appmanifest_*.acf`, and the cloud-storage JSON.

### Epic Games

**Locations.** `manifests`: default `%ProgramData%\Epic\EpicGamesLauncher\Data\Manifests`; validate `*.item`.

**Installed games.** Each `.item` file is JSON. Use `DisplayName`, `AppName`, `CatalogNamespace`, `CatalogItemId`, `InstallLocation`, `InstallSize`, `AppCategories`, `MainGameAppName`, `bIsIncompleteInstall`. Include an entry when it is not incomplete, `AppCategories` contains `games` (or is absent), and `MainGameAppName` equals `AppName` (this excludes DLC and add-ons).

**Actions.** Launch `com.epicgames.launcher://apps/<CatalogNamespace>%3A<CatalogItemId>%3A<AppName>?action=launch&silent=true` (scheme `com.epicgames.launcher`). Store page and install are not supported in v1.

**Art.** None reliably available locally without login; the pipeline falls through to SteamGridDB and the generated placeholder.

**Watch.** The manifests folder.

### GOG

**Locations.** No required folder. Games are listed in the registry under `HKLM\SOFTWARE\WOW6432Node\GOG.com\Games\<gameId>` (values include `gameName`, `path`, `exe`). Each `path` is allowed as a derived location. Optional location `galaxy`: default `%ProgramFiles(x86)%\GOG Galaxy`, validate `GalaxyClient.exe`; if it is skipped, the provider still works.

**Installed games.** For each registry entry, read `<path>/goggame-<gameId>.info` (JSON) when present for the canonical `name` and `playTasks`; the primary task is the one with `isPrimary: true`.

**Actions.** If Galaxy was located and the provider setting "Launch through GOG Galaxy" is on (default on), run `GalaxyClient.exe /command=runGame /gameId=<gameId> /path="<path>"`. Otherwise run the primary play task's exe directly with its arguments and working directory. GOG games are DRM-free, so direct launch is valid.

**Art.** Galaxy's local database (`%ProgramData%\GOG.com\Galaxy\storage\galaxy-2.0.db`) may hold image URLs; treat reading it as a later improvement that needs research. Until then, SteamGridDB and the placeholder.

### Custom games

For anything else: emulators, standalone exes, shortcuts. An **Add game** dialog in the shell collects title, exe, arguments, working directory and optional art files; entries are stored in this provider's settings. Paths the user picks through the host's file dialog become allowed paths for this provider. Launch uses `ctx.run`.

### Mock

Disabled by default. Generates about 80 deterministic fake games spread across three fake sources, with realistic titles, metadata, categories and sizes. Ships generated art at real resolutions (covers 1200 × 1800, heroes 3840 × 1240, transparent logos, headers) in its own `art/` folder, plus a few games with deliberately missing art. Launch shows a toast instead of launching. This is the provider used for all skin development and UI tests.

### Later providers (research required)

| Store | Installed games | Launch | Confidence |
| --- | --- | --- | --- |
| Ubisoft Connect | Registry `HKLM\SOFTWARE\WOW6432Node\Ubisoft\Launcher\Installs\<id>` (`InstallDir`); titles from the matching uninstall entries | `uplay://launch/<id>/0` | Medium |
| EA app | Registry entries and per-game install data; exact format needs verification | EA's URI scheme, needs verification | Low |
| Battle.net | `%ProgramData%\Battle.net\Agent\product.db` (protobuf) | `Battle.net.exe --exec="launch <code>"` | Medium |
| Xbox / Microsoft Store | Needs a new host API to enumerate installed app packages | `shell:AppsFolder\<AUMID>` | Medium |

None of these are needed for v1. Each should be a separate plugin added after the core milestones, verified with `--diagnose` first.

## Library model and user data

The backend turns provider results into **entries**: one entry per game as the user thinks of it, which may combine the same game from several stores. Skins only ever see entries.

### Entry

```ts
interface Entry {
  id: string;                  // id of the entry's primary game record, e.g. "steam:620"
  title: string;
  sortTitle: string;           // leading "The "/"A " moved, case-folded
  kind: "game" | "tool" | "dlc" | "other";
  sources: Source[];           // one per store record merged into this entry
  preferredSource: string;     // provider id used by launch()
  categories: { provider: string; name: string }[];  // store collections
  tags: string[];              // user tags (Vellum's own)
  favorite: boolean;
  hidden: boolean;
  lastLaunched: string | null; // ISO time, recorded by Vellum
  addedAt: string;             // ISO time Vellum first saw it
  sizeBytes?: number;
  metadata: { developer?: string; publisher?: string; releaseDate?: string; genres?: string[]; description?: string };
  art: { cover: string; hero: string; logo: string; header: string; icon: string }; // art URLs
  artStatus: Record<"cover" | "hero" | "logo" | "header" | "icon", "local" | "remote" | "placeholder">;
  notes?: string;
}

interface Source {
  provider: string; providerName: string; gameId: string;  // gameId = "<provider>:<sourceId>"
  capabilities: string[]; installDir?: string;
}
```

Game record ids are `<providerId>:<sourceId>`. All user data is keyed by game record id, so favorites, tags and art overrides survive disabling and re-enabling a provider, and survive merges and unmerges.

### Merging duplicates

- Automatic: two records of `kind: "game"` from different providers merge when their normalized titles match exactly. Normalize by case-folding, removing ™ ® © and punctuation, and collapsing whitespace. Do not strip words such as "Edition" or "Remastered": a false merge is worse than a missed one.
- Manual: the user can select entries and **Merge**, or **Unmerge** an entry. Manual choices are stored as overrides and always beat automatic matching. A setting turns automatic merging off.
- The preferred source defaults to the first provider in a user-orderable provider priority list (default Steam, GOG, Epic, Custom). Each entry can override it, and launch UIs offer **Play via…** for the others.

### Last launched

`lastLaunched` is set when Vellum successfully dispatches a launch (the URI opened or the process started). It records launches from Vellum only, is labeled "Last launched" everywhere, and is not a measure of play. Vellum tracks no other statistics.

### Search, filter and sort

Search is case- and accent-insensitive, matching substrings of the title and word prefixes ("hk" finds "Hollow Knight"). Filters: provider, installed kind, favorites, user tags, store categories, show hidden. Sorts: title, last launched, date added, size, release date, provider. Search, filter and sort run in the backend or in a shared SDK module so every view and skin behaves the same.

### Storage

Data lives in `%APPDATA%\Vellum\`, or in `data\` beside the exe when `portable.flag` exists.

| File | Contents |
| --- | --- |
| `settings.json` | App settings, plugin enabled states and settings, resolved locations, view order and hotkeys, active skin and its option values |
| `userdata.json` | Per game record: favorite, hidden, tags, last launched, notes, art overrides, preferred source; merge overrides |
| `library-cache.json` | Last library snapshot, for instant startup |
| `cache/art/`, `cache/metadata/` | Downloaded and resized art; fetched metadata |
| `logs/` | Rolling logs, 7 days |

Every write is atomic (write a temporary file, then rename) and debounced. Each JSON file carries a `schemaVersion` with migrations, and `userdata.json` keeps one `.bak` copy. Vellum never writes to any store's files.

## Artwork and metadata

Every entry always has all five art kinds available at full resolution, resolved by the backend; skins never fetch art from the internet themselves.

| Kind | Shape | Typical source size |
| --- | --- | --- |
| `cover` | Portrait 2:3 | 1200 × 1800 |
| `hero` | Wide banner, about 3.1:1 | 3840 × 1240 |
| `logo` | Transparent PNG, any shape | up to 1280 wide |
| `header` | Landscape, about 2.14:1 | 920 × 430 |
| `icon` | Square | 256 × 256 |

### Resolution order

For each entry and kind, the first hit wins:

1. **User override**: a local file the user picked, or a SteamGridDB image they chose.
2. **Provider candidates**: from each source's `art()` results, preferred source first.
3. **SteamGridDB**, only if the user has entered a free API key in settings. Look up by Steam appid when the entry has a Steam source, otherwise by title search, and take the top-rated image of the right dimensions. Confirm the current SteamGridDB API endpoints when implementing.
4. **Generated placeholder**: a deterministic image from a hash of the title (two-tone background, title set in a clean typeface); for `logo`, the title rendered on a transparent background.

Each entry carries `artStatus: { cover: "local" | "remote" | "placeholder", … }` so skins can, for example, overlay the title on placeholder covers.

### Serving and caching

- Skins request art at `/__vellum/art/<entryId>/<kind>?w=<width>` on their own origin (see Skin system). Width snaps up to one of 160, 320, 640, 1280, 1920 or `full`; `full` returns the original with no recompression, which HD skins use for hero and cover art.
- Originals are stored in `cache/art/` keyed by a hash of their source plus its modification time, so replacing a custom Steam image invalidates the cache. Resized variants are generated on demand and cached: JPEG quality 90 for opaque images, PNG or WebP for transparent ones.
- All downloads happen in the backend: at most 4 at once, 10 second timeout, and a 7-day negative cache for misses. With no network, everything already cached keeps working.
- Each entry's context menu has **Change art…**, showing every candidate from all sources plus SteamGridDB results and a **Choose file** option, per kind.

### Metadata

When an entry has a Steam source and the setting "Fetch game details from Steam" is on (default on), fetch `https://store.steampowered.com/api/appdetails?appids=<appid>` for developer, publisher, release date, genres and short description. Throttle to one request every 1.5 seconds, cache results for 30 days, and never block the UI on it. Provider-supplied metadata wins over fetched metadata. Other metadata sources (such as IGDB for non-Steam games) are a later addition.

## Skin system

A skin is a plugin folder of HTML, CSS, JS, fonts and images that draws the whole window. Writing a skin must never require rebuilding Vellum or touching store logic, and the three depths of skin must all be easy: recolor (tokens only), relayout (arrange kit components), or fully custom (own JS against the SDK).

### Manifest section

```json
"skin": {
  "preview": "preview.jpg",
  "defaultView": "spotlight",
  "window": { "frameless": true, "minWidth": 960, "minHeight": 600, "background": "#0b0d12" },
  "styles":    { "covers": "views/covers.css" },
  "overrides": { "spotlight": "views/spotlight.js" },
  "views": [
    { "id": "timeline", "name": "Timeline", "entry": "views/timeline.js",
      "placement": { "after": "covers" }, "couch": true, "icon": "icons/timeline.svg" }
  ],
  "options": [
    { "id": "accent", "label": "Accent color", "type": "color", "default": "#7cc4ff", "cssVar": "--v-accent" },
    { "id": "coverSize", "label": "Cover size", "type": "range", "min": 140, "max": 320, "step": 10, "default": 200, "cssVar": "--v-cover-width", "unit": "px" },
    { "id": "heroBlur", "label": "Background blur", "type": "toggle", "default": true }
  ]
}
```

- `styles`: extra CSS applied to a built-in view. `overrides`: replace a built-in view's rendering entirely with the skin's own module. `views`: new views (see Views).
- `window.background` paints the native window before the skin loads, so there is no white flash.

### Loading and isolation

The shell fills the window with one iframe that loads the active skin's `index.html` from a dedicated origin per skin, served by a backend custom protocol (on Windows, Tauri maps custom schemes to `http://<scheme>.localhost/`; follow Tauri's current docs). The protocol handler:

- serves only files inside that skin's folder, rejecting `..` and symlink escapes;
- serves reserved paths from inside the exe: `/__vellum/sdk.js`, `/__vellum/sdk.css` (tokens, base styles, kit), `/__vellum/fonts/…` (one bundled open-source UI font) and `/__vellum/art/…` (Artwork section);
- sends a strict CSP on every response: `default-src 'self'; img-src 'self' data: blob:; media-src 'self'; font-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-src 'none'`.

Skins therefore have no network access and no Tauri IPC. The SDK talks to the shell through `postMessage`; the shell validates every message and calls the backend.

The smallest possible skin, which recolors the default layout:

```html
<!doctype html>
<html>
<head>
  <link rel="stylesheet" href="/__vellum/sdk.css">
  <link rel="stylesheet" href="skin.css">   <!-- sets --v-* tokens -->
  <script type="module" src="/__vellum/sdk.js"></script>
</head>
<body><vellum-app></vellum-app></body>
</html>
```

### SDK API

Available as `window.vellum` and as an ES module from `/__vellum/sdk.js`. Reads are synchronous from an SDK-side cache; writes go to the shell, which owns all state, and return as change events.

| Namespace | Members |
| --- | --- |
| `vellum.ready()` | Promise resolving once library, state and options are loaded |
| `vellum.library` | `all()`, `query()` (current search/filter/sort applied), `get(id)`, `on("change", cb)` |
| `vellum.state` | `get()`, `set(partial)`, `on("change", cb)`; state = `{ view, selectedId, query, filters, sort, groupBy, couch }` |
| `vellum.actions` | `launch(id, provider?)`, `install(id)`, `uninstall(id)`, `openStore(id)`, `toggleFavorite(id)`, `setHidden(id, bool)`, `setTags(id, tags)`, `changeArt(id, kind)`, `showDetails(id)`, `openSettings(page?)`, `randomEntry()` |
| `vellum.art` | `url(id, kind, width?)`; `width` omitted = sized automatically from the element using `devicePixelRatio` |
| `vellum.views` | `list()`, `current()`, `switch(id)`, `register(id, impl)` |
| `vellum.input` | `on("nav", cb)` with `up`, `down`, `left`, `right`, `confirm`, `back`, `menu`, `details`, `prevView`, `nextView`, `pageUp`, `pageDown`, favorite, search, settings; focus helpers |
| `vellum.skin` | `options`, `on("options", cb)`, `assetUrl(path)` |
| `vellum.window` | `minimize()`, `toggleMaximize()`, `close()`, `isMaximized()`; any element with `data-vellum-drag` drags the window |
| `vellum.ui` | `toast(text)`, `contextMenu(id, x, y)` (drawn by the shell, consistent across skins) |
| `vellum.providers` | `list()` with name, icon URL and status, for source badges and filters |

Action calls are validated by the shell (the entry must exist and the provider must declare the capability). Skins cannot launch arbitrary programs.

### Kit components

Lit web components shipped in the SDK. All are themed by tokens and expose `part` names for `::part()` styling.

- Layout: `<vellum-app>` (default complete layout), `<vellum-view-outlet>` (renders the current view), `<vellum-search>`, `<vellum-view-switcher>`, `<vellum-filter-bar>`, `<vellum-sort-menu>`.
- Collections: `<vellum-grid>` and `<vellum-list>` (both virtualized), `<vellum-shelf>` (a horizontal row).
- Items: `<vellum-cover>`, `<vellum-hero>`, `<vellum-logo>` (falls back to styled title text), `<vellum-play-button>`, `<vellum-source-badges>`.
- Focus: a spatial-navigation manager over elements marked `data-vellum-focus`, used by keyboard and controller input alike.

### Tokens

`sdk.css` defines defaults for: `--v-bg`, `--v-surface`, `--v-surface-raised`, `--v-text`, `--v-text-muted`, `--v-accent`, `--v-accent-text`, `--v-focus-ring`, `--v-radius`, `--v-gap`, `--v-font-body`, `--v-font-display`, `--v-cover-width`, `--v-list-row-height`, `--v-hero-overlay`, `--v-blur`, `--v-transition`. Built-in views and kit components use only these, so a token-only skin restyles everything consistently.

### Options

Option types: `color`, `range`, `select`, `toggle`, `font` (fonts bundled in the skin's `fonts/` folder plus the built-in font) and `image` (images bundled in the skin). If an option has `cssVar`, the host sets that variable on the skin's `:root` automatically; every value is also available through `vellum.skin.options`. The settings page for the skin is generated from this list and previews changes live.

### Developer mode

A settings toggle (or `--dev`) enables: file watching on the active skin folder, live CSS swaps without reload, full iframe reload on other changes while the shell keeps state (so you stay on the same game), DevTools with Ctrl+Shift+I, and a visible error overlay when skin JS throws.

### Performance targets

60 fps scrolling with 3,000 entries at 3840 × 2160; first paint from cache under 1.5 seconds; images lazy-loaded at the rendered size times `devicePixelRatio` and decoded off the main thread; Spotlight prefetches hero art for neighboring entries.

### Authoring guide

`docs/skin-authoring.md` must cover: folder layout, the manifest, all tokens, every SDK member with an example, every kit component and its parts, custom views, options, developer mode, and three worked examples matching the shipped skin's techniques (token-only, rearranged layout, custom view).

## Views

Vellum ships three built-in views, and skins can add more. The shell owns which view is active; every view reads the same shared state, so switching views keeps the same selected game, search text, filters and sort.

### Built-in views

| View | Id | Purpose | Couch |
| --- | --- | --- | --- |
| List | `list` | Fast scanning and launching: dense rows | No |
| Covers | `covers` | Browsing by portrait cover art, optionally grouped into shelves | Yes |
| Spotlight | `spotlight` | One game at a time with full hero art; also the details view | Yes |

**List.** Virtualized rows showing icon, title, source badges, tags, size and last launched. Column headers sort. Enter or double-click launches; right-click opens the shell's context menu.

**Covers.** A virtualized grid of covers sized by `--v-cover-width`. Its **Group by** setting turns the grid into **shelves**: one horizontal row per group, each with a collapsible header. Group by: none, store category, user tag, provider, favorites, recently launched, or first letter. Shelf order is user-adjustable for categories and tags. Entries in several groups appear on each shelf.

**Spotlight.** Full-bleed hero art behind the entry's logo (or styled title), a metadata line (developer, release year, genres), the description, source badges, **Play** with **Play via…**, favorite and art actions. A strip of covers along the bottom shows neighboring entries from the current filtered and sorted list; left and right move the selection with a hero crossfade. `vellum.actions.showDetails(id)` switches to Spotlight on that entry, and Back returns to the previous view.

### View implementation contract

Every view, built-in or skin-provided, is a module exporting:

```js
export default {
  mount(el, vellum) { },    // render into el using the SDK
  unmount() { },
  onState(state) { }        // optional; state changes also arrive as SDK events
};
```

Built-in views use exactly this contract, so skin authors can read them as examples.

### Skin views and ordering

- A skin declares views in its manifest with `placement`: `"first"`, `"last"`, `{ "before": "<view id>" }` or `{ "after": "<view id>" }`. Anchoring to ids keeps placement meaningful if more built-ins are added. A missing anchor places the view last.
- `couch: true` marks a view as controller-navigable; only such views appear in couch mode.
- Skins cannot remove built-in views; they can only set `defaultView` (open decision, see the last section).
- The user's order and visibility always win. Settings → Views lists all views in a draggable list with show/hide toggles. A skin view keeps its manifest placement until the user moves it.

### Switching and hotkeys

| Action | Default key |
| --- | --- |
| List / Covers / Spotlight | Ctrl+1 / Ctrl+2 / Ctrl+3 (fixed to the view, not its position) |
| Skin views | Ctrl+4 to Ctrl+9, in the order they appear |
| Next / previous view | Ctrl+Tab / Ctrl+Shift+Tab; controller LB / RB |
| Focus search | Ctrl+F, or start typing |
| Launch selected | Enter |
| Refresh library | Ctrl+R |
| Toggle couch mode | F11 |

All keys are rebindable in settings. Binding built-ins to fixed keys means switching skins never changes what Ctrl+1 does.

### Startup view

The setting "Start in" offers "Last used view" (default) or a specific view. The first time a skin is activated, its `defaultView` is selected once.

## Couch mode and input

Couch mode is a fullscreen, controller-first presentation of the same app: only couch-capable views (Covers, Spotlight and skin views marked `couch`), larger focus targets, and full navigation without a mouse.

### Entering couch mode

- F11, the `--couch` command-line flag, or the setting "Start in couch mode".
- Optional setting "Enter couch mode when a controller connects" (default off).
- The shell sets `state.couch = true` and `data-couch` on the skin's root element. `sdk.css` scales sizes through `--v-couch-scale` (default 1.25) so token-only skins adapt automatically.
- The mouse cursor hides after 3 seconds of no movement.

### Input model

Keyboard, mouse and controller all feed one stream of `nav` events (SDK section). The shell polls controllers with the browser Gamepad API (standard mapping) on every animation frame, applies key repeat (400 ms delay, 80 ms interval) and forwards events to the skin. The kit's focus manager handles spatial navigation by default; a skin or view can intercept any event.

| Controller | Event | Built-in behavior |
| --- | --- | --- |
| D-pad, left stick | `up`/`down`/`left`/`right` | Move focus |
| A | `confirm` | Covers: open Spotlight on that game. Spotlight: Play |
| B | `back` | Close overlay, or return to previous view |
| X | `favorite` | Toggle favorite |
| Y | `search` | Open search with the on-screen keyboard |
| LB / RB | `prevView` / `nextView` | Switch view |
| LT / RT | `pageUp` / `pageDown` | Jump a page, or a letter when sorted by title |
| Menu | `menu` | Context menu for the selected game |
| View | `settings` | Open settings |

The shell provides an on-screen keyboard overlay (`<vellum-osk>`, themed by tokens) for search in couch mode. Arrow keys, Enter, Escape, Page Up/Down and the hotkeys from the Views section map to the same events on a keyboard.

### After launching a game

Setting "When a game launches": do nothing, minimize Vellum (default in couch mode), or close to tray. Vellum does not watch game processes, so it restores when the user returns to it rather than when the game exits.

## Modules

Modules are QoL features packaged as plugins, so features that Steam hard-codes become optional here. A module runs in its own sandboxed iframe on its own origin (same protocol and CSP model as skins), layered above the skin by the shell and hidden until opened. It uses the same SDK plus `vellum.module.close()`, and it can never modify the skin's page.

### Manifest section

```json
"module": {
  "overlay": "index.html",
  "commands": [
    { "id": "open", "label": "Quick launch", "defaultKey": "Ctrl+K", "couch": true }
  ],
  "globalHotkey": { "command": "open", "defaultKey": "Ctrl+Alt+Space", "defaultEnabled": false }
}
```

Commands appear in Settings → Controls, where they can be rebound, and in a shell command list. A `globalHotkey` works system-wide (Tauri global-shortcut plugin): it brings Vellum to the front and runs the command. Global hotkeys are always off until the user turns them on.

### Shipped modules

- **Quick launch**: Ctrl+K opens a small search box over any view; type a few letters, arrow through fuzzy matches, Enter launches. Optional global hotkey.
- **Random pick**: chooses a random entry from the current filtered list (option: only favorites) and shows it in Spotlight.

Further module ideas, not for v1: backlog workflow with tags, bulk art fixer, per-game launch notes.

`docs/module-authoring.md` documents the manifest, overlay lifecycle and command model, using the two shipped modules as examples.

## Settings

Settings are drawn by the shell, not the skin, so they always work even when a skin is broken. They use the active skin's tokens for color and type but keep a fixed layout, and are fully navigable by controller.

| Page | Contents |
| --- | --- |
| General | Start-in view, start in couch mode, couch mode on controller connect, when a game launches, close to tray, start with Windows, data folder location (and whether portable mode is active) |
| Library | Provider priority order (drag), automatic merging, show hidden games, show tools, Refresh |
| Plugins | Tabs for Providers, Skins and Modules. Per plugin: enable toggle, status badge, version, declared permissions (locations, registry keys, URI schemes, art hosts, derived folders), its generated settings, **Re-locate** per location, recent errors. Also **Install plugin…** (.vplugin), **Reload plugins**, **Open plugins folder** |
| Skins | Gallery of installed skins with preview images; activate; the active skin's generated options with live preview; **Reset options** |
| Views | Draggable order of all views with show/hide toggles; startup view |
| Controls | Keyboard bindings for views and module commands; global hotkeys; the controller map |
| Art and metadata | SteamGridDB API key, fetch Steam details toggle, **Clear art cache** |
| Developer | Developer mode, open DevTools, open logs folder, **Run diagnostics** |

Per-game actions (favorite, hide, tags, notes, change art, merge or unmerge, preferred source, open install folder) live in the shell's context menu and a details panel, available from every view.

## Security model

Plugins are designed to be shareable, so every plugin type gets the least power it needs. Treat these rules as requirements, with tests.

| Plugin type | Can | Cannot |
| --- | --- | --- |
| Provider | Read files in its declared and derived folders; read allowlisted registry keys; open allowlisted URI schemes; run exes inside allowed folders | Network, writing files, reading outside its scope, timers, imports from outside its folder |
| Skin | Load its own files; use the SDK | Network, Tauri IPC, file access, launching anything except entries through `vellum.actions` |
| Module | Same as skin | Same as skin; cannot alter the skin's page |

Core rules:

- **IPC.** Tauri capabilities expose backend commands only to the shell's own origin. Skin and module origins get none; the shell checks the origin and schema of every `postMessage` before acting.
- **Paths.** Every provider path is canonicalized and checked against its allowed roots after resolving symlinks. The Steam provider's scope explicitly excludes `config/loginusers.vdf`, `config/config.vdf` and `ssfn*`.
- **Databases** are opened read-only.
- **Plugin install.** `.vplugin` extraction rejects absolute paths and `..` entries, and the user sees the plugin's declared permissions before it is enabled.
- **No remote code.** Vellum never loads scripts from the network; skins and modules are blocked by CSP.
- **Store files are never written.**
- **Network use** is limited to art and metadata downloads by the backend (Steam CDN, Steam store API, SteamGridDB when a key is set). There is no telemetry.
- **Secrets.** The SteamGridDB key is stored in Windows Credential Manager (the `keyring` crate), not in `settings.json`, and never written to logs.

## Testing, diagnostics and dev workflow

### Diagnostics report

`Vellum.exe --diagnose --out report.json` produces a report the user can read and share to confirm store formats on a real machine. It must contain **structure only**:

- per provider: which location candidates were tried, which passed validation and why others failed;
- relevant folder layout (file and folder names, counts, sizes), with account ids replaced by `<account-1>`, `<account-2>`;
- for each file format read (`appmanifest_*.acf`, `.item`, cloud-storage JSON, `goggame-*.info`, registry entries): the keys present and their value types, never the values;
- art cache layout: which naming patterns exist and how many files match each.

Denylisted files are never opened. The report also prints a short human-readable summary, and the user reviews it before sharing.

### Automated tests

- **Rust unit tests**: text VDF (quoting, escapes, nesting, `//` comments, `[$WIN32]`-style conditionals), binary VDF, location resolution with a fake registry and file system, scope checks (traversal, symlinks, denylist), title normalization and merging, search, settings migrations, art resolution order, `.vplugin` extraction safety.
- **Provider tests**: each shipped provider runs in the real QuickJS host against `tests/fixtures/<store>/` folders with a fake registry map. Fixtures include two Steam libraries on different "drives", a deleted and a dynamic collection, custom grid art, both librarycache layouts, an incomplete Epic install, an Epic DLC manifest, and a GOG game with and without Galaxy.
- **Front end**: Vitest for SDK logic; Playwright against the shell and `basis` skin with a mocked backend, covering every view, shelves, keyboard and controller navigation (simulated gamepad), couch mode, live skin options and hot reload. Save screenshots of each view as test artifacts.

### Skin dev harness

`npm run dev:skin -- <path to skin folder>` serves a skin in an ordinary browser with the real SDK, the mock library and its art, live reload, and a small panel for switching views, toggling couch mode, simulating controller input and editing skin options. Skins must be fully buildable and testable with this harness alone, without Rust, Windows or any store installed.

### Definition of done for any feature

Tests pass on Windows; no console errors in the shell or `basis`; the relevant authoring guide is updated; and new decisions are recorded in `docs/decisions.md`. If CI is set up, use a Windows runner for the full build and tests.

## Milestones

Build in this order. Each milestone ends with a working app and its acceptance criteria met; do not start the next one with the previous one's criteria failing.

1. **Foundation.** Tauri project, shell window, plugin discovery and manifest validation, enabled state, settings storage, portable mode, logging, the `platform` module, and `scripts/package-portable.ps1`.
   - The app starts on Windows; the Plugins page lists every shipped plugin, with manifest errors shown for a deliberately broken test plugin.
   - Creating `portable.flag` moves all data to `data\` beside the exe.
   - The package script produces the exact distribution layout.
2. **Provider host and Steam.** QuickJS host with the full `ctx` API and scope enforcement, location resolution with prompts, VDF parsers, the Steam provider (installed games, collections, all four actions), library snapshot cache, last launched, a plain List view in `basis`, and `--diagnose`.
   - A real Steam library appears within 2 seconds of a warm start, including libraries on a second drive, and games launch.
   - Renaming the Steam folder triggers the locate prompt, and validation rejects a wrong folder with a specific message.
   - Scope tests pass, and the diagnostics report contains no values, titles or account ids.
3. **Skin system and views.** Skin protocol and CSP, SDK, kit components, tokens, options, the three built-in views with shelves, the view contract, skin view placement and hotkeys, mock provider with art, developer mode, the skin dev harness, a polished `basis` skin, and `docs/skin-authoring.md`.
   - Switching views keeps the selected game, search and filters.
   - A token-only test skin restyles every view; a test skin adds a view placed `{ "after": "covers" }` and it appears there with Ctrl+4.
   - 3,000 mock entries scroll at 60 fps at 3840 × 2160; hot reload keeps the selection.
   - The harness runs a skin in a browser without Rust.
4. **Artwork and metadata.** The resolver chain, cache and resizing, SteamGridDB, placeholders, Change art, and Steam store metadata.
   - Every entry has all five art kinds; custom Steam grid art takes precedence; everything cached still works offline.
5. **Epic, GOG, Custom and merging.** The three providers, source badges and filters, automatic and manual merging, preferred source and Play via, and `docs/provider-authoring.md`.
   - A game installed on two stores shows once and launches through the preferred store.
   - Disabling a provider hides its games; re-enabling restores their favorites and tags.
6. **Couch mode, modules and plugin management.** Controller input, on-screen keyboard, couch mode, Quick launch and Random pick, global hotkeys, `.vplugin` install with permissions, all settings pages, and `docs/module-authoring.md`.
   - Every function in the app, including settings, is reachable with a controller alone.
   - A provider exported as `.vplugin` and installed on a clean copy works after re-running location detection.
7. **Further providers.** Ubisoft Connect, Battle.net, EA app and Xbox, each as its own plugin, each verified with `--diagnose` on a real install first.

Additional skins are expected to be written separately after milestone 3, using only the authoring guide and the dev harness. That is the real test of the skin system.

## Out of scope and open decisions

Out of scope for this version:

- Logging in to any store, and showing owned-but-uninstalled games.
- Playtime, session tracking, game process monitoring, or any statistics beyond "last launched".
- Writing to any store's files, including editing Steam collections.
- Store browsing, achievements, friends, and download progress.
- Installer, auto-update, code signing, and macOS or Linux builds.

Open decisions. Build with the current default; each is easy to change later.

| Decision | Current default |
| --- | --- |
| Final product name | "Vellum", held in one constant |
| Can a skin hide built-in views by default? | No; only the user can hide views |
| Automatic merging of duplicates | On |
| Is Spotlight also the details view? | Yes; no separate details overlay |
| First-run experience | Detect providers, show the library, then a dismissible tip about skins and SteamGridDB |
