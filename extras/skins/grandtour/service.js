// The pit service: wash the grime off the case, then tune the engine. Restores condition to
// showroom fresh. Works with the mouse (scrub, click) and with keyboard or controller (hold
// Enter / A to pressure-wash; press it when the needle is in the green band).
import vellum from "/__vellum/sdk.js";
import { condition, restore } from "./condition.js";
import { h, modal, tachometer } from "./modal.js";
import { beep, hiss } from "./sound.js";

const W = 180; // grime canvas resolution; drawn scaled up, so reading it back is cheap
const H = 270;

// Hold-to-wash: the zig-zag runs 60 steps a row, a row every 20 px, over WASH_PASS ms. 90% clean
// (the goal) comes a little before the pass ends.
const PASS_STEPS = 60 * Math.ceil((H + 20) / 20);
const WASH_PASS = 6000;

// Tune-up difficulty (option `tuneUp`): needle speed in sweeps per second and how much faster each
// hit makes it; the green band's width in thousands of rpm and how much each hit narrows it.
const TUNE = {
  relaxed: { speed: 0.5, faster: 0.1, band: 2.2, narrow: 0.3 },
  standard: { speed: 0.8, faster: 0.15, band: 1.8, narrow: 0.3 },
  tricky: { speed: 1.25, faster: 0.25, band: 1.5, narrow: 0.35 },
};

