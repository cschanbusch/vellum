// Writes THIRD-PARTY-NOTICES.txt: the licences of everything compiled into the exe (Rust crates
// and the npm packages bundled into the shell and SDK) and the Inter font the SDK embeds.
// Plugins carry their own third-party notices in their folders.
//
//   node scripts/third-party-notices.mjs [out file]     (default: dist/THIRD-PARTY-NOTICES.txt)
//
// Needs cargo on PATH (rustup's ~/.cargo/bin) and node_modules installed.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(process.argv[2] ?? join(ROOT, "dist", "THIRD-PARTY-NOTICES.txt"));

const LICENSE_FILE = /^(licen[cs]e|copying|notice)([-._].*)?$/i;
function licenceTexts(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => LICENSE_FILE.test(f))
    .sort()
    .map((f) => ({ file: f, text: readFileSync(join(dir, f), "utf8").trim() }));
}

const sections = [];
function add(name, version, licence, dir) {
  const texts = licenceTexts(dir);
  let s = `${name} ${version}\nLicence: ${licence || "see below"}\n`;
  if (texts.length) for (const t of texts) s += `\n--- ${t.file} ---\n${t.text}\n`;
  else s += "(No licence file is included in the package; its licence is stated above.)\n";
  sections.push(s);
}

// ---- Rust crates built into the exe (normal dependencies, for Windows x64) ----
const meta = JSON.parse(
  execFileSync(
    "cargo",
    ["metadata", "--format-version", "1", "--locked", "--filter-platform", "x86_64-pc-windows-msvc", "--manifest-path", join(ROOT, "src-tauri", "Cargo.toml")],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  ),
);
const byId = new Map(meta.packages.map((p) => [p.id, p]));
const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
const seen = new Set();
const stack = [...meta.workspace_members];
while (stack.length) {
  const id = stack.pop();
  if (seen.has(id)) continue;
  seen.add(id);
  for (const d of nodes.get(id)?.deps ?? []) {
    // Normal and build dependencies end up in (or produce) the exe; dev dependencies don't.
    if (d.dep_kinds.some((k) => k.kind !== "dev")) stack.push(d.pkg);
  }
}
const crates = [...seen]
  .filter((id) => !meta.workspace_members.includes(id))
  .map((id) => byId.get(id))
  .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
for (const c of crates) add(`${c.name} (Rust crate)`, c.version, c.license, dirname(c.manifest_path));

// ---- npm packages bundled into the shell and SDK (production dependencies) ----
const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"));
const npm = Object.entries(lock.packages)
  .filter(([path, p]) => path.startsWith("node_modules/") && !p.dev && !p.optional)
  .sort(([a], [b]) => a.localeCompare(b));
for (const [path, p] of npm) add(`${path.slice("node_modules/".length)} (npm package)`, p.version, p.license, join(ROOT, path));

// ---- Fonts embedded in the exe ----
const inter = readFileSync(join(ROOT, "sdk", "assets", "fonts", "Inter-LICENSE.txt"), "utf8").trim();
sections.push(`Inter (typeface, embedded in the SDK)\nLicence: OFL-1.1\n\n${inter}\n`);

const header = `Vellum Game Launcher: third-party notices

Vellum Game Launcher (Copyright 2026 Charles Schanbusch, GPL-3.0-only; see LICENSE) includes the
following third-party software, each under its own licence. Plugins in plugins/ carry their own
licences and third-party notices in their folders.

${crates.length} Rust crates, ${npm.length} npm packages, 1 font.
`;
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${header}\n${"=".repeat(78)}\n\n${sections.join(`\n${"=".repeat(78)}\n\n`)}`);
console.log(`wrote ${out}: ${crates.length} crates, ${npm.length} npm packages`);
