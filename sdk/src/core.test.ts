import { describe, expect, it } from "vitest";
import { snapWidth, withWidth } from "./art";
import { pickNext, type Box } from "./focus-math";
import { facets, fold, groupEntries, matches, query, sortEntries } from "./query";
import { orderViews, placeViews, availableViews } from "./view-order";
import { placeholderSvg, wrap } from "./placeholder";
import type { Entry } from "./types";

let n = 0;
function entry(title: string, over: Partial<Entry> = {}): Entry {
  const id = over.id ?? `t:${++n}`;
  const sortTitle = title.replace(/^(The|A|An) (.+)$/i, "$2, $1").toLowerCase();
  return {
    id,
    title,
    sortTitle,
    kind: "game",
    sources: [{ provider: "steam", providerName: "Steam", gameId: id, capabilities: ["launch"] }],
    preferredSource: "steam",
    categories: [],
    labels: [],
    tags: [],
    favorite: false,
    hidden: false,
    lastLaunched: null,
    addedAt: "2026-01-01T00:00:00Z",
    metadata: {},
    art: { cover: "", hero: "", logo: "", header: "", icon: "" },
    artStatus: { cover: "placeholder", hero: "placeholder", logo: "placeholder", header: "placeholder", icon: "placeholder" },
    ...over,
  };
}

describe("search", () => {
  const hk = entry("Hollow Knight");
  const poke = entry("Pokémon™ Mystery Dungeon");
  const hl = entry("Half-Life 2: Episode One");

  it("folds case, accents, symbols and punctuation", () => {
    expect(fold("  Pokémon™  Mystery—Dungeon ")).toBe("pokemon mystery dungeon");
  });

  it("matches substrings case- and accent-insensitively", () => {
    expect(matches(hk, "LOW kn")).toBe(true);
    expect(matches(poke, "pokemon")).toBe(true);
    expect(matches(poke, "POKÉ")).toBe(true);
    expect(matches(hl, "half life")).toBe(true);
  });

  it("matches word prefixes", () => {
    expect(matches(hk, "hk")).toBe(true);
    expect(matches(hk, "holkni")).toBe(true);
    expect(matches(hl, "hl2")).toBe(true);
    expect(matches(hl, "heo")).toBe(true);
    expect(matches(hk, "kh")).toBe(false);
    expect(matches(hk, "hz")).toBe(false);
  });

  it("requires every term", () => {
    expect(matches(hk, "hollow zelda")).toBe(false);
    expect(matches(hk, "")).toBe(true);
  });
});

