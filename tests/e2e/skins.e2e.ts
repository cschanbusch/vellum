// End-to-end tests for the skin system, run in the skin dev harness (see playwright.config.ts).
import { expect, test, type Page } from "@playwright/test";

const BASIS = 5190;
const TOKENS = 5192;
const TIMELINE = 5194;
const SIDEBAR = 5198;

type HarnessEl = HTMLElement & {
  host: {
    state: { view: string; selectedId: string | null; query: string; filters: Record<string, unknown>; couch: boolean; groupBy: string | null };
    entries: { id: string; title: string; favorite: boolean }[];
    available(): { id: string; hotkey?: string }[];
    switchView(id: string): void;
    setState(p: object): void;
    reloadSkinPage(): void;
    toggleCouch(): Promise<void>;
    nav(name: string): void;
    shelves(): { collapsed: string[] };
    isStarted: boolean;
  };
  backend: { setOption(skin: string, key: string, value: unknown): void; setCount(n: number): Promise<void> };
};

const errors: string[] = [];

async function open(page: Page, port: number, { titleScreen = false } = {}) {
  errors.length = 0;
  // Grand Tour's title screen waits for a button; tests skip it unless they're about it.
  if (!titleScreen) await page.addInitScript(() => sessionStorage.setItem("rl-boot", "1"));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://localhost:${port}/`);
  await page.waitForFunction(() => (document.querySelector("vellum-harness") as HarnessEl | null)?.host?.isStarted);
  const frame = page.frameLocator("iframe");
  await expect(frame.locator(".v-view")).toBeVisible();
  return frame;
}

const host = <T>(page: Page, fn: (h: HarnessEl["host"]) => T) =>
  page.evaluate(`(${fn.toString()})(document.querySelector("vellum-harness").host)`) as Promise<T>;
const state = (page: Page) => host(page, (h) => h.state);

async function show(page: Page, view: string) {
  await page.evaluate((v) => (document.querySelector("vellum-harness") as HarnessEl).host.switchView(v), view);
  await expect(page.frameLocator("iframe").locator(`.v-view[data-view="${view}"]`)).toBeVisible();
}

/** Ids of the entries in the current query, in order, as the skin sees them. */
const queryIds = (page: Page) =>
  page.frames().find((f) => f.url().includes("127.0.0.1"))!.evaluate(() => window.vellum.library.query().map((e) => e.id));

test.afterEach(() => {
  expect(errors, "no console errors in the shell or the skin").toEqual([]);
});

test("every built-in view renders", async ({ page }) => {
  const frame = await open(page, BASIS);
  for (const view of ["list", "covers", "spotlight"]) {
    await show(page, view);
    await page.waitForTimeout(600);
    await page.screenshot({ path: `test-artifacts/views/basis-${view}.png` });
  }
  await expect(frame.locator("vellum-hero")).toBeVisible();
  await expect(frame.locator("vellum-play-button")).toBeVisible();
});

test("switching views keeps the selected game, search and filters", async ({ page }) => {
  const frame = await open(page, BASIS);
  await show(page, "covers");
  await frame.locator("vellum-search input").fill("broken");
  await expect.poll(async () => (await state(page)).query).toBe("broken");
  await host(page, (h) => h.setState({ filters: { showHidden: true } }));
  const ids = await queryIds(page);
  expect(ids.length).toBeGreaterThan(1);
  await frame.locator(`vellum-grid .cell[data-id="${ids[1]}"]`).click();
  await expect.poll(async () => (await state(page)).selectedId).toBe(ids[1]);

  await page.keyboard.press("Control+1");
  await expect(frame.locator('.v-view[data-view="list"]')).toBeVisible();
  // The skin switches at once; the shell's copy follows a message later.
  await expect.poll(() => state(page)).toMatchObject({ view: "list", selectedId: ids[1], query: "broken", filters: { showHidden: true } });
  await expect(frame.locator(`vellum-list .row[data-id="${ids[1]}"]`)).toHaveAttribute("aria-selected", "true");
  expect(await queryIds(page)).toEqual(ids);

  await page.keyboard.press("Control+3");
  await expect(frame.locator('.v-view[data-view="spotlight"]')).toBeVisible();
  expect((await state(page)).selectedId).toBe(ids[1]);
});

test("keyboard: arrows move the selection, Enter opens Spotlight, Escape goes back", async ({ page }) => {
  const frame = await open(page, BASIS);
  await show(page, "covers");
  const ids = await queryIds(page);
  await frame.locator(`vellum-grid .cell[data-id="${ids[0]}"]`).click();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => (await state(page)).selectedId).toBe(ids[2]);
  await page.keyboard.press("ArrowLeft");
  await expect.poll(async () => (await state(page)).selectedId).toBe(ids[1]);
  await page.keyboard.press("Enter");
  await expect(frame.locator('.v-view[data-view="spotlight"]')).toBeVisible();
  expect((await state(page)).selectedId).toBe(ids[1]);
  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => (await state(page)).selectedId).toBe(ids[2]);
  await page.keyboard.press("Escape");
  await expect(frame.locator('.v-view[data-view="covers"]')).toBeVisible();
  expect((await state(page)).selectedId).toBe(ids[2]);
});

