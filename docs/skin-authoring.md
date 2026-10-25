# Writing Vellum skins

A skin is a folder of HTML, CSS, JavaScript, fonts and images that draws the whole Vellum
window. You never rebuild Vellum and never touch store logic: the skin gets games, state and
actions from the **SDK**, and draws them with the **kit** (ready-made components) or with its
own code.

There are three depths of skin, and you can mix them:

| Depth | What you write | Example |
| --- | --- | --- |
| Recolor | One CSS file that sets `--v-*` tokens | [Example 1](#example-1-token-only-skin) |
| Relayout | Your own HTML that arranges kit components, plus CSS and `::part()` | [Example 2](#example-2-a-rearranged-layout) |
| Fully custom | Your own JavaScript views against the SDK | [Example 3](#example-3-a-custom-view) |

The three examples are real skins in `tests/fixtures/dev-plugins/skins/` (`token-test`,
`sidebar-test`, `timeline-test`), and the end-to-end tests run them. The default skin, Basis, is in
`plugins/skins/`, and the optional skins in `extras/skins/` show what's possible beyond that:

| Skin | Techniques worth reading |
| --- | --- |
| `basis` | Tokens, a few selectors, options mapped to tokens and toggles |
| `synthwave` | A CSS-only animated backdrop (perspective grid, striped sun), chrome text with `background-clip`, state parts for neon selection, a frameless window |
| `aero` | Light theme, glass panes with `backdrop-filter`, gel buttons, a `select` option driving a `data-` attribute from `skin.js`, generated bubbles |
| `gridline` | Angled panels with `clip-path`, glow with `drop-shadow` on the `cell-selected` part, light cycles on a `<canvas>` paused when hidden or turned off |
| `calling-card` | A custom element of its own (`<cc-ransom>`), a floating "target" card that follows the selection, a replaced brand, heavy use of `transform` on parts |

---

## Contents

1. [Quick start with the dev harness](#1-quick-start-with-the-dev-harness)
2. [Folder layout](#2-folder-layout)
3. [The manifest](#3-the-manifest)
4. [What a skin can and can't do](#4-what-a-skin-can-and-cant-do)
5. [Tokens](#5-tokens)
6. [The SDK](#6-the-sdk)
7. [Kit components](#7-kit-components)
8. [Views](#8-views)
9. [Input and focus](#9-input-and-focus)
10. [Options](#10-options)
11. [Art](#11-art)
12. [Developer mode](#12-developer-mode)
13. [Worked examples](#13-worked-examples)
14. [Checklist before sharing a skin](#14-checklist-before-sharing-a-skin)

---

## 1. Quick start with the dev harness

You can build and test a skin entirely in a browser, with no Rust, Windows or store install:

```sh
npm install
npm run dev:skin -- path/to/my-skin
```

This opens `http://localhost:5180/` with:

- your skin running in a sandboxed frame with the real SDK and the same security policy as the app;
- the **mock library** (80 fake games by default, up to 5,000) and its art;
- live reload: CSS changes swap in place; other changes reload the skin and keep the selected game;
- a panel to switch views, toggle couch mode, press controller buttons, edit your skin's options
  and change the number of games.

Favorites, tags and options you set in the harness are kept in that browser's storage
(**Reset harness data** clears them).

Mock art is generated once with `npm run mock-art`, which needs Rust. Without it the harness
shows generated placeholders, and you can copy `plugins/providers/mock/art/` from any Vellum
extras package into `extras/providers/mock/art/` instead. The harness serves art at full size, while the app also resizes it.

To try the skin in the app, copy the folder into `plugins/skins/` beside `Vellum Game Launcher.exe` and
choose **Activate** in Settings → Skins. Copying a skin to another PC is just copying the folder.

## 2. Folder layout

```
my-skin/
  plugin.json        required: the manifest
  index.html         the entry page (any name; set "entry")
  skin.css           your styles
  preview.jpg        shown in Settings → Skins (16:10 works best)
  views/             custom views and per-view CSS (any layout you like)
  fonts/             fonts your options offer
  images/            images your options offer, or your own art
```

Only `plugin.json` and the entry page are required. Everything is served from the skin's own
folder; files outside it can't be reached.

## 3. The manifest

```json
{
  "id": "my-skin",
  "type": "skin",
  "name": "My skin",
  "version": "1.0.0",
  "apiVersion": 1,
  "author": "You",
  "description": "One line shown in Settings",
  "entry": "index.html",
  "skin": {
    "preview": "preview.jpg",
    "defaultView": "covers",
    "window": { "frameless": false, "minWidth": 960, "minHeight": 600, "background": "#0b0d12" },
    "styles": { "covers": "views/covers.css" },
    "overrides": { "spotlight": "views/spotlight.js" },
    "views": [
      { "id": "timeline", "name": "Timeline", "entry": "views/timeline.js",
        "placement": { "after": "covers" }, "couch": true, "icon": "views/timeline.svg" }
    ],
    "options": [
      { "id": "accent", "label": "Accent color", "type": "color", "default": "#7cc4ff", "cssVar": "--v-accent" }
    ]
  }
}
```

| Field | Meaning |
| --- | --- |
| `id` | Lowercase letters, digits and hyphens. Unique among skins. |
| `apiVersion` | The SDK version you target. Currently `1`. |
| `skin.preview` | Image for the gallery in Settings → Skins. Optional (a warning if missing). |
| `skin.defaultView` | Selected once, the first time the skin is activated. Afterwards the user's choice wins. |
| `skin.window.frameless` | `true` removes the Windows title bar; draw your own controls (see [`<vellum-window-controls>`](#window-controls) and [`data-vellum-drag`](#window)). |
| `skin.window.minWidth` / `minHeight` | Minimum window size in CSS pixels (at least 640 × 400). |
| `skin.window.background` | `#rgb` or `#rrggbb`, painted before the skin loads so there is no white flash. |
| `skin.styles` | Extra CSS for a view, loaded only while that view is shown. Keys are view ids. |
| `skin.overrides` | Replace a built-in view's rendering with your own module (`list`, `covers`, `spotlight`). |
| `skin.views` | New views. See [Views](#8-views). |
| `skin.options` | Settings the user can change. See [Options](#10-options). |

An invalid manifest never crashes Vellum: the skin is listed in Settings → Plugins with its
errors and can't be activated. If the active skin fails to load (no SDK handshake within six
seconds), Vellum falls back to Basis for the session and says so.

## 4. What a skin can and can't do

A skin runs in a sandboxed frame on its own origin, with this Content Security Policy:

```
default-src 'self'; img-src 'self' data: blob:; media-src 'self'; font-src 'self';
style-src 'self' 'unsafe-inline'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self';
frame-src 'none'
```

So:

- **Scripts** must be files in your folder. Inline `<script>` blocks, `onclick="…"` attributes and
  `eval` are blocked. Put code in `.js` modules and add listeners from there.
- **No network.** Bundle any library (Lit, Preact, an animation library…) as a file in your folder.
  Art always comes from Vellum (see [Art](#11-art)).
- **No files, no IPC, no launching programs.** Everything goes through the SDK, and the shell
  checks every call: actions only work on real entries, and only for capabilities the store declares.
- **WebAssembly** from your folder is allowed (`'wasm-unsafe-eval'`): it is sandboxed like script.
- **Audio** from your folder plays: MP3, OGG/Opus, WAV, FLAC, M4A, and MIDI with a SoundFont
  through [`vellum.music`](#music).
- Inline `style` attributes and `<style>` blocks are allowed.
- All skins share one origin, so use [`vellum.skin.storage`](#skin) instead of `localStorage`.

## 5. Tokens

`/__vellum/sdk.css` defines every token. Built-in views and kit components use only these, so a
skin that sets them restyles everything consistently, including the insides of kit components.

| Token | Default | Used for |
| --- | --- | --- |
| `--v-bg` | `#0b0d12` | Window and page background |
| `--v-surface` | `#141824` | Panels, rows on hover, search box |
| `--v-surface-raised` | `#1c2131` | Buttons, menus, selected rows |
| `--v-text` | `#e8eaf0` | Main text |
| `--v-text-muted` | `#9aa3b5` | Secondary text, captions, column headers |
| `--v-accent` | `#7cc4ff` | Play buttons, active states, favorites |
| `--v-accent-text` | `#06121f` | Text on accent backgrounds |
| `--v-focus-ring` | `#a8d8ff` | Keyboard/controller focus outline |
| `--v-radius` | `8px` | Corner radius of covers, buttons, menus |
| `--v-gap` | `16px` | Spacing between covers and around views |
| `--v-font-body` | Inter, Segoe UI… | Body text |
| `--v-font-display` | Inter, Segoe UI… | Titles, logo fallback, headings |
| `--v-cover-width` | `180px` | Width of covers in grids and shelves (height is 1.5×) |
| `--v-list-row-height` | `44px` | Row height in List |
| `--v-hero-overlay` | dark gradients | Layer over hero art so text stays readable |
| `--v-blur` | `0px` | Blur applied to hero art in Spotlight |
| `--v-transition` | `140ms ease` | Hover and selection transitions |
| `--v-couch-scale` | `1.25` | Size multiplier in couch mode |
| `--v-spot-scrim` | dark radial gradient | Spotlight: the layer behind the title and text that keeps them readable on any art |
| `--v-spot-panel` | `none` | Spotlight: a background for the text block itself (a glass card, for example) |
| `--v-spot-panel-padding` | `0` | Padding inside that panel |

Two more tokens tune kit components:

| Token | Default | Effect |
| --- | --- | --- |
| `--v-cover-caption` | `block` | Set to `none` to hide titles under covers |
| `--v-logo-max-height` | `100%` | Maximum height of `<vellum-logo>` images |
| `--v-art-style` | none | `sketch` or `watercolor` redraws covers, heroes and headers ([Art styles](#art-styles)) |
| `--v-icon-style` | none | The same for game icons in `<vellum-list>` |

Tokens are ordinary CSS custom properties, so you can scope them. For example
`.v-spot-strip { --v-cover-width: 104px }` makes only the Spotlight strip smaller.

The shell's own Settings drawer and menus also take the skin's colors (`--v-bg`, surfaces, text,
accent, focus ring, radius), so Settings matches your skin.

**Font.** `sdk.css` bundles Inter (variable weight 100–900) as `font-family: "Inter"`.

**Couch mode** sets `data-couch` on `<html>` and scales `rem` sizes and cover/row sizes by
`--v-couch-scale`. Token-only skins adapt automatically; use `:root[data-couch] …` for anything else.

## 6. The SDK

Load it from the reserved path, never from a copy in your folder:

```html
<script type="module" src="/__vellum/sdk.js"></script>
```

or in your own module:

```js
import vellum from "/__vellum/sdk.js";
await vellum.ready();
```

It is also available as `window.vellum`. Loading the SDK also defines every kit component.

**Reads are synchronous** from a local copy. **Writes return promises** and go to the shell,
which owns all state; the result comes back as a change event. Selection changes apply locally
at once, so navigation feels instant.

### Data shapes

```ts
interface Entry {
  id: string;                       // "steam:620"; use it in every call
  title: string;
  sortTitle: string;                // "witcher 3, the"
  kind: "game" | "tool" | "dlc" | "other";
  sources: { provider: string; providerName: string; gameId: string; capabilities: string[]; installDir?: string }[];
  preferredSource: string;          // provider id used by launch()
  categories: { provider: string; name: string }[];   // the store's collections
  labels: string[];                 // the store's badges: "Demo", "Playtest", "Soundtrack"…
  tags: string[];                   // the user's own tags
  favorite: boolean;
  hidden: boolean;
  lastLaunched: string | null;      // ISO time Vellum last launched it; not playtime
  addedAt: string;                  // ISO time Vellum first saw it
  sizeBytes?: number;
  playtimeMinutes?: number;         // minutes played as the store counts them (Steam), any launcher
  lastPlayed?: string;              // ISO time the store last saw it played
  metadata: { developer?: string; publisher?: string; releaseDate?: string; genres?: string[]; description?: string };
  art: { cover: string; hero: string; logo: string; header: string; icon: string };
  artStatus: { cover: "local" | "remote" | "placeholder"; /* …per kind */ };
  notes?: string;
}

interface UiState {
  view: string;                     // current view id
  selectedId: string | null;
  query: string;                    // search text
  filters: Filters;
  sort: Sort;                       // "title", "-lastLaunched", …
  groupBy: "category" | "tag" | "provider" | "favorites" | "recent" | "letter" | null;
  couch: boolean;
}

interface Filters {
  providers?: string[];             // any of these stores
  kinds?: ("game" | "tool" | "dlc" | "other")[];   // absent = games only
  favorites?: boolean;
  tags?: string[];                  // all of these tags
  categories?: string[];            // any of these, as "provider/name"
  showHidden?: boolean;
}
```

Sort keys are `title`, `lastLaunched`, `added`, `size`, `releaseDate` and `provider`. Each has a
natural direction (titles and stores A→Z, everything else newest or largest first); prefix `-`
to reverse it. Missing values always sort last.

### `vellum.ready()`

Resolves once the library, state, views and options have arrived. Call it before the first read.

```js
await vellum.ready();
console.log(`${vellum.library.all().length} entries`);
```

### `vellum.library`

| Member | Returns |
| --- | --- |
| `all()` | Every entry, including hidden ones and non-games |
| `query()` | Entries after the current search, filters and sort. This is what views show. |
| `get(id)` | One entry, or `undefined` |
| `groups(by?)` | The current query split into shelves: `{ key, label, entries, orderable }[]`. Uses `state.groupBy` when `by` is omitted; without grouping, one group with everything. |
| `facets()` | `{ tags, categories }` present in the library, for filter menus |
| `on("change", cb)` | Called with `all()` when anything in the library changes. Returns an unsubscribe function. |

```js
const favorites = vellum.library.query().filter((e) => e.favorite);
const off = vellum.library.on("change", render);
```

Search is case- and accent-insensitive. It matches substrings of the title and word prefixes:
`hk` finds *Hollow Knight*, and `poke` finds *Pokémon*. Every view and skin uses the same search,
filter and sort code, and the same functions are exported for your own use:
`import { query, matches, sortEntries, groupEntries, fold } from "/__vellum/sdk.js"`.

### `vellum.state`

| Member | Description |
| --- | --- |
| `get()` | The current `UiState` |
| `set(partial)` | Change `view`, `selectedId`, `query`, `filters`, `sort` or `groupBy`. (`couch` belongs to the user: F11.) |
| `on("change", cb)` | Called with the new state |

```js
vellum.state.set({ query: "zelda", sort: "-releaseDate" });
vellum.state.set({ filters: { favorites: true } });
```

State is shared by every view, so switching views keeps the selected game, search and filters.
It also survives skin reloads and restarts.

### `vellum.actions`

| Member | Description |
| --- | --- |
| `launch(id, provider?)` | Launch through the preferred store, or the named one ("Play via…"), after any `onBeforeLaunch` hooks |
| `onBeforeLaunch(hook)` | Run `hook` before launches this skin starts; it can hold or call them off (see below) |
| `install(id)`, `uninstall(id)`, `openStore(id)` | Only work when the store declares the capability |
| `toggleFavorite(id)` | |
| `setHidden(id, hidden)` | |
| `setTags(id, tags)` | Up to 32 tags of up to 40 characters |
| `changeArt(id, kind)` | Opens the shell's Change art dialog at that kind |
| `showDetails(id)` | Spotlight on that entry; Back returns to the previous view |
| `openSettings(page?)` | Opens the shell's settings, e.g. `openSettings("skins")` |
| `randomEntry()` | A random entry from the current query, or `null` |

```js
playButton.addEventListener("click", () => vellum.actions.launch(entry.id).catch(() => {}));
```

The shell shows a toast for launches and for errors, so you can ignore rejected promises.

`onBeforeLaunch(hook)` runs `hook(id, provider)` before every launch your skin starts (the kit's
Play buttons, Enter in a collection, your own calls). The hook may be async: an animation or a
confirmation holds the launch until it settles. Return `false` to call the launch off; anything
else lets it go ahead. It returns an unsubscribe function. A hook that throws is ignored, so a
bug can't stop launches. Launches the shell starts itself (its context menu) don't run hooks.

```js
vellum.actions.onBeforeLaunch(async (id) => {
  await playIgnition();           // hold the launch for the animation
  return !engineStalled();        // false: no launch this time
});
```

### `vellum.art`

`url(id, kind, width?, style?)` gives the URL of an entry's art. `width` may be:

- CSS pixels (multiplied by `devicePixelRatio`, then snapped up to 160/320/640/1280/1920);
- an element, to size from its rendered width;
- `"full"` for the original file, unchanged;
- omitted, for the kind's usual size.

`style` is `"sketch"`, `"watercolor"` or `null` (the art as it is). Omitted, the skin's
`--v-art-style`/`--v-icon-style` tokens decide; `styleFor(kind)` reads them for you.

```js
img.src = vellum.art.url(entry.id, "cover", 200);
hero.style.backgroundImage = `url("${vellum.art.url(entry.id, "hero", "full")}")`;
thumb.src = vellum.art.url(entry.id, "cover", 200, "watercolor");
```

See [Art](#11-art).

### `vellum.views`

| Member | Description |
| --- | --- |
| `list()` | Views offered right now, in the user's order: `{ id, name, builtin, couch, entry?, style?, icon?, hotkey? }[]`. Hidden views are left out, and in couch mode only couch views are listed. |
| `current()` | The current view's info |
| `switch(id)` | Show a view |
| `back()` | Return to the view shown before this one |
| `previous()` | That view's id, or `null` |
| `register(id, impl)` | Provide a view implementation from code (wins over the manifest `entry`) |
| `builtin(id)` | A built-in view's implementation, to wrap or extend |
| `on("change", cb)` | The list of views changed |

### `vellum.input`

| Member | Description |
| --- | --- |
| `on("nav", cb)` | Receive every navigation event; see [Input and focus](#9-input-and-focus) |
| `dispatch(name)` | Send a nav event as if pressed |
| `focus.move(dir)` | Move focus `up`/`down`/`left`/`right`; returns false at an edge |
| `focus.page(dir)` | `pageUp`/`pageDown` in the focused collection |
| `focus.activate()` | Confirm the focused element |
| `focus.focusDefault()` | Focus the view's default element |
| `focus.to(el)` | Focus a specific element |
| `focus.current()` | The focused element, looking inside components |

### `vellum.skin`

| Member | Description |
| --- | --- |
| `id` | Your skin's id |
| `options` | Current option values, defaults filled in: `{ accent: "#7cc4ff", … }` |
| `definitions()` | The option definitions from your manifest |
| `on("options", cb)` | Values changed (the user is editing them live) |
| `assetUrl(path)` | URL path of a file in your folder: `assetUrl("images/bg.jpg")` → `/images/bg.jpg` |
| `dev()` | True in developer mode |
| `storage.get(key, fallback?)`, `storage.set(key, value)`, `storage.remove(key)` | JSON values in `localStorage`, namespaced by your skin id |

Use `storage` only for conveniences, such as a remembered scroll position or a collapsed panel.
Real settings belong in [options](#10-options).

### `vellum.shelves`

Shelf preferences for grouped Covers (the kit uses these; custom shelf UIs can too).

| Member | Description |
| --- | --- |
| `prefs()` | `{ order: { category?: string[], tag?: string[] }, collapsed: string[] }` |
| `setOrder(by, labels)` | The user's order of category or tag shelves |
| `setCollapsed(key, collapsed)` | Collapse a shelf by its group `key` |
| `on("change", cb)` | |

### `vellum.window`

| Member | Description |
| --- | --- |
| `minimize()`, `toggleMaximize()`, `close()` | For frameless skins |
| `isMaximized()`, `isFrameless()` | |
| `on("change", cb)` | Maximized state changed |

**Dragging.** Any element with the `data-vellum-drag` attribute moves the window when dragged,
and double-clicking it maximizes. Buttons, inputs, links and focusable elements inside it still
work. Mark anything else that shouldn't drag with `data-vellum-no-drag`.

```html
<header class="titlebar" data-vellum-drag>…</header>
```

### `vellum.ui`

| Member | Description |
| --- | --- |
| `toast(text)` | A short message drawn by the shell |
| `contextMenu(id, x, y, items?)` | The shell's per-game menu at viewport coordinates. It is the same in every skin: Play, Play via…, details, favorite, tags, hide, change art, store actions, install folder. `items` (up to 6 `{ id, label, disabled? }`) adds the skin's own actions at the top. It resolves with the chosen item's `id`, or `null` when the user picked something else or closed the menu. |
| `menuItems` | `true` when `contextMenu` accepts `items` (Vellum 0.4 and later). On older versions the items are ignored, so check this first if your skin offers the actions another way there. |

```js
card.addEventListener("contextmenu", async (e) => {
  e.preventDefault();
  const pick = await vellum.ui.contextMenu(entry.id, e.clientX, e.clientY, [{ id: "flip", label: "Flip card" }]);
  if (pick === "flip") flip(card);
});
```

### `vellum.providers`

`list()` returns `{ id, name, icon, state, message, games }[]` for each enabled store, where
`state` is `idle`, `scanning`, `ready`, `inactive` or `error`, and `icon` is a URL or `null`.
`on("change", cb)` reports status changes. Use it for source badges, store filters, and
"still scanning" messages.

### `vellum.music` {#music}

Adaptive music from MIDI files and a SoundFont in your folder. Because the music is notes rather
than recorded audio, it can change with the skin: a new scene starts on the next bar line of the
one playing (no crossfade, no gap), instruments fade in and out as layers, and short stingers
land on the beat. The engine loads only when a skin uses music.

**Files.** A SoundFont (`.sf2`, `.sf3`) or DLS bank, and Standard MIDI Files (format 0 or 1).
SF3 (Ogg-compressed samples) is usually 5–10× smaller than SF2; prefer it for shared skins. Use
a General MIDI layout (drums on channel 10, which is channel `9` counting from zero) or your own
bank's presets. Mind the licences: SoundFonts and arrangements are often not free to
redistribute.

**Declare it, write no code.** In `plugin.json`, `skin.music` picks the bank, names the scenes and
layers, and maps views to scenes; the music then follows the view:

```json
"music": {
  "soundbank": "music/bank.sf3",
  "scenes": { "title": "music/title.mid", "garage": { "midi": "music/garage.mid", "from": 8 } },
  "layers": { "drums": [9], "strings": [4, 5] },
  "views": { "garage": "garage", "*": "title" },
  "at": "bar"
}
```

`at` is where view changes land: `"bar"` (default), `"beat"`, `"end"` (the end of the playing
song's loop) or `"now"`. `entry` is where the new scene picks up: `"sync"` (default) continues from
where the music is, `"start"` plays it from the top. A scene's `from` fixes its entry beat instead
(to skip an intro, say).

**Or drive it from code:**

| Member | Description |
| --- | --- |
| `configure(config)` | The same object as `skin.music`; starts the scene for the current view, or `start` |
| `play(scene, { at })` | Change to a scene (or a MIDI path) at the next `at` boundary: `"bar"`, `"beat"`, `"end"`, `"now"`, or a number of beats |
| `stop({ at })` | Stop at a boundary; notes release naturally |
| `layer(name, level, { at, fade })` | Fade a layer (or a channel list) to `level` (0–1) over `fade` seconds, from the next `at` (default `"now"`) |
| `stinger(scene, { at })` | Play a short MIDI over the music on the next beat, on its own 16 channels |
| `tempo(rate)` | Playback speed, 0.25–4 |
| `volume(v)` | Your music level, 0–1; multiplied by the user's Music volume |
| `pause()`, `resume()` | |
| `preload(...scenes)` | Load the bank and songs ahead, so the first change is instant |
| `on("scene" \| "bar" \| "beat" \| "loop", cb)` | Called as the music is heard, with `{ scene, bar, beat, time }`: sync visuals to it |
| `position()` | `{ scene, beat, bar, voices, state }` |

```js
vellum.music.on("bar", ({ bar }) => document.body.classList.toggle("pulse", bar % 2 === 0));
grid.addEventListener("focusin", () => vellum.music.layer("strings", 1, { at: "beat" }));
vellum.actions.onBeforeLaunch(async () => { await vellum.music.stinger("fanfare", { at: "beat" }); return true; });
```

How it plays:

- **Scenes change on the music's grid.** The playing song's notes are released at the boundary
  and the next song starts on that instant.
- **Scenes pick up where the music is** (`entry: "sync"`). Songs whose loops are the same length
  switch on the same beat: write scenes as variations of one piece (same length, tempo, key and
  meter, different arrangement) and the change sounds like the band changing parts. A song of
  another length enters the same share of the way through, on a bar line. Either way it is
  brought up to date first: its instruments and controllers so far, and notes that would already
  be sounding (a held chord) start on the change. From silence, a song starts at the top.
- **Songs loop.** A file's loop points (CC 111, or `loopStart`/`loopEnd` markers) are used;
  otherwise the whole song loops, rounded up to the bar line.
- **Layers carry across scenes.** Keep each instrument on the same channel in every scene and a
  layer you faded out stays out after a change.
- **Vellum steps in for the player.** Music plays only while Vellum's window has focus: it pauses
  when a game (or any other window) comes to the front or Vellum is minimised, and picks up where
  it was as soon as the player is back in Vellum, even with the game still running. Its level is
  the user's Music volume (Settings → General → Sound) times yours.
- **Autoplay.** Browsers start audio after the first click or key press; music configured before
  that starts on it.

**A music folder.** With `"folder": "music"`, Vellum reads that folder of your skin: its SoundFont
(the first `.sf2`, `.sf3` or `.dls`) and a MIDI file per view, named after the view id
(`covers.mid`, `spotlight.mid`, `garage.mid`…, any case). Views without a file are silent, and
anything you set explicitly (`soundbank`, `scenes`, `views`) wins. Players can drop their own tracks
in, and you can ship a skin with an empty folder and a README.

**Holding the music back.** `"autoplay": false` loads the instruments but waits for
`vellum.music.start()`, for a skin with a title screen.

To try it, run the harness on the test skin, which has a tiny generated SoundFont and three
songs: `npm run dev:skin -- tests/fixtures/dev-plugins/skins/music-test` (switch to Spotlight to
hear the scene change). `scripts/make-music-fixture.py` shows how its files were made.

## 7. Kit components

Kit components are web components defined by the SDK. They use only tokens, and each exposes
`part` names so you can style its insides with `::part()`:

```css
vellum-grid::part(art) { border-radius: 2px; }
vellum-view-switcher::part(tab) { text-transform: uppercase; }
```

Entry-based components take an `entry` property (an `Entry`) or an `entry-id` attribute, and
re-render when that entry changes.

### Layout

#### `<vellum-app>`

The default complete layout: a top bar, then the current view. It renders into the page itself
(not a shadow root), so plain CSS selectors reach every part:

| Selector | Element |
| --- | --- |
| `vellum-app .v-topbar` | The top bar (also a window drag region) |
| `.v-brand`, `.v-count` | "Library" and the game count |
| `.v-views` | The `<vellum-view-switcher>` |
| `.v-tools` | Search, filters, sort and the settings button (`.v-icon-button`) |
| `vellum-view-outlet` | Where views render |

#### `<vellum-view-outlet>`

Renders the current view and switches views as state changes. Each view is mounted into
`<div class="v-view" data-view="<id>">`. A view's per-view stylesheet (`skin.styles`) is linked
while the view is shown. If a view fails to load, the built-in view of the same id is used, or
an error message is shown instead of a blank page.

#### `<vellum-search>`

A search box bound to `state.query`. Clicking it, Ctrl+F or the controller's Y button focuses
it; typing elsewhere doesn't, so letter keys are free for skins. Escape clears it, then leaves it. Enter or ↓ moves on to the results.
Parts: `box`, `input`.

#### `<vellum-view-switcher>`

Tabs for `vellum.views.list()`, titled with their hotkeys. Parts: `tabs`, `tab`, `tab-selected` (the current view), and `tab-<view id>` on each tab (`tab-covers`, `tab-catalogue`…) so you can style or label one view's tab.

#### `<vellum-filter-bar>`

One menu for all filters: favorites only, hidden games, tools, DLC, stores, tags and store
collections, plus "Clear all filters". It shows a badge with the number of active filters.
Parts: `trigger`, `panel`, `badge`.

#### `<vellum-sort-menu>`, `<vellum-group-menu>`

The sort key and direction, and the Covers grouping. Parts: `trigger`, `panel`.

#### `<vellum-menu>`

The menu button the controls above are built from. Set `label`, `items` (`{ value, label,
checked?, section? }[]`), `multiple` and `badge`; it fires `vellum-select` with `{ value }`.
Parts: `trigger`, `label`, `badge`, `panel`, `section`.

#### `<vellum-empty>`

Explains an empty view: still scanning, a store folder that couldn't be found, no matches (with
a button to clear the search and filters), or no games. Parts: `box`, `title`, `detail`.

#### `<vellum-window-controls>` {#window-controls}

Minimize, maximize and close buttons. They render only in a frameless window. Put them where
you like. If a frameless skin shows none fully on screen (left out, or pushed off by its
layout), the SDK pins a set to the top-right corner (class `v-window-controls-fallback`), so the
window can always be closed.
Parts: `minimize`, `maximize`, `close`.

### Collections

All three are virtualized: only the visible items exist in the page, so 3,000 entries scroll as
smoothly as 30. Each is a **focus container**: the element itself takes focus, arrows move the
selection (`state.selectedId`), and focus leaves at the edges (see [Input and focus](#9-input-and-focus)).

Set `entries` (an array of `Entry`) and optionally `activate`:

| `activate` | Confirm (Enter, A) does |
| --- | --- |
| `"details"` (default for covers) | Opens Spotlight on the entry |
| `"launch"` (default for List) | Launches it |
| `"none"` | Nothing; handle `vellum-activate` yourself |

Double-click always launches. Right-click opens the shell's context menu.

Events (both bubble, cross shadow roots, and can be cancelled with `preventDefault()` to stop
the default action):

- `vellum-activate` with `detail: { id, how: "confirm" | "dblclick" }`
- `vellum-contextmenu` with `detail: { id, x, y }`

#### `<vellum-grid>`

A wrapping grid of covers sized by `--v-cover-width`. Home and End jump to the ends.

| Part | Element |
| --- | --- |
| `cell` | One cover with its caption. Attributes: `data-id`, `aria-selected`, `data-favorite`, `data-art` (`local` or `placeholder`) |
| `art` | The cover's frame |
| `cover` | The `<img>` |
| `favorite` | The ★ badge |
| `label` | The entry's first label ("Demo"…), on the art |
| `caption`, `title` | The title under the cover (`--v-cover-caption: none` hides it) |
| `sizer` | The element that sets the scroll height |

State is exposed as extra part names, because CSS can't combine `::part()` with attribute
selectors:

| State part | On |
| --- | --- |
| `cell-selected` | The selected cell |
| `art-selected` | The selected cell's art |
| `art-focused` | The selected cell's art while the collection has keyboard or controller focus |

```css
vellum-grid::part(art) { border-radius: 2px; }
vellum-grid::part(art-selected) { box-shadow: 0 0 0 2px var(--v-accent); }
vellum-grid::part(art-focused) { transform: scale(1.06); }
vellum-grid::part(cell-selected) { filter: drop-shadow(0 0 10px var(--v-accent)); }  /* glow that follows a clip-path */
vellum-grid::part(art)::after { content: ""; position: absolute; inset: 0; background: linear-gradient(160deg, #fff6, transparent 35%); }
```

Don't set `transform` on the `cell` part: the grid positions cells with it. Transform `art` instead.

#### `<vellum-cover-row>`

A single horizontal row with the same parts as `<vellum-grid>`. With `centered`, it keeps the
selection in the middle; the Spotlight strip uses this.

#### `<vellum-shelf>`

A titled, collapsible cover row. Set `group` (from `vellum.library.groups()`), `by` (the group
key) and `collapsed`. Category and tag shelves show move up/down buttons on hover.
Parts: `header`, `toggle`, `label`, `count`, `order`, `row`, plus the row's cell parts (its
cover badge is exported as `cover-label`, since `label` is the shelf's own heading).

#### `<vellum-list>`

Dense rows: icon, title (with favorite star and tags), source, size and last launched. Clicking
a column header sorts; clicking it again reverses. Uses `--v-list-row-height`.
Parts: `header`, `column`, `row`, `row-selected` (the selected row), `icon`, `title`, `favorite`, `label` (each store label), `tags`, `source`, `size`, `when`.
To change the columns' widths, set `--cols` (a `grid-template-columns` value) on the element.

### Items

#### `<vellum-cover>`

A single portrait cover, `--v-cover-width` wide unless you size it. Part: `cover`.

#### `<vellum-hero>`

Full-bleed hero art that crossfades when its entry changes, under `--v-hero-overlay`. With the
`blur` attribute, it blurs by `--v-blur`. Parts: `hero` (the images), `overlay`.

#### `<vellum-logo>`

The transparent logo. With no logo, it shows the title in `--v-font-display`, so it is never
empty. Parts: `logo`, `title`.

#### `<vellum-play-button>`

**Play**, plus **Play via…** when the entry has more than one store. It is disabled when no
store can launch the entry. Parts: `button`, `icon` (the ▶ glyph), `via`, `menu`.

Glyph icons in other kit components have their own parts too, so you can restyle or filter them:
`icon` on `<vellum-search>`, `caret` on the filter, sort and group menus, `chevron` on
`<vellum-shelf>`, `favorite` on covers, and `minimize`/`maximize`/`close` on the window controls.

#### `<vellum-source-badges>`

One pill per store the entry comes from. Part: `badge` (with `data-provider`).

## 8. Views

Vellum has three built-in views. Skins can restyle them, replace them, and add more.

| View | Id | Hotkey | Couch |
| --- | --- | --- | --- |
| List | `list` | Ctrl+1 | No |
| Covers (with shelves) | `covers` | Ctrl+2 | Yes |
| Spotlight (also the details view) | `spotlight` | Ctrl+3 | Yes |

Skin views get Ctrl+4 to Ctrl+9 in the order they appear. Ctrl+Tab and Ctrl+Shift+Tab (LB/RB on
a controller) cycle through views.

### The view contract

Every view, built-in or yours, is an ES module whose default export is:

```js
export default {
  mount(el, vellum) { },   // render into el; may be async
  unmount() { },           // optional: remove listeners
  onState(state) { },      // optional: called on every state change while mounted
};
```

`el` is an empty `<div class="v-view" data-view="…">` that fills the space below your layout
(a flex column). The built-in views use exactly this contract. Read them in
`sdk/src/views/` (`list.ts`, `covers.ts`, `spotlight.ts`) as examples.

Tips:

- Re-render on `vellum.library.on("change")` and when `onState` brings a new query, filters or
  sort. Don't rebuild everything on every selection change; collections follow the selection themselves.
- Mark the element that should get focus when the view opens with `data-vellum-focus-default`.
- Return the listeners' unsubscribe functions and call them in `unmount`.

### Adding a view

```json
"views": [
  { "id": "timeline", "name": "Timeline", "entry": "views/timeline.js",
    "placement": { "after": "covers" }, "couch": true, "icon": "views/timeline.svg" }
]
```

`placement` is `"first"`, `"last"`, `{ "before": "<view id>" }` or `{ "after": "<view id>" }`.
Anchoring to an id keeps the placement meaningful if more built-in views are added later. A
missing anchor places the view last. Views anchored to the same view keep their manifest order.
`couch: true` offers the view in couch mode; it must then work with a controller alone.

The user always has the last word: Settings → Views lets them reorder and hide every view,
including yours. Your view keeps its manifest placement until they move it. Skins can't hide
built-in views; they can only choose `defaultView`.

### Replacing or extending a built-in view

`"overrides": { "spotlight": "views/spotlight.js" }` uses your module instead of the built-in
Spotlight; it keeps its id, name and hotkey. To extend rather than replace it, wrap the built-in:

```js
// views/covers.js, used with "overrides": { "covers": "views/covers.js" }
import vellum from "/__vellum/sdk.js";
const base = vellum.views.builtin("covers");

export default {
  mount(el, v) {
    const banner = document.createElement("p");
    banner.textContent = "Tip: press Ctrl+D to favorite";
    el.append(banner);
    return base.mount(el, v);
  },
  unmount: () => base.unmount?.(),
  onState: (s) => base.onState?.(s),
};
```

To only restyle a built-in view, use `"styles": { "covers": "views/covers.css" }`, or style its
classes from your main stylesheet:

- Covers: `.v-view-bar` (the Group by menu), `.v-view-body`, `.v-shelves`.
- Spotlight: `.v-spot-badges` holds `.v-spot-label` (one per store label) and the source badges.
- Spotlight: `.v-spot-stage` (the hero area, which ends where the covers begin) holding
  `.v-spot-hero`, `.v-spot-scrim`, `.v-spot-tools` (the Group by menu) and `.v-spot-content` >
  `.v-spot-info` > `.v-spot-logo`, `.v-spot-meta`, `.v-spot-desc`, `.v-spot-actions`,
  `.v-spot-facts`. Below it, `.v-spot-rows` holds either `.v-spot-strip` (one strip of the
  current list) or, when Group by is set (`[data-grouped]`), one `.v-spot-row` per group with a
  `.v-spot-row-label` and a `<vellum-cover-row>`. Up and down move between rows; up from the
  first row reaches the actions.

## 9. Input and focus

Keyboard, mouse and controller all produce one stream of **nav events**:

| Event | Keyboard | Controller | Default behaviour |
| --- | --- | --- | --- |
| `up` `down` `left` `right` | Arrows | D-pad, left stick | Move focus |
| `confirm` | Enter | A | Covers: open Spotlight. List: launch. Spotlight strip: Play. Buttons: click. |
| `back` | Escape, Backspace | B | Close a menu, clear the search, or return from Spotlight |
| `menu` | Menu key, Shift+F10 | Menu | Context menu for the selected game |
| `details` | Ctrl+I | | Spotlight on the selected game |
| `favorite` | Ctrl+D | X | Toggle favorite |
| `search` | Ctrl+F | Y | Focus the search box (typing elsewhere doesn't) |
| `prevView` `nextView` | Ctrl+Shift+Tab, Ctrl+Tab | LB, RB | Cycle views |
| `pageUp` `pageDown` | Page Up/Down | LT, RT | Jump a page |
| `settings` | Ctrl+, | View | Open settings |

Other keys: Ctrl+1 to Ctrl+9 switch views, Ctrl+R refreshes the library, F11 toggles couch mode,
Ctrl+Shift+I opens DevTools (developer mode), and Home/End jump to the ends of a collection.
Rebinding arrives with the Controls settings page. Controller support arrives with couch mode;
the events are the same, so a skin that works with the keyboard needs no changes.

To intercept an event, call `preventDefault()`:

```js
vellum.input.on("nav", (e) => {
  if (e.name === "left" && myCarouselHasFocus()) {
    e.preventDefault();
    carousel.previous();
  }
});
```

`e.source` is `"keyboard"`, `"shell"` (controller or harness) or `"api"`, and `e.repeat` is true
for held keys.

### Spatial focus

The focus manager moves between elements marked `data-vellum-focus`, choosing the nearest one in
the pressed direction (aligned targets beat closer diagonal ones). It looks inside kit
components too.

```html
<button class="v-button" data-vellum-focus>Shuffle</button>
<div class="hero-card" data-vellum-focus tabindex="0">…</div>
```

- Focusable elements must be able to take DOM focus: buttons, inputs, or `tabindex="0"`.
- `data-vellum-focus-default` marks what to focus when a view opens. It may be on a wrapper;
  the first focus target inside it is used.
- Style focus with `:focus-visible`. `sdk.css` draws a ring in `--v-focus-ring`.

**Focus containers.** A collection of your own can behave like the kit's: give the element
`data-vellum-focus` and these methods, and the focus manager hands it the arrows.

```js
el.vellumNav = (dir) => { /* move your selection; return false at the edge to leave */ };
el.vellumFocusBox = () => selectedItem.getBoundingClientRect();   // where focus leaves from
el.vellumEnter = (fromBox, dir) => { /* focus arrived: pick the item nearest fromBox */ };
el.vellumConfirm = () => { /* confirm on the selected item */ };
```

## 10. Options

Options become a settings page for your skin, in Settings → Skins, with live preview.

```json
"options": [
  { "id": "accent", "label": "Accent color", "type": "color", "default": "#7cc4ff", "cssVar": "--v-accent" },
  { "id": "coverSize", "label": "Cover size", "type": "range", "min": 120, "max": 320, "step": 10,
    "default": 180, "cssVar": "--v-cover-width", "unit": "px" },
  { "id": "heroBlur", "label": "Blur backgrounds", "type": "toggle", "default": false },
  { "id": "corners", "label": "Corners", "type": "select", "default": "10px", "cssVar": "--v-radius",
    "choices": [{ "value": "2px", "label": "Square" }, { "value": "10px", "label": "Rounded" }] },
  { "id": "titleFont", "label": "Title font", "type": "font", "default": "builtin", "cssVar": "--v-font-display",
    "choices": [{ "value": "builtin", "label": "Inter" }, { "value": "fonts/Fraunces.woff2", "label": "Fraunces" }] },
  { "id": "backdrop", "label": "Backdrop", "type": "image", "default": "images/dunes.jpg", "cssVar": "--backdrop",
    "choices": [{ "value": "images/dunes.jpg", "label": "Dunes" }, { "value": "images/city.jpg", "label": "City" }] }
]
```

| Type | Value | With `cssVar`, the variable is set to |
| --- | --- | --- |
| `color` | `"#rrggbb"` | the color |
| `range` | number (`min`, `max`, `step`) | the number plus `unit` |
| `select` | one of `choices[].value` | the value |
| `toggle` | `true` / `false` | `1` / `0` |
| `font` | `"builtin"` or a font file in your folder | a font-family list (the file is loaded for you) |
| `image` | an image file in your folder | `url("…")` |

Variables are set on `:root`, so `--v-*` tokens can be options directly. Toggles and selects
also set an attribute on `<html>`: toggle `heroBlur` adds `data-opt-hero-blur` while it is on,
and select `artStyle` sets `data-opt-art-style="sketch"`. Both work well with CSS:

```css
:root[data-opt-hero-blur] { --v-blur: 18px; }
:root[data-opt-art-style="sketch"] vellum-grid::part(art) { box-shadow: 0 0 0 1px #000; }
```

The kit lays out again when options change, so options like cover size or art style apply at
once.

All values are also in `vellum.skin.options`, and `vellum.skin.on("options", cb)` reports changes.
Values are stored in Vellum's settings, not in your folder, so a shared skin starts from its
defaults on another PC. **Reset options** restores them.

## 11. Art

Every entry always has all five kinds of art, so you never need to check before drawing:

| Kind | Shape | Typical source |
| --- | --- | --- |
| `cover` | Portrait 2:3 | 600 × 900 to 1200 × 1800 |
| `hero` | Wide, about 3.1:1 | 1920 × 620 to 3840 × 1240 |
| `logo` | Transparent, any shape | up to 1280 wide |
| `header` | Landscape, about 2.14:1 | 460 × 215 to 920 × 430 |
| `icon` | Square | 32 to 256 |

Vellum looks for each kind in order: the user's own choice (Change art…), the store's images
on this PC, the store's image servers, SteamGridDB (when the user has entered a key), and
finally a generated placeholder: a two-tone image from the title's hash, with the title set on
it (logos are the title on a transparent background). Downloads happen in the background, so
an entry can start on a placeholder and upgrade a few seconds later: the library updates and
the entry's art URLs change. `entry.artStatus[kind]` tells you which one you got (`"local"`,
`"remote"` or `"placeholder"`). You might hide the title caption for real covers but keep it
for placeholders:

```css
vellum-grid::part(caption) { display: none; }
```

```js
if (entry.artStatus.logo === "placeholder") showStyledTitle(); else showLogo();
```

`<vellum-logo>` already does this.

**Sizes.** Always ask for the size you draw (`vellum.art.url(id, kind, width)` or an element);
the kit does this for you. Vellum resizes once and caches the result, so 3,000 covers load at
320 pixels instead of 1200. Use `"full"` only for art that fills the screen. Art URLs carry a
version, so the browser caches them forever and a changed image gets a new URL.

### Art styles

Vellum can redraw art for skins with a hand-made look. Set a token, usually from an option:

```css
:root { --v-art-style: watercolor; --v-icon-style: sketch; }
```

```json
{ "id": "artStyle", "label": "Cover art", "type": "select", "default": "photo", "cssVar": "--v-art-style",
  "choices": [{ "value": "photo", "label": "As published" }, { "value": "watercolor", "label": "Watercolor" },
              { "value": "sketch", "label": "Pencil sketch" }] }
```

- **`sketch`**: monochrome graphite on warm paper. Edges become pencil lines, the darks get
  cross-hatching, and the paper's tooth shows through.
- **`watercolor`**: flat, painterly washes with pigment pooled at the edges, granulation, light
  areas left as paper and an unpainted, deckled border.

Any other value (such as `photo`) means the art as published. Logos are never restyled, and
neither are placeholders. The art URL gets `&fx=<style>`. Styled art keeps the resolution of the
plain art, up to 3840 px wide, and brush strokes are sized for how each kind is shown, so a
styled hero is as sharp as the original. The backend draws each style once per size and caches
it beside the resized art (about 0.15 s for a 1920 px hero, 0.5 s at 4K), so only the first view
of each image is slower. The dev harness serves
originals and ignores `fx`; check styles in Vellum itself. To try a style on any image:
`cargo run --release --example art_style_preview -- cover.jpg 640 out/`.

Both styles are light, like paper. On a dark skin, give styled art a frame or shadow so it reads
as a print, and keep text off it.

**Hand-drawn glyphs.** For interface icons (the kit's glyph parts above), an SVG filter gives
an inked, slightly wobbly line. Put the filter in its own file in your skin and point at it with
`filter: url("textures/hand.svg#hand")`. A filter defined inside `index.html` doesn't reach the
kit's shadow-DOM parts in Chromium, but a filter in a separate file does. The Frontier skin has a
ready-made one. Keep filters off small text: they cost contrast.

## 12. Developer mode

Turn it on in Settings → Developer, or start Vellum with `--dev`. Then:

- Vellum watches your active skin's folder. A changed `.css` file is swapped in without a reload.
  Any other change reloads the skin, and the shell keeps the view, selection, search and filters.
  A changed `plugin.json` is re-read (new options and views appear).
- Errors thrown by your code appear in an overlay at the bottom of the window, with the stack.
- Ctrl+Shift+I opens DevTools. Choose your skin's frame (`skin.localhost`) in the console's
  context menu to inspect it.
- **Reload skin** in Settings → Developer reloads on demand.

Outside developer mode, errors still go to the log (Settings → Developer → Open logs folder).

## 13. Worked examples

### Example 1: token-only skin

*Recolor everything with one stylesheet.* (`tests/fixtures/dev-plugins/skins/token-test`)

`plugin.json`:

```json
{
  "id": "token-test",
  "type": "skin",
  "name": "Token test",
  "version": "1.0.0",
  "apiVersion": 1,
  "entry": "index.html",
  "skin": { "defaultView": "covers", "window": { "background": "#f4f1ea" } }
}
```

`index.html` is the smallest possible skin: the SDK's styles, yours, the SDK, and the default layout.

```html
<!doctype html>
<html>
<head>
  <link rel="stylesheet" href="/__vellum/sdk.css">
  <link rel="stylesheet" href="skin.css">
  <script type="module" src="/__vellum/sdk.js"></script>
</head>
<body><vellum-app></vellum-app></body>
</html>
```

`skin.css` sets tokens and nothing else:

```css
:root {
  color-scheme: light;
  --v-bg: #f4f1ea;
  --v-surface: #e9e4d8;
  --v-surface-raised: #ddd6c6;
  --v-text: #1f1a14;
  --v-text-muted: #6b6255;
  --v-accent: #c2185b;
  --v-accent-text: #ffffff;
  --v-focus-ring: #c2185b;
  --v-radius: 2px;
  --v-gap: 22px;
  --v-font-body: Georgia, "Times New Roman", serif;
  --v-font-display: Georgia, "Times New Roman", serif;
  --v-cover-width: 150px;
  --v-list-row-height: 36px;
  --v-hero-overlay: linear-gradient(90deg, rgb(244 241 234 / 0.95) 0%, rgb(244 241 234 / 0.6) 45%, transparent 80%);
}
```

Every view follows, including the Play button and list rows inside the kit's shadow roots.
`color-scheme: light` makes scrollbars and native controls light too. Basis
(`plugins/skins/basis/skin.css`) adds a few selectors on top of the same idea.

### Example 2: a rearranged layout

*Arrange kit components your own way, frameless, with per-view CSS.*
(`tests/fixtures/dev-plugins/skins/sidebar-test`)

Instead of `<vellum-app>`, `index.html` places the pieces itself: a sidebar with search, views
and menus, and a title bar with window controls above the view outlet.

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <link rel="stylesheet" href="/__vellum/sdk.css">
  <link rel="stylesheet" href="skin.css">
  <script type="module" src="/__vellum/sdk.js"></script>
</head>
<body>
  <div class="layout">
    <aside class="sidebar" data-vellum-drag>
      <div class="brand">Vellum</div>
      <vellum-search></vellum-search>
      <vellum-view-switcher></vellum-view-switcher>
      <div class="tools">
        <vellum-filter-bar></vellum-filter-bar>
        <vellum-sort-menu></vellum-sort-menu>
      </div>
      <button class="v-button settings" data-vellum-focus>Settings</button>
    </aside>
    <main>
      <header class="titlebar" data-vellum-drag>
        <span class="count"></span>
        <vellum-window-controls></vellum-window-controls>
      </header>
      <vellum-view-outlet></vellum-view-outlet>
    </main>
  </div>
  <script type="module" src="count.js"></script>
</body>
</html>
```

The manifest makes the window frameless, adds an option, and loads extra CSS only for Covers:

```json
"skin": {
  "defaultView": "covers",
  "window": { "frameless": true, "background": "#101418" },
  "styles": { "covers": "covers.css" },
  "options": [
    { "id": "sidebarWidth", "label": "Sidebar width", "type": "range", "min": 200, "max": 320,
      "step": 10, "default": 240, "cssVar": "--sidebar-width", "unit": "px" }
  ]
}
```

`skin.css` lays it out and reaches into the view switcher with `::part()` to stack its tabs:

```css
.layout { display: grid; grid-template-columns: var(--sidebar-width) 1fr; flex: 1; min-height: 0; }
.sidebar { display: flex; flex-direction: column; gap: 14px; padding: 18px 14px; background: var(--v-surface); }
.sidebar vellum-view-switcher::part(tabs) { flex-direction: column; align-items: stretch; width: 100%; background: transparent; }
.sidebar vellum-view-switcher::part(tab) { justify-content: flex-start; }
main { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.titlebar { display: flex; align-items: center; justify-content: space-between; height: 40px; padding-left: 16px; }
```

`covers.css` applies only while Covers is shown:

```css
.v-view[data-view="covers"] vellum-grid::part(art) { border-radius: 4px; }
.v-view[data-view="covers"] .v-view-bar { display: none; }
```

`count.js` is a little skin code. Note that the button's handler is attached here: inline
`onclick` attributes are blocked by the security policy.

```js
import vellum from "/__vellum/sdk.js";

const el = document.querySelector(".count");
const update = () => {
  const n = vellum.library.query().length;
  el.textContent = `${n} game${n === 1 ? "" : "s"}`;
};
await vellum.ready();
update();
vellum.library.on("change", update);
vellum.state.on("change", update);

document.querySelector(".settings").addEventListener("click", () => vellum.actions.openSettings());
```

### Example 3: a custom view

*Add a Timeline view after Covers, reachable with Ctrl+4.*
(`tests/fixtures/dev-plugins/skins/timeline-test`)

```json
"skin": {
  "defaultView": "timeline",
  "views": [
    { "id": "timeline", "name": "Timeline", "entry": "views/timeline.js",
      "placement": { "after": "covers" }, "couch": true }
  ]
}
```

`views/timeline.js` groups the current query by release year, one `<vellum-cover-row>` per year.
Arrows, confirm, favorites, the context menu and selection all work, because the rows are kit
collections:

```js
let unsubs = [];
let root = null;

function render(vellum) {
  const byYear = new Map();
  for (const e of vellum.library.query()) {
    const year = e.metadata.releaseDate?.slice(0, 4) ?? "Unknown";
    if (!byYear.has(year)) byYear.set(year, []);
    byYear.get(year).push(e);
  }
  const years = [...byYear.keys()].sort((a, b) => (a === "Unknown" ? 1 : b === "Unknown" ? -1 : b.localeCompare(a)));
  root.replaceChildren(
    ...years.map((year, i) => {
      const section = document.createElement("section");
      const h = document.createElement("h2");
      h.textContent = year;
      const row = document.createElement("vellum-cover-row");
      row.entries = byYear.get(year);
      if (i === 0) row.setAttribute("data-vellum-focus-default", "");
      section.append(h, row);
      return section;
    }),
  );
}

export default {
  mount(el, vellum) {
    root = document.createElement("div");
    root.style.cssText = "flex:1; overflow-y:auto; padding: 8px 0 32px";
    el.append(root);
    render(vellum);
    unsubs = [vellum.library.on("change", () => render(vellum))];
  },
  onState(state) {
    // Re-render when the query changes, not on every selection.
    const key = JSON.stringify([state.query, state.filters, state.sort]);
    if (key !== this.key) {
      this.key = key;
      if (root) render(window.vellum);
    }
  },
  unmount() {
    unsubs.forEach((u) => u());
    root = null;
  },
};
```

The view list becomes List (Ctrl+1), Covers (Ctrl+2), Timeline (Ctrl+4), Spotlight (Ctrl+3):
built-ins keep their keys wherever they sit.

## 14. Checklist before sharing a skin

- [ ] It works in the harness with 10 games and with 3,000 (`npm run dev:skin`, then the Mock games menu).
- [ ] Every view is usable with the keyboard alone, and couch views with the controller buttons in the harness panel.
- [ ] Focus is always visible.
- [ ] Empty states read well: search for something that doesn't exist.
- [ ] Placeholder art looks fine (the mock library deliberately lacks some art).
- [ ] No console errors, and no inline scripts or handlers.
- [ ] Options have sensible defaults, and Reset options looks right.
- [ ] `preview.jpg` exists, and `version` is bumped.
- [ ] Share the folder (or, later, a `.vplugin` zip of it).

### Example: a view with its own focus container

*Frontier's Catalogue* (`extras/skins/frontier/views/catalogue.js`, `leaf.js`,
`catalogue-ads.js` and `catalogue.css`) lays the library out as a bound mail-order catalogue,
read a spread (two facing pages) at a time. It has a title page, Contents listing every game
with its page number, a divider page per department, one game per page, and advertisements in
the gaps. It shows how to:

- make your own collection a **focus container** (`vellumNav`, `vellumFocusBox`, `vellumEnter`,
  `vellumConfirm`): Left/Right move between the two pages and turn the leaf at the edge, Up/Down
  move through the Contents lines, Page Up/Down jump between departments, and Up from a game's
  page leaves for the toolbar. Elements inside a container (here the Play button) are skipped
  by the focus manager, so keep tabs and other buttons outside it;
- take **Back** for yourself with `vellum.input.on("nav", e => …)` and `e.preventDefault()`
  (Back returns to the Contents), but only when focus is inside your view, so popovers and the
  search box keep their own Back;
- paginate to the space available, measured with a `ResizeObserver`, and draw only the pages on
  screen;
- animate with `requestAnimationFrame`, changing only `transform` and `opacity` per frame, so the
  page content is painted once (`leaf.js` turns a leaf of eight hinged strips, each showing its
  slice of a copy of the page). Respect `prefers-reduced-motion`; the Catalogue cross-fades;
- ask for styled art per element: `vellum.art.url(id, "hero", 1280, "watercolor")` prints the
  figure hand-coloured, whatever the skin's own art style;
- import other modules of your skin from a view (`import … from "./leaf.js"`) and find files
  next to it with `new URL("../textures/x.svg", import.meta.url)`;
- load a view's stylesheet with `@import` from the main stylesheet, and fonts with `url()`
  relative to that file.

**Adding an advertisement to the Catalogue.** Append an object to the list in
`views/catalogue-ads.js`. The comment at the top documents the fields: `sizes` says where it may
go (`"full"` page, `"box"` panel or `"strip"`), `when(ctx)` limits it to libraries it suits, and
`render(ctx)` returns the copy (headline, body, price, fine print, a stamp such as "Not Available
by Mail", and an ornament or a game's art). `ctx` offers facts about the library, such as the
most neglected installed game, the newest arrival or the largest department. Placement is
seeded by the library, so an advertisement stays on the same page between visits. Engravings
for ornaments go in `textures/ads/`.
