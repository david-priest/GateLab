// @vitest-environment jsdom

// The Compensation tab's Check view: the panel, the floor plot, and the tab reading a simulated
// stained mass-cytometry file against a matrix that lacks a coefficient the events show.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateAndCanonicalizeCompensationMatrix } from "../engine/compensationProfile";
import {
  createCompensationBaselineProfile,
  type CompensationProfileRecord,
} from "../engine/compensationProfileRecord";
import { CYTOF_NNLS_SOLVER_VERSION, DEFAULT_CYTOF_NNLS_SETTINGS } from "../engine/cytofCompensationEngine";
import type { FcsFile } from "../engine/fcs";
import { Sample } from "../engine/sample";
import {
  runCompensationScreen,
  screenPairEvents,
  type ScreenData,
  type ScreenResult,
} from "../compensationScreen/screenPairs";
import {
  matrixFrom,
  PANEL,
  simulatePanel,
  TRUE_SPILL,
  withCoefficient,
} from "../compensationScreen/syntheticPanel.fixture";
import { CompensationFloorPlot } from "./CompensationFloorPlot";
import { CompensationScreenPanel, type ScreenStageEdit } from "./CompensationScreenPanel";
import { CompensationTab } from "./CompensationTab";
import { I18nProvider } from "./i18n";
import { clearPersistedTabState } from "./tabState";
import type { CompensationScreenState } from "./useCompensationScreen";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // The coefficient panel's density biplots draw on a canvas, which jsdom does not have.
  vi.stubGlobal("requestAnimationFrame", () => 1);
  clearPersistedTabState();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  clearPersistedTabState();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  vi.unstubAllGlobals();
});

const LACKING = withCoefficient(TRUE_SPILL, "Nd143Di", "Tb159Di", 0);
const done = (result: ScreenResult, data: ScreenData): CompensationScreenState => ({
  status: "done",
  completed: 1,
  total: 1,
  result,
  data,
});
const rowFor = (text: string) =>
  [...host.querySelectorAll<HTMLTableRowElement>(".gl-comp-screen-table tbody tr")]
    .find((row) => row.textContent?.includes(text));
const button = (text: string, within: ParentNode = host) =>
  [...within.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent?.includes(text));

