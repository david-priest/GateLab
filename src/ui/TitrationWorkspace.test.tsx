// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { initialCoreState } from "../store";
import { Sample } from "../engine/sample";
import { newRootPopulation } from "../engine/models";
import { migrateWorkspaceV2ToV3, validateWorkspaceV3 } from "../engine/workspaceV3";
import { stampWorkspaceV3 } from "../engine/workspaceFeatures";
import type { WorkspaceFile } from "../engine/workspace";
import { titrationRecordFromWorkspace, type TitrationSeries } from "../compensationControls/titration";
import type { TitrationReview } from "./TitrationReview";
import { TitrationWorkspace } from "./TitrationWorkspace";

const capture = vi.hoisted(() => vi.fn<(props: ComponentProps<typeof TitrationReview>) => null>(() => null));
vi.mock("./TitrationReview", () => ({ TitrationReview: capture }));

it("records the reviewed Original measurements and working dose, including through v3 migration and validation", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const mounted = createRoot(document.createElement("div"));
  try {
    const root = newRootPopulation();
    const state = initialCoreState();
    Object.assign(state, { root_population_id: root.population_id, populations: { [root.population_id]: root } });
    const sample = new Sample({
      version: "FCS3.1", instrument: "flow", spillover: null, nEvents: 6, keywords: {},
      channels: [{ index: 0, name: "FITC-A", marker: "Marker A", bits: 32, range: 1024 }],
      columns: [Float32Array.from([4, 8, 12, 200, 250, 300])],
    });
    const file = { name: "D1.fcs", id: "D1", hierarchyId: state.active_hierarchy_id, sample };
    const series: TitrationSeries = { id: "first", clone: "C1", lot: "L1", conjugate: "FITC",
      detector: "FITC-A", chosenDose: "1:20", unit: "dilution", note: "Working dose", tubes: [
        { fileId: "D1", dose: "1:20", replicate: "A", populationId: null,
          negativeLower: null, negativeUpper: 100, positiveLower: 100, positiveUpper: null },
      ] };
    const saved = vi.fn();
    act(() => mounted.render(<TitrationWorkspace samples={[file]} state={state} record={undefined} onSave={saved} onClose={() => {}} />));
    const ui = capture.mock.lastCall![0];
    expect(ui.series).toEqual([]);
    expect(ui.files[0].mask("missing")).toBeNull();
    expect(ui.files[0].values("FITC-A")).toEqual(sample.originalColumnData(0));
    ui.onSave([series], series.id);
    const record = saved.mock.lastCall![0];
    expect(record.series[0].tubes[0].reviewed).toMatchObject({ detector: "FITC-A", assay: "original", fileName: "D1.fcs", eventCount: 6,
      statistics: { positiveCount: 3, negativeCount: 3, positiveMedian: 250, negativeMedian: 8 } });
    const v2 = {
      format: "gatelab-workspace", version: 2, savedAt: "2026-01-01T00:00:00Z", app: "GateLab",
      samples: [{ sampleId: file.id, fileName: file.name, dataPath: "data/0_D1.fcs", logicleW: {}, compensationOn: false }],
      activeSample: 0, gating: { gates: {}, gate_order: [], populations: state.populations,
        root_population_id: root.population_id, active_population_id: root.population_id, selected_gate_id: null },
      scales: { globalScales: {} }, display: { xChannel: "FITC-A", yChannel: "FITC-A", mode: "pseudocolor",
        maxEvents: 1000, contourThreshold: 5, titrationReview: record },
    } as WorkspaceFile;
    const v3 = await validateWorkspaceV3(JSON.parse(JSON.stringify(stampWorkspaceV3(migrateWorkspaceV2ToV3(v2)))));
    expect(titrationRecordFromWorkspace(v3)).toEqual(record);
    act(() => mounted.render(<TitrationWorkspace samples={[]} state={state} record={titrationRecordFromWorkspace(v3)} onSave={saved} onClose={() => {}} />));
    expect(capture.mock.lastCall![0].series[0]).toEqual(record.series[0]);
    capture.mock.lastCall![0].onSave(capture.mock.lastCall![0].series, series.id);
    expect(saved.mock.lastCall![0]).toEqual(record);
  } finally {
    act(() => mounted.unmount());
    vi.unstubAllGlobals();
  }
});
