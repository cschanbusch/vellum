// The Garage's cases in WebGL: one renderer and canvas for the whole skin, reused as the focus
// moves. Three turntables stand in a row: the focused case turns on the centre one, its
// neighbours stand still on either side, and stepping left or right slides every case one
// turntable over. Each turntable's top is glass over a mirror: an upside-down copy of each case is
// drawn beneath it (masked to the turntable tops with the stencil), and the glass lets it through
// faintly.
//
// Lighting: a soft key light from the upper left, a dim rim light and a small neutral room
// environment for reflections; no shadow maps and no transmission (one pass). Frames are drawn
// only while something moves: an idle, still Garage costs no GPU time.
import * as THREE from "../lib/three.js";
import { RoomEnvironment } from "../lib/three.js";
import { caseGeometry, contactShadow } from "./geometry.js";

const TURN_PERIOD = 18; // seconds per turn of the turntable
const STILL_YAW = 0.42; // a resting angle that shows the front and a sliver of spine
const SIDE_YAW = 0.5; // neighbours turn this far toward the centre
const OPEN_YAW = 0.18;
const LID_OPEN = (160 * Math.PI) / 180;
const FLOOR = new THREE.Color("#f3f6f9");
const TABLE_R = 112; // turntable radius, mm
const SPACING = 262; // centre to centre of the turntables
const BACK = 70; // the side turntables stand this much further back
const SLIDE_MS = 450;
const ease = (t) => 1 - (1 - t) ** 3;

/** Pixels of case texture uploaded per frame (about 1 MB). A whole full-size wrap in one call
 *  held up a frame for ~65 ms on integrated graphics. */
const UPLOAD_PX = 262144;
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

/** Turntable positions: the slots, and just off-screen either side. */
const SLOTS = {
  L: { x: -SPACING, z: -BACK, yaw: SIDE_YAW },
  C: { x: 0, z: 0, yaw: STILL_YAW },
  R: { x: SPACING, z: -BACK, yaw: -SIDE_YAW },
  offL: { x: -SPACING * 2, z: -BACK * 2, yaw: SIDE_YAW },
  offR: { x: SPACING * 2, z: -BACK * 2, yaw: -SIDE_YAW },
};

const grimeImg = new Image();
grimeImg.src = new URL("../textures/grime.svg", import.meta.url).href;

/** A texture filled from `img` a band of rows per frame (see UPLOAD_PX), so no frame waits on a
 *  whole upload. Resolves with the texture, or with null (and nothing kept) once `alive()` is
 *  false. Same settings as tex(). */
