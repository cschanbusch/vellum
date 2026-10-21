# Open issues

Work in progress, so the next session can pick it up.

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
