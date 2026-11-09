import { describe, expect, it } from "vitest";
import { initialValue, type DuplicateView } from "./duplicates-dialog";

const view = (more: Partial<DuplicateView>): DuplicateView => ({
  title: "Gran Turismo 4",
  copies: [
    { record: "steam:1", provider: "steam", providerName: "Steam", title: "Gran Turismo 4" },
    { record: "pcsx2:SCUS-97328", provider: "pcsx2", providerName: "PCSX2", title: "Gran Turismo 4" },
  ],
  pending: true,
  current: null,
  preferred: "steam",
  ...more,
});

describe("initialValue", () => {
  it("preselects the first store for a new duplicate", () => {
    expect(initialValue(view({}))).toBe("one:steam");
  });

  it("preselects separate entries when a copy's provider suggests it (an emulator)", () => {
    expect(initialValue(view({ suggestSeparate: true }))).toBe("separate");
  });

  it("shows what was already decided, whatever the suggestion", () => {
    expect(initialValue(view({ pending: false, current: "one", suggestSeparate: true }))).toBe("one:steam");
  });
});