async function streamTex(renderer, img, { srgb = true, aniso = 1 } = {}, alive = () => true) {
  const w = img.width;
  const h = img.height;
  if (w * h <= UPLOAD_PX) {
    const t = tex(img, { srgb, aniso });
    renderer.initTexture(t);
    return t;
  }
  const t = new THREE.DataTexture(null, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.source.dataReady = false; // allocate only: the bands fill it
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.flipY = false;
  t.unpackAlignment = 4;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = aniso;
  t.needsUpdate = true;
  renderer.initTexture(t);
  const src = new THREE.Texture(img); // never uploaded itself: its rows are copied into t
  src.flipY = false;
  const rows = Math.max(8, Math.floor(UPLOAD_PX / w));
  const region = new THREE.Box2();
  const at = new THREE.Vector2();
  for (let y = 0; y < h; y += rows) {
    await nextFrame();
    if (!alive()) {
      t.dispose();
      return null;
    }
    const n = Math.min(rows, h - y);
    region.min.set(0, y);
    region.max.set(w, y + n);
    at.set(0, y);
    t.generateMipmaps = y + n >= h; // mipmaps once, with the last band
    renderer.copyTextureToTexture(src, t, region, at);
  }
  t.generateMipmaps = true;
  return t;
}

/** A texture from an ImageBitmap or canvas, top row first (matching the wraps' v). */
function tex(src, { srgb = true, aniso = 1 } = {}) {
  const t = src instanceof HTMLCanvasElement ? new THREE.CanvasTexture(src) : new THREE.Texture(src);
  t.flipY = false;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = aniso;
  t.needsUpdate = true;
  return t;
}

/** A tiling copy of a shared surface map: `per` mm per tile, on uv channel `channel`. */
function tiled(base, per, channel = 0) {
  const t = base.clone();
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(1 / per, 1 / per);
  t.channel = channel;
  t.needsUpdate = true;
  return t;
}

/** The case's look until its wrap is composed: the plain cover on the front, shell color elsewhere. */
export function quickWrap(c, cover) {
  const p = c.profile;
  const k = 320 / p.panel.w;
  const W = Math.round((p.panel.w * 2 + p.spine + 4) * k);
  const H = Math.round((p.panel.h + 4) * k);
  const cv = document.createElement("canvas");
  cv.width = W;
  cv.height = H;
  const g = cv.getContext("2d");
  g.fillStyle = c.style.shell;
  g.fillRect(0, 0, W, H);
  if (cover?.naturalWidth) {
    const x = (2 + p.panel.w + p.spine) * k;
    const s = Math.max((p.panel.w * k) / cover.naturalWidth, (p.panel.h * k) / cover.naturalHeight);
    g.save();
    g.beginPath();
    g.rect(x, 2 * k, p.panel.w * k, p.panel.h * k);
    g.clip();
    g.drawImage(cover, x + (p.panel.w * k - cover.naturalWidth * s) / 2, 2 * k, cover.naturalWidth * s, cover.naturalHeight * s);
    g.restore();
  }
  return cv;
}

/** The turntable's top: polished white with chrome rings and index ticks (alpha = how opaque). */
function tableTop() {
  const S = 1024;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const g = c.getContext("2d");
  const R = S / 2;
  const grad = g.createRadialGradient(R, R, 0, R, R, R);
  grad.addColorStop(0, "rgb(250 252 254 / 0.2)");
  grad.addColorStop(0.5, "rgb(246 249 252 / 0.32)");
  grad.addColorStop(0.555, "rgb(246 249 252 / 0.5)");
  grad.addColorStop(0.56, "rgb(185 195 207 / 1)");
  grad.addColorStop(0.6, "rgb(255 255 255 / 1)");
  grad.addColorStop(0.63, "rgb(143 155 171 / 1)");
  grad.addColorStop(0.66, "rgb(227 232 238 / 1)");
  grad.addColorStop(0.97, "rgb(240 244 248 / 1)");
  grad.addColorStop(1, "rgb(200 208 218 / 1)");
  g.fillStyle = grad;
  g.beginPath();
  g.arc(R, R, R, 0, Math.PI * 2);
  g.fill();
  // Index ticks between the hub and the chrome ring.
  g.strokeStyle = "rgb(90 110 135 / 0.35)";
  g.lineWidth = 3;
  for (let a = 0; a < 360; a += 15) {
    const t = (a * Math.PI) / 180;
    g.beginPath();
    g.moveTo(R + Math.cos(t) * R * 0.41, R + Math.sin(t) * R * 0.41);
    g.lineTo(R + Math.cos(t) * R * 0.53, R + Math.sin(t) * R * 0.53);
    g.stroke();
  }
  return c;
}

/** A soft round shadow (black on transparent). */
function softDisc(alpha) {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grad.addColorStop(0, `rgb(30 45 70 / ${alpha})`);
  grad.addColorStop(0.6, `rgb(30 45 70 / ${alpha * 0.5})`);
  grad.addColorStop(1, "rgb(30 45 70 / 0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  return c;
}

/** The sleeve's (or film's) grime: the grime texture over each panel, faded in by wear. */
function grimeCanvas(p, wear, base) {
  const wrapW = p.panel.w * 2 + p.spine + 4;
  const wrapH = p.panel.h + 4;
  const W = 1024;
  const H = Math.round((W * wrapH) / wrapW);
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d");
  g.fillStyle = `rgb(255 255 255 / ${base})`;
  g.fillRect(0, 0, W, H);
  if (wear > 0.01 && grimeImg.complete && grimeImg.naturalWidth) {
    const k = W / wrapW;
    g.globalAlpha = Math.min(1, wear * 1.1);
    g.drawImage(grimeImg, 0, 0, (2 + p.panel.w) * k, H);
    g.drawImage(grimeImg, (2 + p.panel.w) * k, 0, p.spine * k, H);
    g.drawImage(grimeImg, (2 + p.panel.w + p.spine) * k, 0, (2 + p.panel.w) * k, H);
  }
  return c;
}

/** The mirrored copy's material: masked to the turntable and fading into the floor with depth. */
function mirrored(m, fade) {
  const r = m.clone();
  r.stencilWrite = true;
  r.stencilRef = 1;
  r.stencilFunc = THREE.EqualStencilFunc;
  r.stencilFail = r.stencilZFail = r.stencilZPass = THREE.KeepStencilOp;
  r.onBeforeCompile = (sh) => {
    sh.uniforms.uFloor = { value: FLOOR };
    sh.uniforms.uFade = { value: fade };
    sh.vertexShader = `varying float vMirrorY;\n${sh.vertexShader}`.replace(
      "#include <project_vertex>",
      "#include <project_vertex>\nvMirrorY = (modelMatrix * vec4(transformed, 1.0)).y;",
    );
    sh.fragmentShader = `uniform vec3 uFloor;\nuniform float uFade;\nvarying float vMirrorY;\n${sh.fragmentShader}`.replace(
      "#include <dithering_fragment>",
      "gl_FragColor.rgb = mix(gl_FragColor.rgb, uFloor, 0.08 + 0.92 * smoothstep(0.0, uFade, -vMirrorY));\n#include <dithering_fragment>",
    );
  };
  r.customProgramCacheKey = () => `mirror|${m.type}|${fade}`;
  return r;
}


/** A turntable: chrome wall, glass top (whose stencil mask lets reflections show), a soft shadow. */
function turntable(topTex) {
  const g = new THREE.Group();
  const wall = new THREE.Mesh(
    new THREE.CylinderGeometry(TABLE_R, TABLE_R * 1.015, 7, 128, 1, true),
    new THREE.MeshStandardMaterial({ color: 0xdfe5ec, metalness: 1, roughness: 0.2 }),
  );
  wall.position.y = -3.5;
  const topGeo = new THREE.CircleGeometry(TABLE_R, 128).rotateX(-Math.PI / 2);
  const top = new THREE.Mesh(
    topGeo,
    new THREE.MeshPhysicalMaterial({ map: topTex, transparent: true, roughness: 0.12, clearcoat: 1, clearcoatRoughness: 0.05, depthWrite: false }),
  );
  top.renderOrder = 2;
  // The mask: where a turntable's top is, mirrored cases may draw.
  const mask = new THREE.Mesh(topGeo, new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }));
  Object.assign(mask.material, { stencilWrite: true, stencilRef: 1, stencilFunc: THREE.AlwaysStencilFunc, stencilZPass: THREE.ReplaceStencilOp });
  mask.renderOrder = -10;
  const under = new THREE.Mesh(
    new THREE.PlaneGeometry(TABLE_R * 3, TABLE_R * 3).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: tex(softDisc(0.35)), transparent: true, depthWrite: false }),
  );
  under.position.y = -7.2;
  g.add(wall, top, mask, under);
  return { group: g, top };
}

