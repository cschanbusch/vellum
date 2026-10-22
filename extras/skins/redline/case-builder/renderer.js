// The focused case in WebGL: one renderer and canvas for the whole skin, reused as the focus
// moves. The case stands on a turntable whose top is glass over a mirror: an upside-down copy of
// the case is drawn beneath it (masked to the turntable with the stencil), and the glass, mostly
// opaque, lets it through faintly.
//
// Lighting: a soft key light from the upper left, a dim rim light and a small neutral room
// environment for reflections; no shadow maps and no transmission (one pass). Frames are drawn
// only while something moves: an idle, still Garage costs no GPU time.
import * as THREE from "../lib/three.js";
import { RoomEnvironment } from "../lib/three.js";
import { caseGeometry, contactShadow } from "./geometry.js";

const TURN_PERIOD = 18; // seconds per turn of the turntable
const STILL_YAW = 0.42; // a resting angle that shows the front and a sliver of spine
const OPEN_YAW = 0.18;
const LID_OPEN = (160 * Math.PI) / 180;
const FLOOR = new THREE.Color("#f3f6f9");
const TABLE_R = 122; // turntable radius, mm

const grimeImg = new Image();
grimeImg.src = new URL("../textures/grime.svg", import.meta.url).href;

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

export class CaseStage {
  /**
   * `host`: the element the canvas fills. `still()`: true when cases must not rotate or slide.
   * `reflect()`: whether the turntable shows the case's reflection.
   */
  constructor(host, { still, reflect = () => true }) {
    this.host = host;
    this.still = still;
    this.reflect = reflect;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, stencil: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(2, devicePixelRatio));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.setClearColor(0x000000, 0);
    this.canvas = this.renderer.domElement;
    this.canvas.className = "rl-gar-gl";
    host.append(this.canvas);
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
    this.camera = new THREE.PerspectiveCamera(26, 1, 10, 6000);

