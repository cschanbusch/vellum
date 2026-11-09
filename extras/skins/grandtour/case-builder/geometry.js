// Case geometry, in millimetres: y up with the base at y = 0, the case centred on x and z, the
// front facing +z and the spine on the left (-x), as a case stands on a shelf.
//
// - Shell: rounded-rectangle outlines extruded with a bevel, so every edge is filleted. A case
//   that opens is a tray (with the spine) and a lid that hinges on the spine edge.
// - Insert: one strip swept along the cross-section (back flat, spine fillet, spine, fillet,
//   front flat). The back maps by arc length, as paper wraps: its print runs on round the back
//   fillet and meets the spine there, so the two blend round the curve. The front cover starts
//   exactly where the flat front starts (by arc length alone its first millimetres sat round the
//   front fillet, on the spine's side). Between them the spine print stretches a little, smoothly:
//   1:1 where it meets the back, more toward the front, never with a step. The sleeve is the same
//   strip a little further out. In a keep case the insert is card, PAPER thick: its print is
//   the outer face, and its top and bottom edges and cut ends are solid, paper-white faces.
//
// Geometry is built once per profile and level of detail, and shared by every case of that form.
import * as THREE from "../lib/three.js";

export const BLEED = 2; // mm, as the wrap is composed (compose.worker.js)
const SPINE_INSET = 1.1; // the shell's spine wall sits inside the insert's larger spine fillet
const STRIP_GAP = 0.2; // insert above the shell
const SLEEVE_GAP = 0.2; // sleeve above the insert
const PAPER = 0.3; // a keep case's printed insert: card stock, about 0.3 mm

/**
 * The solid parts of a card insert between its inner path and outer (printed) path, samples a to
 * b: the top and bottom edges and both cut ends, as one mesh (position and normal; no print).
 */
function paperGeometry(inner, outer, a, b, y0, y1) {
  const pos = [];
  const nrm = [];
  const quad = (p0, p1, p2, p3, n) => {
    // Two triangles, p0 p1 p2 and p0 p2 p3; flipped below if they face away from n.
    const e1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
    const e2 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
    const c = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const tri = c[0] * n[0] + c[1] * n[1] + c[2] * n[2] >= 0 ? [p0, p1, p2, p0, p2, p3] : [p0, p2, p1, p0, p3, p2];
    for (const v of tri) {
      pos.push(...v);
      nrm.push(...n);
    }
  };
  for (let i = a; i < b; i++) {
    const [ia, ib, oa, ob] = [inner[i], inner[i + 1], outer[i], outer[i + 1]];
    quad([ia.x, y1, ia.z], [ib.x, y1, ib.z], [ob.x, y1, ob.z], [oa.x, y1, oa.z], [0, 1, 0]);
    quad([ia.x, y0, ia.z], [oa.x, y0, oa.z], [ob.x, y0, ob.z], [ib.x, y0, ib.z], [0, -1, 0]);
  }
  for (const [i, dir] of [
    [a, -1],
    [b, 1],
  ]) {
    // A cut end faces along the strip, away from the rest of it.
    const o = outer[i];
    const n = [o.nz * dir, 0, -o.nx * dir];
    const q = inner[i];
    quad([q.x, y0, q.z], [o.x, y0, o.z], [o.x, y1, o.z], [q.x, y1, q.z], n);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
  return g;
}

/** Detail levels: segments per fillet and per plan corner. */
export const LOD = { focused: { fillet: 8, corner: 8 }, near: { fillet: 3, corner: 4 } };

/** A rectangle with its own radius per corner (tl, tr, br, bl), as a Shape. */
function roundedRect(x0, y0, x1, y1, [tl, tr, br, bl]) {
  const s = new THREE.Shape();
  s.moveTo(x0 + bl, y0);
  s.lineTo(x1 - br, y0);
  if (br) s.quadraticCurveTo(x1, y0, x1, y0 + br);
  s.lineTo(x1, y1 - tr);
  if (tr) s.quadraticCurveTo(x1, y1, x1 - tr, y1);
  s.lineTo(x0 + tl, y1);
  if (tl) s.quadraticCurveTo(x0, y1, x0, y1 - tl);
  s.lineTo(x0, y0 + bl);
  if (bl) s.quadraticCurveTo(x0, y0, x0 + bl, y0);
  return s;
}

/**
 * A filleted slab: the outline (x0..x1, 0..h) extruded from z0 to z1, every edge rounded by
 * `edge`. Corner radii are for the outer outline.
 */
function slab(x0, x1, h, z0, z1, radii, edge, lod) {
  const e = Math.min(edge, (z1 - z0) / 2 - 0.05);
  const inner = radii.map((r) => Math.max(0, r - e));
  const shape = roundedRect(x0 + e, e, x1 - e, h - e, inner);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(0.01, z1 - z0 - 2 * e),
    bevelEnabled: true,
    bevelThickness: e,
    bevelSize: e,
    bevelOffset: 0,
    bevelSegments: lod.fillet,
    curveSegments: lod.corner,
  });
  geo.translate(0, 0, z0 + e);
  geo.computeVertexNormals();
  return geo;
}

