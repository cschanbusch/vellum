// Bundles the parts of three.js the Grand Tour skin's case builder uses into one minified module
// in the skin folder (skins have no network, so the library ships with the skin).
//
//   node scripts/vendor-three.mjs
//
// Add a name to EXPORTS when the case builder starts using it.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rolldown } from "rolldown";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "extras", "skins", "redline", "lib", "three.js");

const EXPORTS = [
  "AlwaysStencilFunc", "BufferGeometry", "CanvasTexture", "CircleGeometry", "Color", "CylinderGeometry",
  "DirectionalLight", "EqualStencilFunc", "ExtrudeGeometry", "Float32BufferAttribute", "Group", "KeepStencilOp",
  "MathUtils", "Matrix4", "Mesh", "MeshBasicMaterial", "MeshPhysicalMaterial", "MeshStandardMaterial",
  "NeutralToneMapping", "NoColorSpace", "PMREMGenerator", "PerspectiveCamera", "PlaneGeometry", "RepeatWrapping",
  "ReplaceStencilOp", "RingGeometry", "SRGBColorSpace", "Scene", "Shape", "Texture", "Vector2", "Vector3",
  "WebGLRenderer",
];

const version = JSON.parse(readFileSync(join(ROOT, "node_modules", "three", "package.json"), "utf8")).version;
const tmp = join(ROOT, "node_modules", ".vendor-three");
mkdirSync(tmp, { recursive: true });
const entry = join(tmp, "entry.js");
writeFileSync(
  entry,
  `export { ${EXPORTS.join(", ")} } from "three";\nexport { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";\n`,
);
const bundle = await rolldown({ input: entry, cwd: ROOT, logLevel: "warn" });
const { output } = await bundle.generate({ format: "esm", minify: true });
await bundle.close();
const banner = `// three.js ${version} (MIT, https://threejs.org), the parts the case builder uses. Built by scripts/vendor-three.mjs.\n`;
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, banner + output[0].code);
writeFileSync(join(dirname(OUT), "three-LICENSE.txt"), readFileSync(join(ROOT, "node_modules", "three", "LICENSE")));
rmSync(tmp, { recursive: true, force: true });
console.log(`wrote ${OUT} (${Math.round(Buffer.byteLength(output[0].code) / 1024)} KB)`);