export class CaseStage {
  /**
   * `host`: the element the canvas fills, or null to build the stage off-page (attach() it
   * later). `still()`: true when cases must not rotate or slide. `reflect()`: whether the
   * turntables show the cases' reflections.
   */
  constructor(host, { still, reflect = () => true }) {
    this.host = host;
    this.still = still;
    this.reflect = reflect;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, stencil: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(2, devicePixelRatio));
    // Checking each shader's log after compiling waits on the GPU (~200 ms seen); the shaders are
    // fixed, so errors would show in development anyway.
    this.renderer.debug.checkShaderErrors = false;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.setClearColor(0x000000, 0);
    this.canvas = this.renderer.domElement;
    this.canvas.className = "rl-gar-gl";
    host?.append(this.canvas);
    this.aniso = this.renderer.capabilities.getMaxAnisotropy();

    const scene = (this.scene = new THREE.Scene());
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.55;
    pmrem.dispose();
    const key = new THREE.DirectionalLight(0xffffff, 2.4);
    key.position.set(-1.2, 1.6, 1.3);
    const rim = new THREE.DirectionalLight(0xdfe9ff, 1.1);
    rim.position.set(1.4, 0.8, -1.4);
    scene.add(key, rim);
    this.camera = new THREE.PerspectiveCamera(26, 1, 10, 8000);

    // The three turntables. The centre one's markings turn with its case.
    this.topTex = tex(tableTop(), { aniso: this.aniso });
    this.tables = {};
    for (const slot of ["L", "C", "R"]) {
      const t = turntable(this.topTex);
      t.group.position.set(SLOTS[slot].x, 0, SLOTS[slot].z);
      scene.add(t.group);
      this.tables[slot] = t;
    }

    this.surface = null; // shared surface maps (THREE textures by name)
    this.models = new Map(); // id -> textures, for the shown cases (and those about to be)
    this.keepIds = new Set();
    this.loading = new Map(); // id -> token of the full wrap being uploaded
    this.uploads = Promise.resolve(); // uploads run one at a time, a band per frame
    this.shown = []; // cases in the scene: { id, model, slot, …, see place() }
    this.yaw = STILL_YAW; // the centre case's angle
    this.yawTarget = null;
    this.lid = 0; // the centre case's lid
    this.lidTarget = 0;
    this.facing = null;
    this.slide = 0; // start time of the current slide, or 0
    this.last = 0;
    this.drawn = 0;
    this.frame = 0;
    this.paused = false;