describe("filters and sorts", () => {
  const a = entry("Alpha", { sizeBytes: 5, lastLaunched: "2026-05-01T00:00:00Z", metadata: { releaseDate: "2010-01-01" } });
  const b = entry("The Beta", { sizeBytes: 50, favorite: true, tags: ["coop", "fav"], metadata: { releaseDate: "2020-01-01" } });
  const c = entry("Gamma", { hidden: true, categories: [{ provider: "steam", name: "RPG" }] });
  const t = entry("Tool", { kind: "tool" });
  const g = entry("Delta", {
    sources: [{ provider: "gog", providerName: "GOG", gameId: "gog:1", capabilities: [] }],
    preferredSource: "gog",
    lastLaunched: "2026-06-01T00:00:00Z",
  });
  const all = [a, b, c, t, g];
  const titles = (es: Entry[]) => es.map((e) => e.title);

  it("defaults to visible games sorted by title", () => {
    expect(titles(query(all, { query: "", filters: {}, sort: "title" }))).toEqual(["Alpha", "The Beta", "Delta"]);
  });

  it("applies every filter", () => {
    const q = (filters: object) => titles(query(all, { query: "", filters, sort: "title" }));
    expect(q({ showHidden: true })).toEqual(["Alpha", "The Beta", "Delta", "Gamma"]);
    expect(q({ kinds: ["tool"] })).toEqual(["Tool"]);
    expect(q({ favorites: true })).toEqual(["The Beta"]);
    expect(q({ providers: ["gog"] })).toEqual(["Delta"]);
    expect(q({ tags: ["coop", "fav"] })).toEqual(["The Beta"]);
    expect(q({ tags: ["coop", "nope"] })).toEqual([]);
    expect(q({ categories: ["steam/RPG"], showHidden: true })).toEqual(["Gamma"]);
  });

  it("sorts in natural directions with missing values last", () => {
    const vis = [a, b, g];
    expect(titles(sortEntries(vis, "lastLaunched"))).toEqual(["Delta", "Alpha", "The Beta"]);
    expect(titles(sortEntries(vis, "-lastLaunched"))).toEqual(["Alpha", "Delta", "The Beta"]);
    expect(titles(sortEntries(vis, "size"))).toEqual(["The Beta", "Alpha", "Delta"]);
    expect(titles(sortEntries(vis, "releaseDate"))).toEqual(["The Beta", "Alpha", "Delta"]);
    expect(titles(sortEntries(vis, "-title"))).toEqual(["Delta", "The Beta", "Alpha"]);
    expect(titles(sortEntries(vis, "provider"))).toEqual(["Delta", "Alpha", "The Beta"]);
    expect(titles(sortEntries(vis, "bogus"))).toEqual(["Alpha", "The Beta", "Delta"]);
  });

  it("lists facets", () => {
    expect(facets(all).tags).toEqual(["coop", "fav"]);
    expect(facets(all).categories).toEqual([{ id: "steam/RPG", provider: "steam", name: "RPG" }]);
  });
});

describe("groups", () => {
  const now = Date.parse("2026-06-10T12:00:00Z");
  const x = entry("Xenon", { tags: ["b", "a"], categories: [{ provider: "steam", name: "RPG" }], lastLaunched: "2026-06-10T08:00:00Z" });
  const y = entry("Yarn", { tags: ["a"], favorite: true, lastLaunched: "2026-05-01T00:00:00Z" });
  const z = entry("7 Days", {});

  it("puts entries on every shelf they belong to, catch-all last", () => {
    const g = groupEntries([x, y, z], "tag", undefined, now);
    expect(g.map((s) => [s.label, s.entries.map((e) => e.title)])).toEqual([
      ["a", ["Xenon", "Yarn"]],
      ["b", ["Xenon"]],
      ["Untagged", ["7 Days"]],
    ]);
    expect(g[2].orderable).toBe(false);
  });

  it("follows the user's shelf order", () => {
    const g = groupEntries([x, y, z], "tag", { order: { tag: ["b"] }, collapsed: [] }, now);
    expect(g.map((s) => s.label)).toEqual(["b", "a", "Untagged"]);
  });

  it("has fixed orders for favorites, recency and letters", () => {
    expect(groupEntries([x, y, z], "favorites", undefined, now).map((s) => s.label)).toEqual(["Favorites", "Everything else"]);
    expect(groupEntries([x, y, z], "recent", undefined, now).map((s) => s.label)).toEqual(["Today", "Earlier", "Never launched"]);
    expect(groupEntries([x, y, z], "letter", undefined, now).map((s) => s.label)).toEqual(["#", "X", "Y"]);
    expect(groupEntries([x, y, z], "category", undefined, now).map((s) => s.key)).toEqual(["category/RPG", "category/Uncategorized"]);
  });
});

