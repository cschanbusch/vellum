import { chromium } from "@playwright/test";
const browser = await chromium.launch({ args: ["--use-angle=d3d11", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
await page.addInitScript(() => sessionStorage.setItem("rl-boot", "1"));
await page.goto("http://localhost:5326/");
await page.waitForFunction(() => document.querySelector("vellum-harness")?.host?.isStarted);
await page.waitForTimeout(7000); // the warm-up runs
const frame = page.frames().find((f) => f.url().includes("127.0.0.1"));
await page.evaluate(() => document.querySelector("vellum-harness").host.switchView("garage"));
await page.waitForTimeout(2000);
console.log(JSON.stringify(await frame.evaluate(() => {
  const h = [...document.querySelectorAll(".rl-gar-hero")];
  return { heroes: h.length, bg: h.map((x) => getComputedStyle(x).backgroundImage.slice(0, 90)), backdrop: !!document.querySelector(".rl-gar-backdrop"), prewarmed: !!window.__rlCaseStage };
})));
await frame.locator(".rl-gar-floor").screenshot({ path: process.argv[2] });
process.exit(0);
