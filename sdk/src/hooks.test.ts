import { describe, expect, it } from "vitest";
import { allowLaunch } from "./hooks";

describe("launch hooks", () => {
  it("lets launches through with no hooks or with hooks that return nothing", async () => {
    expect(await allowLaunch([], "a")).toBe(true);
    expect(await allowLaunch([() => {}, async () => true], "a")).toBe(true);
  });

  it("stops at the first hook that calls the launch off, in order", async () => {
    const seen: string[] = [];
    const hooks = [
      async (id: string) => void seen.push(`1:${id}`),
      async () => {
        seen.push("2");
        return false;
      },
      () => void seen.push("3"),
    ];
    expect(await allowLaunch(hooks, "steam:620", "steam")).toBe(false);
    expect(seen).toEqual(["1:steam:620", "2"]);
  });

  it("ignores hooks that throw", async () => {
    const warn = console.warn;
    console.warn = () => {};
    try {
      expect(await allowLaunch([() => { throw new Error("bug"); }], "a")).toBe(true);
    } finally {
      console.warn = warn;
    }
  });
});
