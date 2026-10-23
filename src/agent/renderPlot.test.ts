// @vitest-environment jsdom
// The Strategy grid render waits for the tab to finish drawing and refuses, with the tab's own
// words, a grid that has nothing on it. The composition itself needs a real canvas.
import { afterEach, describe, expect, it } from "vitest";
import { renderGridPng } from "./renderPlot";

function strategyPanel(state: string, status: string) {
  const panel = document.createElement("div");
  panel.innerHTML = `<p role="status">${status}</p><div id="strategy-grid-container" data-state="${state}"></div>`;
  document.body.appendChild(panel);
  return panel.querySelector<HTMLElement>("#strategy-grid-container")!;
}

afterEach(() => { document.body.innerHTML = ""; });

describe("renderGridPng", () => {
  it("refuses an empty grid with the tab's status line", async () => {
    const container = strategyPanel("empty", "Select a gated population to show its strategy.");
    await expect(renderGridPng(container, "strategy-grid-container-grid")).rejects.toThrow("nothing drawn: Select a gated population");
  });

  it("waits while the tab draws, and gives up after the timeout", async () => {
    const container = strategyPanel("drawing", "Preparing strategy…");
    const started = Date.now();
    setTimeout(() => { container.dataset.state = "preparing"; }, 60);
    await expect(renderGridPng(container, "strategy-grid-container-grid", { timeoutMs: 150 })).rejects.toThrow("still being drawn");
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
  });

  it("reads the state once drawing ends", async () => {
    const container = strategyPanel("drawing", "Preparing strategy…");
    setTimeout(() => { container.dataset.state = "error"; container.parentElement!.insertAdjacentHTML("afterbegin", '<p role="alert">Unknown channel</p>'); }, 60);
    await expect(renderGridPng(container, "strategy-grid-container-grid")).rejects.toThrow("nothing drawn: Unknown channel");
  });
});
