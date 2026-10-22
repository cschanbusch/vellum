// The case builder's worker: composes a case's printed wrap (back, spine, front side by side, as a
// real insert is laid out) on an OffscreenCanvas, plus the disc label and the big-box emboss, and
// generates the shared surface maps (normal and roughness from seeded heightmaps).
//
// Messages in:  { id, type: "wrap", job }   see compose.js for the job's shape
//               { id, type: "maps" }
// Messages out: { id, ok: true, ...result }  or  { id, ok: false, error }
//
// Everything is laid out in millimetres and converted with the tier's px-per-mm. Art that the
// library only has as a placeholder is never printed: each panel falls back to other art or type.

const BLEED = 2; // mm of bleed around the whole wrap, edge pixels extended outward
const PT = 0.3528; // mm per typographic point

// ---- fonts ------------------------------------------------------------------------------------

const fontLoads = new Map();
function loadFonts(fonts) {
  return Promise.all(
    fonts.map((f) => {
      const k = `${f.family}|${f.weight}|${f.url}`;
      if (!fontLoads.has(k)) {
        const face = new FontFace(f.family, `url("${f.url}")`, { weight: String(f.weight ?? 400) });
        fontLoads.set(
          k,
          face.load().then((loaded) => {
            self.fonts.add(loaded);
          }),
        );
      }
      return fontLoads.get(k);
    }),
  );
}

// ---- art --------------------------------------------------------------------------------------

async function bitmap(url) {
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await createImageBitmap(await res.blob());
  } catch {
    return null;
  }
}

/** A logo trimmed to its visible pixels (logos often carry transparent margins). */
function trimmed(img) {
  if (!img) return null;
  const s = Math.min(1, 400 / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * s));
  const h = Math.max(1, Math.round(img.height * s));
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext("2d", { willReadFrequently: true });
  g.drawImage(img, 0, 0, w, h);
  const px = g.getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (px[(y * w + x) * 4 + 3] > 24) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null; // fully transparent: not a usable logo
  return { img, sx: x0 / s, sy: y0 / s, sw: (x1 - x0 + 1) / s, sh: (y1 - y0 + 1) / s };
}

// ---- color ------------------------------------------------------------------------------------