    this.resize = this.resize.bind(this);
    this.ro = new ResizeObserver(this.resize);
    if (host) this.ro.observe(host);
    else this.paused = true;
    this.bindPointer();
    this.resize();
  }

  /** Compiles the shaders for everything in the scene without blocking (where the GPU driver
   *  allows), so the first frame on screen doesn't stall. */
  async warm() {
    await this.renderer.compileAsync(this.scene, this.camera);
  }

  /**
   * Compiles, in the background, the shaders of every kind of case in `profiles` (cases.json):
   * each form with a quick wrap and finished (disc and emboss), real and mirrored. Otherwise the
   * first case of a kind held up the page while the GPU driver built its shaders, up to ~90 ms
   * each on integrated graphics. Run it once the surface maps are in, as they change the shaders.
   * The sample cases are kept (never drawn) until the stage goes: three.js deletes a program once
   * no material uses it, and dropping every case at once (a jump) made them all compile again.
   */
  async warmCases(profiles) {
    if (this.warming || this.disposed) return;
    this.warming = true;
    const px = document.createElement("canvas");
    px.width = px.height = 2;
    const scene = new THREE.Scene();
    const made = [];
    try {
      for (const [profileName, profile] of Object.entries(profiles)) {
        for (const full of [false, true]) {
          const model = {
            case: { profileName, profile, style: { shell: "#8a94a3" } },
            wrapTex: tex(px),
            discTex: full && profile.disc ? tex(px) : null,
            embossTex: full && profile.emboss ? tex(px, { srgb: false }) : null,
            wear: 0,
          };
          const contact = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, opacity: 0.55 }));
          const c = { id: "", model, own: [], group: new THREE.Group(), mirror: new THREE.Group(), contact, slot: "warm" };
          c.mirror.scale.y = -1;
          c.group.add(contact);
          this.dress(c);
          for (const copy of [c.real, c.refl]) if (copy.disc) copy.disc.visible = true; // compiled only if visible
          scene.add(c.group, c.mirror);
          made.push(c);
        }
      }
      await this.renderer.compileAsync(scene, this.camera, this.scene);
    } finally {
      this.samples = made;
    }
  }

  dropSamples() {
    for (const c of this.samples ?? []) {
      this.undress(c);
      c.contact.material.map?.dispose();
      c.contact.material.dispose();
      c.contact.geometry.dispose();
      for (const t of [c.model.wrapTex, c.model.discTex, c.model.embossTex]) t?.dispose();
    }
    this.samples = null;
  }

  /** The case on the centre turntable (or arriving there). */
  get center() {
    return this.shown.find((c) => c.slot === "C") ?? null;
  }

  get current() {
    return this.center?.model ?? null;
  }

  get profile() {
    return this.center?.model.case.profile ?? null;
  }

  // ---- shared maps ----------------------------------------------------------------------------

  setSurfaceMaps(maps) {
    this.surface = {};
    for (const [name, m] of Object.entries(maps)) {
      this.surface[name] = { normal: tex(m.normal, { srgb: false }), rough: tex(m.rough, { srgb: false }) };
    }
    for (const c of this.shown) this.dress(c); // re-dress the cases with grain
    this.render();
  }

  // ---- models ---------------------------------------------------------------------------------

  /**
   * Holds the textures for a case: `model` = { id, case, wrap (ImageBitmap or canvas), disc?,
   * emboss?, wear, quick? }. Uploads them ahead of showing it. A quick wrap (small, shown at
   * once) goes up now; a full wrap streams in a band per frame and replaces the quick one when
   * it is complete.
   */
  preload(model) {
    const old = this.models.get(model.id);
    if (old && old.wrapSrc === model.wrap) return;
    if (model.quick) {
      this.loading.delete(model.id);
      const t = (img, o) => {
        const x = tex(img, o);
        this.renderer.initTexture(x);
        return x;
      };
      this.adopt(model, t(model.wrap, { aniso: this.aniso }), model.disc ? t(model.disc, { aniso: this.aniso }) : null, model.emboss ? t(model.emboss, { srgb: false }) : null);
      return;
    }
    if (model.key && this.loading.get(model.id)?.key === model.key) return; // already on its way
    const token = { key: model.key };
    this.loading.set(model.id, token);
    const close = () => {
      for (const b of [model.wrap, model.disc, model.emboss]) if (b instanceof ImageBitmap) b.close?.();
    };
    const alive = () => !this.disposed && this.loading.get(model.id) === token;
    const job = async () => {
      if (!alive()) return close();
      const out = [];
      for (const [img, o] of [[model.wrap, { aniso: this.aniso }], [model.disc, { aniso: this.aniso }], [model.emboss, { srgb: false }]]) {
        out.push(img ? await streamTex(this.renderer, img, o, alive) : null);
        if (!alive()) break;
      }
      if (!alive() || (model.wrap && !out[0])) {
        for (const t of out) t?.dispose();
        close();
        return;
      }
      this.loading.delete(model.id);
      // The Garage may have moved on while it uploaded.
      if (!this.keepIds.has(model.id) && !this.shown.some((c) => c.id === model.id)) {
        for (const t of out) t?.dispose();
        close();
        return;
      }
      this.adopt(model, ...out);
    };
    this.uploads = this.uploads.then(job, job);
  }

  /** Puts a case's uploaded textures in use, replacing (and freeing) what it had. */
  adopt(model, wrapTex, discTex, embossTex) {
    const old = this.models.get(model.id);
    const m = { ...model, wrapSrc: model.wrap, wrapTex, discTex, embossTex };
    this.models.set(model.id, m);
    // A shown case takes its new textures where it stands.
    for (const c of this.shown) {
      if (c.id === model.id) {
        c.model = m;
        this.dress(c);
      }
    }
    if (old) this.release(old);
    this.render();
  }

  release(m) {
    for (const t of [m.wrapTex, m.discTex, m.embossTex]) t?.dispose();
    if (m.wrap instanceof ImageBitmap) m.wrap.close?.();
    if (m.disc instanceof ImageBitmap) m.disc.close?.();
  }

  /** Disposes the textures of every case not in `ids` (once it has left the stage). */
  keep(ids) {
    this.keepIds = new Set(ids);
    this.prune();
  }

  prune() {
    const onStage = new Set(this.shown.map((c) => c.id));
    for (const [id, m] of this.models) {
      if (!this.keepIds.has(id) && !onStage.has(id)) {
        this.release(m);
        this.models.delete(id);
      }
    }
  }

  has(id) {
    return this.models.has(id);
  }

  /**
   * Shows `ids` = [previous, focused, next] (ids or null) on the three turntables. `dir` is +1
   * or -1 after a step right or left, sliding every case one turntable over; 0 (a jump) or
   * reduced motion crossfades instead.
   */
  setSlots(ids, dir = 0) {
    const want = { L: ids[0] ?? null, C: ids[1] ?? null, R: ids[2] ?? null };
    // The cases asked for are kept: finishing an earlier slide or crossfade below frees models
    // that aren't, and these may have only just been loaded.
    for (const id of ids) if (id) this.keepIds.add(id);
    // A crossfade still waiting would otherwise land after this and put back what it showed.
    this.flushFade();
    const same = this.shown.filter((c) => c.slot !== "out").every((c) => want[c.slot] === c.id) && ["L", "C", "R"].every((s) => !want[s] || this.shown.some((c) => c.slot === s && c.id === want[s]));
    if (same) return;
    this.finishSlide();
    const oldCenter = this.center;
    if (!dir || this.still()) {
      const apply = () => {
        for (const c of [...this.shown]) this.drop(c);
        for (const s of ["L", "C", "R"]) if (want[s] && this.models.has(want[s])) this.place(want[s], s, SLOTS[s]);
        this.resetCenter(oldCenter);
        this.prune();
        this.resize();
      };
      if (this.shown.length) this.crossfade(apply);
      else apply();
      this.kick();
      return;
    }
    // Slide: every case moves to the turntable its id now has, or off the edge it's pushed to.
    const exit = dir > 0 ? SLOTS.offL : SLOTS.offR;
    const enter = dir > 0 ? SLOTS.offR : SLOTS.offL;
    for (const c of this.shown) {
      const slot = Object.keys(want).find((s) => want[s] === c.id);
      c.from = this.poseOf(c);
      c.slot = slot ?? "out";
      c.to = slot ? SLOTS[slot] : exit;
    }
    for (const s of ["L", "C", "R"]) {
      if (!want[s] || this.shown.some((c) => c.id === want[s]) || !this.models.has(want[s])) continue;
      const c = this.place(want[s], s, enter);
      c.from = { ...enter };
      c.to = SLOTS[s];
    }
    this.resetCenter(oldCenter);
    this.slide = performance.now();
    this.resize();
    this.kick();
  }

  /** A new centre case starts turning from where it stands; the old one closes and settles. */
  resetCenter(oldCenter) {
    const c = this.center;
    if (oldCenter && oldCenter !== c) {
      oldCenter.lid = this.lid;
      oldCenter.yaw = this.yaw;
    }
    if (c && c !== oldCenter) {
      this.yaw = c.yaw ?? STILL_YAW;
      this.yawTarget = this.still() ? this.nearest(STILL_YAW) : null;
      this.lid = this.lidTarget = 0;
      this.facing = null;
    }
  }

  /** Snaps a slide in progress to its end (a new step arrived before it finished). */
  finishSlide() {
    if (!this.slide) return;
    this.slide = 0;
    for (const c of [...this.shown]) {
      if (c.slot === "out") this.drop(c);
      else {
        c.x = SLOTS[c.slot].x;
        c.z = SLOTS[c.slot].z;
        c.from = c.to = null;
        if (c.slot !== "C") c.yaw = SLOTS[c.slot].yaw;
      }
    }
    this.prune();
  }

  /** An empty showroom. */
  clear() {
    this.finishSlide();
    for (const c of [...this.shown]) this.drop(c);
    this.keep([]);
    this.render();
  }

  /** `wear` 0..1 dirties the sleeve (or, on cardboard, the print). */
  setWear(id, wear) {
    const m = this.models.get(id);
    if (!m || m.wear === wear) return;
    m.wear = wear;
    for (const c of this.shown) if (c.id === id) this.dressSleeve(c);
    this.render();
  }

  // ---- building cases ----------------------------------------------------------------------------

  /** Puts a case in the scene at `pos` ({ x, z, yaw }), assigned to `slot`. */
  place(id, slot, pos) {
    const c = { id, model: this.models.get(id), slot, x: pos.x, z: pos.z, yaw: pos.yaw, lid: 0, from: null, to: null, own: [], mats: null, mirrorMats: null };
    c.group = new THREE.Group();
    c.mirror = new THREE.Group();
    c.mirror.scale.y = -1;
    c.contact = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, opacity: 0.55 }));
    c.contact.position.y = 0.05;
    c.contact.renderOrder = 3;
    c.group.add(c.contact);
    this.scene.add(c.group, c.mirror);
    this.shown.push(c);
    this.dress(c);
    return c;
  }

  /** Removes a case from the scene and frees what was made for it (not its model's textures). */
  drop(c) {
    this.undress(c);
    c.group.removeFromParent();
    c.mirror.removeFromParent();
    c.contact.material.map?.dispose();
    c.contact.material.dispose();
    c.contact.geometry.dispose();
    this.shown = this.shown.filter((x) => x !== c);
  }

  /** (Re)builds a case's meshes and materials, and its mirrored copy, from its model. */
  dress(c) {
    this.undress(c);
    const m = c.model;
    const p = m.case.profile;
    const geo = caseGeometry(m.case.profileName, p, "focused");
    const card = p.material === "cardboard";
    const sf = this.surface;
    const own = (t) => (t && c.own.push(t), t); // textures made for this case, disposed with it
    const shellMap = sf?.[p.heightmaps?.shell];
    const shell = new THREE.MeshStandardMaterial({
      color: new THREE.Color(m.case.style.shell),
      roughness: card ? 0.92 : 0.45,
      metalness: 0,
      normalMap: shellMap ? own(tiled(shellMap.normal, card ? 30 : 10)) : null,
      roughnessMap: shellMap ? own(tiled(shellMap.rough, card ? 30 : 10)) : null,
      normalScale: new THREE.Vector2(card ? 0.5 : 0.35, card ? 0.5 : 0.35),
    });
    const insertMap = sf?.[p.heightmaps?.insert];
    const insert = new THREE.MeshStandardMaterial({
      map: m.wrapTex,
      roughness: card ? 0.9 : 0.75,
      metalness: 0,
      // The big box's embossed logo, else paper (or card) grain, faint.
      normalMap: m.embossTex ?? (insertMap ? own(tiled(insertMap.normal, card ? 30 : 20, 1)) : null),
      normalScale: m.embossTex ? new THREE.Vector2(1, 1) : new THREE.Vector2(0.12, 0.12),
    });
    const sleeveMap = sf?.[p.heightmaps?.sleeve];
    const sleeve = card
      ? new THREE.MeshStandardMaterial({ transparent: true, roughness: 1, depthWrite: false })
      : new THREE.MeshPhysicalMaterial({
          color: 0xffffff,
          transparent: true,
          roughness: 0.08,
          metalness: 0,
          clearcoat: 1,
          clearcoatRoughness: 0.06,
          depthWrite: false,
          normalMap: sleeveMap ? own(tiled(sleeveMap.normal, 120, 1)) : null,
          normalScale: new THREE.Vector2(0.15, 0.15),
        });
    c.mats = { shell, insert, sleeve };
    if (p.disc) {
      c.mats.label = new THREE.MeshStandardMaterial({ map: m.discTex, transparent: true, roughness: 0.35, metalness: 0.1 });
      c.mats.hub = new THREE.MeshPhysicalMaterial({
        color: 0xe8edf3,
        metalness: 0.9,
        roughness: 0.18,
        normalMap: sf?.rings ? sf.rings.normal : null,
        normalScale: new THREE.Vector2(0.6, 0.6),
      });
      c.mats.edge = new THREE.MeshStandardMaterial({ color: 0xc9d1db, metalness: 1, roughness: 0.25 });
    }
    const fade = p.outer.h * 0.7;
    c.mirrorMats = Object.fromEntries(Object.entries(c.mats).map(([k, v]) => [k, mirrored(v, fade)]));
    this.dressSleeve(c);
    c.real = this.assemble(geo, c.mats);
    c.refl = this.assemble(geo, c.mirrorMats);
    // After the mask, before everything else. Meshes only: a group's renderOrder orders its whole
    // subtree ahead of the mask.
    c.refl.root.traverse((x) => {
      if (x.isMesh) x.renderOrder = x.material.transparent ? 0 : -5;
    });
    c.group.add(c.real.root);
    c.mirror.add(c.refl.root);
    const sh = contactShadow(p);
    c.contact.material.map?.dispose();
    c.contact.material.map = tex(sh.canvas);
    c.contact.material.needsUpdate = true;
    c.contact.scale.set(sh.span, 1, sh.span);
    this.pose();
  }

  undress(c) {
    c.real?.root.removeFromParent();
    c.refl?.root.removeFromParent();
    for (const set of [c.mats, c.mirrorMats]) for (const mat of Object.values(set ?? {})) mat.dispose();
    // Wraps and the shared surface maps stay; textures made for this case go.
    for (const t of c.own) t.dispose();
    c.own = [];
    c.sleeveTex?.dispose();
    c.sleeveTex = null;
    c.real = c.refl = c.mats = c.mirrorMats = null;
  }

  /** One copy of a case: shell, insert, sleeve, and (if it opens) the lid and the disc. */
  assemble(geo, mats) {
    const root = new THREE.Group();
    const body = new THREE.Group();
    root.add(body);
    body.add(new THREE.Mesh(geo.tray, mats.shell));
    if (geo.spineCap) body.add(new THREE.Mesh(geo.spineCap, mats.shell));
    body.add(new THREE.Mesh(geo.insertBack, mats.insert));
    const sb = new THREE.Mesh(geo.sleeveBack, mats.sleeve);
    sb.renderOrder = 1;
    body.add(sb);
    let lid = null;
    let disc = null;
    if (geo.lid) {
      lid = new THREE.Group();
      lid.position.set(geo.hinge.x, 0, geo.hinge.z);
      lid.add(new THREE.Mesh(geo.lid, mats.shell), new THREE.Mesh(geo.insertFront, mats.insert));
      const sf = new THREE.Mesh(geo.sleeveFront, mats.sleeve);
      sf.renderOrder = 1;
      lid.add(sf);
      body.add(lid);
    }
    if (geo.disc && mats.label) {
      disc = new THREE.Group();
      disc.position.set(geo.disc.x, geo.disc.y, geo.disc.z);
      disc.scale.set(geo.disc.scale, geo.disc.scale, 1);
      const label = new THREE.Mesh(geo.disc.label, mats.label);
      const hub = new THREE.Mesh(geo.disc.hub, mats.hub);
      const edge = new THREE.Mesh(geo.disc.edge, mats.edge);
      edge.position.z = -0.6;
      disc.add(label, hub, edge);
      disc.visible = false;
      body.add(disc);
    }
    return { root, body, lid, disc };
  }

  dressSleeve(c) {
    const p = c.model.case.profile;
    const card = p.material === "cardboard";
    c.sleeveTex?.dispose();
    c.sleeveTex = tex(grimeCanvas(p, c.model.wear ?? 0, card ? 0 : 0.12));
    for (const mat of [c.mats?.sleeve, c.mirrorMats?.sleeve]) {
      if (!mat) continue;
      mat.map = c.sleeveTex;
      mat.needsUpdate = true;
    }
  }

  // ---- camera ----------------------------------------------------------------------------------

  resize() {
    const w = this.host?.clientWidth;
    const h = this.host?.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    const cam = this.camera;
    cam.aspect = w / h;
    const H = this.profile?.outer.h ?? 190;
    // The focused case fills about half the height (a big box a little more), its base at 80%,
    // leaving room for the neighbours at the edges.
    const frac = Math.min(0.6, 0.5 * (H / 190) ** 0.35);
    const fov = THREE.MathUtils.degToRad(cam.fov);
    const dist = H / (frac * 2 * Math.tan(fov / 2));
    const el = THREE.MathUtils.degToRad(10);
    cam.position.set(0, H / 2 + Math.sin(el) * dist, Math.cos(el) * dist);
    cam.lookAt(0, H / 2, 0);
    cam.updateMatrixWorld();
    cam.updateProjectionMatrix();
    const base = new THREE.Vector3(0, 0, 0).project(cam);
    const shift = new THREE.Matrix4().makeTranslation(0, 1 - 2 * 0.8 - base.y, 0);
    cam.projectionMatrix.premultiply(shift);
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
    this.render();
  }

  // ---- motion ----------------------------------------------------------------------------------

  get isOpen() {
    return this.lidTarget > 0;
  }

  get canOpen() {
    return !!this.profile?.opens;
  }

  /**
   * Right click: holds the centre case square to its front, then its back, then lets it turn
   * again. Opening the case lets it go too.
   */
  toggleFace() {
    if (!this.center) return;
    this.facing = this.facing === null ? "front" : this.facing === "front" ? "back" : null;
    this.lidTarget = 0;
    const apply = () => {
      if (this.facing === null) this.yawTarget = this.still() ? this.nearest(STILL_YAW) : null;
      else this.yawTarget = this.nearest(this.facing === "back" ? Math.PI : 0);
      if (this.still()) {
        this.yaw = this.yawTarget;
        this.lid = 0;
      }
    };
    if (this.still()) this.crossfade(apply);
    else apply();
    this.kick();
  }

  /** Opens the centre case to show the disc, or closes it. */
  toggleOpen() {
    if (!this.center || !this.canOpen) return;
    const open = !(this.lidTarget > 0);
    const apply = () => {
      this.facing = null;
      this.lidTarget = open ? LID_OPEN : 0;
      this.yawTarget = open ? this.nearest(OPEN_YAW) : this.still() ? this.nearest(STILL_YAW) : null;
      if (this.still()) {
        this.lid = this.lidTarget;
        this.yaw = this.yawTarget ?? STILL_YAW;
      }
    };
    if (this.still()) this.crossfade(apply);
    else apply();
    this.kick();
  }

  /** `angle` plus whole turns, nearest `from` (the centre case's yaw by default). */
  nearest(angle, from = this.yaw) {
    const t = Math.PI * 2;
    return from + ((((angle - from) % t) + t * 1.5) % t) - t / 2;
  }

  /** A jump, or reduced motion: no sliding; the change crossfades (applied once faded out). */
  crossfade(apply) {
    this.canvas.classList.add("is-fading");
    clearTimeout(this.fadeTimer);
    const prior = this.pending;
    this.pending = () => {
      prior?.();
      apply();
    };
    this.fadeTimer = setTimeout(() => this.flushFade(), 140);
  }

  /** Applies a crossfade still waiting to happen, now. */
  flushFade() {
    const run = this.pending;
    if (!run) return;
    clearTimeout(this.fadeTimer);
    this.pending = null;
    run();
    this.pose();
    this.render();
    this.canvas.classList.remove("is-fading");
  }

  /** Click opens or closes the case; right click holds its front, then its back, then lets go.
   *  The case isn't turned by hand: the turntable turns it. */
  bindPointer() {
    let down = null;
    this.canvas.addEventListener("pointerdown", (e) => {
      if (e.button === 0) down = { x: e.clientX, y: e.clientY };
    });
    this.canvas.addEventListener("pointerup", (e) => {
      if (!down || e.button !== 0) return;
      const click = Math.hypot(e.clientX - down.x, e.clientY - down.y) < 6;
      down = null;
      if (click && this.canOpen) this.toggleOpen();
    });
    this.canvas.addEventListener("pointercancel", () => (down = null));
    // Right click (and keeps the shell's context menu away).
    this.canvas.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.toggleFace();
    });
  }

  /** Moves the stage into `host` (the Garage, mounted again) and draws again. The scene, its cases
   *  and their textures were kept, so this is instant. */
  attach(host) {
    this.host = host;
    host.append(this.canvas);
    this.ro.disconnect();
    this.ro.observe(host);
    this.paused = false;
    this.resize();
    this.pose();
    this.render();
    this.kick();
  }

  /** Takes the canvas out of the page and stops drawing, keeping everything else for later. */
  detach() {
    this.finishSlide();
    this.flushFade();
    this.pause(true);
    this.ro.disconnect();
    this.canvas.remove();
  }

  /** Stops drawing while something covers the stage (a dialog), and picks up again after. */
  pause(on) {
    this.paused = on;
    if (on) {
      cancelAnimationFrame(this.frame);
      this.frame = 0;
    } else this.kick();
  }

  /** Starts the frame loop (it stops itself when nothing moves). */
  kick() {
    if (this.frame || this.paused) return;
    this.last = performance.now();
    this.frame = requestAnimationFrame((t) => this.tick(t));
  }

  tick(now) {
    this.frame = 0;
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    const still = this.still();
    let moving = false;
    const spinning = !still && this.yawTarget == null && this.lidTarget === 0 && !this.facing;
    if (spinning && this.center) {
      this.yaw -= (dt * Math.PI * 2) / TURN_PERIOD;
      moving = true;
    } else if (this.yawTarget != null && !still) {
      const d = this.yawTarget - this.yaw;
      this.yaw += d * Math.min(1, dt * 7);
      if (Math.abs(d) > 0.001) moving = true;
      else this.yaw = this.yawTarget;
    }
    if (!still) {
      const d = this.lidTarget - this.lid;
      this.lid += d * Math.min(1, dt * 6);
      if (Math.abs(d) > 0.002) moving = true;
      else this.lid = this.lidTarget;
      // Cases that left the centre close their lids.
      for (const c of this.shown) {
        if (c.slot !== "C" && c.lid > 0) {
          c.lid = Math.max(0, c.lid - dt * 5);
          moving = true;
        }
      }
    } else if (this.yawTarget == null) this.yaw = STILL_YAW;
    if (this.slide) {
      if (now - this.slide >= SLIDE_MS) this.finishSlide();
      else moving = true;
    }
    // Only the turntable turning: about 60 frames a second is plenty, whatever the display's rate.
    const easy = spinning && !this.slide && this.lid === this.lidTarget;
    if (!easy || now - this.drawn >= 15) {
      this.drawn = now;
      this.pose();
      this.render();
    }
    if (moving) this.frame = requestAnimationFrame((t) => this.tick(t));
  }

  /** Where a case stands now: { x, z, yaw }. */
  poseOf(c) {
    const t = this.slide && c.from && c.to ? ease(Math.min(1, (performance.now() - this.slide) / SLIDE_MS)) : 1;
    const at = c.to && c.from ? { x: c.from.x + (c.to.x - c.from.x) * t, z: c.from.z + (c.to.z - c.from.z) * t } : { x: c.x, z: c.z };
    let yaw;
    if (c.slot === "C") yaw = this.yaw;
    else if (c.from && c.to) {
      // Settles from wherever it was facing to its turntable's angle.
      const from = c.from.yaw ?? c.yaw;
      const to = this.nearest(c.to.yaw, from);
      yaw = from + (to - from) * t;
    } else yaw = c.yaw;
    return { x: at.x, z: at.z, yaw };
  }

  /** Applies position, angle, lid and shadow to every case and its mirrored copy. */
  pose() {
    const reflect = this.reflect();
    for (const c of this.shown) {
      const { x, z, yaw } = this.poseOf(c);
      c.x = x;
      c.z = z;
      if (c.slot !== "C") c.yaw = yaw;
      const p = c.model.case.profile;
      const lid = c.slot === "C" ? this.lid : c.lid;
      const open = lid / LID_OPEN;
      // An opened case slides right on its turntable, so the case and its lid stay centred.
      const slide = p.outer.w * 0.42 * open;
      for (const g of [c.group, c.mirror]) {
        g.position.set(x, 0, z);
        g.rotation.y = yaw;
      }
      c.mirror.visible = reflect;
      for (const a of [c.real, c.refl]) {
        if (!a) continue;
        a.body.position.x = slide;
        if (a.lid) a.lid.rotation.y = -lid;
        if (a.disc) a.disc.visible = lid > 0.17;
      }
      c.contact.position.x = slide;
      // The contact shadow only on a turntable: it fades out between them.
      const near = Math.min(...["L", "C", "R"].map((s) => Math.hypot(x - SLOTS[s].x, z - SLOTS[s].z)));
      c.contact.material.opacity = 0.55 * (1 - open * 0.4) * Math.max(0, 1 - near / (TABLE_R * 0.6));
    }
    // The centre turntable's markings turn with its case.
    this.tables.C.top.rotation.y = this.yaw;
  }

  render() {
    if (!this.host?.isConnected) return;
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.disposed = true;
    this.dropSamples();
    cancelAnimationFrame(this.frame);
    clearTimeout(this.fadeTimer);
    this.pending = null;
    this.ro.disconnect();
    for (const c of [...this.shown]) this.drop(c);
    for (const m of this.models.values()) this.release(m);
    this.models.clear();
    this.scene.environment?.dispose();
    this.renderer.dispose();
    this.canvas.remove();
  }
}
