# Grand Tour

A racing-showroom skin. Its Garage view builds every game a 3D case at runtime (`case-builder/`):
a printed wrap (back, spine, front) composed in a worker from the game's art and metadata, put on a
WebGL case shaped by a **case profile**, standing on a glass turntable over its own reflection.

## Adding a profile or changing a store's mapping

Profiles and store styles live in `cases.json`:

- `profiles.<name>`: outer size, printed panel, spine and band (mm), corner and fillet radii,
  `material` (`plastic-sleeve` or `cardboard`), `opens`, `disc`, and the surface maps to use
  (`grain`, `wave`, `paper`, `fiber`).
- `stores.<provider id>`: the default `profile`, `shell` and `accent` colors, and `band`
  (`top` or `none`). Providers without an entry use `default`.

Users change a store's form in the skin options (`caseSteam`, `caseEpic`, ...). A new profile is
picked up by those options once it is added to their `choices` in `plugin.json`.

Composed wraps are cached in the skin's IndexedDB; bump `BUILDER` in `case-builder/compose.js`
when the composer's drawing changes. `lib/three.js` is rebuilt with `node scripts/vendor-three.mjs`.
The case gallery (`dev/case-gallery.html`) shows every profile with awkward mock games: open
`http://127.0.0.1:<harness port + 1>/dev/case-gallery.html` while the dev harness runs.
