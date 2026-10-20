import { describe, expect, it } from "vitest";
import { validateCall } from "./bridge";

const h = { hasEntry: (id: string) => id === "steam:620", hasView: (id: string) => id === "list" || id === "covers" };

describe("validateCall", () => {
  it("accepts well-formed calls", () => {
    expect(validateCall("state.set", { view: "list", selectedId: "steam:620" }, h)).toBeNull();
    expect(validateCall("state.set", { selectedId: null, query: "hk", sort: "-size", groupBy: "tag" }, h)).toBeNull();
    expect(validateCall("state.set", { filters: { favorites: true, tags: ["a"], kinds: ["game", "tool"] }, groupBy: null }, h)).toBeNull();
    expect(validateCall("actions.launch", { id: "steam:620" }, h)).toBeNull();
    expect(validateCall("actions.launch", { id: "steam:620", provider: "steam" }, h)).toBeNull();
    expect(validateCall("actions.setTags", { id: "steam:620", tags: ["co-op"] }, h)).toBeNull();
    expect(validateCall("actions.setHidden", { id: "steam:620", hidden: true }, h)).toBeNull();
    expect(validateCall("actions.changeArt", { id: "steam:620", kind: "hero" }, h)).toBeNull();
    expect(validateCall("ui.toast", { text: "hi" }, h)).toBeNull();
    expect(validateCall("ui.contextMenu", { id: "steam:620", x: 10, y: 20 }, h)).toBeNull();
    expect(validateCall("ui.theme", { tokens: { "--v-accent": "#ff0", "--v-bg": "rgb(1 2 3)" } }, h)).toBeNull();
    expect(validateCall("shell.command", { command: "refresh" }, h)).toBeNull();
    expect(validateCall("shelves.set", { order: { tag: ["a", "b"] }, collapsed: ["tag/a"] }, h)).toBeNull();
    expect(validateCall("window.startDrag", {}, h)).toBeNull();
  });

  it("rejects unknown keys, wrong types and unknown entries or views", () => {
    expect(validateCall("state.set", { couch: true }, h)).toMatch(/cannot change couch/);
    expect(validateCall("state.set", { view: 3 }, h)).toMatch(/view/);
    expect(validateCall("state.set", { view: "spotlight" }, h)).toMatch(/available view/);
    expect(validateCall("state.set", { sort: "random" }, h)).toMatch(/sort/);
    expect(validateCall("state.set", { groupBy: "color" }, h)).toMatch(/groupBy/);
    expect(validateCall("state.set", { query: "x".repeat(201) }, h)).toMatch(/query/);
    expect(validateCall("state.set", { filters: { evil: 1 } }, h)).toMatch(/unknown filter/);
    expect(validateCall("state.set", { filters: { kinds: ["spaceship"] } }, h)).toMatch(/kind/);
    expect(validateCall("actions.launch", { id: "steam:999" }, h)).toMatch(/no entry/);
    expect(validateCall("actions.launch", { id: 620 }, h)).toMatch(/id must be/);
    expect(validateCall("actions.openStore", { id: "steam:620", provider: {} }, h)).toMatch(/provider/);
    expect(validateCall("actions.setTags", { id: "steam:620", tags: ["x".repeat(41)] }, h)).toMatch(/tags/);
    expect(validateCall("actions.setHidden", { id: "steam:620", hidden: "yes" }, h)).toMatch(/hidden/);
    expect(validateCall("actions.changeArt", { id: "steam:620", kind: "poster" }, h)).toMatch(/art kind/);
    expect(validateCall("ui.toast", { text: "x".repeat(301) }, h)).toMatch(/300/);
    expect(validateCall("ui.toast", "hi", h)).toMatch(/object/);
    expect(validateCall("ui.contextMenu", { id: "steam:620", x: "1", y: 2 }, h)).toMatch(/numbers/);
    expect(validateCall("ui.theme", { tokens: { "--v-bg": "url(http://evil)" } }, h)).toMatch(/unsafe/);
    expect(validateCall("ui.theme", { tokens: { "--x": "red" } }, h)).toMatch(/unknown token/);
    expect(validateCall("shell.command", { command: "rm -rf" }, h)).toMatch(/command/);
    expect(validateCall("shelves.set", { order: { color: [] } }, h)).toMatch(/group keys/);
    expect(validateCall("actions.launch", null, h)).toMatch(/object/);
  });
});
