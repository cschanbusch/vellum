# Vellum — PCSX2 Provider Design

Oct 21, 2026 · @Charles

## Summary

A `pcsx2` provider plugin lists every PS2 disc image in the user's PCSX2 game folders as a Vellum entry, launches it with PCSX2's command line, and has Vellum's art pipeline fetch covers and other art, so the user never runs PCSX2's own cover downloader.

This extends the main Vellum design overview. It follows the provider contract, location resolution, art pipeline and security rules there unchanged, and needs a few small, general-purpose additions to the core (see Changes to the main design). Like every provider, it is read-only toward PCSX2's files.

The PCSX2 file layouts below come from public documentation and community tools, not an official spec. Confirm each with `--diagnose` against a real PCSX2 install before calling the plugin done.

## Locations

Three locations resolve through the standard chain (saved path, registry, defaults, then a prompt with **Browse**):

| Key | Purpose | Defaults | Validate | Required |
| --- | --- | --- | --- | --- |
| `install` | Folder holding the emulator | `%ProgramFiles%\PCSX2` | `pcsx2-qt.exe` | Yes |
| `data` | PCSX2's settings, covers and caches | `<install>` when it holds `portable.ini` or `portable.txt`; otherwise `%USERPROFILE%\Documents\PCSX2` | `inis/PCSX2.ini` | No |
| `games` | Extra game folders the user adds in Vellum | none | at least one supported file | No |

Many users run portable builds from arbitrary folders, so the `install` prompt matters more here than for store providers.

**Game folders.** If `data` resolves, read `inis/PCSX2.ini` and take the folders listed in the `[GameList]` section under `Paths` (scan top level only) and `RecursivePaths` (scan subfolders). Each becomes a derived location, so the plugin's manifest sets `derivedLocations: true`. The user can add folders in the plugin's settings too (the `games` location). Scan both sets.

## Finding games and serials

Every PS2 disc has a serial such as `SLUS-20062`, and the serial is what makes art lookup reliable, so the scan's main job is to find it for each file.

**Files.** Collect `.iso`, `.chd`, `.cso`, `.zso`, `.gz`, `.cue` and `.bin` files from the game folders. A `.bin` referenced by a `.cue` is skipped in favor of the `.cue`. Files named `.elf` are listed as `kind: "other"`, hidden by default.

**Serial, first match wins:**

1. **Filename.** Match `[A-Z]{4}[-_ ]?\d{3}\.?\d{2}` (for example `SLUS_200.62` or `SLES-50330`) anywhere in the name.
2. **Disc contents** (`.iso` and `.cue`/`.bin` only). Read the ISO 9660 primary volume descriptor at sector 16, walk the root directory to `SYSTEM.CNF`, read it, and parse the `BOOT2 = cdrom0:\SLUS_200.62;1` line. Use 2048-byte sectors for `.iso`; for raw `.bin` images use 2352-byte sectors with a 24-byte header offset. Only small ranges are read, never the whole image.
3. **Title match.** For compressed formats, normalize the filename (drop extension and bracketed tags such as `(USA)`) and look it up against titles in PCSX2's game database. Accept only a unique match.

Normalize every serial to `XXXX-NNNNN` (`SLUS_200.62` becomes `SLUS-20062`).

**Titles and metadata.** PCSX2 ships its game database at `<install>/resources/GameIndex.yaml`, keyed by serial with `name` and `region` fields. Use it for the title and region; without a serial or a database hit, use the cleaned filename.

**Entries.** `sourceId` is the serial when known, otherwise `file:` plus a hash of the file's path relative to its game folder. If two files share a serial, keep the first and log the duplicate. `launchData` holds the absolute path.

**Watch** each game folder and `inis/PCSX2.ini`. Cache serials by path, size and modified time, so a rescan never re-reads unchanged discs.

## Launching

`launch` runs `<install>/pcsx2-qt.exe` through `ctx.run`, with the working directory set to `install`:

```
pcsx2-qt.exe -fullscreen -nogui -fastboot -- "<absolute path to the game file>"
```

- `-fullscreen` starts fullscreen; `-nogui` hides PCSX2's own window and closes PCSX2 when the game shuts down (it implies `-batch`), returning the user to Vellum; `-fastboot` skips the PS2 BIOS intro.
- The `--` must always come immediately before the path, so paths with spaces or a leading dash work.
- The arguments before `--` come from the plugin setting "Launch arguments" (default `-fullscreen -nogui -fastboot`). Each entry can override them from its details panel, for example `-slowboot` for a game that needs the BIOS boot or `-gamecfg <file>` for a specific settings file.
- The only capability is `launch`: there is no install, uninstall or store page. Each entry's `installDir` is the folder holding its file, so the shell's existing open-folder action works.

## Artwork

Vellum fetches all PCSX2 art itself, into its own cache, through the standard art pipeline. The provider never downloads anything: its `art()` function returns local files and URLs, and the backend fetches them. Vellum does not write into PCSX2's covers folder.

Candidates per entry, first hit wins (a user override always comes first, as for every provider):