describe("CompensationScreenPanel", () => {
  const simulated = simulatePanel({ events: 20_000 });
  const render = (
    result: ScreenResult,
    handlers: Partial<{
      onSelect: (source: string, receiver: string) => void;
      onStage: (edits: readonly ScreenStageEdit[]) => void;
      onRunAgain: () => void;
      populationName: string | null;
      canStage: boolean;
      state: CompensationScreenState;
    }> = {},
  ) => act(() => root.render(
    <I18nProvider>
      <CompensationScreenPanel
        state={handlers.state ?? done(result, simulated.data)}
        channelLabel={(pnn) => pnn.replace("Di", "")}
        populationName={handlers.populationName === undefined ? "Cells" : handlers.populationName}
        selected={null}
        onSelect={handlers.onSelect ?? (() => {})}
        isStaged={() => false}
        canStage={handlers.canStage ?? true}
        onStage={handlers.onStage ?? (() => {})}
        onRunAgain={handlers.onRunAgain ?? (() => {})}
      />
    </I18nProvider>,
  ));

  it("lists the pair whose coefficient is missing, with the matrix value beside what the events support", () => {
    const result = runCompensationScreen(simulated.data, matrixFrom(LACKING));
    render(result);
    const rows = [...host.querySelectorAll(".gl-comp-screen-table tbody tr")];
    expect(rows).toHaveLength(1);
    const row = rowFor("Nd143 → Tb159")!;
    expect(row.textContent).toContain("oxide (+16)");
    expect(row.textContent).toContain("0.00%");
    expect(row.textContent).toContain("Possible missing coefficient");
    expect(row.querySelector(".gl-comp-screen-reading")?.className).toContain("is-below");
    expect(host.textContent).toContain("pairs read from 20,000 events of Cells.");
    expect(host.textContent).toContain("Needs a look (1)");
  });

  it("stages the floor's slope for that pair and selects it", () => {
    const result = runCompensationScreen(simulated.data, matrixFrom(LACKING));
    const onStage = vi.fn();
    const onSelect = vi.fn();
    render(result, { onStage, onSelect });
    const stage = button("Stage", rowFor("Nd143 → Tb159")!)!;
    act(() => stage.click());
    expect(onSelect).toHaveBeenCalledWith("Nd143Di", "Tb159Di");
    expect(onStage).toHaveBeenCalledTimes(1);
    const [edit] = onStage.mock.calls[0][0] as ScreenStageEdit[];
    expect(edit).toMatchObject({ source: "Nd143Di", receiver: "Tb159Di" });
    expect(edit.value).toBeGreaterThan(0.008);
    expect(edit.value).toBeLessThan(0.0105);
  });

  it("offers no staging while the matrix cannot be edited", () => {
    render(runCompensationScreen(simulated.data, matrixFrom(LACKING)), { canStage: false });
    expect(button("Stage", rowFor("Nd143 → Tb159")!)!.disabled).toBe(true);
  });

  it("says so when no pair disagrees, and shows the other readings on request", () => {
    render(runCompensationScreen(simulated.data, matrixFrom(TRUE_SPILL)));
    expect(host.textContent).toContain("No pair's matrix value disagrees with these events.");
    act(() => button("Consistent")!.click());
    expect(rowFor("Nd144 → Gd160")!.textContent).toContain("Consistent");
    act(() => button("Too dim")!.click());
    expect(rowFor("Er167 → Er168")!.textContent).toContain("Source too dim");
    act(() => button("Upper bound only")!.click());
    expect(rowFor("Yb171 → Yb172")!.textContent).toContain("Upper bound only");
  });

  it("selects a pair when its row is clicked", () => {
    const onSelect = vi.fn();
    render(runCompensationScreen(simulated.data, matrixFrom(LACKING)), { onSelect });
    act(() => rowFor("Nd143 → Tb159")!.click());
    expect(onSelect).toHaveBeenCalledWith("Nd143Di", "Tb159Di");
  });

  it("names the factor the oxide pairs share and stages every oxide value by it", () => {
    const run: Record<string, Record<string, number>> = {};
    for (const [source, row] of Object.entries(TRUE_SPILL)) run[source] = { ...row };
    run.Nd143Di.Tb159Di *= 2.5;
    run.Nd144Di.Gd160Di *= 2.5;
    run.Nd145Di.Dy161Di *= 2.5;
    const shifted = simulatePanel({ events: 20_000, spill: run });
    const result = runCompensationScreen(shifted.data, matrixFrom(TRUE_SPILL));
    const onStage = vi.fn();
    render(result, { onStage, state: done(result, shifted.data) });
    expect(host.querySelector(".gl-comp-screen-oxide")?.textContent).toContain("Oxide (+16) pairs share a factor of");
    act(() => button("oxide values")!.click());
    const edits = onStage.mock.calls[0][0] as ScreenStageEdit[];
    expect(edits.map(({ source, receiver }) => `${source}>${receiver}`).sort())
      .toEqual(["Nd143Di>Tb159Di", "Nd144Di>Gd160Di", "Nd145Di>Dy161Di"]);
    for (const edit of edits) {
      expect(edit.value / TRUE_SPILL[edit.source][edit.receiver]).toBeCloseTo(result.oxide!.ratio, 9);
    }
  });

  it("warns when every event is in scope, shows progress while reading, and reads again on request", () => {
    const result = runCompensationScreen(simulated.data, matrixFrom(TRUE_SPILL));
    const onRunAgain = vi.fn();
    render(result, { populationName: null, onRunAgain });
    expect(host.textContent).toContain("Every event is in scope.");
    act(() => button("Read again")!.click());
    expect(onRunAgain).toHaveBeenCalledTimes(1);
    render(result, { state: { status: "running", completed: 3, total: 11, result, data: simulated.data } });
    expect(host.querySelector("progress")?.getAttribute("value")).toBe("3");
    expect(button("Read again")!.disabled).toBe(true);
    // The last reading stays on screen while the next one runs.
    expect(host.querySelector(".gl-comp-screen-filters")).not.toBeNull();
  });
});