describe("view order", () => {
  const skin = {
    views: [
      { id: "timeline", name: "Timeline", entry: "t.js", placement: { after: "covers" } },
      { id: "wall", name: "Wall", entry: "w.js", placement: { after: "covers" } },
      { id: "intro", name: "Intro", entry: "i.js", placement: "first" as const },
      { id: "orphan", name: "Orphan", entry: "o.js", placement: { before: "missing" } },
    ],
    overrides: { spotlight: "s.js" },
    styles: { covers: "c.css" },
  };

  it("places skin views by anchor, keeping manifest order", () => {
    expect(placeViews(skin).map((v) => v.id)).toEqual(["intro", "list", "covers", "timeline", "wall", "spotlight", "orphan"]);
    const s = placeViews(skin);
    expect(s.find((v) => v.id === "spotlight")?.entry).toBe("s.js");
    expect(s.find((v) => v.id === "covers")?.style).toBe("c.css");
  });

  it("gives built-ins fixed hotkeys and skin views Ctrl+4.. in order", () => {
    const v = orderViews({ views: [{ id: "timeline", name: "Timeline", entry: "t.js", placement: { after: "covers" } }] });
    expect(v.map((x) => `${x.id}=${x.hotkey}`)).toEqual(["list=Ctrl+1", "covers=Ctrl+2", "timeline=Ctrl+4", "spotlight=Ctrl+3"]);
  });

  it("applies the user's order and hidden views; new views slot in by placement", () => {
    const v = orderViews(skin, { order: ["spotlight", "covers", "list"], hidden: ["intro"] });
    expect(v.map((x) => x.id)).toEqual(["intro", "spotlight", "covers", "timeline", "wall", "list", "orphan"]);
    expect(v[0].hidden && !v[0].hotkey).toBe(true);
    expect(v.find((x) => x.id === "timeline")?.hotkey).toBe("Ctrl+4");
    expect(availableViews(v, true).map((x) => x.id)).toEqual(["spotlight", "covers"]);
  });
});

describe("art", () => {
  it("snaps widths up", () => {
    expect([1, 160, 161, 600, 1920, 1921, 0, NaN].map(snapWidth)).toEqual([160, 160, 320, 640, 1920, "full", 160, 160]);
    expect(withWidth("/a?v=1", 320)).toBe("/a?v=1&w=320");
    expect(withWidth("/a", "full")).toBe("/a?w=full");
  });

  it("wraps placeholder titles", () => {
    expect(wrap("The Elder Scrolls V: Skyrim Special Edition", 14, 5)).toEqual(["The Elder", "Scrolls V:", "Skyrim Special", "Edition"]);
    expect(wrap("Supercalifragilistic", 8, 5)).toEqual(["Supercal", "ifragili", "stic"]);
    expect(wrap("a b c d e f", 1, 3)).toEqual(["a", "b", "…"]);
  });

  it("makes deterministic, escaped SVG", () => {
    const s = placeholderSvg("Tom & <Jerry>", "cover");
    expect(s).toBe(placeholderSvg("Tom & <Jerry>", "cover"));
    expect(s).toContain("Tom &#38; &#60;Jerry&#62;");
    expect(placeholderSvg("Hollow Knight", "icon")).toContain(">HK</text>");
    expect(placeholderSvg("Hollow Knight", "hero")).not.toContain("<text");
  });
});

describe("spatial navigation", () => {
  const box = (left: number, top: number, w = 100, h = 150): Box => ({ left, top, right: left + w, bottom: top + h });
  // A 3×2 grid of covers with 20px gaps, plus a wide toolbar above.
  const grid = [box(0, 100), box(120, 100), box(240, 100), box(0, 270), box(120, 270), box(240, 270)];
  const toolbar = box(0, 0, 400, 40);
  const all = [...grid, toolbar];

  it("moves within a grid", () => {
    expect(pickNext(grid[0], all, "right")).toBe(1);
    expect(pickNext(grid[1], all, "down")).toBe(4);
    expect(pickNext(grid[4], all, "left")).toBe(3);
    expect(pickNext(grid[2], all, "right")).toBe(-1);
  });

  it("leaves the grid for the nearest element that way", () => {
    expect(pickNext(grid[1], all, "up")).toBe(6);
    expect(pickNext(toolbar, all, "down")).toBe(0);
  });

  it("prefers aligned targets over closer diagonal ones", () => {
    const from = box(0, 0);
    const aligned = box(0, 400);
    const diagonal = box(300, 200);
    expect(pickNext(from, [diagonal, aligned], "down")).toBe(1);
  });
});
