# Decisions

## 2026-10-21 — Window placement; store playtime; Grand Tourer's varied wear and floor reflection

- **The window comes back where it was.** `window_state.rs` saves the normal (un-maximized) position and size, in physical pixels, and whether the window was maximized.
  - **Where:** `window.json` in the data folder, so a portable copy keeps its own placement.
  - **When:** the placement is tracked as the window moves and resizes, and written on close and on exit. While the window is maximized or minimized, only the flag changes, so un-maximizing returns to the last normal size.
  - **On start:** the window is hidden (`"visible": false`) until it has been placed, so it never flashes at the default size.
  - **Unplugged monitors:** a saved position is used only if enough of the window's top strip (80 px wide, 24 of its top 40 px) is on a connected monitor. Otherwise the window opens centred at the saved size.
  - **Why not a plugin:** a hand-rolled module rather than `tauri-plugin-window-state`, which saves to its own config folder and would ignore portable mode.
- **Store playtime is part of the library.** `ProviderGame` and `Entry` gain `playtimeMinutes` and `lastPlayed`, an addition to the spec's model.
  - **Steam:** the provider reads both from the active account's `localconfig.vdf` (`Software/Valve/Steam/apps/<appid>`). They count every session, not only Vellum's launches.
  - **Watched:** the file is watched, so new playtime arrives when Steam writes it as a game closes.
  - **Other stores:** Epic and GOG don't keep playtime locally in a form we read yet.
- **Grand Tourer's wear varies, and play wears it too.**
  - **Starts:** each start costs 5–14% (uniform).
  - **Play:** hours on the store's clock cost 3% an hour on average, varied by up to 40% each time and capped at 60% for one stretch.
  - **The odometer:** the skin keeps the store's minutes as last seen (`p`). The first reading only records it, so play from before Grand Tourer, or from before this change, costs nothing.
  - **Shown on the card:** the Garage card shows Mileage (hours), and the condition note says what the last wear cost.
- **The Garage reflection is a true floor reflection.** It used to be the model's own projection flipped about a fixed line, so wherever the base wasn't on that line (the near and far corners in perspective), the reflection came away from the model.
  - **How:** a floor mirrors the model in 3D, seen from the same eye. That is the same as flipping a view of the model from an eye mirrored below the floor. So the mirrored copy uses `perspective-origin: 50% 150%`: its eye is at the model's centre, mirrored about its base.
  - **Faces:** the mirrored copy now culls back faces normally.

## 2026-10-21 — Redline becomes Grand Tourer; menu sounds

- **Renamed for what it imitates, but the id stays `redline`.** "Grand Tourer" is what GT stands for, and the title screen's tagline, "The Real Gaming Library", nods at the series' own. Changing the id would orphan the active-skin setting and every game's condition, which `vellum.skin.storage` keys by skin id, so only the display name, title and wordmark changed. The folder is still `extras/skins/redline`.
- **Menu sounds are synthesized like the engine sounds** (`sound.js` `ui()`, wired up in `menu-sounds.js`): glassy ticks and bell chimes, an air swoosh between modes, and a soft knock at an edge. The skin only listens: it observes `vellum.input.on("nav")` and never calls `preventDefault`.
  - **Moved or blocked:** whether a step moved is judged two frames later, from whether the selection or DOM focus changed. `state.set` is optimistic, so the selection is already updated by then.
  - **Mouse:** a selection change with no step pending ticks; trusted clicks on buttons chime. Clicks inside kit collections are left to the selection tick, and programmatic clicks (from a confirm) are skipped, so nothing doubles. The same sound never repeats within 45 ms.
  - **Option:** the sounds have their own "Menu sounds" toggle and share the volume slider.

## 2026-10-21 — Frontier's Catalogue as a bound book

- **Spreads, not a listing plus a plate.** The Catalogue is a flat list of pages read two at a time:
  - front matter: the inside cover, the title page, the house guarantee and How to Order;
  - the Contents, listing every game in the query with its page number, over as many spreads as needed;
  - for each department, a divider page on the left facing its first game, then one game per page;
  - the want list and a colophon.
