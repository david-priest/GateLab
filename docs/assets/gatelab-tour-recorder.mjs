// Records the README tour: drives a running GateLab (GATELAB_URL, default http://localhost:5173/) in
// headless Chrome through playwright-core and saves one PNG per step; assemble with ffmpeg.
// Frames are named NN-<label>-<hold>.png; the hold (seconds) sets how long the GIF shows the frame.
import { chromium } from "playwright-core";
import { writeFileSync } from "node:fs";

const APP_URL = process.env.GATELAB_URL ?? "http://localhost:5173/";
const FCS = process.env.GATELAB_DEMO ?? "./pbmc-demo.fcs"; // the public 17-colour PBMC demo file
const OUT = new URL("./frames/", import.meta.url).pathname;
const W = 1500, H = 1000;
let n = 0;
const log = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
page.setDefaultTimeout(8000);
const modal = () => page.locator(".gl-modal-backdrop").last();
const shot = async (label, hold = 1.2) => {
  await page.screenshot({ path: `${OUT}${String(++n).padStart(2, "0")}-${label}-${hold}.png` });
  log.push(`${n} ${label}`);
};
const nameGate = async (name, shotLabel) => {
  const field = page.getByLabel("Gate name:");
  await field.waitFor({ state: "visible", timeout: 10000 });
  await field.fill(name);
  const box = page.getByLabel("Also create a population from this gate");
  if (await box.count()) await box.check();
  await sleep(500);
  if (shotLabel) await shot(shotLabel, 1.4);
  await modal().getByRole("button", { name: "Create", exact: true }).click();
  await sleep(1500);
};
const step = async (label, fn) => { try { await fn(); } catch (e) { log.push(`FAILED ${label}: ${e.message}`); } };

await page.goto(APP_URL, { waitUntil: "load" });
await page.waitForSelector('input[type=file][accept=".fcs"][multiple]', { state: "attached", timeout: 30000 });
await sleep(800);
await shot("empty", 1.2);

// Open the demo file through the hidden picker input.
await page.setInputFiles('input[type=file][accept=".fcs"][multiple]', FCS);
await page.waitForSelector(".gl-tabs", { timeout: 60000 });
await page.waitForSelector(".gl-plot-area svg", { timeout: 60000 });
await sleep(2500);
await shot("loaded", 2.0);

const plotBox = async () => page.locator(".gl-plot-area svg").first().boundingBox();
const toolByTitle = (re) => page.locator("button").filter({ has: page.locator(`xpath=self::*[contains(@title, "${re}")]`) }).first();

// 1. A rectangle gate on FSC-A x SSC-A, drawn with the mouse.
await step("rectangle", async () => {
  const tool = page.locator('button[title*="Rectangle gate"]').first();
  await tool.click();
  const b = await plotBox();
  const x0 = b.x + b.width * 0.28, y0 = b.y + b.height * 0.30;
  const x1 = b.x + b.width * 0.80, y1 = b.y + b.height * 0.86;
  await page.mouse.move(x0, y0); await page.mouse.down();
  await page.mouse.move(x0 + 40, y0 + 40, { steps: 4 }); await shot("rect-drag-1", 0.5);
  await page.mouse.move((x0 + x1) / 2, (y0 + y1) / 2, { steps: 6 }); await shot("rect-drag-2", 0.5);
  await page.mouse.move(x1, y1, { steps: 8 }); await shot("rect-drag-3", 0.6);
  await page.mouse.up();
  await sleep(1200);
  await nameGate("Cells", "rect-name");
  await shot("rect-done", 1.8);
});