const hex = (r, g, b) => `#${[r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("")}`;
function rgb(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function lum([r, g, b]) {
  const f = (c) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
const contrast = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
const WHITE = [255, 255, 255];
const INK = [20, 22, 26];
/** White or near-black, whichever reads better on `bg`. */
const textOn = (bg) => (contrast(WHITE, bg) >= contrast(INK, bg) ? WHITE : INK);
const css = (c, a = 1) => `rgb(${c[0]} ${c[1]} ${c[2]} / ${a})`;

/** The art's dominant color: the median of its mid-tone pixels at 32 x 48. */
function dominant(img) {
  const c = new OffscreenCanvas(32, 48);
  const g = c.getContext("2d", { willReadFrequently: true });
  g.drawImage(img, 0, 0, 32, 48);
  const px = g.getImageData(0, 0, 32, 48).data;
  const keep = [];
  for (let i = 0; i < px.length; i += 4) {
    const p = [px[i], px[i + 1], px[i + 2]];
    const l = lum(p);
    if (l > 0.02 && l < 0.85) keep.push(p);
  }
  if (!keep.length) return null;
  const med = (k) => keep.map((p) => p[k]).sort((a, b) => a - b)[keep.length >> 1];
  return [med(0), med(1), med(2)];
}

/** Darkened until white text on it has at least 4.5:1 contrast. */
function darkenFor(c) {
  let out = [...c];
  for (let i = 0; i < 40 && contrast(WHITE, out) < 4.5; i++) out = out.map((v) => v * 0.92);
  return out;
}

// ---- drawing helpers --------------------------------------------------------------------------

/** Draws `img` filling the box, anchored top-centre. Returns false when that would crop too much. */
function fillTop(g, img, x, y, w, h, maxCrop = 0.1) {
  const s = Math.max(w / img.width, h / img.height);
  const dw = img.width * s;
  const dh = img.height * s;
  const cropX = (dw - w) / 2 / dw; // each side
  const cropY = (dh - h) / dh; // all from the bottom
  if (cropX > maxCrop || cropY > maxCrop) return false;
  g.save();
  g.beginPath();
  g.rect(x, y, w, h);
  g.clip();
  g.drawImage(img, x - (dw - w) / 2, y, dw, dh);
  g.restore();
  return true;
}

/**
 * The cover at the panel's full height, centred, with small side margins in `bg` when it is
 * narrower than the panel (a 2:3 cover on a DVD panel leaves about 4 mm a side), or its sides
 * cropped a little when it is wider. Returns false when neither fits well.
 */
function fitHeight(g, img, x, y, w, h, bg) {
  const s = h / img.height;
  const dw = img.width * s;
  if (dw < w * 0.8 || dw > w * 1.1) return false;
  g.fillStyle = css(bg);
  g.fillRect(x, y, w, h);
  g.save();
  g.beginPath();
  g.rect(x, y, w, h);
  g.clip();
  g.drawImage(img, x + (w - dw) / 2, y, dw, h);
  g.restore();
  return true;
}

/** Draws `img` covering the box, centred, cropping as needed. */
function cover(g, img, x, y, w, h, anchorY = 0.5) {
  const s = Math.max(w / img.width, h / img.height);
  const dw = img.width * s;
  const dh = img.height * s;
  g.save();
  g.beginPath();
  g.rect(x, y, w, h);
  g.clip();
  g.drawImage(img, x - (dw - w) / 2, y - (dh - h) * anchorY, dw, dh);
  g.restore();
}

/** A blurred, enlarged copy of `img` over the box. */
function blurred(g, img, x, y, w, h, radius) {
  g.save();
  g.beginPath();
  g.rect(x, y, w, h);
  g.clip();
  g.filter = `blur(${Math.max(1, radius)}px)`;
  const s = Math.max(w / img.width, h / img.height) * 1.15;
  const dw = img.width * s;
  const dh = img.height * s;
  g.drawImage(img, x - (dw - w) / 2, y - (dh - h) / 2, dw, dh);
  g.restore();
}

/** Draws a trimmed logo fitted in the box (centred). */
function logoIn(g, logo, x, y, w, h) {
  const s = Math.min(w / logo.sw, h / logo.sh);
  const dw = logo.sw * s;
  const dh = logo.sh * s;
  g.drawImage(logo.img, logo.sx, logo.sy, logo.sw, logo.sh, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  return [x + (w - dw) / 2, y + (h - dh) / 2, dw, dh];
}

/** A badge (the provider's own icon) drawn in a single color, fitted to height `h`. */
function badge(g, b, x, y, h, color, align = "left", maxW = Infinity) {
  if (b.img) {
    const s = Math.min(h / b.img.height, maxW / b.img.width);
    const w = b.img.width * s;
    const bh = b.img.height * s;
    const c = new OffscreenCanvas(Math.max(1, Math.ceil(w)), Math.max(1, Math.ceil(bh)));
    const bg = c.getContext("2d");
    bg.drawImage(b.img, 0, 0, w, bh);
    bg.globalCompositeOperation = "source-in";
    bg.fillStyle = color;
    bg.fillRect(0, 0, c.width, c.height);
    const dx = align === "center" ? x - w / 2 : x;
    g.drawImage(c, dx, y + (h - bh) / 2);
    return w;
  }
  // No icon from the provider: its name, set small. (The theme draws no store logos itself.)
  g.save();
  g.fillStyle = color;
  g.textBaseline = "middle";
  let size = h * 0.62;
  g.font = `700 ${size}px ${BODY}`;
  const label = b.name.toUpperCase();
  while (size > 4 && g.measureText(label).width > maxW) g.font = `700 ${(size *= 0.9)}px ${BODY}`;
  const w = g.measureText(label).width;
  g.fillText(label, align === "center" ? x - w / 2 : x, y + h / 2);
  g.restore();
  return w;
}

let DISPLAY = "sans-serif";
let BODY = "sans-serif";

/** Splits `text` into at most `max` lines of width `w`; a cut ends in an ellipsis. */
function wrapLines(g, text, w, max) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  let cut = false;
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (!line || g.measureText(next).width <= w) {
      line = next;
      continue;
    }
    lines.push(line);
    line = word;
    if (lines.length === max) {
      cut = true;
      line = "";
      break;
    }
  }
  if (line) lines.push(line);
  const ellipsize = (l) => {
    while (l && g.measureText(`${l}…`).width > w) l = l.slice(0, -1).trimEnd();
    return `${l}…`;
  };
  for (let i = 0; i < lines.length; i++) {
    if (g.measureText(lines[i]).width > w) {
      lines[i] = ellipsize(lines[i]);
      cut = true;
    }
  }
  if (cut && !lines[lines.length - 1].endsWith("…")) lines[lines.length - 1] = ellipsize(lines[lines.length - 1]);
  return { lines, cut };
}

// ---- the wrap ---------------------------------------------------------------------------------

async function composeWrap(job) {
  await loadFonts(job.fonts);
  DISPLAY = `"${job.displayFont}", sans-serif`;
  BODY = `"${job.bodyFont}", sans-serif`;
  const { profile: p, style } = job;
  const k = job.frontPx / p.panel.w; // px per mm
  const mm = (v) => v * k;

  const [coverImg, heroImg, logoRaw, headerImg, iconImg, ...badgeImgs] = await Promise.all([
    bitmap(job.art.cover),
    bitmap(job.art.hero),
    bitmap(job.art.logo),
    bitmap(job.art.header),
    bitmap(job.art.icon),
    ...job.badges.map((b) => bitmap(b.url)),
  ]);
  const badges = job.badges.map((b, i) => ({ name: b.name, img: badgeImgs[i] }));
  const main = badges[0] ?? { name: "", img: null };
  const logo = trimmed(logoRaw);

  const PW = p.panel.w;
  const PH = p.panel.h;
  const SW = p.spine;
  const W = Math.round(mm(PW * 2 + SW + BLEED * 2));
  const H = Math.round(mm(PH + BLEED * 2));
  const canvas = new OffscreenCanvas(W, H);
  const g = canvas.getContext("2d");
  g.imageSmoothingQuality = "high";

  // Panel origins (mm, inside the bleed).
  const back = { x: BLEED, y: BLEED };
  const spine = { x: BLEED + PW, y: BLEED };
  const front = { x: BLEED + PW + SW, y: BLEED };

  const shell = rgb(style.shell);
  const accent = rgb(style.accent);
  const toneFrom = coverImg ?? heroImg ?? headerImg;
  const spineBg = darkenFor((toneFrom && dominant(toneFrom)) ?? shell);
  const bandH = style.band === "top" ? p.band : 0;
  const onAccent = textOn(accent);

  g.fillStyle = css(spineBg);
  g.fillRect(0, 0, W, H);

  // ---- front ----
  const fx = mm(front.x);
  const fy = mm(front.y + bandH);
  const fw = mm(PW);
  const fh = mm(PH - bandH);
  let embossLogo = null;
  if (coverImg && !fitHeight(g, coverImg, fx, fy, fw, fh, spineBg)) {
    // An unusual shape: show all of it over a blurred, enlarged copy of itself.
    blurred(g, coverImg, fx, fy, fw, fh, mm(6));
    g.fillStyle = "rgb(0 0 0 / 0.18)";
    g.fillRect(fx, fy, fw, fh);
    const s = Math.min(fw / coverImg.width, fh / coverImg.height);
    g.drawImage(coverImg, fx + (fw - coverImg.width * s) / 2, fy + (fh - coverImg.height * s) / 2, coverImg.width * s, coverImg.height * s);
  } else if (!coverImg) {
    // No cover: the hero (or the case's own colors) behind the logo or the title.
    if (heroImg) {
      blurred(g, heroImg, fx, fy, fw, fh, mm(3));
      g.fillStyle = "rgb(0 0 0 / 0.25)";
      g.fillRect(fx, fy, fw, fh);
    } else {
      const grad = g.createLinearGradient(fx, fy, fx, fy + fh);
      grad.addColorStop(0, css(spineBg.map((v) => Math.min(255, v * 1.5))));
      grad.addColorStop(1, css(spineBg.map((v) => v * 0.6)));
      g.fillStyle = grad;
      g.fillRect(fx, fy, fw, fh);
    }
    if (logo) {
      embossLogo = logoIn(g, logo, fx + fw * 0.1, fy + fh * 0.12, fw * 0.8, fh * 0.22);
    } else {
      g.fillStyle = "#fff";
      g.textAlign = "center";
      g.textBaseline = "top";
      let size = mm(13);
      let fit;
      for (; size > mm(5); size *= 0.92) {
        g.font = `400 ${size}px ${DISPLAY}`;
        fit = wrapLines(g, job.title.toUpperCase(), fw * 0.82, 4);
        if (!fit.cut) break;
      }
      g.font = `400 ${size}px ${DISPLAY}`;
      fit = wrapLines(g, job.title.toUpperCase(), fw * 0.82, 4);
      const lh = size * 1.3;
      const top = fy + fh / 3 - (fit.lines.length * lh) / 2;
      g.shadowColor = "rgb(0 0 0 / 0.5)";
      g.shadowBlur = mm(1.2);
      fit.lines.forEach((l, i) => g.fillText(l, fx + fw / 2, top + i * lh));
      g.shadowBlur = 0;
      g.textAlign = "left";
    }
  }
  if (bandH) {
    // The band runs across the front and the spine, carrying the store badge.
    g.fillStyle = css(accent);
    g.fillRect(mm(spine.x), mm(front.y), mm(SW + PW), mm(bandH));
    g.fillStyle = "rgb(255 255 255 / 0.18)";
    g.fillRect(mm(spine.x), mm(front.y + bandH) - Math.max(1, mm(0.35)), mm(SW + PW), Math.max(1, mm(0.35)));
    badge(g, main, fx + mm(5), mm(front.y + bandH * 0.2), mm(bandH * 0.6), css(onAccent), "left", fw * 0.6);
  }

  // ---- spine ----
  const sx = mm(spine.x);
  const sw = mm(SW);
  const sTop = mm(spine.y);
  const sBottom = mm(spine.y + PH);
  if (bandH) {
    badge(g, main, sx + sw / 2, mm(spine.y + bandH * 0.2), mm(bandH * 0.6), css(onAccent), "center", sw * 0.8);
  } else if (main.name) {
    badge(g, main, sx + sw / 2, sTop + mm(4), Math.min(sw * 0.6, mm(8)), "#fff", "center", sw * 0.8);
  }
  const iconSize = sw * 0.8;
  let midBottom = sBottom - mm(4);
  if (iconImg) {
    const iy = sBottom - mm(4) - iconSize;
    g.save();
    g.beginPath();
    g.roundRect(sx + (sw - iconSize) / 2, iy, iconSize, iconSize, iconSize * 0.12);
    g.clip();
    cover(g, iconImg, sx + (sw - iconSize) / 2, iy, iconSize, iconSize);
    g.restore();
    midBottom = iy - mm(4);
  }
  const midTop = sTop + (bandH ? mm(bandH) : mm(14)) + mm(4);
  const midLen = midBottom - midTop;
  // Rotated 90 degrees clockwise: x runs down the spine, y runs across it (right to left).
  g.save();
  g.translate(sx + sw / 2, midTop);
  g.rotate(Math.PI / 2);
  if (logo && logo.sw / logo.sh >= 3) {
    g.filter = "brightness(0) invert(1)"; // logos on the spine read best in white
    const lw = Math.min(midLen, (logo.sw / logo.sh) * sw * 0.75);
    logoIn(g, logo, (midLen - lw) / 2, -sw * 0.375, lw, sw * 0.75);
    g.filter = "none";
  } else {
    g.fillStyle = "#fff";
    g.textBaseline = "middle";
    g.textAlign = "center";
    const title = job.title.toUpperCase();
    // 70% of the spine's width, shrinking to 40% before wrapping. On wide spines (big boxes) the
    // type is capped at what a keep case's spine would carry, so titles don't balloon.
    const cap = (f) => Math.min(sw * f, mm(24 * f));
    let size = cap(0.7);
    g.font = `400 ${size}px ${DISPLAY}`;
    while (size > cap(0.4) && g.measureText(title).width > midLen) g.font = `400 ${(size *= 0.95)}px ${DISPLAY}`;
    if (g.measureText(title).width <= midLen) {
      g.fillText(title, midLen / 2, 0);
    } else {
      size = cap(0.36);
      g.font = `400 ${size}px ${DISPLAY}`;
      const { lines } = wrapLines(g, title, midLen, 2);
      const lh = size * 1.18;
      lines.forEach((l, i) => g.fillText(l, midLen / 2, (i - (lines.length - 1) / 2) * lh));
    }
  }
  g.restore();

  // ---- back ----
  const bx = mm(back.x);
  const by = mm(back.y);
  const bw = mm(PW);
  const bh = mm(PH);
  let backBg = spineBg;
  if (job.richBacks && heroImg) {
    blurred(g, heroImg, bx, by, bw, bh, mm(8));
    g.fillStyle = css(spineBg, 0.62);
    g.fillRect(bx, by, bw, bh);
    backBg = spineBg.map((v) => v * 0.9); // the scrim keeps it dark, so white text holds 4.5:1
  }
  const ink = textOn(backBg);
  const inkSoft = css(ink, 0.72);
  const m = mm(7); // margin
  const iw = bw - m * 2;

  // Footer: every source's badge, and the header art small.
  const footH = mm(13);
  const footY = by + bh - m - footH;
  let bxCursor = bx + m;
  for (const b of badges) bxCursor += badge(g, b, bxCursor, footY + footH * 0.25, footH * 0.5, css(ink), "left", iw * 0.28) + mm(4);
  if (headerImg) {
    const hh = footH;
    const hw = Math.min(iw * 0.42, (headerImg.width / headerImg.height) * hh);
    cover(g, headerImg, bx + bw - m - hw, footY, hw, hh);
  }
  g.fillStyle = css(ink, 0.3);
  g.fillRect(bx + m, footY - mm(4), iw, Math.max(1, mm(0.3)));

  // Metadata: label and value pairs, omitting what's missing.
  const md = job.metadata;
  const year = md.releaseDate ? md.releaseDate.slice(0, 4) : null;
  const pairs = [
    ["Developer", md.developer],
    ["Publisher", md.publisher && md.publisher !== md.developer ? md.publisher : null],
    ["Released", year],
    ["Genre", md.genres?.length ? md.genres.slice(0, 3).join(", ") : null],
  ].filter(([, v]) => v);
  const rowH = mm(8);
  const mdTop = footY - mm(6) - pairs.length * rowH;
  g.textBaseline = "middle";
  pairs.forEach(([label, value], i) => {
    const y = mdTop + i * rowH + rowH / 2;
    g.fillStyle = inkSoft;
    g.font = `700 ${mm(3.3)}px ${BODY}`;
    g.letterSpacing = `${mm(0.35)}px`;
    g.fillText(label.toUpperCase(), bx + m, y);
    g.letterSpacing = "0px";
    g.fillStyle = css(ink);
    g.font = `600 ${mm(4.8)}px ${BODY}`;
    let v = String(value);
    const vw = iw - mm(34);
    while (v.length > 1 && g.measureText(v).width > vw) v = v.slice(0, -2) + "…";
    g.fillText(v, bx + m + mm(34), y);
  });

  // Banner (the header art), and the description below it (or a taller strip without one).
  const stripW = iw;
  const textBottom = (pairs.length ? mdTop : footY - mm(4)) - mm(5);
  const strip = headerImg ?? heroImg ?? coverImg; // the header carries the logo; the hero is the Garage backdrop
  const desc = md.description?.trim();
  // The banner whole (never cropped), at most a quarter of the panel tall; narrower art is centred.
  let stripH = 0;
  if (strip) {
    const maxH = desc ? bh * 0.25 : Math.max(bh * 0.25, textBottom - (by + m));
    const aspect = strip.width / strip.height;
    const sw2 = Math.min(stripW, maxH * aspect);
    stripH = sw2 / aspect;
    const sx2 = bx + m + (stripW - sw2) / 2;
    g.save();
    g.beginPath();
    g.roundRect(sx2, by + m, sw2, stripH, mm(1.2));
    g.clip();
    g.drawImage(strip, sx2, by + m, sw2, stripH);
    g.restore();
  }
  if (desc) {
    const top = by + m + (stripH ? stripH + mm(6) : 0);
    // The title as a heading, then the description, shrinking from 11 pt to 8 pt to fit.
    g.fillStyle = css(ink);
    g.textBaseline = "top";
    let hs = mm(5.2);
    g.font = `400 ${hs}px ${DISPLAY}`;
    const head = wrapLines(g, job.title.toUpperCase(), iw, 2);
    head.lines.forEach((l, i) => g.fillText(l, bx + m, top + i * hs * 1.25));
    const textTop = top + head.lines.length * hs * 1.25 + mm(2.5);
    const room = textBottom - textTop;
    let size = 11;
    let fit;
    for (; size >= 8; size -= 0.5) {
      g.font = `400 ${mm(size * PT)}px ${BODY}`;
      const lines = Math.max(1, Math.floor(room / (mm(size * PT) * 1.35)));
      fit = wrapLines(g, desc, iw, lines);
      if (!fit.cut) break;
    }
    if (size < 8) size = 8;
    g.font = `400 ${mm(size * PT)}px ${BODY}`;
    fit = wrapLines(g, desc, iw, Math.max(1, Math.floor(room / (mm(size * PT) * 1.35))));
    g.fillStyle = inkSoft;
    if (room > mm(size * PT)) fit.lines.forEach((l, i) => g.fillText(l, bx + m, textTop + i * mm(size * PT) * 1.35));
  }

  // ---- bleed: extend the edge pixels outward ----
  const b = Math.round(mm(BLEED));
  const ihPx = H - b * 2;
  g.drawImage(canvas, b, b, 1, ihPx, 0, b, b, ihPx);
  g.drawImage(canvas, W - b - 1, b, 1, ihPx, W - b, b, b, ihPx);
  g.drawImage(canvas, 0, b, W, 1, 0, 0, W, b);
  g.drawImage(canvas, 0, H - b - 1, W, 1, 0, H - b, W, b);

  const out = { w: W, h: H, spine: hex(...spineBg) };
  out.wrap = await canvas.convertToBlob({ type: "image/webp", quality: 0.9 });

  // ---- disc label ----
  if (job.disc) out.disc = await discLabel(job, logo, spineBg);

  // ---- big-box emboss: the logo we printed, raised ----
  if (job.emboss && embossLogo) {
    const ek = 0.5; // half resolution is plenty for a soft emboss
    const ec = new OffscreenCanvas(Math.round(W * ek), Math.round(H * ek));
    const eg = ec.getContext("2d");
    eg.fillStyle = "#000";
    eg.fillRect(0, 0, ec.width, ec.height);
    eg.filter = `blur(${mm(1.5) * ek}px) brightness(0) invert(1)`;
    const [lx, ly, lw, lh] = embossLogo;
    eg.drawImage(logo.img, logo.sx, logo.sy, logo.sw, logo.sh, lx * ek, ly * ek, lw * ek, lh * ek);
    out.emboss = await normalBlob(ec, 6);
  }
  return out;
}

/** A logo's average color, weighted by how opaque each pixel is. */
function logoTone(logo) {
  const w = 96;
  const h = Math.max(1, Math.round((w * logo.sh) / logo.sw));
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext("2d", { willReadFrequently: true });
  g.drawImage(logo.img, logo.sx, logo.sy, logo.sw, logo.sh, 0, 0, w, h);
  const px = g.getImageData(0, 0, w, h).data;
  let r = 0, gr = 0, b = 0, a = 0;
  for (let i = 0; i < px.length; i += 4) {
    const k = px[i + 3] / 255;
    r += px[i] * k;
    gr += px[i + 1] * k;
    b += px[i + 2] * k;
    a += k;
  }
  return a ? [r / a, gr / a, b / a] : WHITE;
}

/**
 * The disc's color: the game's own color, darkened behind a light logo or lightened behind a
 * dark one until the logo stands out: 7:1 against its average color, since the turntable's
 * lights brighten the printed disc on screen.
 */
function discColor(base, tone) {
  let bg = [...base];
  const darken = lum(tone) > 0.3;
  for (let i = 0; i < 40 && contrast(bg, tone) < 7; i++) {
    bg = darken ? bg.map((v) => v * 0.88) : bg.map((v) => v + (255 - v) * 0.14);
  }
  return bg;
}

async function discLabel(job, logo, base) {
  const S = 1024;
  const c = new OffscreenCanvas(S, S);
  const g = c.getContext("2d");
  const R = S / 2;
  const hub = R * (23 / 60); // printing starts outside the clear hub
  const bg = logo ? discColor(base, logoTone(logo)) : base;
  const grad = g.createRadialGradient(R, R, hub, R, R, R);
  grad.addColorStop(0, css(bg.map((v) => Math.min(255, v * 1.06 + 4))));
  grad.addColorStop(1, css(bg.map((v) => v * 0.9)));
  g.fillStyle = grad;
  g.beginPath();
  g.arc(R, R, R, 0, Math.PI * 2);
  g.arc(R, R, hub, 0, Math.PI * 2, true);
  g.fill("evenodd");
  // Fine print rings near the edge.
  const ink = textOn(bg);
  g.strokeStyle = css(ink, 0.18);
  g.lineWidth = 2;
  for (const r of [R * 0.96, R * 0.93]) {
    g.beginPath();
    g.arc(R, R, r, 0, Math.PI * 2);
    g.stroke();
  }
  const boxW = R * 1.1;
  const boxH = R * 0.36;
  const top = R - hub - boxH - R * 0.06;
  if (logo) {
    // The logo as published, in its own colors.
    logoIn(g, logo, R - boxW / 2, top, boxW, boxH);
  } else {
    g.fillStyle = css(ink);
    g.textAlign = "center";
    g.textBaseline = "middle";
    let size = R * 0.14;
    g.font = `400 ${size}px ${DISPLAY}`;
    const t = job.title.toUpperCase();
    while (size > R * 0.06 && g.measureText(t).width > boxW) g.font = `400 ${(size *= 0.92)}px ${DISPLAY}`;
    const { lines } = wrapLines(g, t, boxW, 2);
    lines.forEach((l, i) => g.fillText(l, R, top + boxH / 2 + (i - (lines.length - 1) / 2) * size * 1.2));
  }
  return c.convertToBlob({ type: "image/webp", quality: 0.92 });
}

// ---- heightmaps and normal maps -----------------------------------------------------------------

function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const N = 512;

/** Tileable value noise with `px` x `py` lattice cells over the tile. */
function valueNoise(r, px, py) {
  const lat = new Float32Array(px * py).map(() => r());
  const out = new Float32Array(N * N);
  const fade = (t) => t * t * (3 - 2 * t);
  for (let y = 0; y < N; y++) {
    const fy = (y / N) * py;
    const y0 = Math.floor(fy);
    const ty = fade(fy - y0);
    const ya = y0 % py;
    const yb = (y0 + 1) % py;
    for (let x = 0; x < N; x++) {
      const fx = (x / N) * px;
      const x0 = Math.floor(fx);
      const tx = fade(fx - x0);
      const xa = x0 % px;
      const xb = (x0 + 1) % px;
      const a = lat[ya * px + xa] + (lat[ya * px + xb] - lat[ya * px + xa]) * tx;
      const b = lat[yb * px + xa] + (lat[yb * px + xb] - lat[yb * px + xa]) * tx;
      out[y * N + x] = a + (b - a) * ty;
    }
  }
  return out;
}

function fbm(seed, octaves) {
  const r = prng(seed);
  const out = new Float32Array(N * N);
  let total = 0;
  for (const [px, py, amp] of octaves) {
    const n = valueNoise(r, px, py);
    for (let i = 0; i < out.length; i++) out[i] += n[i] * amp;
    total += amp;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

/** Stipple: scattered small soft bumps over fine noise, tileable. */
function stipple(seed, count, radius) {
  const r = prng(seed);
  const out = fbm(seed + 1, [[128, 128, 1], [256, 256, 0.6]]);
  for (let i = 0; i < out.length; i++) out[i] *= 0.35;
  for (let n = 0; n < count; n++) {
    const cx = r() * N;
    const cy = r() * N;
    const rad = radius * (0.6 + r() * 0.8);
    const h = 0.4 + r() * 0.6;
    for (let dy = -Math.ceil(rad); dy <= rad; dy++) {
      for (let dx = -Math.ceil(rad); dx <= rad; dx++) {
        const d = Math.hypot(dx, dy) / rad;
        if (d >= 1) continue;
        const x = (Math.round(cx + dx) + N) % N;
        const y = (Math.round(cy + dy) + N) % N;
        out[y * N + x] = Math.max(out[y * N + x], 0.35 + h * 0.65 * (1 - d * d));
      }
    }
  }
  return out;
}

function rings() {
  const out = new Float32Array(N * N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const r = Math.hypot(x - N / 2 + 0.5, y - N / 2 + 0.5) / (N / 2);
      // A raised stacking ring and fine moulding rings.
      const ring = Math.exp(-(((r - 0.62) / 0.03) ** 2)) + 0.25 * Math.sin(r * 140) * (r < 0.95 ? 1 : 0);
      out[y * N + x] = 0.5 + ring * 0.5;
    }
  }
  return out;
}

/** Sobel normal map (tangent space, tiling) and a matching roughness map from a heightmap. */
function toMaps(hm, strength, roughSpread, wrap = true) {
  const at = (x, y) => {
    if (wrap) return hm[((y + N) % N) * N + ((x + N) % N)];
    return hm[Math.max(0, Math.min(N - 1, y)) * N + Math.max(0, Math.min(N - 1, x))];
  };
  const nc = new OffscreenCanvas(N, N);
  const rc = new OffscreenCanvas(N, N);
  const nd = new ImageData(N, N);
  const rd = new ImageData(N, N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const gx = at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1);
      const gy = at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1);
      let nx = -gx * strength;
      let ny = gy * strength; // image rows run down; tangent-space y runs up
      let nz = 1;
      const l = Math.hypot(nx, ny, nz);
      nx /= l;
      ny /= l;
      nz /= l;
      const i = (y * N + x) * 4;
      nd.data[i] = (nx * 0.5 + 0.5) * 255;
      nd.data[i + 1] = (ny * 0.5 + 0.5) * 255;
      nd.data[i + 2] = (nz * 0.5 + 0.5) * 255;
      nd.data[i + 3] = 255;
      // Raised grain a touch rougher, so highlights break up.
      const r = Math.max(0, Math.min(1, 0.85 + (hm[y * N + x] - 0.5) * roughSpread));
      rd.data[i] = rd.data[i + 1] = rd.data[i + 2] = r * 255;
      rd.data[i + 3] = 255;
    }
  }
  nc.getContext("2d").putImageData(nd, 0, 0);
  rc.getContext("2d").putImageData(rd, 0, 0);
  return { normal: nc.transferToImageBitmap(), rough: rc.transferToImageBitmap() };
}