test("simulated controller input drives the same navigation", async ({ page }) => {
  const frame = await open(page, BASIS);
  await show(page, "covers");
  const ids = await queryIds(page);
  await frame.locator(`vellum-grid .cell[data-id="${ids[0]}"]`).click();
  await host(page, (h) => h.nav("right"));
  await expect.poll(async () => (await state(page)).selectedId).toBe(ids[1]);
  await host(page, (h) => h.nav("nextView"));
  await expect.poll(async () => (await state(page)).view).toBe("spotlight");
  await host(page, (h) => h.nav("prevView"));
  await expect.poll(async () => (await state(page)).view).toBe("covers");
  await host(page, (h) => h.nav("favorite"));
  await expect.poll(() => host(page, (h) => h.entries.find((e) => e.id === h.state.selectedId)?.favorite)).toBe(true);
  await expect(frame.locator(`vellum-grid .cell[data-id="${ids[1]}"]`)).toHaveAttribute("data-favorite", "");
});

test("typing searches; no matches explains itself", async ({ page }) => {
  const frame = await open(page, BASIS);
  await show(page, "covers");
  await frame.locator("vellum-grid").click({ position: { x: 5, y: 5 } });
  await page.keyboard.type("zzqx");
  await expect.poll(async () => (await state(page)).query).toBe("zzqx");
  await expect(frame.locator("vellum-empty")).toContainText("No games match");
  await frame.locator("vellum-empty button").click();
  await expect.poll(async () => (await state(page)).query).toBe("");
});

test("Covers groups into shelves that collapse", async ({ page }) => {
  const frame = await open(page, BASIS);
  await show(page, "covers");
  await host(page, (h) => h.setState({ groupBy: "category" }));
  const shelves = frame.locator("vellum-shelf");
  await expect.poll(() => shelves.count()).toBeGreaterThan(2);
  await expect(shelves.last()).toContainText("Uncategorized");
  const first = shelves.first();
  await first.locator("button.toggle").click();
  await expect(first).toHaveAttribute("collapsed", "");
  await expect.poll(() => host(page, (h) => h.shelves().collapsed.length)).toBe(1);
  await page.screenshot({ path: "test-artifacts/views/basis-shelves.png" });
});

test("skin options apply live", async ({ page }) => {
  await open(page, BASIS);
  const skin = page.frames().find((f) => f.url().includes("127.0.0.1"))!;
  await page.evaluate(() => (document.querySelector("vellum-harness") as HarnessEl).backend.setOption("basis", "accent", "#ff3366"));
  await expect.poll(() => skin.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--v-accent").trim())).toBe("#ff3366");
  await page.evaluate(() => (document.querySelector("vellum-harness") as HarnessEl).backend.setOption("basis", "heroBlur", true));
  await expect.poll(() => skin.evaluate(() => document.documentElement.hasAttribute("data-opt-hero-blur"))).toBe(true);
});

test("hot reload keeps the selection and view", async ({ page }) => {
  const frame = await open(page, BASIS);
  await show(page, "list");
  const ids = await queryIds(page);
  await frame.locator(`vellum-list .row[data-id="${ids[3]}"]`).click();
  await expect.poll(async () => (await state(page)).selectedId).toBe(ids[3]);
  await host(page, (h) => h.reloadSkinPage());
  await page.waitForTimeout(300);
  await expect(page.frameLocator("iframe").locator(`vellum-list .row[data-id="${ids[3]}"]`)).toHaveAttribute("aria-selected", "true");
  expect((await state(page)).view).toBe("list");
});

test("the context menu is drawn by the shell", async ({ page }) => {
  const frame = await open(page, BASIS);
  await show(page, "covers");
  const ids = await queryIds(page);
  await frame.locator(`vellum-grid .cell[data-id="${ids[0]}"]`).click({ button: "right" });
  const menu = page.locator("vellum-context-menu .menu");
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "Add to favorites" }).click();
  await expect(menu).toBeHidden();
  await expect(frame.locator(`vellum-grid .cell[data-id="${ids[0]}"]`)).toHaveAttribute("data-favorite", "");
});

test("couch mode offers only couch views", async ({ page }) => {
  const frame = await open(page, BASIS);
  await show(page, "list");
  await host(page, (h) => h.toggleCouch());
  await expect.poll(() => frame.locator("html").getAttribute("data-couch")).toBe("");
  const views = await host(page, (h) => h.available().map((v) => v.id));
  expect(views).toEqual(["covers", "spotlight"]);
  expect((await state(page)).view).toBe("covers");
  await page.screenshot({ path: "test-artifacts/views/basis-couch.png" });
});