    // The turntable: chrome wall, glass top, a soft shadow beneath; it turns with the case.
    this.table = new THREE.Group();
    scene.add(this.table);
    const wall = new THREE.Mesh(
      new THREE.CylinderGeometry(TABLE_R, TABLE_R * 1.015, 7, 128, 1, true),
      new THREE.MeshStandardMaterial({ color: 0xdfe5ec, metalness: 1, roughness: 0.2 }),
    );
    wall.position.y = -3.5;
    const topGeo = new THREE.CircleGeometry(TABLE_R, 128).rotateX(-Math.PI / 2);
    this.topTex = tex(tableTop(), { aniso: this.aniso });
    const top = new THREE.Mesh(
      topGeo,
      new THREE.MeshPhysicalMaterial({ map: this.topTex, transparent: true, roughness: 0.12, clearcoat: 1, clearcoatRoughness: 0.05, depthWrite: false }),
    );
    top.renderOrder = 2;
    // The mask: where the turntable's top is, the mirrored case may draw.
    const mask = new THREE.Mesh(topGeo, new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }));
    Object.assign(mask.material, {
      stencilWrite: true,
      stencilRef: 1,
      stencilFunc: THREE.AlwaysStencilFunc,
      stencilZPass: THREE.ReplaceStencilOp,
    });
    mask.renderOrder = -10;
    const under = new THREE.Mesh(
      new THREE.PlaneGeometry(TABLE_R * 3, TABLE_R * 3).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: tex(softDisc(0.35)), transparent: true, depthWrite: false }),
    );
    under.position.y = -7.2;
    this.contact = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, opacity: 0.55 }),
    );
    this.contact.position.y = 0.05;
    this.contact.renderOrder = 3;
    this.table.add(wall, top, mask, under, this.contact);
    this.mirror = new THREE.Group();
    this.mirror.scale.y = -1;
    this.table.add(this.mirror);

    this.own = [];
    this.sleeveTex = null;
    this.surface = null; // shared surface maps (THREE textures by name)
    this.models = new Map(); // id -> { textures } (focused and neighbours, at most three)
    this.current = null;
    this.yaw = STILL_YAW;
    this.yawTarget = null;
    this.lid = 0;
    this.lidTarget = 0;
    this.facing = null;
    this.arrive = 1;
    this.held = false;
    this.resumeAt = 0;
    this.last = 0;
    this.drawn = 0;
    this.frame = 0;
    this.paused = false;

    this.resize = this.resize.bind(this);
    this.ro = new ResizeObserver(this.resize);
    this.ro.observe(host);
    this.bindPointer();
    this.resize();
  }

  // ---- shared maps ----------------------------------------------------------------------------

  setSurfaceMaps(maps) {
    this.surface = {};
    for (const [name, m] of Object.entries(maps)) {
      this.surface[name] = { normal: tex(m.normal, { srgb: false }), rough: tex(m.rough, { srgb: false }) };
    }
    if (this.current) this.build(); // re-dress the case with grain
  }

  // ---- models ---------------------------------------------------------------------------------

  /**
   * Holds the textures for a case: `model` = { id, case, wrap (ImageBitmap or canvas), disc?,
   * emboss?, wear }. Uploads them now, so showing it later is instant.
   */
  preload(model) {
    const old = this.models.get(model.id);
    if (old && old.wrapSrc === model.wrap) return;
    if (old) this.release(old);
    const m = { ...model, wrapSrc: model.wrap };
    m.wrapTex = tex(model.wrap, { aniso: this.aniso });
    m.discTex = model.disc ? tex(model.disc, { aniso: this.aniso }) : null;
    m.embossTex = model.emboss ? tex(model.emboss, { srgb: false }) : null;
    for (const t of [m.wrapTex, m.discTex, m.embossTex]) if (t) this.renderer.initTexture(t);
    this.models.set(model.id, m);
    if (this.current?.id === model.id) {
      this.current = m;
      this.build();
    }
  }

  release(m) {
    for (const t of [m.wrapTex, m.discTex, m.embossTex]) t?.dispose();
    if (m.wrap instanceof ImageBitmap) m.wrap.close?.();
    if (m.disc instanceof ImageBitmap) m.disc.close?.();
  }

  /** Disposes the textures of every case not in `ids`. */
  keep(ids) {
    const want = new Set(ids);
    for (const [id, m] of this.models) {
      if (!want.has(id)) {
        this.release(m);
        this.models.delete(id);
      }
    }
  }

  has(id) {
    return this.models.has(id);
  }

  /** Shows a preloaded case. */
  show(id) {
    const m = this.models.get(id);
    if (!m) return;
    const changed = this.current?.id !== id;
    this.current = m;
    if (changed) {
      this.facing = null;
      this.lid = this.lidTarget = 0;
      this.yawTarget = null;
      this.held = false;
      if (this.still()) this.crossfade(() => this.build());
      else {
        this.arrive = 0;
        this.build();
      }
    }
    this.kick();
  }

  /** An empty turntable. */
  clear() {
    this.clearCase();
    this.current = null;
    this.keep([]);
    this.render();
  }

  /** `wear` 0..1 dirties the sleeve (or, on cardboard, the print). */
  setWear(id, wear) {
    const m = this.models.get(id);
    if (!m || m.wear === wear) return;
    m.wear = wear;
    if (this.current?.id === id) this.dressSleeve();
  }

  // ---- building the scene ----------------------------------------------------------------------

  /** (Re)builds the case meshes for the current model, and its mirrored copy. */
  build() {
    this.clearCase();
    const m = this.current;
    const c = m.case;
    const p = c.profile;
    const geo = caseGeometry(c.profileName, p, "focused");
    const card = p.material === "cardboard";
    const sf = this.surface;
    const own = (t) => (t && this.own.push(t), t); // textures made for this build, disposed with it
    const shellMap = sf?.[p.heightmaps?.shell];
    const shell = new THREE.MeshStandardMaterial({
      color: new THREE.Color(c.style.shell),
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
    this.mats = { shell, insert, sleeve };
    if (p.disc) {
      this.mats.label = new THREE.MeshStandardMaterial({ map: m.discTex, transparent: true, roughness: 0.35, metalness: 0.1 });
      this.mats.hub = new THREE.MeshPhysicalMaterial({
        color: 0xe8edf3,
        metalness: 0.9,
        roughness: 0.18,
        normalMap: sf?.rings ? sf.rings.normal : null,
        normalScale: new THREE.Vector2(0.6, 0.6),
      });
      this.mats.edge = new THREE.MeshStandardMaterial({ color: 0xc9d1db, metalness: 1, roughness: 0.25 });
    }
    this.dressSleeve();

    const fade = p.outer.h * 0.7;
    const mirrorMats = Object.fromEntries(Object.entries(this.mats).map(([k, v]) => [k, mirrored(v, fade)]));
    this.mirrorMats = mirrorMats;
    this.real = this.assemble(geo, p, this.mats);
    this.refl = this.assemble(geo, p, mirrorMats);
    // After the mask, before everything else. Meshes only: a group's renderOrder orders its whole
    // subtree ahead of the mask.
    this.refl.root.traverse((x) => {
      if (x.isMesh) x.renderOrder = x.material.transparent ? 0 : -5;
    });
    this.table.add(this.real.root);
    this.mirror.add(this.refl.root);

    // The contact shadow under this footprint.
    const sh = contactShadow(p);
    this.contact.material.map?.dispose();
    this.contact.material.map = tex(sh.canvas);
    this.contact.material.needsUpdate = true;
    this.contact.scale.set(sh.span, 1, sh.span);

    this.profile = p;
    this.resize();
    this.pose();
    this.render();
  }

  /** One copy of the case: shell, insert, sleeve, and (if it opens) the lid and the disc. */
  assemble(geo, p, mats) {
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

  dressSleeve() {
    const m = this.current;
    const p = m.case.profile;
    const card = p.material === "cardboard";
    this.sleeveTex?.dispose();
    this.sleeveTex = tex(grimeCanvas(p, m.wear ?? 0, card ? 0 : 0.12));
    for (const mat of [this.mats?.sleeve, this.mirrorMats?.sleeve]) {
      if (!mat) continue;
      mat.map = this.sleeveTex;
      mat.needsUpdate = true;
    }
    this.render();
  }

  clearCase() {
    for (const a of [this.real, this.refl]) a?.root.removeFromParent();
    for (const set of [this.mats, this.mirrorMats]) for (const mat of Object.values(set ?? {})) mat.dispose();
    // Wraps and the shared surface maps stay; textures made for this build go.
    for (const t of this.own) t.dispose();
    this.own = [];
    this.sleeveTex?.dispose();
    this.sleeveTex = null;
    this.real = this.refl = null;
    this.mats = this.mirrorMats = null;
  }

  // ---- camera ----------------------------------------------------------------------------------

  resize() {
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    const cam = this.camera;
    cam.aspect = w / h;
    const H = this.profile?.outer.h ?? 190;
    // The case fills about 60% of the height (a big box a little more), its base at 80%.
    const frac = Math.min(0.72, 0.6 * (H / 190) ** 0.35);
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
   * Right click: holds the case square to its front, then its back, then its front again. Opening
   * the case or turning it by hand lets it go.
   */
  toggleFace() {
    if (!this.current) return;
    this.facing = this.facing === "front" ? "back" : "front";
    this.lidTarget = 0;
    const apply = () => {
      this.yawTarget = this.nearest(this.facing === "back" ? Math.PI : 0);
      if (this.still()) {
        this.yaw = this.yawTarget;
        this.lid = 0;
      }
    };
    if (this.still()) this.crossfade(apply);
    else apply();
    this.kick();
  }

  /** Lets go of a held face: back to turning (or resting, with reduced motion). */
  release() {
    this.facing = null;
  }

  /** Opens the case to show the disc, or closes it. */
  toggleOpen() {
    if (!this.current || !this.canOpen) return;
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

  /** `angle` plus whole turns, nearest the current yaw. */
  nearest(angle) {
    const t = Math.PI * 2;
    return this.yaw + ((((angle - this.yaw) % t) + t * 1.5) % t) - t / 2;
  }

  /** Reduced motion: no rotation or sliding; the change crossfades. */
  crossfade(apply) {
    this.canvas.classList.add("is-fading");
    setTimeout(() => {
      apply();
      this.pose();
      this.render();
      this.canvas.classList.remove("is-fading");
    }, 140);
  }

  bindPointer() {
    let down = null;
    this.canvas.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      down = { x: e.clientX, yaw: this.yaw, moved: false };
      this.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener("pointermove", (e) => {
      if (!down) return;
      const dx = e.clientX - down.x;
      if (Math.abs(dx) > 4) down.moved = true;
      if (!down.moved || this.still()) return;
      this.held = true;
      this.facing = null;
      this.yawTarget = null;
      this.yaw = down.yaw + dx * 0.012;
      this.render();
    });
    const up = () => {
      if (!down) return;
      const click = !down.moved;
      down = null;
      if (click) {
        if (this.canOpen) this.toggleOpen();
        return;
      }
      // Let go: the turntable carries on after a moment.
      this.resumeAt = performance.now() + 1200;
      this.kick();
    };
    this.canvas.addEventListener("pointerup", up);
    // Right click holds the front, then the back (and keeps the shell's context menu away).
    this.canvas.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.toggleFace();
    });
    this.canvas.addEventListener("pointercancel", up);
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
    if (this.held && now >= this.resumeAt && this.resumeAt) {
      this.held = false;
      this.resumeAt = 0;
    }
    const spinning = !still && !this.held && this.yawTarget == null && this.lidTarget === 0 && !this.facing;
    if (spinning && this.current) {
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
      if (this.arrive < 1) {
        this.arrive = Math.min(1, this.arrive + dt / 0.45);
        moving = true;
      }
    } else if (this.yawTarget == null) this.yaw = STILL_YAW;
    if (this.held && this.resumeAt) moving = true; // keep ticking until the turntable resumes
    // Only the turntable turning: about 60 frames a second is plenty, whatever the display's rate.
    const easy = spinning && this.arrive >= 1 && this.lid === this.lidTarget;
    if (!easy || now - this.drawn >= 15) {
      this.drawn = now;
      this.pose();
      this.render();
    }
    if (moving) this.frame = requestAnimationFrame((t) => this.tick(t));
  }

  /** Applies yaw, lid and arrival to both copies. */
  pose() {
    if (!this.real) return;
    const p = this.profile;
    const open = this.lid / LID_OPEN;
    // The opened case slides right on the turntable, so the case and its lid stay centred.
    const slide = p.outer.w * 0.42 * open;
    const e = 1 - (1 - this.arrive) ** 3;
    const s = 0.94 + 0.06 * e;
    this.table.rotation.y = this.yaw; // the case, its reflection and the ticks turn together
    this.mirror.visible = this.reflect();
    for (const a of [this.real, this.refl]) {
      a.body.position.x = slide;
      this.contact.position.x = slide;
      a.root.scale.setScalar(s);
      if (a.lid) a.lid.rotation.y = -this.lid;
      if (a.disc) a.disc.visible = this.lid > 0.17;
    }
    this.contact.material.opacity = 0.55 * (1 - open * 0.4);
  }

  render() {
    if (!this.host.isConnected) return;
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    cancelAnimationFrame(this.frame);
    this.ro.disconnect();
    this.clearCase();
    for (const m of this.models.values()) this.release(m);
    this.models.clear();
    this.scene.environment?.dispose();
    this.renderer.dispose();
    this.canvas.remove();
  }
}
