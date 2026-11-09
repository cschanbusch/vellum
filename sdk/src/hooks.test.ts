import { describe, expect, it } from "vitest";
import { allowLaunch, prepareLaunch } from "./hooks";

describe("launching an entry set to ask each time", () => {
  const ask = { id: "a", askSource: true };

  it("asks first, then runs the hooks with the chosen store", async () => {
    const seen: string[] = [];
    const out = await prepareLaunch(ask, "a", undefined, async () => (seen.push("ask"), "gog"), [(_, p) => void seen.push(`hook:${p}`)]);
    expect(out).toEqual({ provider: "gog" });
    expect(seen).toEqual(["ask", "hook:gog"]);
  });

  it("runs no hooks and doesn't launch when the picker is cancelled", async () => {
    const seen: string[] = [];
    expect(await prepareLaunch(ask, "a", undefined, async () => null, [() => void seen.push("hook")])).toBeNull();
    expect(seen).toEqual([]);
  });

  it("doesn't ask when a store was named, or the entry isn't set to ask", async () => {
    const never = async () => {
      throw new Error("asked");
    };
    expect(await prepareLaunch(ask, "a", "steam", never, [])).toEqual({ provider: "steam" });
    expect(await prepareLaunch({ id: "b" }, "b", undefined, never, [])).toEqual({ provider: undefined });
  });

  it("still lets a hook call it off after the choice", async () => {
    expect(await prepareLaunch(ask, "a", undefined, async () => "gog", [() => false])).toBeNull();
  });
});

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
