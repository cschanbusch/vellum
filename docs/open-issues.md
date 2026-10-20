# Open issues

Work in progress, so the next session can pick it up.

## Covers grid draws only some rows in the real app (WebView2) — open

**Seen:** 2026-10-20, packaged build (`dist\Vellum\Vellum.exe`) with the FICSIT skin active and
a fresh data folder (Steam 82 games). In Covers, rows 1–3 of the grid were empty. Only a few
covers appeared, near the bottom of the window (around row 4), and the scrollbar was at the
top.

**Not reproduced in the skin dev harness**, which uses Playwright Chromium. These all
rendered correctly:
- the same skin at the app's size (1280×800 CSS px, 125% scaling);
- narrowing the results and then restoring them;
- an empty result followed by a full one.

The Phase 3 capture of Basis in the real app (before the window-controls change) was correct.

**Suspects, most likely first:**
1. `container: vellum-app / inline-size` on `<vellum-app>` (sdk/src/sdk.css), added with the
   window-controls fix. It was never checked in WebView2's Covers view since then.
2. The app's library arriving in stages (fresh data folder: empty, then Steam, then the art
   refresh), while the grid measures itself. Check `CoverCollection.measure()` / `relayout()`
   in sdk/src/kit/collection.ts against a 0 or stale `clientHeight`.
3. Something FICSIT-specific: the boot overlay, or the frameless title bar resizing the
   window after the page loads.

**How to investigate:** WebView2 can expose DevTools to Playwright:

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9333"
.\dist\Vellum\Vellum.exe --data-dir <temp folder>
```

Then `chromium.connectOverCDP("http://127.0.0.1:9333")`, find the frame on
`http://skin.localhost`, and read `vellum-grid`'s `clientHeight`, `scrollTop`, the sizer's
height and each `.cell`'s `transform` / `checkVisibility()`. I had confirmed the port works
(Edg/155) when I stopped.

**Next:** compare against Basis in the same build, to rule the skin in or out, and try
removing the container query. Then add an e2e or CDP check that the first row of covers is
painted at startup.

## FICSIT Terminal skin — done except the issue above

`plugins/skins/ficsit/` holds:
- vector textures: steel, tread plate, grit, and the factory scene;
- an animated factory backdrop: conveyors, smoke, beacons;
- a title bar with a clock and shift counter;
- a status strip with a corporate notice ticker;
- a boot sequence;
- crate-style covers;
- the dossier-style Spotlight;
- options.

It passes the e2e suite (all views, grouped Spotlight, window controls at 960–1600 px) in the
harness. Its preview image is generated.
