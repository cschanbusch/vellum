// Renders Grand Tour's engine sounds (engine-synth.js) off the page's thread, for sound.js.
import { crankSamples, fireSamples, stallSamples } from "./engine-synth.js";

const KINDS = { crank: crankSamples, fire: fireSamples, stall: stallSamples };

self.onmessage = ({ data: { id, kind, sr, args } }) => {
  try {
    const out = KINDS[kind](sr, ...args);
    self.postMessage({ id, ok: true, out }, out.map((c) => c.buffer));
  } catch (e) {
    self.postMessage({ id, ok: false, error: String(e?.stack ?? e) });
  }
};
