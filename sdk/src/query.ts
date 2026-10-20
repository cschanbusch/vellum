// Search, filter, sort and grouping, shared by every view and skin so they all behave the same.
// Pure functions over entries; the SDK applies them to the current state in `library.query()`.

import type { Entry, Filters, GroupKey, ShelfPrefs, Sort, SortKey } from "./types";

/** Case- and accent-folded text with ™ ® © and punctuation turned into spaces. */
export function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

interface Folded {
  text: string;
  words: string[];
}

const foldCache = new WeakMap<Entry, Folded>();

function folded(e: Entry): Folded {
  let f = foldCache.get(e);
  if (!f) {
    const text = fold(e.title);
    f = { text, words: text.split(" ").filter(Boolean) };
    foldCache.set(e, f);
  }
  return f;
}

/** True when `q` can be split into prefixes of words in order, e.g. "hk" or "holkni" in "hollow knight". */
function prefixChain(q: string, words: string[], from: number): boolean {
  if (!q) return true;
  for (let w = from; w < words.length; w++) {
    const word = words[w];
    for (let k = Math.min(q.length, word.length); k >= 1; k--) {
      if (word.startsWith(q.slice(0, k)) && prefixChain(q.slice(k), words, w + 1)) return true;
    }
  }
  return false;
}

/** Every space-separated term must match the title as a substring or as a chain of word prefixes. */
export function matches(e: Entry, query: string): boolean {
  const terms = fold(query).split(" ").filter(Boolean);
  if (!terms.length) return true;
  const f = folded(e);
  return terms.every((t) => f.text.includes(t) || prefixChain(t, f.words, 0));
}

export function passesFilters(e: Entry, f: Filters): boolean {
  if (!(f.kinds ?? ["game"]).includes(e.kind)) return false;
  if (!f.showHidden && e.hidden) return false;
  if (f.favorites && !e.favorite) return false;
  if (f.providers?.length && !e.sources.some((s) => f.providers!.includes(s.provider))) return false;
  if (f.tags?.length && !f.tags.every((t) => e.tags.includes(t))) return false;
  if (f.categories?.length && !e.categories.some((c) => f.categories!.includes(`${c.provider}/${c.name}`))) return false;
  return true;
}

const providerName = (e: Entry) =>
  (e.sources.find((s) => s.provider === e.preferredSource) ?? e.sources[0])?.providerName ?? "";

/** Natural directions: titles A→Z, providers A→Z, everything else newest/largest first. */
const SORTERS: Record<SortKey, { value: (e: Entry) => string | number | undefined; desc: boolean }> = {
  title: { value: (e) => e.sortTitle, desc: false },
  provider: { value: (e) => providerName(e).toLowerCase(), desc: false },
  lastLaunched: { value: (e) => e.lastLaunched ?? undefined, desc: true },
  added: { value: (e) => e.addedAt || undefined, desc: true },
  size: { value: (e) => e.sizeBytes, desc: true },
  releaseDate: { value: (e) => e.metadata.releaseDate, desc: true },
};

export function parseSort(sort: string): { key: SortKey; reversed: boolean } {
  const reversed = sort.startsWith("-");
  const key = (reversed ? sort.slice(1) : sort) as SortKey;
  return SORTERS[key] ? { key, reversed } : { key: "title", reversed: false };
}

/** Sorts a copy. Missing values always go last; ties fall back to title, then id. */
export function sortEntries(entries: readonly Entry[], sort: Sort | string): Entry[] {
  const { key, reversed } = parseSort(sort);
  const s = SORTERS[key];
  const dir = s.desc !== reversed ? -1 : 1;
  const tie = (a: Entry, b: Entry) => (a.sortTitle < b.sortTitle ? -1 : a.sortTitle > b.sortTitle ? 1 : a.id < b.id ? -1 : 1);
  return [...entries].sort((a, b) => {
    const va = s.value(a);
    const vb = s.value(b);
    if (va === vb || key === "title") return key === "title" ? dir * tie(a, b) : tie(a, b);
    if (va === undefined) return 1;
    if (vb === undefined) return -1;
    return (va < vb ? -1 : 1) * dir;
  });
}

