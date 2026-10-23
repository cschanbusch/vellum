import { copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Builds the music engine (src/music/engine.ts, with the spessasynth synth) as sdk/dist/music.js
// and copies the synth's AudioWorklet processor beside it as music-processor.js. Skins never
// import these directly: vellum.music loads them from /__vellum/ on first use.
const processor = fileURLToPath(new URL("../node_modules/spessasynth_lib/dist/spessasynth_processor.min.js", import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  build: {
    outDir: "dist",
    emptyOutDir: false,
    target: "es2022",
    minify: true,
    lib: { entry: "src/music/engine.ts", formats: ["es"], fileName: () => "music.js" },
  },
  plugins: [
    {
      name: "copy-music-processor",
      closeBundle() {
        copyFileSync(processor, fileURLToPath(new URL("dist/music-processor.js", import.meta.url)));
      },
    },
  ],
});