describe("CompensationFloorPlot", () => {
  it("draws the events, the floor of each group, the matrix line and the bound, and says the values", () => {
    const simulated = simulatePanel({ events: 20_000 });
    const matrix = matrixFrom(LACKING);
    const pair = runCompensationScreen(simulated.data, matrix).pairs[0];
    const events = screenPairEvents(simulated.data, matrix, pair.source, pair.receiver)!;
    act(() => root.render(
      <I18nProvider>
        <CompensationFloorPlot pair={pair} events={events} sourceLabel="marker_a" receiverLabel="marker_d" />
      </I18nProvider>,
    ));
    const svg = host.querySelector("svg")!;
    expect(svg.querySelectorAll(".gl-comp-floor-point")).toHaveLength(pair.floor!.points.length);
    expect(svg.querySelector(".gl-comp-floor-events")?.getAttribute("d")?.length).toBeGreaterThan(1000);
    expect(svg.querySelector(".gl-comp-floor-matrix")).not.toBeNull();
    expect(svg.querySelector(".gl-comp-floor-bound")).not.toBeNull();
    expect(svg.getAttribute("aria-label")).toContain("marker_a to marker_d: matrix 0.00%");
    expect(host.querySelector("figcaption")?.textContent).toContain("Most the events allow");
    // The brightest group's floor is drawn above the reference group's: the floor rises.
    const points = [...svg.querySelectorAll(".gl-comp-floor-point")];
    expect(Number(points[points.length - 1].getAttribute("cy"))).toBeLessThan(Number(points[0].getAttribute("cy")));
  });
});

