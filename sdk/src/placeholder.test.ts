// The backend serves the same placeholder SVG as this module (src-tauri/src/art/placeholder.rs).
// Both test against this fixture. Regenerate after an intentional change with
//   UPDATE_FIXTURES=1 npx vitest run sdk/src/placeholder.test.ts
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { placeholderSvg } from "./placeholder";
import { ART_KINDS } from "./types";

const FIXTURE = fileURLToPath(new URL("../../tests/fixtures/placeholders.json", import.meta.url));
const TITLES = ["Hollow Knight", "The Elder Scrolls V: Skyrim Special Edition", "Tom & <Jerry>", "Ōkami HD", "ゼルダの伝説 ブレス オブ ザ ワイルド", "A", "Supercalifragilisticexpialidocious Adventures", "7 Days to Die", "\"Quoted\" 'Name'"];

it("matches the shared fixture", () => {
  const cases = TITLES.flatMap((title) => ART_KINDS.map((kind) => ({ title, kind, svg: placeholderSvg(title, kind) })));
  if (process.env.UPDATE_FIXTURES || !existsSync(FIXTURE)) writeFileSync(FIXTURE, JSON.stringify(cases, null, 1) + "\n");
  expect(JSON.parse(readFileSync(FIXTURE, "utf8"))).toEqual(cases);
});
