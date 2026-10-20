Plugins for development and tests. Debug builds scan this folder in addition to `plugins/`, so
they show up in Settings. Never shipped; set `VELLUM_NO_DEV_PLUGINS=1` to hide them.

- Deliberately broken plugins (`providers/broken-*`, `skins/misplaced-provider`,
  `modules/no-manifest`) show how manifest errors look on the Plugins page.
- `skins/token-test`: a token-only skin (the smallest possible skin); it must restyle every view.
- `skins/timeline-test`: adds a custom view placed `{ "after": "covers" }`, reachable with Ctrl+4.
- `skins/sidebar-test`: rearranges the kit into a sidebar layout, frameless, with per-view CSS.