function rng(seed) {
  let a = seed >>> 0;
  return () => ((a = (a * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/** Road grime: brown and grey splats, streaks and specks, heavier toward the bottom. */
function paintGrime(g, wear, seed) {
  const r = rng(seed);
  g.clearRect(0, 0, W, H);
  const strength = 0.55 + wear * 0.4;
  for (let i = 0; i < 70; i++) {
    const x = r() * W;
    const y = Math.pow(r(), 0.7) * H;
    const rad = 10 + r() * 34;
    const grad = g.createRadialGradient(x, y, 0, x, y, rad);
    const tone = r() < 0.6 ? "86 64 40" : "70 72 74";
    grad.addColorStop(0, `rgb(${tone} / ${0.55 * strength})`);
    grad.addColorStop(1, `rgb(${tone} / 0)`);
    g.fillStyle = grad;
    g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  // Drips and streaks running down.
  g.lineCap = "round";
  for (let i = 0; i < 26; i++) {
    g.strokeStyle = `rgb(90 70 46 / ${0.35 * strength})`;
    g.lineWidth = 1 + r() * 3;
    const x = r() * W;
    const y = r() * H * 0.6;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + (r() - 0.5) * 6, y + 20 + r() * 70);
    g.stroke();
  }
  // A film over everything, so no clean gaps remain between splats.
  g.fillStyle = `rgb(110 96 76 / ${0.32 * strength})`;
  g.fillRect(0, 0, W, H);
  for (let i = 0; i < 260; i++) {
    g.fillStyle = `rgb(50 40 30 / ${0.5 * strength})`;
    g.fillRect(r() * W, r() * H, 1 + r() * 1.5, 1 + r() * 1.5);
  }
}

/** Fraction of the grime still on (by alpha), 0..1. */
function dirt(g) {
  const px = g.getImageData(0, 0, W, H).data;
  let sum = 0;
  for (let i = 3; i < px.length; i += 16) sum += px[i]; // every 4th pixel is plenty
  return sum / (px.length / 16) / 255;
}

/**
 * Opens the service for `entry`. Resolves to true when it was completed (condition restored),
 * false when cancelled.
 */
export function openService(entry) {
  return new Promise((resolve) => {
    const startedAt = performance.now();
    const root = h("div", "rl-svc");
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", `Service: ${entry.title}`);
    const panel = h("div", "rl-svc-panel");
    const head = h("header", "rl-svc-head");
    const step = h("span", "rl-svc-step", "Step 1 / 2");
    const name = h("span", "rl-svc-title", "Wash");
    const model = h("span", "rl-svc-model", entry.title);
    const clock = h("span", "rl-svc-clock", "0.0 s");
    head.append(h("span", "rl-svc-badge", "Pit service"), step, name, model, clock);
    const stage = h("div", "rl-svc-stage");
    const foot = h("footer", "rl-svc-foot");
    const hint = h("p", "rl-svc-hint");
    const cancel = h("button", "v-button rl-svc-cancel", "Esc  Cancel");
    foot.append(hint, cancel);
    panel.append(head, stage, foot);
    root.append(panel);

    let done = false;
    let actions = {};
    const tick = setInterval(() => (clock.textContent = `${((performance.now() - startedAt) / 1000).toFixed(1)} s`), 100);
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearInterval(tick);
      cleanup?.();
      close();
      resolve(ok);
    };
    let cleanup = null;
    actions.back = () => finish(false);
    const close = modal(root, actions);
    let onFoot = () => finish(false);
    cancel.addEventListener("click", () => onFoot());

    // ---- step 1: wash --------------------------------------------------------------------
    const car = h("div", "rl-svc-car");
    const img = h("img");
    img.alt = "";
    img.draggable = false;
    img.src = vellum.art.url(entry.id, "cover", 320, null);
    const canvas = h("canvas", "rl-svc-grime");
    canvas.width = W;
    canvas.height = H;
    const sponge = h("div", "rl-svc-sponge");
    car.append(img, canvas, sponge);
    const meter = h("div", "rl-svc-meter");
    const fill = h("div", "rl-svc-meter-fill");
    const pct = h("span", "rl-svc-meter-pct", "0%");
    meter.append(fill, pct);
    const washSide = h("div", "rl-svc-side");
    washSide.append(h("p", "rl-svc-label", "Clean"), meter);
    stage.append(car, washSide);
    hint.textContent = "Scrub the grime off with the mouse, or hold Enter / A to pressure-wash.";

    const g = canvas.getContext("2d", { willReadFrequently: true });
    let hash = 0;
    for (const ch of entry.id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    paintGrime(g, 1 - condition(entry.id), hash);
    const start = dirt(g);

    const scrub = (x, y, radius = 16) => {
      g.save();
      g.globalCompositeOperation = "destination-out";
      const grad = g.createRadialGradient(x, y, 0, x, y, radius);
      grad.addColorStop(0, "rgb(0 0 0 / 0.9)");
      grad.addColorStop(1, "rgb(0 0 0 / 0)");
      g.fillStyle = grad;
      g.fillRect(x - radius, y - radius, radius * 2, radius * 2);
      g.restore();
    };
    let progress = 0;
    const measure = () => {
      progress = Math.max(0, Math.min(1, 1 - dirt(g) / start));
      fill.style.width = `${Math.round(progress * 100)}%`;
      pct.textContent = `${Math.round(progress * 100)}%`;
      if (progress >= 0.9 && !done && stageNo === 1) {
        g.clearRect(0, 0, W, H);
        beep(true);
        setTimeout(tuneUp, 350);
        stageNo = 2;
      }
    };
    let stageNo = 1;

    // Mouse: scrub where the pointer drags.
    let stopHiss = null;
    let measureTimer = 0;
    const toCanvas = (e) => {
      const r = canvas.getBoundingClientRect();
      return [((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H];
    };
    let last = null;
    canvas.addEventListener("pointerdown", (e) => {
      canvas.setPointerCapture(e.pointerId);
      last = toCanvas(e);
      scrub(...last);
      stopHiss = hiss();
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!last) return;
      const p = toCanvas(e);
      // Fill in between samples so fast strokes don't skip.
      const steps = Math.max(1, Math.ceil(Math.hypot(p[0] - last[0], p[1] - last[1]) / 6));
      for (let i = 1; i <= steps; i++) scrub(last[0] + ((p[0] - last[0]) * i) / steps, last[1] + ((p[1] - last[1]) * i) / steps);
      last = p;
      clearTimeout(measureTimer);
      measureTimer = setTimeout(measure, 60);
    });
    const up = () => {
      last = null;
      stopHiss?.();
      stopHiss = null;
      measure();
    };
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", up);

    // Keyboard / controller: hold to pressure-wash along a zig-zag.
    // Paced by the clock, not the frame rate: a full pass over the case takes about WASH_PASS ms.
    let path = 0;
    let along = 0; // path, unrounded
    let spraying = 0;
    let sprayUntil = 0;
    let sprayAt = 0;
    const sprayFrame = (now) => {
      if (done || stageNo !== 1) return;
      if (performance.now() > sprayUntil) {
        spraying = 0;
        stopHiss?.();
        stopHiss = null;
        sponge.classList.remove("is-on");
        measure();
        return;
      }
      along += Math.max(0, Math.min(now - sprayAt, 250)) * (PASS_STEPS / WASH_PASS);
      sprayAt = now;
      while (path < Math.floor(along)) {
        path += 1;
        const row = Math.floor(path / 60);
        const t = (path % 60) / 59;
        const x = (row % 2 ? 1 - t : t) * W;
        const y = ((row * 20) % (H + 20)) + 6;
        scrub(x, y, 23);
        sponge.style.left = `${(x / W) * 100}%`;
        sponge.style.top = `${(y / H) * 100}%`;
      }
      measure();
      spraying = requestAnimationFrame(sprayFrame);
    };
    actions.confirm = () => {
      if (stageNo !== 1) return;
      sprayUntil = performance.now() + 380; // held keys and buttons repeat, extending it
      if (!spraying) {
        stopHiss = stopHiss ?? hiss();
        sponge.classList.add("is-on");
        sprayAt = performance.now();
        spraying = requestAnimationFrame(sprayFrame);
      }
    };
    actions.confirmUp = () => (sprayUntil = 0);
    cleanup = () => {
      stopHiss?.();
      cancelAnimationFrame(spraying);
      cancelAnimationFrame(needleFrame);
    };

    // ---- step 2: tune-up --------------------------------------------------------------------
    let needleFrame = 0;
    function tuneUp() {
      step.textContent = "Step 2 / 2";
      name.textContent = "Tune-up";
      hint.textContent = "Press Enter / A (or click) when the needle is in the green band. Three to go.";
      const tach = tachometer("rl-svc-tach");
      const lights = h("div", "rl-svc-lights");
      const lamps = [0, 1, 2].map(() => lights.appendChild(h("span", "rl-svc-lamp")));
      const side = h("div", "rl-svc-side");
      side.append(h("p", "rl-svc-label", "Timing"), lights);
      const dial = h("div", "rl-svc-dial");
      dial.append(tach.svg);
      stage.replaceChildren(dial, side);
      let hits = 0;
      const level = TUNE[vellum.skin.options.tuneUp] ?? TUNE.standard;
      let speed = level.speed; // sweeps per second
      let zone = [0, 0];
      const newZone = () => {
        const width = level.band - hits * level.narrow;
        const from = 1.2 + Math.random() * (5.8 - width);
        zone = [from, from + width];
        tach.band(...zone);
        dial.dataset.zone = zone.map((z) => z.toFixed(2)).join(" "); // for tests
        dial.dataset.speed = speed.toFixed(2);
      };
      newZone();
      const t0 = performance.now();
      let rpm = 0;
      const frame = (now) => {
        // Back and forth across the dial.
        const phase = ((now - t0) / 1000) * speed;
        rpm = 4 - 3.9 * Math.cos(phase * Math.PI);
        tach.set(rpm);
        dial.dataset.rpm = rpm.toFixed(2);
        needleFrame = requestAnimationFrame(frame);
      };
      needleFrame = requestAnimationFrame(frame);
      const press = () => {
        if (done) return;
        const hit = rpm >= zone[0] && rpm <= zone[1];
        beep(hit);
        dial.classList.remove("is-hit", "is-miss");
        void dial.offsetWidth;
        dial.classList.add(hit ? "is-hit" : "is-miss");
        if (!hit) return;
        lamps[hits].classList.add("is-on");
        hits += 1;
        hint.textContent = `Press Enter / A (or click) when the needle is in the green band. ${["Three", "Two", "One"][hits] ?? "None"} to go.`;
        speed += level.faster;
        if (hits === 3) {
          cancelAnimationFrame(needleFrame);
          complete();
        } else newZone();
      };
      actions.confirm = (e) => {
        if (!e?.repeat) press();
      };
      actions.confirmUp = null;
      dial.addEventListener("click", press);
    }

    function complete() {
      restore(entry.id);
      const secs = ((performance.now() - startedAt) / 1000).toFixed(1);
      clearInterval(tick);
      step.textContent = "Done";
      name.textContent = "Service complete";
      hint.textContent = "";
      const card = h("div", "rl-svc-done");
      card.append(h("p", "rl-svc-done-big", "100%"), h("p", "rl-svc-done-line", "Showroom fresh"), h("p", "rl-svc-done-time", `Pit time ${secs} s`));
      stage.replaceChildren(card);
      cancel.textContent = "Enter  Continue";
      actions.confirm = () => finish(true);
      onFoot = () => finish(true);
      setTimeout(() => finish(true), 1800);
    }
  });
}