// 2. Select the new population, then change the axes to CD3 x CD19 through the axis pickers.
const pickAxis = async (which, name) => {
  const label = page.locator(which === "x" ? ".cytof-xlabel" : ".cytof-ylabel").first();
  await label.click();
  await sleep(400);
  const search = page.locator('input[placeholder="Type to search channels..."]').first();
  await search.fill(name);
  await sleep(500);
  // The list matches by substring ("CD4" also lists CD45), so choose the exact entry.
  await page.locator("select[size]").last().selectOption({ label: name });
  await sleep(1500);
};
await step("select-cells", async () => {
  const rows = page.locator(".pop-row");
  const count = await rows.count();
  await rows.nth(count - 1).click();
  await sleep(1200);
  await shot("cells-selected", 1.5);
});
await step("axes-cd3-cd56", async () => {
  await pickAxis("x", "CD3"); await shot("x-cd3", 1.0);
  await pickAxis("y", "CD56"); await shot("y-cd56", 1.8);
});

// 3. A polygon gate around the CD3+ events.
await step("polygon", async () => {
  await page.locator('button[title*="Polygon gate"]').first().click();
  const b = await plotBox();
  const pts = [[0.60, 0.58], [0.80, 0.50], [0.96, 0.60], [0.96, 0.97], [0.60, 0.97]];
  for (const [fx, fy] of pts) { await page.mouse.click(b.x + b.width * fx, b.y + b.height * fy); await sleep(250); }
  await shot("poly-vertices", 0.8);
  await page.mouse.dblclick(b.x + b.width * pts[0][0], b.y + b.height * pts[0][1]);
  await sleep(1200);
  await nameGate("T cells", "poly-name");
  await shot("poly-done", 1.8);
});

// 4. Under T cells, a quadrant on CD4 x CD8.
await step("quadrant", async () => {
  const rows = page.locator(".pop-row");
  const count = await rows.count();
  await rows.nth(count - 1).click(); await sleep(1000);
  await pickAxis("x", "CD4"); await pickAxis("y", "CD8"); await shot("cd4-cd8", 1.2);
  await page.locator('button[title*="Quadrant gate"]').first().click();
  const b = await plotBox();
  await page.mouse.click(b.x + b.width * 0.50, b.y + b.height * 0.55);
  await sleep(1200);
  await shot("quadrant-dialog", 1.5);
  const create = modal().getByRole("button", { name: /^Create/ }).last();
  if (await create.count()) await create.click();
  await sleep(1500);
  // Back to the parent, so the plot shows the four quadrants over the T cells.
  await page.locator(".pop-row").filter({ hasText: "T cells" }).first().click();
  await sleep(1800);
  await shot("quadrant-done", 2.4);
});

// 5. The tree, then the other tabs.
await step("tree", async () => { await page.locator(".pop-row").filter({ hasText: "CD4 SP" }).first().click(); await sleep(1200); await shot("tree", 1.5); });
for (const [tab, hold] of [["Strategy", 2.6], ["Illustration", 2.8], ["Plotting", 2.4], ["Statistics", 2.2], ["Scales", 1.6]]) {
  await step(`tab-${tab}`, async () => {
    await page.locator('[role="tab"]').filter({ hasText: tab }).click();
    await sleep(tab === "Illustration" ? 4500 : 2500);
    if (tab === "Strategy") {
      try { await page.getByText("Full path from root").click(); await sleep(2500); } catch (e) { log.push(`full path: ${e.message.split("\n")[0]}`); }
    }
    if (tab === "Illustration") {
      // Add the two gated populations to the figure, so the panels show the gates.
      for (const name of ["Cells", "T cells"]) {
        try { await page.locator(".gl-figure-inspector").getByText(name, { exact: true }).first().click(); await sleep(600); } catch (e) { log.push(`figure tick ${name}: ${e.message.split("\n")[0]}`); }
      }
      await sleep(4000);
    }
    await shot(`tab-${tab.toLowerCase()}`, hold);
  });
}
await step("back-to-gating", async () => { await page.locator('[role="tab"]').filter({ hasText: "Gating" }).click(); await sleep(1500); await shot("gating-end", 2.0); });

writeFileSync(`${OUT}../tour.log`, log.join("\n") + "\n");
await browser.close();
console.log(log.join("\n"));
