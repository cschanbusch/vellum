# Open issues

Work in progress, so the next session can pick it up.

## FICSIT button-sound e2e test flakes (open, 2026-11-01)

`FICSIT's button and cursor sounds` failed 1 of 5 repeats and once in a full run: after
`host.switchView("hub")`, `.v-view[data-view="hub"]` isn't there within 5 s (`show()` in
`tests/e2e/skins.e2e.ts`). Not caused by recent work: it fails the same way on the 0.5.0 commit
(2 of 8 repeats). Not yet investigated.

In a full run, `music: a scene per view...` (test global `__scenes` undefined) and `a rearranged
layout works...` (`link[href="/covers.css"]` missing) can also fail once. Each passed 10 of 10
alone on 0.6.1, so they look like timing under load, possibly the same race as above.

On the Phase 5 code (2026-11-02), the music test failed once in a full run (55 of 56 passed, the
`__scenes` error) and 1 of 10 alone, at a different step: after `music.pause()` the state stayed
"running" (also seen on 2026-10-25). Both come before the test's launch step, so they don't touch
the launch code Phase 5 changed, but no baseline comparison was run and the cause isn't known.
`__scenes` going undefined after being set suggests the skin page reloaded mid-test.

## Grand Tour: turning off motion removes menus (open, 2026-10-23; still mode disabled)

Reported by the user: with the skin's Motion option off, Spotlight's information panel and the
Garage's right-hand panel (the spec card) disappear. Probably something whose entrance animation
never runs under `data-rl-still` (or reduced motion), leaving it at its hidden start state. Not
investigated yet. For now still mode is switched off: `moving()` in skin.js always returns true
and the Motion option is gone from plugin.json, so `data-rl-still` is never set (reduced motion in
Windows included). To restore: bring back the option and the old `moving()`, then fix the panels.

## Phase 5: still to try in a real window (closed, 2026-11-09)

Tried by the user before 0.7.0: the options and tooltips on Settings → Plugins ("functional and
helpful"), Open silently for Steam and Epic (Epic's window stays hidden), GOG launches, and a custom
game added through the Add game dialog and launched. Not separately confirmed: the route through
Galaxy (**Skip Galaxy launch** off), where the risk was Windows quoting `/path=<path>` differently
from GOG's usual `/path="<path>"`; and Grand Tour keeping a game's condition after a merge (the
entry id it depends on is confirmed not to move).

## Garage cases reset by themselves (closed, 2026-11-03)

**Reported:** every so often the Garage's textures reloaded and the keep cases' rotation reset.

**Cause:** the Garage rebuilt every case whenever it heard about providers, and each scan's status changes (scanning, then ready) sent that twice, even if no game had changed. Steam rewriting its files triggered those scans, so one 7-minute session on 2026-10-30 had 15 of them.

**Fixed three ways:** Vellum no longer watches store files, so scans follow the player's actions; the shell tells skins only what changed; and the Garage (Grand Tour 2.1.1) rebuilds its cases only when a store's name or icon changes, and redraws only when something on show changes.

## Frontier Catalogue arrow-key flake is back (open, 2026-10-23)

The closed issue below recurred: on 2026-10-23 the Catalogue test failed twice in full e2e runs and
once in four solo runs, then passed the next eight solo runs (roughly 1 in 10). The step that
failed in the run with detail was the same one: two ArrowRight presses didn't turn the leaf
(`expect.poll(folios).not.toBe(spread)`). The harness's mock library doesn't rescan, so the fix
below (no rebuilds for no-op library updates) can't be the whole story: look for another rebuild
or focus change during the turn, or keys dropped while `busy`. Not investigated yet.

## Frontier Catalogue: an arrow key sometimes doesn't turn the page (closed, 2026-10-22)

The e2e test "Frontier's Catalogue…" fails intermittently (2 of 5 runs on 2026-10-22) at the
same step: after an arrow key, `expect.poll(folios).not.toBe(spread)` (tests/e2e/skins.e2e.ts,
around line 301) times out, so the spread never turned. Not yet investigated. Likely suspect: a
key arriving while the previous leaf turn is still animating is dropped instead of queued
(views/catalogue.js, leaf.js). Frontier ships through the vellum-skins catalog, not in Vellum's
release zip.

**Cause:** every library update rebuilt the book, even when nothing on its pages had changed, and
a rebuild arriving during a leaf turn reset it. Vellum also announced a library change after every
rescan, including the frequent ones triggered by Steam rewriting its config (store files are no
longer watched at all; see 2026-11-03). Fixed both ways: the
backend only announces a change when a scan's results differ, and the Catalogue (Frontier 1.3.1)
skips updates that don't change what its pages print. The test then passed 16 times in a row.

## Covers grid drew only some rows in the real app: not a bug (closed 2026-10-20)

**Reported (by me):** a `PrintWindow` capture of the packaged app with the FICSIT skin and a
fresh data folder, taken 8 s after launch, showed the Covers grid with its first rows empty.

**Re-tested** with the same build, skin and fresh data folder. I inspected the running WebView2
through `--remote-debugging-port`:
- The grid's state was right: all 30 pooled cells were painted at the correct positions (rows
  0–4), and `clientHeight`, `scrollTop` and the sizer height were correct.
- Screenshots over CDP at 2, 4, 6, 8 and 11 s after launch showed the boot screen at 2 s, then
  a complete grid every time.
- `PrintWindow` captures at the same moments also showed a complete grid.

The user never saw the problem in daily use. The most likely explanation is that the one bad
capture caught WebView2 mid-composite: `PrintWindow` copies the window's GPU layers at the
moment of the call. It is not the container query, the staged library load or the skin.

**Lessons for checking the app:**
- Prefer CDP screenshots of the live WebView2 to `PrintWindow`: they show what Chromium
  actually rendered. If you use `PrintWindow`, capture twice before believing a glitch.
- Launch with `$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=<port>"`
  and use a new port each time. A port still held by a leftover WebView2 process makes the
  app exit right after plugin discovery.
- Attach with Playwright's `chromium.connectOverCDP(...)`. The skin frame is the one on
  `http://skin.localhost`. **Never call `browser.close()`** on that connection: it shuts down
  the WebView2 and quits Vellum. End the script with `process.exit(0)` instead.