/**
 * The insert's path in the x-z plane, as samples { x, z, nx, nz, s, w } (s = arc length from the
 * back's open edge; w = the point's position across the printed wrap, in mm, bleed excluded).
 * `out` is the distance outside the case's outer faces.
 */
export function stripPath(p, out, lod) {
  const W = p.outer.w;
  const D = p.outer.d;
  const r = p.fillet.spine + out;
  const zf = D / 2 + out; // front surface
  const xs = -W / 2 - out; // spine surface
  const cxs = xs + r; // fillet centres
  const czf = zf - r;
  const spineFlat = 2 * czf;
  // The back flat is what the back panel leaves after running round the fillet; the front gets a
  // flat as wide as its panel. Either is cut short if the case is too narrow.
  const maxFlat = W - (p.fillet.spine + out) - p.fillet.edge - 0.5; // stay clear of the open edge
  const arcLen = (Math.PI / 2) * r;
  const backFlat = Math.max(1, Math.min(maxFlat, p.spine / 2 + p.panel.w - spineFlat / 2 - arcLen));
  const frontFlat = Math.max(1, Math.min(maxFlat, p.panel.w));
  const pts = [];
  const push = (x, z, nx, nz) => {
    const prev = pts[pts.length - 1];
    const s = prev ? prev.s + Math.hypot(x - prev.x, z - prev.z) : 0;
    if (prev && s - prev.s < 1e-6) return;
    pts.push({ x, z, nx, nz, s });
  };
  // Back, from its open edge toward the spine.
  push(cxs + backFlat, -zf, 0, -1);
  push(cxs, -zf, 0, -1);
  // Back-spine fillet, centre (cxs, -czf), from straight back (-z) round to straight left (-x).
  for (let i = 1; i <= lod.fillet; i++) {
    const a = -Math.PI / 2 - (i / lod.fillet) * (Math.PI / 2);
    push(cxs + Math.cos(a) * r, -czf + Math.sin(a) * r, Math.cos(a), Math.sin(a));
  }
  const spineTop = pts.length - 1; // the spine face runs from here...
  push(xs, czf, -1, 0);
  const spineBottom = pts.length - 1; // ...to here
  // Spine-front fillet, centre (cxs, czf), from left (-x) round to front (+z).
  for (let i = 1; i <= lod.fillet; i++) {
    const a = Math.PI + (i / lod.fillet) * (-Math.PI / 2);
    push(cxs + Math.cos(a) * r, czf + Math.sin(a) * r, Math.cos(a), Math.sin(a));
  }
  const frontStart = pts.length - 1;
  push(cxs + frontFlat, zf, 0, 1);
  // Where each sample falls on the print (w, mm across the wrap).
  const P = p.spine;
  const PW = p.panel.w;
  // Measured on the samples themselves (chords run a little shorter than the true arcs).
  const sMid = (pts[spineTop].s + pts[spineBottom].s) / 2;
  const sb = sMid - P / 2; // the back panel ends here, as arc length places it
  const sf = pts[frontStart].s; // the front panel starts here
  const L = sf - sb; // the stretch the spine print covers
  // w = x + a x^2 over the spine: slope 1 where it meets the back (no join), (2P - L) / L where it
  // meets the front. Linear if the curve would turn back on itself (L > 2P, not in any profile).
  const a = L > 0 && L <= 2 * P ? (P - L) / (L * L) : 0;
  const lin = L > 0 ? P / L : 1;
  const frontLen = pts[pts.length - 1].s - sf;
  for (const q of pts) {
    if (q.s <= sb) q.w = PW - (sb - q.s);
    else if (q.s < sf) {
      const x = q.s - sb;
      q.w = PW + (a ? x + a * x * x : x * lin);
    } else q.w = PW + P + (frontLen > 0 ? ((q.s - sf) / frontLen) * PW : 0);
  }
  return { pts, spineTop, spineBottom, frontStart, hinge: { x: cxs, z: zf } };
}