test("a token-only skin restyles every view", async ({ page }) => {
  const frame = await open(page, TOKENS);
  const skin = page.frames().find((f) => f.url().includes("127.0.0.1"))!;
  for (const view of ["list", "covers", "spotlight"]) {
    await show(page, view);
    await page.waitForTimeout(500);
    await page.screenshot({ path: `test-artifacts/views/token-test-${view}.png` });
  }
  expect(await skin.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgb(244, 241, 234)");
  // Kit internals (shadow DOM) follow the tokens too.
  const play = frame.locator("vellum-play-button button.play");
  await expect(play).toHaveCSS("background-color", "rgb(194, 24, 91)");
  await show(page, "list");
  await expect(frame.locator("vellum-list .row").first()).toHaveCSS("font-family", /Georgia/);
});

test("a skin view placed after Covers appears there with Ctrl+4", async ({ page }) => {
  const frame = await open(page, TIMELINE);
  const views = await host(page, (h) => h.available().map((v) => `${v.id}=${v.hotkey}`));
  expect(views).toEqual(["list=Ctrl+1", "covers=Ctrl+2", "timeline=Ctrl+4", "spotlight=Ctrl+3"]);
  // defaultView applies the first time the skin is active.
  expect((await state(page)).view).toBe("timeline");
  await expect(frame.locator('.v-view[data-view="timeline"]')).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Control+1");
  await expect(frame.locator('.v-view[data-view="list"]')).toBeVisible();
  await frame.locator("vellum-list").click();
  await page.keyboard.press("Control+4");
  // The skin's view module loads on demand; allow for a busy machine running many harnesses.
  await expect(frame.locator('.v-view[data-view="timeline"] .tl-year').first()).toBeVisible({ timeout: 15_000 });
  await expect(frame.locator("vellum-view-switcher button[aria-selected=true]")).toHaveText("Timeline");
  await page.screenshot({ path: "test-artifacts/views/timeline-test.png" });
});

test("a rearranged layout works from kit components and parts", async ({ page }) => {
  const frame = await open(page, SIDEBAR);
  await expect(frame.locator(".sidebar vellum-view-switcher")).toBeVisible();
  await expect(frame.locator(".titlebar .count")).toHaveText(/\d+ games/);
  // Frameless skins get min/max/close from the kit.
  await expect(frame.locator('vellum-window-controls button[aria-label="Close"]')).toBeVisible();
  // The per-view stylesheet is loaded only while Covers is shown.
  await expect(frame.locator('link[href="/covers.css"]')).toHaveCount(1);
  await frame.locator(".sidebar vellum-view-switcher button", { hasText: "List" }).click();
  await expect(frame.locator('.v-view[data-view="list"]')).toBeVisible();
  await expect(frame.locator('link[href="/covers.css"]')).toHaveCount(0);
  await page.screenshot({ path: "test-artifacts/views/sidebar-test.png" });
});

test("grouped Spotlight shows a row per group; up/down move between rows", async ({ page }) => {
  const frame = await open(page, BASIS);
  await host(page, (h) => h.setState({ view: "spotlight", groupBy: "category" }));
  const rows = frame.locator(".v-spot-rows vellum-cover-row");
  await expect.poll(() => rows.count()).toBeGreaterThan(2);
  // The hero ends above the covers.
  const stage = await frame.locator(".v-spot-stage").boundingBox();
  const covers = await frame.locator(".v-spot-rows").boundingBox();
  expect(stage!.y + stage!.height).toBeLessThanOrEqual(covers!.y + 1);

  const firstRowIds = await rows.nth(0).evaluate((r) => (r as unknown as { entries: { id: string }[] }).entries.map((e) => e.id));
  const secondRowIds = await rows.nth(1).evaluate((r) => (r as unknown as { entries: { id: string }[] }).entries.map((e) => e.id));
  await rows.nth(0).locator(`.cell[data-index="0"]`).click();
  await expect.poll(async () => (await state(page)).selectedId).toBe(firstRowIds[0]);
  await page.keyboard.press("ArrowDown");
  await expect.poll(async () => secondRowIds.includes((await state(page)).selectedId!)).toBe(true);
  await expect(rows.nth(1)).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(rows.nth(0)).toBeFocused();
  await page.keyboard.press("ArrowUp");
  // Up from the first row reaches the actions.
  await expect.poll(() => frame.locator(".v-spot-actions").evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await page.screenshot({ path: "test-artifacts/views/basis-spotlight-grouped.png" });
});

test("Frontier's Catalogue: the contents turn to a game; arrows turn leaves; tabs, Page Down and Back find their way; ads are placed stably", async ({ page }) => {
  const frame = await open(page, 5224);
  await show(page, "catalogue");
  const book = frame.locator(".fr-cat-book");
  const settled = () => expect(book).not.toHaveAttribute("data-turning", "", { timeout: 10_000 });
  // The first visit of a session opens the cover, then settles on a spread.
  await expect(frame.locator(".fr-cat-page .fr-cat-sheet").first()).toBeVisible();
  await settled();

  // The Contents tab opens the contents.
  await frame.locator(".fr-cat-tab").first().click();
  await settled();
  await expect(frame.locator(".fr-cat-tab").first()).toHaveAttribute("aria-current", "page");
  await expect(frame.locator(".fr-cat-toc-line").first()).toBeVisible();

  // A line turns to that game's page, which takes focus and selects the game.
  const line = frame.locator(".fr-cat-toc-line:not(.is-dept)").nth(5);
  const title = (await line.locator(".fr-cat-toc-title").textContent())!;
  const folio = (await line.locator(".fr-cat-toc-page").textContent())!;
  await line.click();
  await settled();
  await expect(frame.locator(".fr-cat-page.is-at .fr-cat-plate-title")).toHaveText(title);
  await expect(frame.locator(".fr-cat-page.is-at .fr-cat-folio")).toHaveText(`— ${folio} —`);
  const selected = (await state(page)).selectedId;
  expect((await host(page, (h) => h.entries)).find((e) => e.id === selected)?.title).toBe(title);

  // Two steps right always leave the spread: a leaf turns.
  await frame.locator(".fr-cat-spread").focus();
  const folios = async () => (await frame.locator(".fr-cat-page .fr-cat-folio").allTextContents()).join(" ");
  const spread = await folios();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await settled();
  await expect.poll(folios).not.toBe(spread);
  await expect(frame.locator(".fr-cat-spread")).toBeFocused();

  // Page Down opens the next department on its divider page, and its tab is current.
  const tab = (await frame.locator('.fr-cat-tab[aria-current="page"]').textContent())!;
  await page.keyboard.press("PageDown");
  await settled();
  await expect(frame.locator(".fr-cat-page.is-at .fr-cat-sheet")).toHaveClass(/is-divider/);
  await expect(frame.locator('.fr-cat-tab[aria-current="page"]')).not.toHaveText(tab);

  // Back returns to the contents, with a line in hand.
  await page.keyboard.press("Escape");
  await settled();
  await expect(frame.locator(".fr-cat-toc-line.is-focus")).toHaveCount(1);
  await page.keyboard.press("ArrowDown");
  await expect(frame.locator(".fr-cat-toc-line.is-focus")).toHaveCount(1);
  await page.screenshot({ path: "test-artifacts/views/frontier-catalogue.png" });

  // The same library gets the same advertisements in the same places, even after a reload.
  const ads = (await frame.locator(".fr-cat").getAttribute("data-ads"))!;
  expect(ads.split(" ").length).toBeGreaterThan(3);
  await host(page, (h) => h.reloadSkinPage());
  await expect(page.frameLocator("iframe").locator(".fr-cat")).toHaveAttribute("data-ads", ads);
  // "None" leaves only the house guarantee, which is front matter.
  await page.evaluate(() => (document.querySelector("vellum-harness") as HarnessEl).backend.setOption("frontier", "adverts", "none"));
  await expect(page.frameLocator("iframe").locator(".fr-cat")).toHaveAttribute("data-ads", "guarantee");
  await page.evaluate(() => (document.querySelector("vellum-harness") as HarnessEl).backend.setOption("frontier", "adverts", "sparing"));

  // A search with no matches says so in period style.
  await host(page, (h) => h.setState({ query: "zzzzqqq" }));
  await expect(page.frameLocator("iframe").locator(".fr-cat-none")).toBeVisible();
  await host(page, (h) => h.setState({ query: "" }));
});

// Grand Tour's Garage draws its case in WebGL, so these run in the "gpu" project (see
// playwright.config.ts).
test.describe("Grand Tour", () => {
  test("Grand Tour's ignition: a worn game can stall; a service restores it; a start wears it", async ({ page }) => {
    const frame = await open(page, 5226);
    await show(page, "garage");
    const skin = page.frames().find((f) => f.url().includes("127.0.0.1"))!;
    await frame.locator(".rl-gar-strip").focus();
    const id = await skin.evaluate(() => window.vellum.state.get().selectedId!);
    const launched = () => host(page, (h) => h.entries.find((e) => e.id === h.state.selectedId)?.lastLaunched ?? null);

    // Worn out and unlucky: the engine won't turn over, and nothing launches.
    await skin.evaluate(async (id) => {
      const c = await import(new URL("condition.js", location.href).href);
      c.setCondition(id, 0.05);
      Math.random = () => 0.01;
    }, id);
    await expect(frame.locator(".rl-gar-cond-note.is-warn")).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(frame.locator(".rl-ign")).toBeVisible();
    await expect(frame.locator(".rl-ign.is-stalled")).toBeVisible({ timeout: 8000 });
    expect(await launched()).toBeNull();

    // Service: pressure-wash (hold Enter), then three presses with the needle in the green band.
    await page.evaluate(() => (document.querySelector("vellum-harness") as HarnessEl).backend.setOption("redline", "tuneUp", "relaxed"));
    await page.keyboard.press("s");
    await expect(frame.locator(".rl-svc")).toBeVisible();
    const washFrom = Date.now();
    await expect
      .poll(async () => {
        await page.keyboard.down("Enter");
        return frame.locator(".rl-svc-dial").count();
      }, { timeout: 40_000, intervals: [60] })
      .toBe(1);
    await page.keyboard.up("Enter");
    // The held wash is paced by the clock (about six seconds a pass), whatever the frame rate.
    expect(Date.now() - washFrom).toBeGreaterThan(3500);
    // The tune-up timing option sets the needle's pace.
    await expect(frame.locator(".rl-svc-dial")).toHaveAttribute("data-speed", "0.50");
    for (let i = 0; i < 3; i++) {
      // Press from inside the page, the moment the needle is in the band, so timing is exact.
      await skin.evaluate(
        () =>
          new Promise<void>((resolve) => {
            const dial = document.querySelector<HTMLElement>(".rl-svc-dial")!;
            const tick = () => {
              const [a, b] = (dial.dataset.zone ?? "0 0").split(" ").map(Number);
              const rpm = Number(dial.dataset.rpm);
              if (rpm > a + 0.08 && rpm < b - 0.08) {
                dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
                resolve();
              } else requestAnimationFrame(tick);
            };
            tick();
          }),
      );
      // The third hit completes the service, which replaces the lamps.
      if (i < 2) await expect(frame.locator(".rl-svc-lamp.is-on")).toHaveCount(i + 1);
    }
    await expect(frame.locator(".rl-svc-done")).toBeVisible();
    await page.keyboard.press("Enter");

    // Serviced, it cranks again by itself, fires, and launches; the start costs some condition.
    await expect.poll(launched, { timeout: 10_000 }).not.toBeNull();
    await expect(frame.locator(".rl-ign")).toHaveCount(0, { timeout: 5000 });
    // A start costs 5-14%; with the dice loaded low, just over 5%.
    await expect(frame.locator(".rl-gar-cond-pct")).toHaveText("95%");
    await expect(frame.locator(".rl-gar-cond-note")).toHaveText("Last start took 5% off");
  });

  test("Grand Tour's wear: hours on the store's clock cost condition, but past play doesn't", async ({ page }) => {
    const frame = await open(page, 5226);
    await show(page, "garage");
    const skin = page.frames().find((f) => f.url().includes("127.0.0.1"))!;
    await expect(frame.locator(".rl-gar-thumb").first()).toBeVisible();
    const id = await skin.evaluate(() => window.vellum.state.get().selectedId!);
    const cond = () =>
      skin.evaluate(async (id) => {
        const c = await import(new URL("condition.js", location.href).href);
        return c.condition(id);
      }, id);
    const read = (minutes: number) =>
      skin.evaluate(
        async ([id, minutes]) => {
          const c = await import(new URL("condition.js", location.href).href);
          c.notePlaytime([{ id, playtimeMinutes: minutes }], () => 0.5);
        },
        [id, minutes] as const,
      );
    // The odometer as first seen is history: it costs nothing. (The real reading already happened
    // at start-up from the mock library; a lower one resets it.)
    await read(10);
    await read(10);
    expect(await cond()).toBe(1);
    // Two more hours at the average rate (3% an hour): 6% off.
    await read(130);
    expect(await cond()).toBeCloseTo(0.94, 5);
    await expect(frame.locator(".rl-gar-cond-pct")).toHaveText("94%");
    await expect(frame.locator(".rl-gar-cond-note")).toHaveText("2.0 h on the road since the last check: 6% off");
    // A marathon is capped: worn, not wrecked.
    await read(130 + 60 * 100);
    expect(await cond()).toBeCloseTo(0.34, 5);
    // The spec card shows the mileage (the reading the card's entry carries, from the mock library).
    await expect(frame.locator(".rl-gar-figure-label", { hasText: "Mileage" })).toBeVisible();
  });

  test("Grand Tour's Garage: left/right pick the model, up/down change maker, the card follows", async ({ page }) => {
    const frame = await open(page, 5226);
    await show(page, "garage");
    const strip = frame.locator(".rl-gar-strip");
    await expect(frame.locator(".rl-gar-thumb").first()).toBeVisible();
    await strip.focus();
    await page.keyboard.press("ArrowRight");
    await expect(frame.locator(".rl-gar-thumb.is-selected")).toHaveAttribute("data-i", "1");
    // The card shows the selected model, and the shell ends up with the same selection.
    const name = await frame.locator(".rl-gar-name").textContent();
    await expect.poll(() => host(page, (h) => h.entries.find((e) => e.id === h.state.selectedId)?.title)).toBe(name);
    // Down changes maker; the banner and the current maker tab follow.
    const maker = await frame.locator(".rl-gar-banner-maker").textContent();
    await page.keyboard.press("ArrowDown");
    await expect(frame.locator(".rl-gar-banner-maker")).not.toHaveText(maker!);
    await expect(frame.locator('.rl-gar-maker[aria-current="true"]')).toHaveCount(1);
    await expect(strip).toBeFocused();
    // Selecting elsewhere moves the Garage there.
    const other = await host(page, (h) => h.entries[h.entries.length - 1]);
    await host(page, (h) => h.setState({ selectedId: h.entries[h.entries.length - 1].id }));
    await expect(frame.locator(".rl-gar-name")).toHaveText(other.title);
    await page.waitForTimeout(800);
    await page.screenshot({ path: "test-artifacts/views/redline-garage.png" });
  });

  test("Grand Tour's Garage builds each game a case: composed wrap, neighbours preloaded, front/back hold, open, forms", async ({ page }) => {
    const frame = await open(page, 5226);
    await show(page, "garage");
    const skin = page.frames().find((f) => f.url().includes("127.0.0.1"))!;
    const probe = <T>(fn: string) => skin.evaluate(`(() => { const s = window.__rlCaseStage; return ${fn}; })()`) as Promise<T>;
    // The focused case gets its composed wrap (a DVD keep case for the mock store), and its neighbour
    // is preloaded for an instant step.
    await expect.poll(() => probe<string | null>("s.current?.key ?? null"), { timeout: 30_000 }).toContain("|keepcase-dvd|full|");
    await expect.poll(() => probe<number>("s.models.size"), { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
    await expect(frame.locator(".rl-gar-gl")).toBeVisible();

    // Right click holds the front, then the back; a click opens it on its disc and lets go.
    const gl = frame.locator(".rl-gar-gl");
    await gl.click({ button: "right" });
    expect(await probe<string | null>("s.facing")).toBe("front");
    await gl.click({ button: "right" });
    expect(await probe<string | null>("s.facing")).toBe("back");
    await gl.click();
    expect(await probe<number>("s.lidTarget")).toBeGreaterThan(2.5);
    expect(await probe<string | null>("s.facing")).toBeNull();
    await expect.poll(() => probe<boolean>("s.real.disc.visible")).toBe(true);
    await gl.click();
    expect(await probe<number>("s.lidTarget")).toBe(0);
    await frame.locator(".rl-gar-strip").focus();

    // The form is a skin option per store: the change rebuilds the case without a restart. Big
    // boxes don't open.
    const setOption = (k: string, v: unknown) =>
      page.evaluate(([k, v]) => (document.querySelector("vellum-harness") as HarnessEl).backend.setOption("redline", k as string, v), [k, v] as const);
    await setOption("caseOther", "bigbox");
    await expect.poll(() => probe<string | null>("s.current?.key ?? null"), { timeout: 30_000 }).toContain("|bigbox|full|");
    await gl.click();
    expect(await probe<number>("s.lidTarget")).toBe(0);
    // The floor reflection option hides the mirrored copy.
    await setOption("reflections", false);
    await expect.poll(() => probe<boolean>("s.mirror.visible")).toBe(false);
    await setOption("reflections", true);
    await setOption("caseOther", "keepcase-dvd");
    await page.waitForTimeout(500);
    await page.screenshot({ path: "test-artifacts/views/redline-garage-case.png" });
  });

  test("Grand Tour's case gallery: every profile composes every awkward mock game", async ({ page }) => {
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    errors.length = 0;
    await page.goto("http://127.0.0.1:5227/dev/case-gallery.html");
    await page.waitForFunction(() => document.body.dataset.ready === "1", null, { timeout: 120_000 });
    await expect(page.locator("figure")).toHaveCount(21);
    await expect(page.locator("figure.is-error")).toHaveCount(0);
    await expect(page.locator("figure[data-ready]")).toHaveCount(21);
    // Every wrap decoded, at the medium tier's size (front panel 640 px wide plus back, spine and bleed).
    const widths = await page.locator("figure img").evaluateAll((imgs) => imgs.map((i) => (i as HTMLImageElement).naturalWidth));
    expect(widths.every((w) => w > 1300)).toBe(true);
    await page.screenshot({ path: "test-artifacts/views/redline-case-gallery.png", fullPage: true });
  });

  test("Grand Tour's title screen waits for any button, and that press goes no further", async ({ page }) => {
    const frame = await open(page, 5226, { titleScreen: true });
    const title = frame.locator(".rl-boot");
    await expect(title).toBeVisible();
    await expect(title).toContainText("PRESS ANY BUTTON");
    await page.waitForTimeout(3500); // it used to leave by itself after 2.6 s
    await expect(title).toBeVisible();
    await frame.locator("body").press("a");
    await expect(title).toBeHidden();
    expect((await state(page)).query, "the key that dismissed it didn't start a search").toBe("");
  });

  test("Grand Tour's menu sounds: steps tick, a dead end knocks, Back and a mode change have their own sounds", async ({ page }) => {
    // Record the pitch of every oscillator the skin starts: each menu sound has its own.
    await page.addInitScript(() => {
      const w = window as unknown as { __tones: number[] };
      w.__tones = [];
      if (!window.AudioContext) return;
      const freqs = new WeakSet<AudioParam>();
      const create = AudioContext.prototype.createOscillator;
      AudioContext.prototype.createOscillator = function () {
        const o = create.call(this);
        freqs.add(o.frequency);
        return o;
      };
      const value = Object.getOwnPropertyDescriptor(AudioParam.prototype, "value")!;
      Object.defineProperty(AudioParam.prototype, "value", {
        ...value,
        set(v: number) {
          if (freqs.has(this)) w.__tones.push(Math.round(v));
          value.set!.call(this, v);
        },
      });
      const at = AudioParam.prototype.setValueAtTime;
      AudioParam.prototype.setValueAtTime = function (v: number, t: number) {
        if (freqs.has(this)) w.__tones.push(Math.round(v));
        return at.call(this, v, t);
      };
    });
    const frame = await open(page, 5226);
    await show(page, "garage");
    const skin = page.frames().find((f) => f.url().includes("127.0.0.1"))!;
    const heard = () => skin.evaluate(() => (window as unknown as { __tones: number[] }).__tones.splice(0));
    const strip = frame.locator(".rl-gar-strip");
    await expect(frame.locator(".rl-gar-thumb").first()).toBeVisible();
    await strip.focus();
    await page.keyboard.press("Shift"); // dismisses the title screen, if it is up
    await page.waitForTimeout(100);
    await heard();

    // A step right ticks high, a step left ticks lower.
    await page.keyboard.press("ArrowRight");
    await expect.poll(heard).toContain(1880);
    await page.keyboard.press("ArrowLeft");
    await expect.poll(heard).toContain(1720);
    // Page Up on the first model goes nowhere: a knock, not a tick.
    await page.keyboard.press("PageUp");
    await expect.poll(heard).toContain(240);
    expect(await heard()).not.toContain(1720);
    // Back falls from E to A; a mode change swooshes with a high bell.
    await page.keyboard.press("Escape");
    await expect.poll(heard).toEqual(expect.arrayContaining([1319, 880]));
    await host(page, (h) => h.switchView("covers"));
    await expect.poll(heard).toContain(2349);
    // Picking a cover with the mouse ticks too.
    await frame.locator("vellum-grid .cell").nth(2).click();
    await expect.poll(heard).toContain(1720);

    // Menu sounds have their own switch.
    await page.evaluate(() => (document.querySelector("vellum-harness") as HarnessEl).backend.setOption("redline", "menuSounds", false));
    await page.waitForTimeout(200);
    await heard();
    await frame.locator("vellum-grid .cell").nth(3).click();
    await page.waitForTimeout(300);
    expect(await heard()).toEqual([]);
  });
});

for (const [id, port] of [["synthwave", 5210], ["aero", 5212], ["gridline", 5214], ["calling-card", 5216], ["ficsit", 5218], ["frontier", 5224], ["redline", 5226]] as const) {
  test(`the ${id} skin renders every view`, async ({ page }) => {
    const frame = await open(page, port);
    for (const view of ["list", "covers", "spotlight"]) {
      await show(page, view);
      await page.waitForTimeout(700);
      await page.screenshot({ path: `test-artifacts/views/${id}-${view}.png` });
    }
    await host(page, (h) => h.setState({ groupBy: "tag" }));
    await expect(frame.locator(".v-spot-rows[data-grouped]")).toBeVisible();
    await page.screenshot({ path: `test-artifacts/views/${id}-spotlight-grouped.png` });
    await show(page, "covers");
    await expect(frame.locator("vellum-shelf").first()).toBeVisible();
  });
}

for (const [id, port] of [["synthwave", 5210], ["gridline", 5214], ["calling-card", 5216], ["ficsit", 5218], ["frontier", 5224], ["redline", 5226], ["sidebar-test", 5198]] as const) {
  test(`frameless ${id} always shows window controls, even in a narrow window`, async ({ browser }) => {
    for (const width of [1600, 1100, 960]) {
      const page = await browser.newPage({ viewport: { width, height: 800 } });
      const frame = await open(page, port);
      await page.evaluate(() => ((document.querySelector("vellum-harness") as HarnessEl & { panel: boolean }).panel = false));
      for (const view of ["covers", "spotlight", "list"]) {
        await show(page, view);
        await page.waitForTimeout(700);
        const frameBox = (await page.locator("iframe").boundingBox())!;
        const inside = async () => {
          for (const b of await frame.locator('vellum-window-controls button[aria-label="Close"]').all()) {
            const box = await b.boundingBox();
            if (box && box.width > 0 && box.x >= frameBox.x && box.x + box.width <= frameBox.x + frameBox.width + 1) return true;
          }
          return false;
        };
        await expect.poll(inside, { message: `${width}px ${view}: a Close button fully inside the window` }).toBe(true);
      }
      await page.close();
    }
  });
}

test("filtering leaves no stale games painted, in every collection", async ({ page }) => {
  await open(page, BASIS);
  const skin = page.frames().find((f) => f.url().includes("127.0.0.1"))!;
  // Games actually painted on screen (checkVisibility), compared with the current results.
  const stale = () =>
    skin.evaluate(() => {
      const q = new Set(window.vellum.library.query().map((e) => e.id));
      const out: string[] = [];
      const walk = (root: Document | ShadowRoot) => {
        for (const el of root.querySelectorAll<HTMLElement>(".cell, .row")) {
          const r = el.getBoundingClientRect();
          if (el.dataset.id && el.checkVisibility() && r.bottom > 0 && r.top < innerHeight && !q.has(el.dataset.id)) out.push(el.dataset.id);
        }
        for (const el of root.querySelectorAll("*")) if (el.shadowRoot) walk(el.shadowRoot);
      };
      walk(document);
      return out;
    });
  for (const [view, groupBy] of [["covers", null], ["covers", "letter"], ["list", null], ["spotlight", null], ["spotlight", "letter"]] as const) {
    await host(page, (h) => h.setState({ filters: {}, query: "" }));
    await page.evaluate(([v, g]) => (document.querySelector("vellum-harness") as HarnessEl).host.setState({ view: v, groupBy: g }), [view, groupBy] as const);
    await page.waitForTimeout(400);
    for (const filters of [{ kinds: ["tool"] }, { favorites: true }, {}]) {
      await page.evaluate((f) => (document.querySelector("vellum-harness") as HarnessEl).host.setState({ filters: f }), filters);
      await page.waitForTimeout(400);
      expect(await stale(), `${view}${groupBy ? `/${groupBy}` : ""} with ${JSON.stringify(filters)}`).toEqual([]);
    }
    await host(page, (h) => h.setState({ query: "burn" }));
    await page.waitForTimeout(400);
    expect(await stale(), `${view}${groupBy ? `/${groupBy}` : ""} searching "burn"`).toEqual([]);
  }
});

test("3,000 covers scroll smoothly at 3840×2160", async ({ browser }) => {
  const page = await browser.newPage({ viewport: { width: 3840, height: 2160 } });
  await open(page, BASIS);
  await page.evaluate(() => (document.querySelector("vellum-harness") as HarnessEl).backend.setCount(3000));
  await page.waitForFunction(() => (document.querySelector("vellum-harness") as HarnessEl).host.entries.length === 3000);
  await show(page, "covers");
  const skin = page.frames().find((f) => f.url().includes("127.0.0.1"))!;
  await page.waitForTimeout(1000);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const metrics = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
  const before = await metrics();
  const frames = await skin.evaluate(async () => {
    const grid = document.querySelector("vellum-grid") as HTMLElement;
    const out: number[] = [];
    let last = performance.now();
    const end = last + 4000;
    await new Promise<void>((done) => {
      const tick = (t: number) => {
        out.push(t - last);
        grid.scrollTop += (6000 * (t - last)) / 1000; // a fast flick: 6,000 px/s
        last = t;
        if (t < end && grid.scrollTop < grid.scrollHeight - grid.clientHeight) requestAnimationFrame(tick);
        else done();
      };
      requestAnimationFrame(tick);
    });
    out.shift();
    return { frames: out, cells: grid.shadowRoot!.querySelectorAll(".cell").length };
  });
  const after = await metrics();
  const ms = (k: string) => (after[k] - before[k]) * 1000;
  const n = frames.frames.length;
  const sorted = [...frames.frames].sort((a, b) => a - b);
  const result = {
    frames: n,
    cells: frames.cells,
    // Main-thread work per frame: what the skin and kit cost.
    scriptMsPerFrame: +(ms("ScriptDuration") / n).toFixed(2),
    layoutAndStyleMsPerFrame: +((ms("LayoutDuration") + ms("RecalcStyleDuration")) / n).toFixed(2),
    // Wall-clock frames include headless Chromium's software compositing of 8.3 MP.
    avgFrameMs: +(frames.frames.reduce((a, b) => a + b, 0) / n).toFixed(1),
    p95FrameMs: sorted[Math.floor(n * 0.95)],
  };
  console.log(`3,000 covers at 3840×2160: ${JSON.stringify(result)}`);
  await test.info().attach("scroll-perf.json", { body: JSON.stringify(result, null, 2), contentType: "application/json" });
  expect(result.cells, "the grid stays virtualized").toBeLessThan(400);
  // A 60 fps frame is 16.7 ms; the kit's share must leave most of it for painting.
  expect(result.scriptMsPerFrame + result.layoutAndStyleMsPerFrame).toBeLessThan(6);
  await page.close();
});
