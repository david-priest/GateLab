// Switching the workspace's matrix and switching back: a gate drawn around known events is
// counted under matrix A, under matrix B, and under A again. The Compensation tab's
// "Use for the workspace…" installs a stored profile on every file through CompensationManager.apply,
// so this is the path a switch takes; the two counts under A must be equal, and each count is the
// one worked out by hand below.

import { describe, expect, it } from "vitest";
import { CompensationManager, type CompensationWorkerLike } from "./compensationManager";
import { validateAndCanonicalizeCompensationMatrix } from "./compensationProfile";
import {
  createCompensationBaselineProfile,
  type CompensationProfileRecord,
} from "./compensationProfileRecord";
import type { FcsFile } from "./fcs";
import { getGateMask } from "./gates";
import { newGate, type Gate } from "./models";
import { Sample } from "./sample";
import type {
  CompensationWorkerRequest,
  CompensationWorkerResponse,
} from "../workers/compensationProtocol";
import { createCompensationWorkerRuntime } from "../workers/compensationWorkerRuntime";

class RuntimeWorker implements CompensationWorkerLike {
  onmessage: ((event: MessageEvent<CompensationWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  private readonly runtime = createCompensationWorkerRuntime({
    emit: (response) => this.onmessage?.({ data: response } as MessageEvent<CompensationWorkerResponse>),
    yieldToEventLoop: () => Promise.resolve(),
    microbatchEvents: 1,
  });

  postMessage(message: CompensationWorkerRequest): void {
    this.runtime.dispatch(message);
  }

  terminate(): void {}
}

/**
 * Six events with FL1-A at 1,000 and FL2-A from 150 to 650. Each matrix spills only FL1-A into
 * FL2-A, so compensated FL2-A is FL2-A − s × 1,000: under A (s = 0.05) 100 to 600, under B
 * (s = 0.50) −350 to 150. FL1-A and FSC-A are unchanged.
 */
function flowFcs(fsc: number): FcsFile {
  return {
    version: "FCS3.1",
    nEvents: 6,
    instrument: "flow",
    keywords: {},
    channels: [
      { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262_144 },
      { index: 1, name: "FL1-A", marker: null, bits: 32, range: 262_144 },
      { index: 2, name: "FL2-A", marker: null, bits: 32, range: 262_144 },
    ],
    columns: [
      Float32Array.from([fsc, fsc, fsc, fsc, fsc, fsc]),
      Float32Array.from([1000, 1000, 1000, 1000, 1000, 1000]),
      Float32Array.from([150, 250, 350, 450, 550, 650]),
    ],
    spillover: null,
  };
}

async function flowProfile(profileId: string, spill: number): Promise<CompensationProfileRecord> {
  const canonical = validateAndCanonicalizeCompensationMatrix({
    sourceChannels: ["FL1-A", "FL2-A"],
    receiverChannels: ["FL1-A", "FL2-A"],
    matrix: [[1, spill], [0, 1]],
  }, "flow-spillover");
  if (!canonical.ok) throw new Error(canonical.errors.map(({ message }) => message).join(" "));
  return createCompensationBaselineProfile({
    kind: "flow-spillover",
    method: "matrix-inverse",
    solverVersion: "flow-lu-v1",
    solverSettings: { singularTolerance: 1e-12, conditionWarningThreshold: 1e8 },
    matrix: canonical.value,
  }, {
    profileId,
    name: profileId,
    createdAt: "2026-10-23T00:00:00.000Z",
    origin: { type: "uploaded", fileName: `${profileId}.csv`, format: "csv", sourceColumnHeader: "channel" },
  });
}

/** FL1-A 500 to 1,500 by FL2-A 120 to 380, in raw units: no event lies on an edge. */
function bandGate(): Gate {
  return {
    ...newGate("FL2 band", "rectangle", "FL1-A", "FL2-A", [[500, 120], [1500, 120], [1500, 380], [500, 380]]),
    space: "raw",
  };
}

function count(sample: Sample, gate: Gate): number {
  return getGateMask(gate, sample.gateAssayData().forGate(gate)).reduce((total, inside) => total + inside, 0);
}

describe("switching the workspace's matrix", () => {
  it("counts a drawn gate under A, under B, and under A again, the two A counts equal", async () => {
    const d1 = new Sample(flowFcs(100));
    const d2 = new Sample(flowFcs(200));
    const a = await flowProfile("matrix-a", 0.05);
    const b = await flowProfile("matrix-b", 0.5);
    const manager = new CompensationManager({
      workspaceKey: "workspace-switch",
      workerFactory: () => new RuntimeWorker(),
      yieldToEventLoop: () => Promise.resolve(),
    });
    const gate = bandGate();
    const useForWorkspace = (profile: CompensationProfileRecord) => manager.apply({
      profile,
      targets: [d1, d2].map((sample) => ({ sample, activeLayer: "compensated" as const })),
    });

    expect([count(d1, gate), count(d2, gate)]).toEqual([3, 3]); // Original: 150, 250, 350

    await useForWorkspace(a);
    const underA = [count(d1, gate), count(d2, gate)];
    expect(underA).toEqual([2, 2]); // 200, 300

    await useForWorkspace(b);
    expect([count(d1, gate), count(d2, gate)]).toEqual([1, 1]); // 150
    for (const sample of [d1, d2]) {
      const status = sample.compensatedLayerStatus();
      expect(status.state !== "missing" && status.metadata.runtimeIdentity === "profile"
        ? status.metadata.profileId
        : null).toBe("matrix-b");
    }

    await useForWorkspace(a);
    expect([count(d1, gate), count(d2, gate)]).toEqual(underA);
    manager.dispose();
  });
});
