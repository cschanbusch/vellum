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
  webServer: [
    harness("plugins/skins/basis", 5190),
    harness("tests/fixtures/dev-plugins/skins/token-test", 5192),
    harness("tests/fixtures/dev-plugins/skins/timeline-test", 5194),
    harness("tests/fixtures/dev-plugins/skins/sidebar-test", 5198),
    harness("plugins/skins/synthwave", 5210),
    harness("plugins/skins/aero", 5212),
    harness("plugins/skins/gridline", 5214),
    harness("plugins/skins/calling-card", 5216),
    harness("plugins/skins/ficsit", 5218),
    harness("plugins/skins/frontier", 5224),
  ],
});
