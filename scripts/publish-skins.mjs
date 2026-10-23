// Publishes skins to the catalog repository (cschanbusch/vellum-skins), where Vellum's
// Settings → Get skins finds them (src-tauri/src/catalog.rs).
//
//   node scripts/publish-skins.mjs [skin ids…]      (default: the showcase skins)
//   node scripts/publish-skins.mjs --dry-run        (build the zips in dist/skins, publish nothing)
//
// For each skin, the version in its plugin.json is published once: a release tagged
// `<id>-v<version>` with `<id>-<version>.zip` (one `<id>/` folder, without dev-only files) and a
// preview image, then an entry in catalog.json. A version that's already published is skipped, so
// bump the skin's version to publish a change. Needs the GitHub CLI (`gh`), signed in.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = "cschanbusch/vellum-skins";
const SHOWCASE = ["frontier", "ficsit", "redline", "calling-card"];
/** Folders a skin keeps for development only. */
const DEV_ONLY = ["dev"];

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const ids = args.filter((a) => !a.startsWith("--"));
const skins = ids.length ? ids : SHOWCASE;
const out = join(ROOT, "dist", "skins");
mkdirSync(out, { recursive: true });

const gh = (...a) => execFileSync("gh", a, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
const tar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const download = (tag, file) => `https://github.com/${REPO}/releases/download/${tag}/${file}`;

function readManifest(id) {
  const dir = ["extras", "plugins"].map((d) => join(ROOT, d, "skins", id)).find((d) => existsSync(join(d, "plugin.json")));
  if (!dir) throw new Error(`no skin named ${id}`);
  return { dir, manifest: JSON.parse(readFileSync(join(dir, "plugin.json"), "utf8").replace(/^\uFEFF/, "")) };
}

/** Files git ignores in `dir` (a player's own music, say): they never go into a published zip. */
function ignoredFiles(dir) {
  const out = execFileSync("git", ["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", dir], { cwd: ROOT, encoding: "utf8" });
  return new Set(out.split("\0").filter(Boolean).map((f) => resolve(ROOT, f)));
}

/** The zip: one `<id>/` folder (Windows' tar writes standard zips). */
function buildZip(id, dir, version) {
  const stage = join(out, ".stage");
  rmSync(stage, { recursive: true, force: true });
  const ignored = ignoredFiles(dir);
  const keep = (src) => !DEV_ONLY.some((d) => src === join(dir, d)) && !ignored.has(resolve(src));
  cpSync(dir, join(stage, id), { recursive: true, filter: keep });
  const zip = join(out, `${id}-${version}.zip`);
  rmSync(zip, { force: true });
  execFileSync(tar, ["-a", "-c", "-f", zip, "-C", stage, id]);
  rmSync(stage, { recursive: true, force: true });
  return zip;
}

function released(tag) {
  try {
    gh("release", "view", tag, "-R", REPO, "--json", "tagName");
    return true;
  } catch {
    return false;
  }
}

function loadCatalog() {
  try {
    const file = JSON.parse(gh("api", `repos/${REPO}/contents/catalog.json`));
    return { catalog: JSON.parse(Buffer.from(file.content, "base64").toString("utf8")), sha: file.sha };
  } catch {
    return { catalog: { schema: 1, plugins: [] }, sha: null };
  }
}

const versionKey = (v) => v.split(/[.-]/).map((n) => (/^\d+$/.test(n) ? Number(n).toString().padStart(8, "0") : n)).join(".");

const { catalog, sha } = loadCatalog();
let changed = false;
for (const id of skins) {
  const { dir, manifest } = readManifest(id);
  const version = manifest.version;
  const tag = `${id}-v${version}`;
  const zip = buildZip(id, dir, version);
  const entry = {
    version,
    apiVersion: manifest.apiVersion ?? 1,
    url: download(tag, `${id}-${version}.zip`),
    size: statSync(zip).size,
    sha256: sha256(zip),
    published: new Date().toISOString(),
  };
  const previewName = `${id}-preview.jpg`;
  const previewSrc = join(dir, manifest.skin?.preview ?? "preview.jpg");
  if (dryRun) {
    console.log(`would publish ${tag}: ${zip} (${entry.size} bytes, sha256 ${entry.sha256})`);
    continue;
  }
  if (released(tag)) {
    console.log(`${tag} is already published; bump ${id}'s version to publish a change`);
    continue;
  }
  const preview = join(out, previewName);
  const assets = [zip];
  if (existsSync(previewSrc)) {
    cpSync(previewSrc, preview);
    assets.push(preview);
  }
  gh("release", "create", tag, "-R", REPO, "--latest=false", "--title", `${manifest.name} ${version}`, "--notes", `${manifest.name} ${version} for Vellum Game Launcher. Install it from Settings → Get skins (Vellum 0.2.1 or newer), or extract the zip into Vellum's plugins\\skins folder.`, ...assets);
  let plugin = catalog.plugins.find((p) => p.id === id);
  if (!plugin) {
    plugin = { id, type: "skin", versions: [] };
    catalog.plugins.push(plugin);
  }
  Object.assign(plugin, {
    name: manifest.name,
    description: manifest.description ?? "",
    author: manifest.author ?? "Charles Schanbusch",
    license: "PolyForm-Strict-1.0.0",
    homepage: `https://github.com/${REPO}`,
    ...(existsSync(previewSrc) ? { preview: download(tag, previewName) } : {}),
  });
  plugin.versions = [entry, ...plugin.versions.filter((v) => v.version !== version)].sort((a, b) => (versionKey(a.version) < versionKey(b.version) ? 1 : -1));
  changed = true;
  console.log(`published ${tag}`);
}

if (changed) {
  catalog.plugins.sort((a, b) => a.name.localeCompare(b.name));
  const body = JSON.stringify(catalog, null, 2) + "\n";
  const fields = ["-X", "PUT", `repos/${REPO}/contents/catalog.json`, "-f", `message=Catalog: ${skins.join(", ")}`, "-f", `content=${Buffer.from(body).toString("base64")}`];
  if (sha) fields.push("-f", `sha=${sha}`);
  gh("api", ...fields);
  console.log("catalog.json updated");
}