/**
 * A strip mesh over path samples `pts` (from index a to b), y from y0 to y1, mapped onto the
 * wrap. uv: the wrap (v = 0 at the image's top row, as ImageBitmaps upload). uv1: millimetres,
 * for tiling surface maps.
 */
function stripGeometry(pts, a, b, y0, y1, wrapMm) {
  const pos = [];
  const nrm = [];
  const uv = [];
  const uv1 = [];
  const idx = [];
  for (let i = a; i <= b; i++) {
    const q = pts[i];
    const u = (BLEED + q.w) / wrapMm.w;
    for (const [y, v] of [
      [y0, (BLEED + (y1 - y0)) / wrapMm.h],
      [y1, BLEED / wrapMm.h],
    ]) {
      pos.push(q.x, y, q.z);
      nrm.push(q.nx, 0, q.nz);
      uv.push(u, v);
      uv1.push(q.s, y);
    }
  }
  for (let i = 0; i < b - a; i++) {
    const k = i * 2;
    // Outward-facing winding: the path runs back -> spine -> front (clockwise seen from above).
    idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute("uv1", new THREE.Float32BufferAttribute(uv1, 2));
  g.setIndex(idx);
  return g;
}

const cache = new Map();

/**
 * Geometry for a profile at a detail level ("focused" or "near"), shared between cases:
 * { tray, lid, spineCap, insertBack, insertFront, sleeveBack, sleeveFront, disc, hinge, wrapMm }.
 * For a case that doesn't open, `tray` is the whole shell and `lid` is null.
 */
export function caseGeometry(name, p, level = "focused") {
  const key = `${name}|${level}`;
  if (cache.has(key)) return cache.get(key);
  const lod = LOD[level];
  const W = p.outer.w;
  const H = p.outer.h;
  const D = p.outer.d;
  const cr = p.cornerRadius;
  const edge = p.fillet.edge;
  const wrapMm = { w: p.panel.w * 2 + p.spine + BLEED * 2, h: p.panel.h + BLEED * 2 };
  const xSpine = -W / 2 + SPINE_INSET;
  const out = {};

  // A keep case's insert is card with a thickness; a box's print is the box itself.
  const paper = p.opens ? PAPER : 0;
  const ins = stripPath(p, STRIP_GAP + paper, lod);
  const y0 = (H - p.panel.h) / 2;
  const y1 = y0 + p.panel.h;
  out.wrapMm = wrapMm;

  if (p.opens) {
    // A clamshell split down the middle of its thickness: the tray (the back half, with the
    // spine) and the lid (the front half). The lid hinges where a real keep case's cover does: on
    // the outer front corner of the spine, where the insert folds round from the spine to the front.
    // So the insert stays joined at the fold at every angle, and the lid swings clear of the spine.
    // (Hinged at the middle of the thickness, it swept through the spine as it opened.)
    const LID = D / 2;
    const hx = ins.hinge.x;
    const hz = ins.hinge.z;
    out.hinge = { x: hx, z: hz };
    out.tray = slab(xSpine, W / 2, H, -D / 2, D / 2 - LID, [cr, cr, cr, cr], edge, lod);
    out.spineCap = slab(xSpine, hx + 0.6, H, D / 2 - LID - 0.5, D / 2, [cr, 0, 0, cr], Math.min(edge, 0.8), lod);
    // Lid geometry is built relative to the hinge, so it rotates about its own origin.
    const lid = slab(hx, W / 2, H, D / 2 - LID, D / 2, [0, cr, cr, 0], edge, lod);
    lid.translate(-hx, 0, -hz);
    out.lid = lid;
    // Split the strips where the front begins (on the hinge line): the front part rides on the lid.
    const split = ins.frontStart;
    out.insertBack = stripGeometry(ins.pts, 0, split, y0, y1, wrapMm);
    out.insertFront = stripGeometry(ins.pts, split, ins.pts.length - 1, y0, y1, wrapMm);
    out.insertFront.translate(-hx, 0, -hz);
    const back = stripPath(p, STRIP_GAP, lod);
    if (paper && back.pts.length === ins.pts.length) {
      out.paperBack = paperGeometry(back.pts, ins.pts, 0, split, y0, y1);
      out.paperFront = paperGeometry(back.pts, ins.pts, split, ins.pts.length - 1, y0, y1);
      out.paperFront.translate(-hx, 0, -hz);
    }
    const slv = stripPath(p, STRIP_GAP + paper + SLEEVE_GAP, lod);
    const split2 = slv.frontStart;
    out.sleeveBack = stripGeometry(slv.pts, 0, split2, y0 - 0.3, y1 + 0.3, wrapMm);
    out.sleeveFront = stripGeometry(slv.pts, split2, slv.pts.length - 1, y0 - 0.3, y1 + 0.3, wrapMm);
    out.sleeveFront.translate(-hx, 0, -hz);
  } else {
    out.tray = slab(xSpine, W / 2, H, -D / 2, D / 2, [cr, cr, cr, cr], edge, lod);
    out.lid = null;
    out.insertBack = stripGeometry(ins.pts, 0, ins.pts.length - 1, y0, y1, wrapMm);
    out.insertFront = null;
    // A film over the print, for wear (cardboard has no sleeve).
    const film = stripPath(p, STRIP_GAP + 0.05, lod);
    out.sleeveBack = stripGeometry(film.pts, 0, film.pts.length - 1, y0, y1, wrapMm);
    out.sleeveFront = null;
  }

  if (p.disc) {
    const seg = level === "focused" ? 96 : 48;
    const label = new THREE.RingGeometry(23, 59.5, seg, 1);
    const hub = new THREE.RingGeometry(7.5, 23, seg, 1);
    const edgeG = new THREE.CylinderGeometry(60, 60, 1.2, seg, 1, true);
    edgeG.rotateX(Math.PI / 2);
    // Ring UVs run up the texture; ImageBitmaps upload top row first, so flip v.
    for (const g of [label, hub]) {
      const a = g.attributes.uv;
      for (let i = 0; i < a.count; i++) a.setY(i, 1 - a.getY(i));
    }
    // The disc lies on the tray, 1.2 mm thick; it is shown only while the lid is open.
    // Centred on the tray beside the hinge; scaled down where a narrow case can't hold 120 mm.
    const hx = ins.hinge.x;
    const scale = Math.min(1, (W / 2 - hx) / 2 / 61);
    out.disc = { label, hub, edge: edgeG, x: (hx + W / 2) / 2, y: H / 2, z: 1.2, scale };
  }
  cache.set(key, out);
  return out;
}

/** The contact shadow: the footprint, softly blurred, as a canvas (white on transparent). */
export function contactShadow(p) {
  const S = 256;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const g = c.getContext("2d");
  const span = Math.max(p.outer.w, p.outer.d) * 1.6;
  const k = S / span;
  g.filter = `blur(${Math.max(4, p.outer.d * k * 0.45)}px)`;
  g.fillStyle = "rgb(0 0 0 / 0.75)";
  g.beginPath();
  g.roundRect(S / 2 - (p.outer.w / 2) * k, S / 2 - (p.outer.d / 2) * k, p.outer.w * k, p.outer.d * k, 3 * k);
  g.fill();
  return { canvas: c, span };
}
