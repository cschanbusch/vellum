// Generated placeholder art: a deterministic two-tone SVG from a hash of the title.
// The backend serves the same SVG (src-tauri/src/art/placeholder.rs); the skin dev harness uses
// this copy. tests/fixtures/placeholders.json keeps the two byte-for-byte identical.

import type { ArtKind } from "./types";

interface Layout {
  w: number;
  h: number;
  /** Characters per line before wrapping, font size, max lines; 0 = no title text. */
  chars: number;
  size: number;
  lines: number;
}

const LAYOUTS: Record<ArtKind, Layout> = {
  cover: { w: 600, h: 900, chars: 14, size: 64, lines: 5 },
  hero: { w: 1920, h: 620, chars: 0, size: 0, lines: 0 },
  header: { w: 920, h: 430, chars: 22, size: 54, lines: 3 },
  logo: { w: 1280, h: 400, chars: 24, size: 96, lines: 2 },
  icon: { w: 256, h: 256, chars: 0, size: 0, lines: 0 },
};

const FONT = "Inter, 'Segoe UI', system-ui, sans-serif";

/** FNV-1a over the UTF-8 bytes. */
export function hashTitle(title: string): number {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(title)) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Greedy word wrap by character count; long words are broken; overflow ends in "…". */
export function wrap(title: string, chars: number, maxLines: number): string[] {
  const lines: string[] = [];
  let line: string[] = [];
  const push = () => {
    lines.push(line.join(""));
    line = [];
  };
  for (const word of title.split(/\s+/).filter(Boolean)) {
    let w = Array.from(word);
    if (line.length && line.length + 1 + w.length > chars) push();
    if (line.length) line.push(" ");
    while (w.length > chars - line.length) {
      const take = chars - line.length;
      line.push(...w.slice(0, take));
      w = w.slice(take);
      push();
    }
    line.push(...w);
  }
  if (line.length) push();
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    const last = Array.from(kept[maxLines - 1]);
    kept[maxLines - 1] = last.slice(0, Math.max(0, chars - 1)).join("").trimEnd() + "…";
    return kept;
  }
  return lines;
}

function initials(title: string): string {
  const words = title.split(/\s+/).filter((w) => /^[\p{L}\p{N}]/u.test(w));
  return words
    .slice(0, 2)
    .map((w) => Array.from(w)[0].toUpperCase())
    .join("");
}

export function placeholderSvg(title: string, kind: ArtKind): string {
  const L = LAYOUTS[kind];
  const h = hashTitle(title);
  const hue1 = h % 360;
  const hue2 = (hue1 + 30 + ((h >>> 9) % 60)) % 360;
  const cx = (h >>> 3) % L.w;
  const cy = (h >>> 13) % L.h;
  const r = Math.floor(Math.max(L.w, L.h) * 0.6);
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${L.w} ${L.h}" width="${L.w}" height="${L.h}">`,
  ];
  if (kind !== "logo") {
    parts.push(
      `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
        `<stop offset="0" stop-color="hsl(${hue1},45%,20%)"/><stop offset="1" stop-color="hsl(${hue2},55%,36%)"/>` +
        `</linearGradient></defs>`,
      `<rect width="${L.w}" height="${L.h}" fill="url(#g)"/>`,
      `<circle cx="${cx}" cy="${cy}" r="${r}" fill="hsl(${hue2},60%,60%)" fill-opacity="0.12"/>`,
    );
  }
  const text = kind === "icon" ? [initials(title)] : L.chars ? wrap(title, L.chars, L.lines) : [];
  const size = kind === "icon" ? 110 : L.size;
  if (text.length && text[0]) {
    const lineHeight = Math.round(size * 1.15);
    const first = Math.round(L.h / 2 - ((text.length - 1) * lineHeight) / 2 + size * 0.35);
    parts.push(
      `<g font-family="${FONT}" font-weight="700" font-size="${size}" fill="#ffffff" fill-opacity="0.92" text-anchor="middle">`,
    );
    text.forEach((t, i) => parts.push(`<text x="${L.w / 2}" y="${first + i * lineHeight}">${escapeXml(t)}</text>`));
    parts.push(`</g>`);
  }
  parts.push(`</svg>`);
  return parts.join("");
}
