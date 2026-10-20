#!/usr/bin/env node
// Skin dev harness: runs a skin in an ordinary browser with the real SDK, the mock library and
// its art, live reload, and a panel for views, couch mode, controller input and options.
// No Rust, Windows or store installs needed.
//
//   npm run dev:skin -- <path to skin folder> [--port 5180] [--count 80] [--no-open]
//
// Two origins, like the app: the harness page (the "shell") on http://localhost:<port>, and the
// sandboxed skin on http://127.0.0.1:<port + 1> with Vellum's CSP.

import { createReadStream, existsSync, readFileSync, statSync, watch } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createServer as createVite } from "vite";
import { mockLibrary } from "./harness/library.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CSP =
  "default-src 'self'; img-src 'self' data: blob:; media-src 'self'; font-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-src 'none'";

// ---- arguments --------------------------------------------------------------------------------

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : fallback;
};
const port = Number(flag("--port", "5180"));
let count = Number(flag("--count", "80"));
const noOpen = args.includes("--no-open") && args.splice(args.indexOf("--no-open"), 1);
const skinDir = resolve(args[0] ?? join(ROOT, "plugins", "skins", "basis"));
const mockDir = join(ROOT, "plugins", "providers", "mock");

if (!existsSync(join(skinDir, "plugin.json"))) {
  console.error(`No plugin.json in ${skinDir}. Pass the path of a skin folder.`);
  process.exit(1);
}

// ---- the SDK ----------------------------------------------------------------------------------

const sdkJs = join(ROOT, "sdk", "dist", "sdk.js");
function buildSdk() {
  console.log("Building the SDK…");
  const r = spawnSync("npx", ["vite", "build", "--config", "sdk/vite.config.ts", "--logLevel", "warn"], { cwd: ROOT, stdio: "inherit", shell: true });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
if (!existsSync(sdkJs)) buildSdk();

// ---- mock library -------------------------------------------------------------------------------

let library = await mockLibrary(mockDir, count);
const artReady = existsSync(join(mockDir, "art"));
if (!artReady) console.log("Mock art not generated; placeholders are shown. Run `npm run mock-art` once (needs Rust), or copy plugins/providers/mock/art from any Vellum package.");

const placeholder = await import(new URL("../sdk/src/placeholder.ts", import.meta.url).href).catch(() => null);

// ---- skin server (the sandboxed origin) ---------------------------------------------------------

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
};

function send(res, status, type, body, extra = {}) {
  res.writeHead(status, { "Content-Type": type, "Content-Security-Policy": CSP, "X-Content-Type-Options": "nosniff", "Cache-Control": "no-cache", ...extra });
  res.end(body);
}

function sendFile(res, file, extra) {
  res.writeHead(200, { "Content-Type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream", "Content-Security-Policy": CSP, "X-Content-Type-Options": "nosniff", "Cache-Control": "no-cache", ...extra });
  createReadStream(file).pipe(res);
}

/** Like the app: only files inside the skin folder; no `..`. */
function skinFile(urlPath) {
  let rel;
  try {
    rel = decodeURIComponent(urlPath).replace(/^\/+/, "") || "index.html";
  } catch {
    return null;
  }
  if (rel.split(/[\\/]/).some((p) => p === ".." || p.includes(":"))) return null;
  const full = resolve(skinDir, rel);
  return full.startsWith(skinDir + sep) && existsSync(full) && statSync(full).isFile() ? full : null;
}

const skinServer = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  if (p === "/__vellum/sdk.js") return sendFile(res, sdkJs);
  if (p === "/__vellum/sdk.css") return sendFile(res, join(ROOT, "sdk", "src", "sdk.css"));
  if (p === "/__vellum/fonts/InterVariable.woff2") return sendFile(res, join(ROOT, "sdk", "assets", "fonts", "InterVariable.woff2"));
  const art = p.match(/^\/__vellum\/art\/(.+)\/(cover|hero|logo|header|icon)$/);
  if (art) {
    const id = decodeURIComponent(art[1]);
    const rec = library.art.get(id);
    if (!rec) return send(res, 404, "text/plain", "no such entry");
    const file = rec.files[art[2]];
    // The harness serves originals; the app also resizes to the requested width.
    if (file && existsSync(file)) return sendFile(res, file, { "Cache-Control": "public, max-age=3600" });
    const svg = placeholder ? placeholder.placeholderSvg(rec.title, art[2]) : "<svg xmlns='http://www.w3.org/2000/svg'/>";
    return send(res, 200, "image/svg+xml", svg);
  }
  if (p.startsWith("/__vellum/")) return send(res, 404, "text/plain", "not found");
  const file = skinFile(p);
  if (!file) return send(res, 404, "text/plain", "not found");
  sendFile(res, file);
});
skinServer.listen(port + 1, "127.0.0.1");

// ---- harness page (the "shell") -----------------------------------------------------------------

const clients = new Set();
function broadcast(event, data) {
  for (const res of clients) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

let reloadTimer;
const changed = new Set();
watch(skinDir, { recursive: true }, (_type, name) => {
  if (!name) return;
  changed.add(name.split(sep).join("/"));
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    for (const path of changed) broadcast("skin-file", { path });
    changed.clear();
  }, 120);
});

function readManifest() {
  const text = readFileSync(join(skinDir, "plugin.json"), "utf8").replace(/^﻿/, "");
  return JSON.parse(text);
}

const harnessPlugin = {
  name: "vellum-harness",
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      const url = new URL(req.url, "http://x");
      if (url.pathname === "/__harness/config") {
        res.setHeader("Content-Type", "application/json");
        let manifest = null;
        let error = null;
        try {
          manifest = readManifest();
        } catch (e) {
          error = `plugin.json: ${e.message}`;
        }
        return res.end(JSON.stringify({ skinOrigin: `http://127.0.0.1:${port + 1}`, skinDir, manifest, error, count, artReady }));
      }
      if (url.pathname === "/__harness/library") {
        const n = Number(url.searchParams.get("count") ?? count);
        if (n !== count) {
          count = Math.max(1, Math.min(5000, n));
          library = await mockLibrary(mockDir, count);
        }
        res.setHeader("Content-Type", "application/json");
        return res.end(JSON.stringify(library.entries));
      }
      if (url.pathname === "/__harness/events") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        res.write(": connected\n\n");
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      }
      next();
    });
  },
};

const vite = await createVite({
  root: join(ROOT, "shell", "harness"),
  configFile: false,
  logLevel: "warn",
  server: { port, strictPort: true, open: !noOpen, fs: { allow: [ROOT] } },
  plugins: [harnessPlugin],
});
await vite.listen();
console.log(`Vellum skin harness: http://localhost:${port}/  (skin: ${skinDir})`);
