import { describe, expect, it } from "vitest";
import type { Entry } from "../../../sdk/src/types";
import { libraryChange } from "./library-change";

const entry = (id: string, more: Partial<Entry> = {}) => ({ id, title: id, ...more }) as Entry;

describe("libraryChange", () => {
  it("finds nothing when a reload returns the same library", () => {
    expect(libraryChange([entry("a"), entry("b")], [entry("a"), entry("b")])).toEqual({ kind: "none" });
  });

  it("names only the games that differ", () => {
    const changed = entry("b", { playtimeMinutes: 90 });
    expect(libraryChange([entry("a"), entry("b")], [entry("a"), changed])).toEqual({ kind: "entries", changed: [changed] });
  });

  it("needs a whole update when games are added, removed or reordered", () => {
    expect(libraryChange([entry("a")], [entry("a"), entry("b")])).toEqual({ kind: "library" });
    expect(libraryChange([entry("a"), entry("b")], [entry("a")])).toEqual({ kind: "library" });
    expect(libraryChange([entry("a"), entry("b")], [entry("b"), entry("a")])).toEqual({ kind: "library" });
  });
});