export function query(entries: readonly Entry[], q: { query: string; filters: Filters; sort: Sort | string }): Entry[] {
  return sortEntries(
    entries.filter((e) => passesFilters(e, q.filters) && matches(e, q.query)),
    q.sort,
  );
}

export interface Group {
  /** Stable key, `"<groupKey>/<label>"`; used for collapsed state. */
  key: string;
  label: string;
  entries: Entry[];
  /** Whether the user may reorder this group among its siblings. */
  orderable: boolean;
}

const DAY = 86_400_000;

function recentBucket(iso: string | null, now: number): string {
  if (!iso) return "Never launched";
  const age = now - Date.parse(iso);
  if (age < DAY) return "Today";
  if (age < 7 * DAY) return "This week";
  if (age < 31 * DAY) return "This month";
  return "Earlier";
}

const FIXED_ORDER: Partial<Record<GroupKey, string[]>> = {
  favorites: ["Favorites", "Everything else"],
  recent: ["Today", "This week", "This month", "Earlier", "Never launched"],
};
const LAST_LABEL: Partial<Record<GroupKey, string>> = { category: "Uncategorized", tag: "Untagged" };

function labelsFor(e: Entry, by: GroupKey, now: number): string[] {
  switch (by) {
    case "category":
      return [...new Set(e.categories.map((c) => c.name))];
    case "tag":
      return e.tags;
    case "provider":
      return [...new Set(e.sources.map((s) => s.providerName))];
    case "favorites":
      return [e.favorite ? "Favorites" : "Everything else"];
    case "recent":
      return [recentBucket(e.lastLaunched, now)];
    case "letter": {
      const c = fold(e.sortTitle).charAt(0).toUpperCase();
      return [c >= "A" && c <= "Z" ? c : "#"];
    }
  }
}

/**
 * Groups already-sorted entries into shelves. An entry in several groups appears in each.
 * Category and tag shelves follow the user's order first, then A→Z; the catch-all is last.
 */
export function groupEntries(entries: readonly Entry[], by: GroupKey, prefs?: ShelfPrefs, now = Date.now()): Group[] {
  const map = new Map<string, Entry[]>();
  const catchAll = LAST_LABEL[by];
  for (const e of entries) {
    const labels = labelsFor(e, by, now);
    for (const l of labels.length ? labels : catchAll ? [catchAll] : []) {
      let list = map.get(l);
      if (!list) map.set(l, (list = []));
      list.push(e);
    }
  }
  const fixed = FIXED_ORDER[by];
  const user = prefs?.order[by] ?? [];
  const rank = (label: string): [number, string] => {
    if (fixed) return [fixed.indexOf(label), ""];
    if (label === catchAll) return [Number.MAX_SAFE_INTEGER, ""];
    if (by === "letter") return [label === "#" ? -1 : 0, label];
    const u = user.indexOf(label);
    return u >= 0 ? [u - user.length, ""] : [0, label.toLowerCase()];
  };
  const orderable = by === "category" || by === "tag";
  return [...map.entries()]
    .map(([label, list]) => ({ key: `${by}/${label}`, label, entries: list, orderable: orderable && label !== catchAll, r: rank(label) }))
    .sort((a, b) => a.r[0] - b.r[0] || (a.r[1] < b.r[1] ? -1 : a.r[1] > b.r[1] ? 1 : 0))
    .map(({ r: _r, ...g }) => g);
}

/** Every user tag and store category in the library, for filter menus. */
export function facets(entries: readonly Entry[]) {
  const tags = new Set<string>();
  const categories = new Map<string, { provider: string; name: string }>();
  for (const e of entries) {
    e.tags.forEach((t) => tags.add(t));
    e.categories.forEach((c) => categories.set(`${c.provider}/${c.name}`, c));
  }
  const byText = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base" });
  return {
    tags: [...tags].sort(byText),
    categories: [...categories.entries()].sort((a, b) => byText(a[1].name, b[1].name)).map(([id, c]) => ({ id, ...c })),
  };
}