- **Gaps between departments.** When a department ends on a left-hand page, the facing page takes a full-page advertisement, or a ruled Memoranda page when advertisements are off.
- **Contents capacity.** The number of lines in a column is measured from the page height. Department headings never sit alone at the foot of a column.
- **Leaves bend by strips, not WebGL.** The pages are live HTML (the Play button, focus, text), which can't be turned into a texture cheaply. A turning leaf is eight vertical strips, each hinged to the one before it, and the strips nearer the fore-edge lead so the paper curls. Each strip shows its slice of a fresh copy of the page.
  - **Shading:** an even tone and a ramp per strip, changed by opacity only.
  - **Cast shadow:** a band moved by `transform`.
  - **Cost:** a turn never repaints page content. Most of its main-thread time is building and laying out the copies at the start, about 200 ms per turn in headless Chromium.
  - **Riffle:** jumps of more than one spread riffle up to five leaves.
  - **Drag:** a margin can be clicked to turn, or dragged; the leaf follows the pointer by inverting the fore-edge position.
  - **Reduced motion:** with reduced motion or Frontier's still mode, pages cross-fade.
- **The cover opens once per session** (sessionStorage), then the book turns to the last page read. That is the page saved in the skin's storage when nothing has been selected since, else the selected game's page, else the Contents.
- **Advertisements are data** (`views/catalogue-ads.js`).
  - **Placement is seeded** by the sorted entry ids and the advertisements setting, and each one has a turn before any repeats. The same library therefore always shows the same advertisements in the same places.
  - **Kinds:** novelty goods (some stamped "Discontinued" or "Not Available by Mail", as in RDR2's catalogue), notices built from the user's own library (neglected, recently played, newly arrived, heaviest, the largest department), and house notices.
  - **Settings:** None, Sparing (the default: gaps, the foot of the Contents and a full page every 9 to 12 games) and Generous (every 5 to 7 games, plus a strip on each game's page).
- **Small windows.** The book's type stops shrinking at 10 px, so at small sizes a page holds fewer ems. The page is a size container, and below 50 em tall the game page drops its testimonial and tightens the stamp and figure.

## 2026-10-21 — Core and extras plugins

- **Optional plugins live in `extras/`, not `plugins/`.** `plugins/` keeps only what the launcher needs on its own: the Steam, Epic, GOG and custom providers and Basis, the default skin (the fallback when a skin fails). The other skins, both QoL modules and the mock provider (disabled by default, used by the skin harness) moved to `extras/`, which has the same `providers|skins|modules` layout. Debug builds scan `extras/` whenever they use the repo's `plugins/`. Packaged builds have a single `plugins/` folder: the extras are copied into it, so installing, removing or sharing a plugin is still one folder. Releases ship two zips, the launcher with core plugins and an extras zip laid out to extract over it. `package-portable.ps1 -NoExtras` builds the folder without them, and `-Zip` writes both release zips.

## 2026-10-20 — Local store metadata, launch hooks, Redline's wear and tear

- **Store metadata from local caches, pulled forward from Phase 4.** Steam's `appcache/appinfo.vdf` already holds developer, publisher, genres and release date for every app the client knows, offline. `src-tauri/src/formats/appinfo.rs` reads versions 27 to 29 (v29 keeps keys in a string table, so the binary KeyValues reader now takes either inline or indexed keys) and returns only those fields for the apps asked for. Providers call it as `ctx.formats.steamAppinfo(bytes, appids)`, an addition to the provider API in the spec. Steam genre ids are mapped to names in the provider; store descriptors that aren't genres (Early Access, Free to Play, content warnings) are dropped. Epic's `Data/Catalog/catcache.bin` (base64 JSON) gives the developer only: it has no genres or release dates, so those wait for Phase 4's online metadata. The catalog folder is a second, optional Epic location.
- **`vellum.actions.onBeforeLaunch(hook)`** lets a skin hold or call off launches it starts. Hooks run in order; `false` cancels; a hook that throws is ignored so a skin bug can't block launching. Launches the shell starts (its context menu) don't run skin hooks.
- **Redline's condition is skin state, not library data.** It lives in `vellum.skin.storage` (per machine, per skin), costs 12% per start, and below 40% a start fails with a chance rising to 75% at 0% (never certain, so cranking again can still work). The service minigame (wash, then a timed tune-up) restores it. Sounds are synthesized with Web Audio, so no recordings are shipped. Overlays keep a stack so only the topmost takes input.

## 2026-10-20 — Art styles and skin contrast

- **Art styles are drawn in Rust, not with CSS or SVG filters.** Sketch (a colour dodge of the image over its blurred inverse, with hatching and paper tooth) and watercolor (a Kuwahara filter, tonal snapping, edge pooling, granulation and a deckled border) need neighbourhood operations that CSS filters can't express. As SVG filters on thousands of pooled cells they would cost far more than a one-time render. `src-tauri/src/art/style.rs` renders each style once per cached width (`{key}-{w}-{style}`), and art URLs ask for it with `fx=`. Skins choose a style with the `--v-art-style` and `--v-icon-style` tokens, so no new bridge API is needed.
- **Styled art is as sharp as the plain art.** Styles render at the requested width up to 3840 px (`style::MAX_STYLED_WIDTH`), with brush size set per kind (heroes and headers are shown at about their pixel size, covers well below it), and the source's fine detail is drawn back over the watercolor washes as ink. The work runs in row bands across cores, and the Kuwahara tables are kept per band, so 4K stays fast and small. `style::VERSION` is part of the cache key, so changing a style re-renders.
- **Hand-drawn interface glyphs are an SVG filter in a skin file.** Chromium doesn't apply a `url(#id)` filter defined in the document to shadow-DOM parts, but it does apply one from a separate same-origin SVG file. The kit gives its glyphs parts (`icon`, `caret`, `chevron`) so skins can target them.
- **Select options are exposed as `data-opt-<id>="<value>"`**, as toggles already were, so skins can style by choice without matching inline styles.
- **Atmosphere stays behind the interface.** Frontier's film grain had been an overlay above everything (z-index 90 at 55% opacity), which lowered the contrast of all text and icons and made the screen look out of focus. Skin guidance is now: fog, grain and particles sit under the UI; body text keeps at least 4.5:1 against what is actually behind it, and icons and large type keep at least 3:1; the selected item is the sharpest thing on screen.

## 2026-10-20 — Phase 3 (skin system, views, input model, art v0) choices

- **One host controller, two backends.** The shell's skin host (`shell/src/host/controller.ts`) owns UI state, answers bridge calls and pushes changes to the skin. It knows nothing about Tauri: the app gives it a Tauri backend, and the skin dev harness gives it a mock backend over the mock provider. The harness therefore exercises the real bridge validation, state handling, context menu and overlays, and the Playwright suite runs against it without Rust.
- **The shell owns state; the SDK applies selection locally first.** `state.set` updates the SDK's copy immediately and the shell's echo replaces it, so arrow-key navigation doesn't wait on postMessage round trips. The last view, selection, sort, grouping and filters are saved in `settings.json` (`ui.last`) and restored at startup; the search text is not.
- **Search, filter, sort and grouping run in the SDK** (`sdk/src/query.ts`), shared by every view and skin and exported for skin code. Search folds case, accents and punctuation; a term matches as a substring or as a chain of word prefixes ("hk", "holkni"). Sort keys carry a natural direction (titles A→Z, dates and sizes newest/largest first); a `-` prefix reverses it, and missing values always sort last.
- **View order** (`sdk/src/view-order.ts`): skin views are placed by anchor, and views sharing an anchor keep manifest order. Once the user reorders, the full order is saved. New views (for example from a newly activated skin) go after their nearest placed neighbour, and views placed last stay last. Hotkeys: Ctrl+1–3 are fixed to List/Covers/Spotlight; visible skin views get Ctrl+4–9 in display order.
- **Confirm in Covers opens Spotlight; double-click launches.** This follows the spec's controller table (A on a cover opens Spotlight; A in Spotlight plays) and keeps keyboard and controller identical. List launches on Enter, as the spec says for List.
- **Spotlight focuses the cover strip by default:** left/right step through games (spec), confirm plays, and Up reaches Play/Favorite/Change art. With Play focused by default, Right would have meant "next button" and contradicted the spec.
- **Spotlight layout (user feedback):** the hero ends above the covers instead of running under them, and a scrim token (`--v-spot-scrim`, plus an optional `--v-spot-panel`) sits behind the title and text so they stay readable on bright art. With Group by set, Spotlight shows one cover row per group, streaming-app style; up/down move between rows (the view handles them, so rows partly scrolled out of view still work), and up from the first row reaches the actions.
- **Store labels (user feedback).** Providers may give each game up to three short `labels`, shown as badges on covers, in List and in Spotlight. Steam labels demos and playtests by name ("Half Sword" and "Half Sword Demo" have near-identical art, so they need a visible badge) and marks soundtracks: Steam installs them under `steamapps/music`, which is a reliable local signal; names ending in Soundtrack/OST are a fallback. Soundtracks are kind `other`.
- **Tools and soundtracks are filtered, not dropped.** Steam now reports everything installed; the default filter shows games only. Filters → "Tools and redistributables" and "Soundtracks and other extras" are the display toggles, both off by default. The Steam provider's "Show tools" setting was removed.
- **Epic manifests (found on the user's machine):** base games leave `MainGameAppName` empty, and add-ons set it to their base game. An entry is DLC only when that field names another app; the spec's "equals AppName" rule would have dropped every base game.
- **A frameless window always has window controls (user feedback).** Skins with wide top bars pushed the min/max/close buttons off screen, and the Settings drawer covered them. Now `<vellum-app>`'s tools area clips instead of pushing, and narrow windows drop the game count, shorten search and hide Sort. The Settings drawer has its own controls for frameless skins. As a safety net, the SDK pins a set of controls to the top-right corner whenever a frameless skin shows none fully on screen.
- **Selection state as part names.** CSS can't combine `::part()` with attribute selectors, so the kit adds `cell-selected`, `art-selected`, `art-focused`, `row-selected` and `tab-selected` part names. Skins style selection and focus without kit changes.
- **Shipped skins:** Basis (default), Synthwave, Aero (Frutiger Aero), Gridline (neon-on-black, Tron-like) and Calling Card (a style homage to Persona 5's menus; fan-made, no original assets, fonts or logos). Their fonts (Monoton, Orbitron, Rajdhani, Nunito, Anton, Archivo Black, Bebas Neue) are SIL OFL 1.1 from the Fontsource packages, with each font's license file beside it. Every animation honours `prefers-reduced-motion` and has an option to turn it off; Gridline's canvas also pauses while the window is hidden.
- **Collections are focus containers.** Grid, list and cover rows take DOM focus themselves and move the selection internally (index math, so virtualization doesn't matter). The geometric search (`focus-math.ts`) only runs when a move leaves a container. Custom collections can join with `vellumNav`/`vellumFocusBox`/`vellumEnter`/`vellumConfirm`.
- **Keys pressed inside the skin are handled by the SDK**, which turns them into nav events, view hotkeys or shell commands (`shell.command`: refresh, couch, DevTools). Keys pressed while the shell has focus (Settings open) are handled by the shell. Rebinding arrives with the Controls page (Phase 6). Favorite is Ctrl+D and details is Ctrl+I, because plain letters start a search.
- **Settings is a drawer over the skin**, not a separate screen, so skin options preview live. It uses the skin's colors: the SDK reports its resolved tokens (`ui.theme`, validated: known tokens only, no `url(`), and the shell maps them to `--skin-*` variables with fallbacks, so a broken skin can't make Settings unreadable.
- **Option values for `font` and `image`** are chosen from `choices` (files in the skin), like `select`. Toggles also set `data-opt-<kebab-id>` on `<html>` for CSS selectors.
- **Skin-side storage:** `vellum.skin.storage` namespaces `localStorage` by skin id (all skins share one origin; see the Phase 0 decision).
- **Skin load failure** = no SDK handshake within 6 s. The shell then shows Basis for the rest of the session (a runtime override, not a settings change) and says which skin failed. Activating a skin again clears the override.
- **Placeholders are SVG**, generated identically by Rust (`art/placeholder.rs`) and TypeScript (`sdk/src/placeholder.ts`); `tests/fixtures/placeholders.json` keeps them byte-identical. SVG is crisp at every size and costs nothing to resize. Text uses Inter/Segoe UI from the system, because fonts can't load inside an image.
- **Art v0 serving.** Provider `art()` runs once per game in a single QuickJS runtime (`host::invoke_each`, 30 s budget for the batch) after each scan; candidates are validated (known kind; image file inside the provider's scope or its own folder; https URL on an `artHosts` host) and stored in the snapshot with mtime and size. Art URLs carry a version (hash of path, mtime and size, or of the title for placeholders), so responses are cached as immutable. Resizing runs on a fixed pool of 2–6 threads (a screen of covers must not decode 150 originals at once), never upscales, writes JPEG q90 for opaque images and PNG for transparent ones, and caches variants in `cache/art/variants/`. Remote candidates are kept but not downloaded until Phase 4.
- **Providers may read their own folder** (`ctx.pluginDir`), for bundled data and art. It is not a run root: `ctx.run` still only starts exes in declared locations or the game's install folder.
- **Steam's newer cache layout.** Found on the user's machine (2026 client): many apps have no `library_600x900`; they have `library_capsule.jpg` (300×450), `library_header.jpg` (460×215) and `library_hero.jpg` in hashed subfolders, plus a 32×32 `<sha1>.jpg` icon at the top of the app folder. The provider now uses these as fallbacks (cover order: 600×900 nested, 600×900 flat, then capsule). Fixtures and a test cover both layouts.
- **Mock art is generated, not committed** (`npm run mock-art`, a Rust example that renders 80 sets at real resolutions with Inter Display, about 29 MB, in about 30 s). The titles come from running the mock provider itself. Larger mock libraries reuse the 80 sets. Some games deliberately lack a cover, hero, logo or header. The package script generates the art when it's missing. Without it, the harness shows placeholders.
- **The harness serves art at full size** (Node has no image library); the app resizes.
- **Performance check.** With 3,000 covers at 3840×2160, the grid keeps about 200 pooled cells. Main-thread work per frame is about 1.5 ms script plus 2.4 ms style/layout (Playwright, headless Chromium). Headless wall-clock frames are 26 ms on average, but hiding every image changes nothing; the time is headless software compositing of 8.3 MP, not the kit. At 1600×950 it holds 16.7 ms. The e2e test asserts the main-thread budget (< 6 ms per frame) and virtualization. The 60 fps target at 4K still needs a real 4K display.
- **Bundled font:** Inter (SIL OFL 1.1), variable weight, served at `/__vellum/fonts/InterVariable.woff2`. The art generator uses Inter Display Bold (TTF, in `scripts/mock-art/`).
- **Dependencies are optimized in debug builds** (`[profile.dev.package."*"] opt-level = 2`): image decoding and resizing are far too slow unoptimized. Our own crate stays fast to compile.
- **DevTools in release builds** need the `devtools` feature of the `tauri` crate; the command refuses unless developer mode is on.
- **Window actions go through Rust commands** (`window_action`) instead of widening the shell's capabilities. The skin's `window` section (frame, minimum size, background) is applied at startup and on skin changes.
- **Test skins live in `tests/fixtures/dev-plugins/skins/`** (token-only, sidebar layout, timeline view). Debug builds list them, and they are the three worked examples in `docs/skin-authoring.md`.

## 2026-10-20 — Phase 2 (provider host, Steam, thin skin path) choices

- **One fresh QuickJS runtime per call** (scan, launch, watch, …). Startup costs about 1 ms; scope, deadline and memory cap are per call. Folders added with `ctx.fs.allow` during a scan are kept by the host and given to later calls (launch, watch) for that provider.
- **`ctx` is frozen** and built over a private native object that is deleted before provider code runs, so provider code can't reach unchecked host functions or swap `ctx` methods.
- **`denyFiles`** is a new manifest field (`provider.denyFiles`): `ssfn*` matches a file name anywhere in scope; `config/loginusers.vdf` matches a path ending in those segments. Steam declares its login/account files there. Denied files can't be read, and `glob` hides them.
- **`ProviderGame.hidden`** is a new optional field: the store hides this game (Steam's hidden collection). The user's own hide/unhide in `userdata.json` overrides it.
- **`ctx.sqlite` is deferred.** No v1 provider needs it (GOG Galaxy's database is a "later improvement" in the spec), so it throws a clear error until then. This avoids compiling bundled SQLite now.
- **Steam account choice** uses the most recently modified `localconfig.vdf`. A provider setting `account` overrides it, but there is no UI for it yet, because select options can't list choices that only the provider knows. Revisit with the settings work in Phase 3/6.
- **The mock provider is one provider**, with its games spread across three fictional stores in `launchData.fakeStore`. A `count` setting (10–5000) scales it for performance work. Mock art arrives in Phase 3.
- **A provider whose required location is missing is inactive:** its games are hidden (they can't launch) and a notice offers Browse / Skip for now / Disable. Skip lasts for the session. A provider that throws or times out keeps its last results and gets an error status.
- **Entry ids** stay "id of the primary record" (spec). With one source per entry until Phase 5, they're stable; revisit when merging changes the primary.
- **`--diagnose`** reduces names to patterns (`appmanifest_<n>.acf`, `<hash>`), account folders to `<account-n>`, library paths to `<library-n>`, the user profile to `%USERPROFILE%`, and file contents to key/type shapes. Verified on a real install: none of 181 identifying strings appeared in the report. Release builds attach to the parent console so the summary prints.
- **Robustness, learned from the real library:** (1) A title starting with a multi-byte character made `sort_title` slice through a character and panic. (2) That panic happened inside a synchronous Tauri command, which runs on the WebView2 callback thread and can't unwind, so the process aborted. Fixed both, and also: data commands are `async` (a bug fails one call, not the app), JSON stores ignore lock poisoning, and every JSON reader accepts a UTF-8 BOM (Windows editors add one).
- **Skins see entries only through the SDK.** The SDK keeps a read cache; writes go to the shell, which validates every call (origin, source window, method allowlist, argument shapes, and that the entry exists) before invoking the backend.

## 2026-10-19 — Phase 1 (Foundation) choices

- **Phase order.** We follow the revised phasing (Phase 0 spikes; mock provider and a thin skin path moved into Phase 2; art v0 and keyboard focus moved into Phase 3), not the spec's milestone list verbatim. Reasons: the spec's M2 needs a skin before M3 builds the skin system, and M3's views need art before M4.
- **Dev-only broken plugins.** Debug builds also scan `tests/fixtures/dev-plugins/`, so the Plugins page always shows example manifest errors without ever shipping broken plugins. Set `VELLUM_NO_DEV_PLUGINS=1` to hide them. Debug builds use the repo's `plugins/` when no `plugins/` folder sits beside the exe.
- **CLI flags.** `--data-dir <path>` and `--plugins-dir <path>` override locations (tests, profiles). `--print-plugins [--out file]` writes the discovery result as JSON and exits without a window; release builds have no console, so `--out` is how scripts read it. Unknown flags are ignored so later flags can be added freely.
- **Settings file.** The settings file is typed (`Settings`) but keeps unknown keys, so a downgrade doesn't drop data written by a newer version. A file from a newer schema is backed up as `settings.json.v<N>.bak` before it's rewritten. An unreadable file is renamed to `settings.json.corrupt` and defaults are used. Writes are atomic (temp file + rename) and debounced by 300 ms on a background thread, and flushed on exit.
- **Skins aren't enabled or disabled.** "Enabled" for a skin means "active". The Plugins page offers **Activate** instead of a toggle.
- **`select` options** declare their values as `"choices": [{ "value": …, "label": … }]` (the spec doesn't define this field).
- **Manifest type sections** are validated now but kept as raw JSON in `Manifest.section`. Each host (provider host in Phase 2, skins in Phase 3, modules in Phase 6) will give its section a typed form when it's built.
- **Package script** builds with `npx tauri build --no-bundle` and copies the binary to `dist/Vellum/Vellum Game Launcher.exe`, building into `target/package` so that test builds (which replace `target/release/vellum.exe` with a dev binary) are never packaged. `-Portable` also writes `portable.flag`, and `-SkipBuild` reuses the existing binary.

## 2026-10-19 — Skin/module origins: fixed schemes, not one per plugin (Phase 0 spike)

Tauri registers custom URI schemes at build time, so a new origin per installed skin cannot be added at runtime. Decision:

- One `skin` scheme (`http://skin.localhost` on Windows) serves whichever skin is active; switching skins reloads the iframe.
- A fixed pool of module schemes (`vmod0`…`vmodN`) is handed out to modules as they load. The pool size caps how many modules can be enabled at once.
- Because every skin shares the `skin` origin, the SDK namespaces any skin-side storage by skin id.

Verified in `spikes/origin-ipc` (Tauri 2, WebView2 155): the skin and module iframes are separate origins and cannot read each other or the shell. The spec's CSP blocks network access, inline scripts, `eval`, and fetches to the IPC endpoint and to other origins. The protocol handler rejects `..` traversal, including `%2e%2e`, `%2f` and `%5c` encodings. The iframe sandbox (`allow-scripts allow-same-origin`) blocks top-window navigation. The postMessage bridge works and rejects malformed messages and non-allowlisted methods.

## 2026-10-19 — Tauri IPC globals are injected into skin iframes; rely on origin checks + bridge allowlist

Finding: Tauri 2 injects `__TAURI_INTERNALS__`/`__TAURI__` into every frame, and WebView2 exposes `chrome.webview` in iframes, so skin code *can see* an IPC channel. A direct `invoke("ping")` from the skin origin never reached the backend (the command did not run, and the call hung with no answer), because Tauri only accepts IPC from the shell's origin as granted by capabilities.

Decision: treat the skin origin as hostile even though it can see the IPC globals:
- Capabilities grant permissions to the shell window's local origin only; never add `remote` URLs or capabilities that would match `skin.localhost` / `vmod*.localhost`.
- Every backend command that matters re-checks its caller where Tauri allows it, and the shell's bridge keeps a strict method allowlist with schema validation.
- Add a regression test in Phase 2/3 that runs this spike's hostile checks against the real shell.
- Follow-up: see whether Tauri can be configured to inject its IPC script into the main frame only, as extra defense in depth.

## 2026-10-19 — Provider sandbox: rquickjs 0.14, one fresh runtime per scan (Phase 0 spike)

Verified in `spikes/quickjs`: ES modules resolve only to `./`/`../` paths inside the plugin folder; bare and URL imports are rejected. Synchronous host functions return strings and `Uint8Array`. Reads are canonicalized and checked against allowed roots plus a filename denylist. The interrupt handler stops an infinite loop at the deadline. `set_memory_limit` turns a memory bomb into a catchable "out of memory" error. No timers, `fetch`, `require` or `std`/`os` exist in `Context::full`. Nine runtimes on nine threads run in parallel, and one hung provider doesn't delay the others.

Decisions:
- Create a fresh `Runtime` + `Context` for every scan/launch call and drop it afterwards. Startup costs ~1 ms, and a runtime that hit OOM or an interrupt is never reused.
- Each provider runs on its own OS thread (runtimes aren't shared across threads).
- Use `.catch(&ctx)` on every JS boundary call so provider exceptions keep their message.

## 2026-10-19 — Cover grid: pooled-cell virtualization is enough for 60 fps (Phase 0 spike)

Tested in `spikes/perf` inside the real sandboxed skin iframe (Intel UHD integrated GPU, 165 Hz panel, 125% scaling). The grid has 3,000 entries, a fixed pool of absolutely positioned cells moved with `transform`, `img.decoding = "async"`, and art served by the custom protocol with immutable cache headers.

| Mode | Cells / DOM nodes | Worst phase avg fps | Worst frame |
| --- | --- | --- | --- |
| Native 1920×1113 | 56 / 177 | 165 | 6.3 ms |
| 4K layout (3840×2160 physical, scaled to fit) | 154 / 471 | 156 (fast scroll at 6000 px/s) | 12.4 ms |

No frame exceeded 16.7 ms, and there were no long tasks. Decisions:
- `<vellum-grid>` uses this pooled-cell approach; no virtualization library needed.
- Art URLs pick the smallest variant ≥ cell width × `devicePixelRatio`. That is 320 px here; 4K at 200% scaling needs 640.

Caveats: the 4K mode reproduces the 4K item count and DOM load, but not the full cost of drawing 4K pixels, so recheck on a real 4K display. The spike reused 120 unique images; with 3,000 unique covers the risk is pop-in during fast scroll (images still loading), not frame rate. Phase 3 should show a token-colored placeholder and prefetch one screen ahead.