/** A normal map from a grayscale canvas (white raised), as a PNG blob. */
async function normalBlob(c, strength) {
  const g = c.getContext("2d", { willReadFrequently: true });
  const { width: w, height: h } = c;
  const src = g.getImageData(0, 0, w, h).data;
  const at = (x, y) => src[(Math.max(0, Math.min(h - 1, y)) * w + Math.max(0, Math.min(w - 1, x))) * 4] / 255;
  const out = new ImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const gx = at(x + 1, y) - at(x - 1, y);
      const gy = at(x, y + 1) - at(x, y - 1);
      let nx = -gx * strength;
      let ny = gy * strength;
      const l = Math.hypot(nx, ny, 1);
      const i = (y * w + x) * 4;
      out.data[i] = (nx / l * 0.5 + 0.5) * 255;
      out.data[i + 1] = (ny / l * 0.5 + 0.5) * 255;
      out.data[i + 2] = (1 / l * 0.5 + 0.5) * 255;
      out.data[i + 3] = 255;
    }
  }
  const oc = new OffscreenCanvas(w, h);
  oc.getContext("2d").putImageData(out, 0, 0);
  return oc.convertToBlob({ type: "image/png" });
}

function surfaceMaps() {
  return {
    grain: toMaps(stipple(11, 2600, 2.2), 2.2, 0.35),
    wave: toMaps(fbm(21, [[2, 2, 1], [4, 4, 0.5]]), 6, 0.1),
    paper: toMaps(fbm(31, [[64, 64, 1], [128, 128, 0.7], [256, 256, 0.5]]), 1.6, 0.2),
    fiber: toMaps(fbm(41, [[24, 160, 1], [48, 320, 0.6], [128, 128, 0.4]]), 2.4, 0.3),
    rings: toMaps(rings(), 3, 0.1, false),
  };
}

// ---- dispatch ---------------------------------------------------------------------------------

self.onmessage = async (ev) => {
  const { id, type, job } = ev.data;
  try {
    if (type === "wrap") {
      const out = await composeWrap(job);
      self.postMessage({ id, ok: true, ...out });
    } else if (type === "maps") {
      const maps = surfaceMaps();
      const transfer = Object.values(maps).flatMap((m) => [m.normal, m.rough]);
      self.postMessage({ id, ok: true, maps }, transfer);
    }
  } catch (e) {
    self.postMessage({ id, ok: false, error: String(e?.stack ?? e) });
  }
};
