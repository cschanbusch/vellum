// The ignition sequence that runs before every start in Grand Tour: the starter cranks (sound and
// a twitching tachometer), then the engine either fires and the game launches, or, if the game
// is worn below RISKY, it may fail to turn over. Then: crank again, service it, or give up.
import vellum from "/__vellum/sdk.js";
import { condition, describe, failChance, wear } from "./condition.js";
import { h, modal, tachometer } from "./modal.js";
import { openService } from "./service.js";
import { voiceFor } from "./engine-voice.js";
import { crank, fire, stall } from "./sound.js";

const still = () => document.documentElement.hasAttribute("data-rl-still");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let busy = false;

/** Animates the needle: twitching with each compression stroke while cranking. */
function twitch(tach, strokes, dur, base) {
  const t0 = performance.now();
  return new Promise((resolve) => {
    const frame = (now) => {
      const t = (now - t0) / 1000;
      if (t >= dur) return resolve();
      // The last stroke before now, and how far into it we are.
      let i = 0;
      while (i + 1 < strokes.length && strokes[i + 1] <= t) i++;
      const into = t - strokes[i];
      const kick = Math.exp(-into * 14);
      tach.set(base + 0.35 * kick + Math.random() * 0.05);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}

/** Sweeps the needle through `points` ([rpm, ms] pairs) with easing. */
function sweep(tach, from, points) {
  return points.reduce(
    (p, [to, ms]) =>
      p.then(
        () =>
          new Promise((resolve) => {
            const t0 = performance.now();
            const a = from;
            from = to;
            const frame = (now) => {
              const k = Math.min(1, (now - t0) / ms);
              const e = 1 - Math.pow(1 - k, 3);
              tach.set(a + (to - a) * e);
              if (k < 1) requestAnimationFrame(frame);
              else resolve();
            };
            requestAnimationFrame(frame);
          }),
      ),
    Promise.resolve(),
  );
}

/**
 * Runs the ignition for `entry`. Resolves true when the engine fired (go ahead and launch),
 * false when the player gave up. A `test` run (the Garage's test drive) is the same start
 * without launching; it costs no condition unless `wear` is set too.
 */
function ignite(entry, { test = false, wear: wearing = !test } = {}) {
  return new Promise((resolve) => {
    const root = h("div", "rl-ign");
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", `Starting ${entry.title}`);
    const panel = h("div", "rl-ign-panel");
    const tach = tachometer("rl-ign-tach");
    const label = h("p", "rl-ign-label", test ? (wearing ? "Test ignition · with wear" : "Test ignition") : "Ignition");
    const title = h("p", "rl-ign-title", entry.title);
    const status = h("p", "rl-ign-status", "Cranking");
    const cond = h("p", "rl-ign-cond");
    const actions = h("div", "rl-ign-actions");
    const again = h("button", "rl-ign-btn rl-ign-again", "Crank again");
    again.prepend(h("kbd", null, "Enter"));
    const fix = h("button", "rl-ign-btn rl-ign-service", "Service");
    fix.prepend(h("kbd", null, "S"));
    const quit = h("button", "rl-ign-btn rl-ign-quit", "Cancel");
    quit.prepend(h("kbd", null, "Esc"));
    actions.append(again, fix, quit);
    actions.hidden = true;
    panel.append(label, title, tach.svg, status, cond, actions);
    root.append(panel);

    let settled = false;
    let stalled = false;
    let running = false;
    const end = (ok) => {
      if (settled) return;
      settled = true;
      close();
      resolve(ok);
    };
    const showCondition = () => {
      const c = condition(entry.id);
      cond.textContent = `Condition ${Math.round(c * 100)}%  ·  ${describe(c)}`;
      cond.dataset.level = c >= 0.7 ? "good" : c >= 0.4 ? "fair" : "poor";
    };

    const attempt = async () => {
      if (running || settled) return;
      running = true;
      stalled = false;
      actions.hidden = true;
      root.classList.remove("is-stalled", "is-fired");
      status.textContent = "Cranking";
      showCondition();
      const c = condition(entry.id);
      // Worn engines crank longer before they catch (or don't).
      const dur = 0.85 + (1 - c) * 1.1 + Math.random() * 0.25;
      const fails = Math.random() < failChance(c);
      const voice = voiceFor(entry);
      const strokes = crank(dur, c, fails, voice);
      await twitch(tach, strokes, dur, 0.25);
      if (settled) return;
      if (fails) {
        stall(0, voice);
        await sweep(tach, 0.3, [[0.6, 160], [0, 420]]);
        stalled = true;
        running = false;
        root.classList.add("is-stalled");
        status.textContent = "Engine won't turn over";
        actions.hidden = false;
        again.focus({ preventScroll: true });
        return;
      }
      fire(c, voice);
      root.classList.add("is-fired");
      status.textContent = "Started";
      if (!still()) panel.classList.add("is-shaking");
      // The needle follows this engine: up to its flare, then down to its idle.
      await sweep(tach, 0.3, [[voice.flare / 1000, 320], [(voice.idle * (1 + (1 - c) * 0.1)) / 1000, 650]]);
      if (test) status.textContent = "Started · test only";
      if (wearing) wear(entry.id);
      showCondition();
      await wait(250);
      end(true);
    };

    const service = async () => {
      if (!stalled || settled) return;
      root.classList.add("is-away");
      const done = await openService(entry);
      root.classList.remove("is-away");
      showCondition();
      if (done) void attempt();
    };

    const close = modal(root, {
      confirm: () => (stalled ? attempt() : undefined),
      alt: () => void service(),
      back: () => end(false),
    });
    again.addEventListener("click", () => void attempt());
    fix.addEventListener("click", () => void service());
    quit.addEventListener("click", () => end(false));
    void attempt();
  });
}

/** A test drive: the full ignition for `entry` without launching; with `wear`, the start costs condition. */
export async function testIgnition(entry, { wear = false } = {}) {
  if (busy || !entry) return;
  busy = true;
  try {
    await ignite(entry, { test: true, wear });
  } finally {
    busy = false;
  }
}

/** Installs the ignition in front of every launch Grand Tour starts. */
export function installIgnition() {
  return vellum.actions.onBeforeLaunch(async (id) => {
    if (busy) return false; // already starting something
    const entry = vellum.library.get(id);
    if (!entry) return true;
    busy = true;
    try {
      return await ignite(entry);
    } finally {
      busy = false;
    }
  });
}
