import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// The shell is built into static files that Tauri embeds in the Vellum Game Launcher exe.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
});
