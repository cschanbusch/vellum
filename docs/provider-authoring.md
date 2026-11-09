# Writing a provider

A provider finds one store's or emulator's installed games and starts them. It is a folder with a manifest and one JavaScript file, run in a sandbox with no network and no file access beyond what its manifest declares. Vellum handles the rest: the library, art downloads, skins and user data.

Start from the closest shipped provider in `plugins/providers/`:

| Provider | A good example of |
| --- | --- |
| `custom` | The smallest useful provider: games from its own settings, launched with `ctx.run` |
| `epic` | Reading JSON manifests from one folder, launching with a URI, an optional location |
| `gog` | Games listed in the registry, folders allowed at scan time, one option changing how games launch, a local icon |
| `pcsx2` | An emulator: games from the emulator's own settings and cache (a binary format read in JavaScript), command-line options for every game and per game, local covers then URLs |
| `steam` | Everything at once: several libraries, binary formats, art files and URLs, every capability |

## 1. Check the real install first

Before writing any code, look at a real install. Published descriptions of store formats are often out of date. Two examples from this project's own design document:

- It put GOG Galaxy in `%ProgramFiles(x86)%`, but Galaxy 2.1 installs to `%ProgramFiles%`.
- It said Epic's `MainGameAppName` always equals `AppName` for a base game, but base games leave it empty.

Both would have passed tests written from the document and failed for real users.

`--diagnose` helps with this. It writes a structure-only report, which is safe to share because names are reduced to patterns and file contents to key and type shapes:

```
"Vellum Game Launcher.exe" --diagnose --out report.json
```

It opens no window. Settings → Developer → **Run diagnostics** writes the same report to the logs folder. For every provider it records each location and every candidate path tried, with the reason any was rejected. Steam, Epic and GOG also have a probe in `src-tauri/src/diagnose.rs` that reports the shape of their data; add one for a new store if you're contributing it to Vellum.