describe("the Check view in the Compensation tab", () => {
  const simulated = simulatePanel({ events: 20_000 });

  function panelSample(): Sample {
    const fcs: FcsFile = {
      version: "FCS3.1",
      nEvents: simulated.data.eventCount,
      instrument: "cytof",
      keywords: {},
      channels: PANEL.map((channel, index) => ({ index, name: channel.pnn, marker: channel.marker, bits: 32, range: 100_000 })),
      columns: PANEL.map((channel) => Float32Array.from(simulated.data.values(channel.pnn)!)),
      spillover: null,
    };
    return new Sample(fcs);
  }

  async function profileFor(spill: typeof TRUE_SPILL): Promise<CompensationProfileRecord> {
    const matrix = validateAndCanonicalizeCompensationMatrix(matrixFrom(spill), "cytof-spillover");
    if (!matrix.ok) throw new Error("fixture matrix failed");
    return createCompensationBaselineProfile({
      kind: "cytof-spillover",
      method: "nnls",
      solverVersion: CYTOF_NNLS_SOLVER_VERSION,
      solverSettings: DEFAULT_CYTOF_NNLS_SETTINGS,
      matrix: matrix.value,
      includedChannels: PANEL.map((channel) => channel.pnn),
    }, {
      profileId: "panel-profile",
      name: "Panel matrix",
      createdAt: "2026-11-19T00:00:00.000Z",
      origin: { type: "uploaded", fileName: "matrix.csv", format: "csv", sourceColumnHeader: "" },
    });
  }

  function install(sample: Sample, profile: CompensationProfileRecord): void {
    if (profile.scientific.kind !== "cytof-spillover") throw new Error("not a mass-cytometry profile");
    const included = profile.scientific.includedChannels;
    sample.installCompensatedLayer({
      metadata: {
        profileId: profile.profileId,
        profileHash: profile.profileHash,
        matrixHash: profile.matrixHash,
        kind: profile.scientific.kind,
        method: profile.scientific.method,
        includedPnns: included,
        channelBindings: included.map((pnn) => ({
          pnn,
          fcsColumnIndex: sample.channels.find((channel) => channel.pnn === pnn)!.columnIndex,
          matrixSourceIndex: profile.scientific.matrix.sourceChannels.indexOf(pnn),
          matrixReceiverIndex: profile.scientific.matrix.receiverChannels.indexOf(pnn),
          included: true,
        })),
        transformBinding: { kind: "cytof-asinh", cofactor: 5 },
      },
      // The compensated values are not what the screen reads; any layer of the right shape will do.
      columns: included.map((pnn) => {
        const channel = sample.channels.find((candidate) => candidate.pnn === pnn)!;
        return {
          pnn,
          fcsColumnIndex: channel.columnIndex,
          values: Float32Array.from(sample.originalColumnData(sample.index(channel.key)!)),
        };
      }),
    }, { activeLayer: "compensated" });
  }

  const renderTab = (sample: Sample, profile: CompensationProfileRecord, visible = true) => act(() => root.render(
    <I18nProvider>
      <CompensationTab
        sample={sample}
        compensationOn
        installedProfile={profile}
        installedBaselineProfile={profile}
        onApplyProfile={async () => {}}
        visible={visible}
        stateKey="workspace-a:screen"
      />
    </I18nProvider>,
  ));
  const tab = (name: string) =>
    [...host.querySelectorAll<HTMLButtonElement>('.gl-comp-workspace-tabs [role="tab"]')]
      .find((candidate) => candidate.textContent?.trim().startsWith(name))!;
  /** Let the screen's slices run until the panel shows a finished reading. */
  const settle = async () => {
    for (let turn = 0; turn < 400; turn++) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      if (host.querySelector(".gl-comp-screen-scope")?.textContent?.includes("pairs read")) return;
    }
    throw new Error("the screen did not finish");
  };

  it("reads nothing until the view is opened, then finds the missing coefficient", async () => {
    const sample = panelSample();
    const profile = await profileFor(LACKING);
    install(sample, profile);
    renderTab(sample, profile);
    expect(tab("Check").textContent?.trim()).toBe("Check");
    expect(host.querySelector(".gl-comp-screen")).toBeNull();

    act(() => tab("Check").click());
    expect(host.querySelector(".gl-comp-screen")).not.toBeNull();
    await settle();
    expect(tab("Check").textContent?.trim()).toBe("Check (1)");
    expect(rowFor("→")!.textContent).toContain("Possible missing coefficient");
    expect(rowFor("→")!.textContent).toContain("Nd143Di → Tb159Di");
    expect(host.textContent).toContain("Every event is in scope.");
  });

  it("shows the selected pair's reading and floor in the coefficient panel, and settles once the value is staged", async () => {
    const sample = panelSample();
    const profile = await profileFor(LACKING);
    install(sample, profile);
    renderTab(sample, profile);
    act(() => tab("Check").click());
    await settle();

    act(() => rowFor("Nd143Di → Tb159Di")!.click());
    const badge = host.querySelector(".gl-comp-inspector .gl-comp-screen-badge")!;
    expect(badge.textContent).toContain("Possible missing coefficient");
    expect(badge.textContent).toContain("the matrix holds no value");
    expect(host.querySelector(".gl-comp-inspector .gl-comp-floor-plot svg")).not.toBeNull();

    // Staging puts the value in the working matrix; the next reading is against it.
    act(() => button("Stage", badge)!.click());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await settle();
    expect(tab("Check").textContent?.trim()).toBe("Check");
    expect(host.textContent).toContain("No pair's matrix value disagrees with these events.");
    act(() => button("Consistent")!.click());
    const row = rowFor("Nd143Di → Tb159Di")!;
    expect(row.textContent).toContain("staged");
    expect(row.textContent).toContain("Consistent");
  });

  it("leaves the old residual suggestions out of Flagged for a mass-cytometry matrix", async () => {
    const sample = panelSample();
    const profile = await profileFor(TRUE_SPILL);
    install(sample, profile);
    renderTab(sample, profile);
    act(() => tab("Flagged").click());
    expect(host.querySelector(".gl-comp-suggestions")).toBeNull();
    expect(host.querySelector('select[aria-label="Compensation evidence mode"]')).toBeNull();
    expect(host.textContent).toContain("Every pair is read against the events in Check");
  });

  it("does not read while the tab is hidden", async () => {
    const sample = panelSample();
    const profile = await profileFor(LACKING);
    install(sample, profile);
    renderTab(sample, profile);
    act(() => tab("Check").click());
    // Hidden before the first slice runs: nothing is read.
    renderTab(sample, profile, false);
    for (let turn = 0; turn < 20; turn++) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    }
    expect(host.querySelector(".gl-comp-screen-scope")?.textContent ?? "").not.toContain("pairs read");
    renderTab(sample, profile, true);
    await settle();
    expect(tab("Check").textContent?.trim()).toBe("Check (1)");
  });
});
