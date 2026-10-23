import { defineConfig } from "@playwright/test";

// End-to-end tests run against the skin dev harness (real SDK, shell controller and bridge,
// mock backend), one harness per skin under test. No Rust or Windows needed.
const harness = (skin: string, port: number) => ({
  command: `node scripts/dev-skin.mjs ${skin} --port ${port} --no-open`,
  url: `http://localhost:${port}/__harness/config`,
  reuseExistingServer: false,
  timeout: 60_000,
});

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "**/*.e2e.ts",
  outputDir: "test-results",
  timeout: 60_000,
  workers: 1,
  reporter: [["list"]],
  use: { viewport: { width: 1600, height: 950 } },
  projects: [
    { name: "software", grepInvert: /Grand Tour/ },
    // Grand Tour's Garage draws its case in WebGL. Those tests run on the GPU (ANGLE on Direct3D
    // 11): the software renderer is slow enough to skew every timing around it. The rest keep the
    // software renderer, which the performance budgets were measured on.
    { name: "gpu", grep: /Grand Tour/, use: { launchOptions: { args: ["--use-angle=d3d11", "--ignore-gpu-blocklist"] } } },
  ],
  webServer: [
    harness("plugins/skins/basis", 5190),
    harness("tests/fixtures/dev-plugins/skins/token-test", 5192),
    harness("tests/fixtures/dev-plugins/skins/timeline-test", 5194),
    harness("tests/fixtures/dev-plugins/skins/sidebar-test", 5198),
    harness("tests/fixtures/dev-plugins/skins/music-test", 5230),
    harness("plugins/skins/basis --user-music tests/fixtures/user-music", 5232),
    harness("extras/skins/synthwave", 5210),
    harness("extras/skins/aero", 5212),
    harness("extras/skins/gridline", 5214),
    harness("extras/skins/calling-card", 5216),
    harness("extras/skins/ficsit", 5218),
    harness("extras/skins/frontier", 5224),
    harness("extras/skins/redline", 5226),
  ],
});