Once your provider is written, run it against the real install too. Copy fixture-based tests from the real shapes you found, and keep a test marked `#[ignore]` that reads the real install using the recording stand-in for launches (see [Testing](#8-testing)).

## 2. The folder and manifest

Put the folder under `providers/` in your plugins folder (Settings → Plugins → **Open plugins folder**), then press **Reload plugins**. A manifest error appears on the provider's card, so you can see what to fix.

```
providers/mystore/
  plugin.json
  provider.js
```

```json
{
  "id": "mystore",
  "type": "provider",
  "name": "My Store",
  "version": "0.1.0",
  "apiVersion": 1,
  "author": "You",
  "description": "Installed games from My Store",
  "entry": "provider.js",
  "settings": [
    {
      "id": "silentLaunch",
      "label": "Open silently",
      "tooltip": "Starts the game without showing My Store's window. My Store itself still runs, because its games need it.",
      "type": "toggle",
      "default": true
    }
  ],
  "provider": {
    "locations": {
      "root": {
        "label": "My Store folder",
        "required": true,
        "registry": [{ "hive": "HKLM", "key": "SOFTWARE\\MyStore", "value": "InstallPath" }],
        "defaults": ["%ProgramFiles%\\My Store"],
        "validate": ["mystore.exe"]
      }
    },
    "derivedLocations": true,
    "registryRead": ["HKLM\\SOFTWARE\\MyStore"],
    "uriSchemes": ["mystore"],
    "artHosts": ["cdn.mystore.example"],
    "denyFiles": ["config/login.dat"],
    "capabilities": ["launch", "watch"]
  }
}
```

**Top level.** `id` uses lowercase letters, digits and hyphens, and it becomes part of every game's id, so don't change it later. `icon` is optional and names an image in the folder.

**`provider` section.** Each field is a permission or a promise; anything you leave out is denied.

| Field | Meaning |
| --- | --- |
| `locations` | Folders the provider may read, resolved as described in [Locations](#3-locations) |
| `derivedLocations` | `true` lets `ctx.fs.allow` add folders found during a scan, such as extra game libraries |
| `registryRead` | Registry keys `ctx.registry` may read, written as `HIVE\key`. Subkeys are included |
| `uriSchemes` | Schemes `ctx.openUri` may open |
| `artHosts` | Hosts `art()` may name in `https://` URLs |
| `denyFiles` | Files never readable, even inside a location: `ssfn*` matches a file name anywhere, `config/login.dat` matches a path ending in those segments. List anything holding logins |
| `capabilities` | Which actions the provider offers: `launch`, `install`, `uninstall`, `openStore`. The shell only offers what's listed |
| `gameSettings` | Options the user sets per game, shown in **Launch options…** in the game menu. See below |
| `duplicates` | `"separate"` preselects **Separate entries** when one of your games has the same title as another store's, as an emulator's game is usually a different product. The default is the first store |

The Plugins page shows the user these permissions.

**`settings`.** These appear on the provider's card in Settings → Plugins, and `ctx.settings` holds the values, with your defaults filling in for anything not saved. The page shows `toggle`, `select` (with `choices: [{ value, label }]`), `range` (with `min`, `max`, optional `step`) and `text` (a line of up to 2,000 characters) options. Give each option a `tooltip` saying what it actually does and why someone would change it. Changing an option rescans the provider.

**`gameSettings`.** The same kinds of option, set for one game at a time: listing any puts **Launch options…** in that game's menu, and `launch` finds the game's values in `ctx.gameSettings`, with your defaults for anything not set. Only values that differ from the default are saved, with the game's record, so they survive merges. To let a game follow a provider-wide setting, give it a `select` whose default means "as set for the provider": PCSX2's per-game Fullscreen is `default`, `on` or `off`, and its `launch` reads `ctx.settings.fullscreen` for `default`.

**If your store has a launcher,** follow the shipped providers: ticked means no launcher in the way, and the label says what really happens. Steam and Epic say "Open silently" because their launchers still run, hidden; GOG says "Skip Galaxy launch" because Galaxy doesn't start at all.

## 3. Locations

For each location, Vellum tries these in order and stops at the first folder that passes `validate`:

1. the path saved from last time;
2. the `registry` hints (these don't need `registryRead`);
3. the `defaults`, with `%NAME%` variables expanded.

`validate` lists paths or globs that must exist inside the folder. Choose something the store always has, because this is what rejects a wrong folder when a user browses for one.

The resolved paths are in `ctx.locations`, by key. An optional location that wasn't found is simply absent.

**A `required` location that isn't found makes the provider inactive and shows every such user a prompt** with Browse, Skip and Disable. New providers start enabled, so a required location means everyone without your store sees that prompt. Unless a provider is useless without a folder and most users will have it, make the location optional and let `scan` return no games. GOG does this: it has no required location, and a PC without GOG just has no GOG games.

## 4. The module

`provider.js` is an ES module whose default export holds the functions. Each receives `ctx`; all but `scan` also receive the game. Only `scan` is required by every provider, and a capability you list needs its function.

```js
export default {
  scan(ctx) {
    return {
      games: [
        { sourceId: "42", title: "Some Game", installDir: "C:\\Games\\Some Game", launchData: { id: "42" } },
      ],
    };
  },
  launch(ctx, game) {
    ctx.openUri(`mystore://run/${game.launchData.id}`);
  },
};
```

| Function | Returns | Used for |
| --- | --- | --- |
| `scan(ctx)` | `{ games: [...] }` | The installed games |
| `launch(ctx, game)` | nothing | Play |
| `install`, `uninstall`, `openStore (ctx, game)` | nothing | The store actions in the game menu |
| `art(ctx, game)` | candidates, see [Art](#6-art) | Images for one game; optional |

**Failures stay contained.** If `scan` throws or times out, the provider keeps its previous games and shows an error status, and other providers aren't affected. If `launch` throws, the user sees your message in a toast, so make it a sentence.

**When `scan` runs.** At startup, on a refresh (Ctrl+R), when your options or locations change, and after a launch, install or uninstall of one of your games. Vellum doesn't watch store files, so a game installed elsewhere appears at the next of those. Older providers may still have `watch` in their capabilities and a `watch()` function: both are accepted and ignored.

### The game shape

`sourceId` and `title` are required. A game with a problem is skipped and logged without affecting the rest, while a malformed overall result is an error.

| Field | Type | Notes |
| --- | --- | --- |
| `sourceId` | string | Stable and unique within the provider. **User data is stored against `<providerId>:<sourceId>`**, so if it changes, the game loses its favorites, tags and art choices |
| `title` | string | |
| `kind` | `game`, `tool`, `dlc`, `other` | Default `game` |
| `installDir` | string | Enables **Open install folder**, and lets `ctx.run` start programs inside it |
| `sizeBytes` | number | |
| `launchData` | object | Handed back unchanged to `launch`. Put whatever launching needs here |
| `categories` | string[] | The store's collections |
| `labels` | string[] | Short badges such as "Demo". At most 3 are kept, 20 characters each |
| `metadata` | object | `developer`, `publisher`, `releaseDate` (ISO), `genres`, `description` |
| `hidden` | boolean | The store itself hides this game. The user's choice in Vellum overrides it |
| `playtimeMinutes` | number | As the store counts it: every session, not only Vellum's launches |
| `lastPlayed` | string | ISO time the store last saw it played |

### Duplicates: why `kind` and `labels` matter

Vellum never merges games by itself. When records of kind `game` from different providers have the same normalized title (case-folded; ™ ® © and punctuation removed; whitespace collapsed), it asks the user to choose: one entry through a chosen store, one entry that asks each time, or separate entries marked with the store's name.

Two things keep false matches away from that prompt, and both are yours to set:

- **Report tools, DLC and soundtracks with the right `kind`.** Only `game` records count.
- **Label demos and playtests.** A record with any label doesn't count, because a demo isn't the full game.

Report titles as the store does. Don't strip "Edition" or "Remastered" to improve matching: those words mean different products, and the user can join anything by hand with **Merge with…**. A user's choice applies to the records, so it survives a title change, but not a `sourceId` change.

## 5. The `ctx` API

`ctx` is frozen, and it is the only way out of the sandbox. There is no `fetch`, `atob`, `TextDecoder`, `process` or timers. `import` only reaches `./relative` files inside your own folder.

**Limits per call:** `scan` and `art` get 30 seconds, everything else 10 seconds, and each call gets 256 MB. Every call runs in a fresh runtime, so nothing carries over between calls in JavaScript variables. `art` is the exception within a call: it runs once per game in one shared runtime and budget.

### Files

| Function | Notes |
| --- | --- |
| `ctx.fs.readText(path)` | UTF-8, with a byte order mark removed |
| `ctx.fs.readBytes(path)` | A `Uint8Array` of the whole file, so mind large files |
| `ctx.fs.list(dir)` | `[{ name, isDir, size, mtime }]`, sorted by name |
| `ctx.fs.glob(dir, pattern)` | Full paths. Segments separated by `/`; `**` means any number of folders |
| `ctx.fs.exists(path)` | Not scope-checked |
| `ctx.fs.stat(path)` | `{ isDir, size, mtime }` or `null`. Not scope-checked |
| `ctx.fs.allow(dir)` | Adds a folder for this and later calls, and returns its canonical path. Needs `derivedLocations` |

Reads must be inside a location, a folder from `ctx.fs.allow`, or your own plugin folder (`ctx.pluginDir`), which is readable for bundled data. Folders you allow during `scan` stay allowed for later calls until the next scan, so allow every folder a game needs, not just the ones you read now.

### Registry

`ctx.registry.get(hive, key, value)` returns a string or `null`, and `ctx.registry.subkeys(hive, key)` returns names. `hive` is `"HKCU"` or `"HKLM"`. Both throw for keys outside `registryRead`.

### Parsing

`ctx.formats.vdf(text)` and `ctx.formats.binaryVdf(bytes)` parse Valve's formats, and `ctx.formats.steamAppinfo(bytes, appids)` reads Steam's `appinfo.vdf`. Use `JSON.parse` for JSON. `ctx.sqlite` exists but always throws in this version.

### Starting things

**`ctx.openUri(uri)`** opens a URI whose scheme is in `uriSchemes`.

**`ctx.run(exe, args, cwd, options)`** starts a program. `args` is an array of separate arguments, and Vellum handles the quoting. `cwd` defaults to the program's folder. The file must exist and be inside a location, a folder from `ctx.fs.allow`, or the current game's `installDir`. Your plugin folder is readable but never runnable. A `.lnk` or `.url` file opens through Windows instead, which ignores `args` and `cwd`. With `options` `{ sameMonitor: true }`, Vellum watches for the program's windows for a few seconds after they appear and moves any that open on another monitor to the one Vellum is on: a window filling its monitor (fullscreen) is made to fill Vellum's, and a smaller one keeps its size and its place relative to the screen. Use it for programs that remember a position of their own, such as an emulator.

If you have an arguments line from a store, split it before passing it on: `gog/provider.js` has a small `splitArgs` to copy, which keeps backslashes because they are usually Windows paths.

### Everything else

`ctx.locations`, `ctx.settings`, `ctx.gameSettings` (in `launch` only; empty otherwise) and `ctx.pluginDir` are described above. `ctx.env.expand("%APPDATA%\\x")` expands variables. `ctx.log.info`, `.warn` and `.error` write to Vellum's log, tagged with your provider's id.

## 6. Art

`art(ctx, game)` returns candidates in the order you prefer them, at most 24:

```js
art(ctx, game) {
  return [
    { kind: "cover", file: `${game.installDir}\\cover.png` },
    { kind: "hero", url: `https://cdn.mystore.example/${game.sourceId}/hero.jpg` },
  ];
}
```

`kind` is `cover`, `hero`, `logo`, `header` or `icon`. A `file` must be `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif` or `.ico`, inside your scope. A `url` must be `https://` on one of your `artHosts`. The provider never downloads anything: the backend fetches URLs, caches them and retries misses.

For each entry and kind, the first hit wins: the user's own choice, then your candidates, then SteamGridDB if the user has a key, then a generated placeholder. So return only what you really have. When a game is merged, candidates from all its stores are offered, preferred store first.

## 7. Launching and launchers

Think about what the user sees when they press Play. A launcher window coming up over Vellum is what users notice most, so if a store has a way to avoid it, make that the default and offer an option to turn it off:

- **The game can run without its launcher** (GOG's are DRM-free): run it directly with `ctx.run`.
- **The launcher must run** (Steam, Epic): ask it to stay hidden if it can.
- **Say what's given up** in the option's tooltip. GOG's mentions the cloud saves and playtime tracking that only come through Galaxy.

## 8. Testing

Integration tests run your provider in the real QuickJS host, without opening any windows. See `src-tauri/tests/gog_provider.rs` for a compact example.

```rust
let mut h = Harness::new(shipped_provider("gog", Map::new()), &[("galaxy", &galaxy)], registry);
let games = parse_scan(h.call(Method::Scan, None).unwrap().value).unwrap().games;
h.call(Method::Launch, Some(&serde_json::to_value(&games[0]).unwrap())).unwrap();
assert_eq!(h.opened(), ["run C:\\... /command=runGame ..."]);
```

`Harness` (`src-tauri/tests/common/mod.rs`) uses a recording stand-in for launches, so `h.opened()` shows what would have started and nothing actually does. `FakeRegistry` stands in for the registry.

To check a real install safely, swap in the real registry and mark the test ignored, as `live_real_install` does in `gog_provider.rs`. It reads the real files and records real launch commands without running them:

```
cargo test --test gog_provider live_real_install -- --ignored --nocapture
```

Before calling a provider done:

- [ ] Run `--diagnose` and the provider against a real install.
- [ ] Launch a real game through every route you offer.
- [ ] Check a PC without the store: no prompt unless you intended one, and no errors.
- [ ] Check that a game's `sourceId` survives a rescan, an update and, if relevant, moving it.
- [ ] Check that DLC, tools and demos don't reach the duplicate prompt.
