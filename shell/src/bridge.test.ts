import { describe, expect, it } from "vitest";
import { validateCall } from "./bridge";

const h = { hasEntry: (id: string) => id === "steam:620" };

describe("validateCall", () => {
  it("accepts well-formed calls", () => {
    expect(validateCall("state.set", { view: "list", selectedId: "steam:620" }, h)).toBeNull();
    expect(validateCall("state.set", { selectedId: null }, h)).toBeNull();
    expect(validateCall("actions.launch", { id: "steam:620" }, h)).toBeNull();
    expect(validateCall("actions.launch", { id: "steam:620", provider: "steam" }, h)).toBeNull();
    expect(validateCall("ui.toast", { text: "hi" }, h)).toBeNull();
  });

  it("rejects unknown keys, wrong types and unknown entries", () => {
    expect(validateCall("state.set", { couch: true }, h)).toMatch(/only view and selectedId/);
    expect(validateCall("state.set", { view: 3 }, h)).toMatch(/view/);
    expect(validateCall("actions.launch", { id: "steam:999" }, h)).toMatch(/no entry/);
    expect(validateCall("actions.launch", { id: 620 }, h)).toMatch(/id must be/);
    expect(validateCall("actions.openStore", { id: "steam:620", provider: {} }, h)).toMatch(/provider/);
    expect(validateCall("ui.toast", { text: "x".repeat(301) }, h)).toMatch(/300/);
    expect(validateCall("ui.toast", "hi", h)).toMatch(/object/);
    expect(validateCall("actions.launch", null, h)).toMatch(/object/);
  });
});
