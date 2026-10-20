import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Builds the skin SDK as one ES module (sdk/dist/sdk.js). src-tauri/build.rs embeds it in
// the exe, and the skin protocol serves it at /__vellum/sdk.js.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    minify: false,
    lib: { entry: "src/index.ts", formats: ["es"], fileName: () => "sdk.js" },
  },
});
