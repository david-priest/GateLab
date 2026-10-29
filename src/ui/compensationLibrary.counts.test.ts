// A file's matrix with single-precision noise, stored with that noise set to 0 and 1 so it can be
// copied and edited: a gate drawn around known events counts the same under the stored copy as
// under the file's own matrix, and each count is the one worked out by hand below.

import { describe, expect, it } from "vitest";
import { CompensationManager, type CompensationWorkerLike } from "../engine/compensationManager";
import type { FcsFile } from "../engine/fcs";
import { getGateMask } from "../engine/gates";
import { newGate, type Gate } from "../engine/models";
import { Sample } from "../engine/sample";
import type {
  CompensationWorkerRequest,
  CompensationWorkerResponse,
} from "../workers/compensationProtocol";
import { createCompensationWorkerRuntime } from "../workers/compensationWorkerRuntime";
import { baselineFromEmbedded, embeddedFlowMatrixOf } from "./compensationLibrary";

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
 * Six events with FL1-A at 1,000 and FL2-A from 150 to 650, and the matrix FACSDiva might write
 * for a 5% FL1-A → FL2-A spill: a diagonal of 1.000002 and a -5e-9 FL2-A → FL1-A coefficient.
 * Compensated FL2-A is close to FL2-A − 50: 100 to 600.
 */
function noisyFcs(): FcsFile {
  return {
    version: "FCS3.1",
    nEvents: 6,
    instrument: "flow",
    keywords: { $SPILLOVER: "2,FL1-A,FL2-A,1.000002,0.05,-5e-9,1" },
    channels: [
      { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262_144 },
      { index: 1, name: "FL1-A", marker: null, bits: 32, range: 262_144 },
      { index: 2, name: "FL2-A", marker: null, bits: 32, range: 262_144 },
    ],
    columns: [
      Float32Array.from([100, 100, 100, 100, 100, 100]),
      Float32Array.from([1000, 1000, 1000, 1000, 1000, 1000]),
      Float32Array.from([150, 250, 350, 450, 550, 650]),
    ],
    spillover: { channels: ["FL1-A", "FL2-A"], matrix: [[1.000002, 0.05], [-5e-9, 1]] },
  };
}

/** FL1-A 500 to 1,500 by FL2-A 120 to 380, in raw units: no event lies within 1 of an edge. */
function bandGate(): Gate {
  return {
    ...newGate("FL2 band", "rectangle", "FL1-A", "FL2-A", [[500, 120], [1500, 120], [1500, 380], [500, 380]]),
    space: "raw",
  };
}

function count(sample: Sample, gate: Gate): number {
  return getGateMask(gate, sample.gateAssayData().forGate(gate)).reduce((total, inside) => total + inside, 0);
}

describe("a stored copy of a matrix with floating-point noise", () => {
  it("counts a drawn gate as the file's own matrix does", async () => {
    const gate = bandGate();

    // The file on its own embedded matrix, noise and all.
    const own = new Sample(noisyFcs());
    expect(count(own, gate)).toBe(3); // Original: 150, 250, 350
    own.setCompensation(true);
    const underOwn = count(own, gate);
    expect(underOwn).toBe(2); // about 200, 300

    // The same file on the stored copy the Matrices list makes of that matrix.
    const stored = new Sample(noisyFcs());
    const embedded = (await embeddedFlowMatrixOf(stored, "D1.fcs"))!;
    expect(embedded.roundedCoefficients).toBe(2);
    const profile = await baselineFromEmbedded(embedded, "D1 spillover");
    const manager = new CompensationManager({
      workspaceKey: "workspace-noise",
      workerFactory: () => new RuntimeWorker(),
      yieldToEventLoop: () => Promise.resolve(),
    });
    await manager.apply({ profile, targets: [{ sample: stored, activeLayer: "compensated" }] });
    expect(count(stored, gate)).toBe(underOwn);

    // Event by event, the two compensated FL2-A columns differ by far less than one unit.
    const fl2 = own.index("FL2-A")!;
    const fromOwn = own.rawColumnData(fl2);
    const fromStored = stored.rawColumnData(stored.index("FL2-A")!);
    for (let event = 0; event < 6; event++) {
      expect(Math.abs(fromOwn[event] - fromStored[event])).toBeLessThan(0.01);
    }
    manager.dispose();
  });
});
