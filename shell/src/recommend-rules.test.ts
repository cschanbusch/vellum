import { describe, expect, it } from "vitest";
import type { CatalogPlugin } from "./api";
import { shouldRecommend } from "./recommend-rules";

const skin = (over: Partial<CatalogPlugin> = {}): CatalogPlugin =>
  ({
    id: "redline",
    kind: "skin",
    name: "Grand Tour",
    description: "",
    author: null,
    license: null,
    preview: null,
    homepage: null,
    versions: [{ version: "1.5.1", unavailable: null }],
    installed: null,
    present: null,
    ...over,
  }) as CatalogPlugin;

describe("shouldRecommend", () => {
  it("offers a catalog skin that isn't here", () => expect(shouldRecommend(skin(), [])).toBe(true));
  it("not when the catalog lacks it", () => expect(shouldRecommend(undefined, [])).toBe(false));
  it("not when it is installed from the catalog", () => expect(shouldRecommend(skin({ installed: "1.5.0" }), [])).toBe(false));
  it("not when it ships with this copy of Vellum", () => expect(shouldRecommend(skin({ present: "1.5.1" }), [])).toBe(false));
  it("not after Don't ask again", () => expect(shouldRecommend(skin(), ["redline"])).toBe(false));
  it("not when no version runs here", () =>
    expect(shouldRecommend(skin({ versions: [{ version: "9.0.0", unavailable: "Needs Vellum 9" }] as CatalogPlugin["versions"] }), [])).toBe(false));
});
