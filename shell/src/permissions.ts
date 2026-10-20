// Turns a provider manifest section into the plain-language permission list the user sees
// before enabling or installing a plugin.

interface LocationDecl {
  label?: string;
}

export interface Permission {
  kind: "folder" | "derived" | "registry" | "uri" | "network" | "action";
  text: string;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);

export function providerPermissions(section: Record<string, unknown> | null): Permission[] {
  if (!section) return [];
  const out: Permission[] = [];
  const locations = (section.locations ?? {}) as Record<string, LocationDecl>;
  for (const [key, loc] of Object.entries(locations)) {
    out.push({ kind: "folder", text: `Read files in: ${loc?.label ?? key}` });
  }
  if (section.derivedLocations === true) {
    out.push({ kind: "derived", text: "Read additional folders it finds in the store's own data (e.g. libraries on other drives)" });
  }
  for (const key of strings(section.registryRead)) {
    out.push({ kind: "registry", text: `Read registry keys under ${key}` });
  }
  for (const scheme of strings(section.uriSchemes)) {
    out.push({ kind: "uri", text: `Open ${scheme}:// links (hands launches to the store client)` });
  }
  for (const host of strings(section.artHosts)) {
    out.push({ kind: "network", text: `Point art downloads at ${host} (downloaded by Vellum, not the plugin)` });
  }
  return out;
}
