# Decisions

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
- **Package script** builds with `npx tauri build --no-bundle` and copies `target/release/vellum.exe` to `dist/Vellum/Vellum.exe`. `-Portable` also writes `portable.flag`, and `-SkipBuild` reuses the existing binary.

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
