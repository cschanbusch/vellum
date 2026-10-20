import { describe, expect, it } from "vitest";
import { providerPermissions } from "./permissions";

describe("providerPermissions", () => {
  it("lists every declared permission in order", () => {
    const perms = providerPermissions({
      locations: { root: { label: "Steam installation folder" } },
      derivedLocations: true,
      registryRead: ["HKCU\\Software\\Valve\\Steam"],
      uriSchemes: ["steam"],
      artHosts: ["cdn.cloudflare.steamstatic.com"],
    });
    expect(perms.map((p) => p.kind)).toEqual(["folder", "derived", "registry", "uri", "network"]);
    expect(perms[0].text).toContain("Steam installation folder");
    expect(perms[3].text).toContain("steam://");
  });

  it("tolerates missing or malformed sections", () => {
    expect(providerPermissions(null)).toEqual([]);
    expect(providerPermissions({ uriSchemes: "steam", derivedLocations: "yes" })).toEqual([]);
  });
});