| Kind | Candidates in order |
| --- | --- |
| `cover` | 1. Existing PCSX2 cover: `<data>/covers/<serial>` or `<data>/covers/<title>` with `.jpg`, `.png` or `.webp` · 2. Remote by serial: `https://raw.githubusercontent.com/xlenore/ps2-covers/main/covers/default/<serial>.jpg` · 3. SteamGridDB grid by title · 4. Placeholder |
| `hero`, `logo`, `header`, `icon` | 1. SteamGridDB by title · 2. Derived (below) · 3. Placeholder |

- Remote covers need a serial. Entries without one go straight to SteamGridDB.
- Plugin setting "Cover style": `flat` (default, the `covers/default/` set) or `3D box` (`covers/3d/<serial>.png`, transparent).
- SteamGridDB lookup uses the GameIndex title, which is cleaner than a filename. It only runs when the user has entered a SteamGridDB key, as in the main design.
- The manifest's `artHosts` is `["raw.githubusercontent.com"]`; SteamGridDB is called by the backend itself, not the provider.

**Derived art.** Many PS2 games have no hero or logo anywhere. Instead of a placeholder, the pipeline generates a hero from the cover: scaled to fill 3840 × 1240, heavily blurred and darkened, so Spotlight still looks intentional. The logo falls back to the title rendered on transparency (already in the main design). This applies to every provider, not just PCSX2.

**Aspect ratio.** PS2 cases are not exactly 2:3 like Steam covers, and 3D box art is a different shape again. The art pipeline records each image's pixel width and height in the entry, and `<vellum-cover>` fills the 2:3 frame (`object-fit: cover`) when the ratio is within 5% of 2:3, and otherwise fits the whole image (`contain`) over a blurred copy of itself. Skins can read the dimensions and choose differently.

## Changes to the main design

The plugin needs these additions to the core. Each is general-purpose, so later emulator providers (DuckStation, Dolphin, RPCS3) can reuse them.

| Area | Addition | Why |
| --- | --- | --- |
| Host API | `ctx.fs.readRange(path, offset, length)`, at most 1 MB per call | Read `SYSTEM.CNF` from multi-gigabyte disc images |
| Host API | `ctx.formats.ini(text)` and `ctx.formats.yaml(text)`, parsed in Rust | `PCSX2.ini` and the large `GameIndex.yaml` |
| Host API | `ctx.cache.get(key)` and `ctx.cache.set(key, value)`: a per-provider JSON store in Vellum's cache folder, capped at 10 MB | Remember serials by path, size and modified time; keep a title index keyed by the database's modified time |
| Provider contract | Manifest flag `"launchOptions": true`; `launch(ctx, game, options)` receives the entry's saved options | Per-game argument overrides |
| User data and shell | Per game record `launchOptions: { args?: string }`, edited in the details panel when the provider sets the flag | Same |
| Art pipeline | Derived hero from the cover when no hero exists | PS2 and other retro games rarely have hero art |
| Library model | `artInfo: Record<kind, { width: number; height: number }>` on each entry; `<vellum-cover>` fit rule | Covers that are not 2:3 |

Nothing here loosens the security model: `readRange` uses the same path scope checks as other reads, and the cache is written by the host, not by the provider directly.

## Settings

| Setting | Default |
| --- | --- |
| Launch arguments | `-fullscreen -nogui -fastboot` |
| Cover style | Flat |
| Fetch covers from the online cover set | On |
| Additional game folders | None |
| Show ELF files | Off |

## Acceptance criteria

- With PCSX2 in a portable folder, the locate prompt finds it via **Browse**, and validation rejects a folder without `pcsx2-qt.exe`.
- Game folders from `PCSX2.ini` are scanned, including subfolders for `RecursivePaths`.
- Serials are found for `.iso` and `.cue`/`.bin` files with no serial in the filename, and for compressed files whose names match the database uniquely. A rescan of 200 unchanged games reads no disc data.
- Launching a game opens it fullscreen in PCSX2; quitting the game returns to Vellum with PCSX2 closed; a per-game `-slowboot` override is honored.
- With an empty PCSX2 covers folder and network access, every game with a known serial gets a real cover, and Spotlight shows a derived hero for games with no hero art.
- Works offline using PCSX2's local covers and anything already cached.
- Fixture tests cover: a tiny generated ISO 9660 image with `SYSTEM.CNF`, a raw 2352-byte `.bin`, a filename with a serial, a compressed file matched by title, portable and installed layouts, and a `PCSX2.ini` with both path types.

## Open questions

- Should Vellum offer to copy the covers it fetched into PCSX2's covers folder, so PCSX2's own game list shows them too? That would be the plugin's only write, so the current answer is no.
- The online cover set states no license. Fetching covers on the user's own machine mirrors what PCSX2's built-in downloader does, but bundling those covers with Vellum would not be appropriate.
- Multi-disc games appear as separate entries, one per disc. Grouping them is a later improvement.

## Sources

- [PCSX2 docs: Command Line Options](https://pcsx2.net/docs/advanced/cli)
- [PCSX2 wiki: Command-line support](https://wiki.pcsx2.net/Command-line_support)
- [xlenore/ps2-covers](https://github.com/xlenore/ps2-covers) (cover URL templates by serial)
- [PCSX2 Cover Downloader fork](https://github.com/andercard0/PCSX2_Cover_Downloader) (PCSX2's built-in Cover Downloader setup)
