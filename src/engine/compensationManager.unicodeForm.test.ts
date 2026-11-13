// A compensation profile whose channel names match the file's $PnN once both are in Unicode NFC is
// applied to the file, whatever normal form the file writes its $PnN in.
import { describe, expect, it } from "vitest";
import { CompensationManager } from "./compensationManager";
import { validateAndCanonicalizeCompensationMatrix } from "./compensationProfile";
import { createCompensationBaselineProfile } from "./compensationProfileRecord";
import { Sample } from "./sample";
import type { FcsFile } from "./fcs";
import type { CompensationWorkerRequest, CompensationWorkerResponse } from "../workers/compensationProtocol";
import { createCompensationWorkerRuntime } from "../workers/compensationWorkerRuntime";

class RuntimeWorker {
  onmessage: ((event: MessageEvent<CompensationWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  private readonly runtime = createCompensationWorkerRuntime({
    emit: (response) => this.onmessage?.({ data: response } as MessageEvent<CompensationWorkerResponse>),
    yieldToEventLoop: () => Promise.resolve(),
    microbatchEvents: 1,
  });
  postMessage(message: CompensationWorkerRequest): void { this.runtime.dispatch(message); }
  terminate(): void {}
}

// The same letter in two normal forms: precomposed (NFC) and A plus a combining ring (NFD).
const NFC_RING = "Å";
const NFD_RING = "Å";

describe("CompensationManager with a $PnN in another Unicode normal form", () => {
  it.each([["NFD", NFD_RING], ["NFC", NFC_RING]])("applies an NFC profile to a file whose $PnN is in %s", async (_form, letter) => {
    const fcs: FcsFile = {
      version: "FCS3.1",
      nEvents: 3,
      instrument: "flow",
      keywords: {},
      channels: [
        { index: 0, name: `FL1-${letter}`, marker: null, bits: 32, range: 262_144 },
        { index: 1, name: `FL2-${letter}`, marker: null, bits: 32, range: 262_144 },
      ],
      columns: [Float32Array.from([100, 200, 300]), Float32Array.from([10, 20, 30])],
      spillover: null,
    };
    const sample = new Sample(fcs);
    const names = [`FL1-${NFC_RING}`, `FL2-${NFC_RING}`];
    const canonical = validateAndCanonicalizeCompensationMatrix(
      { sourceChannels: names, receiverChannels: names, matrix: [[1, 0.1], [0, 1]] },
      "flow-spillover",
    );
    if (!canonical.ok) throw new Error("the test matrix was not accepted");
    const profile = await createCompensationBaselineProfile({
      kind: "flow-spillover",
      method: "matrix-inverse",
      solverVersion: "flow-lu-v1",
      solverSettings: { singularTolerance: 1e-12, conditionWarningThreshold: 1e8 },
      matrix: canonical.value,
    }, {
      profileId: "P1", name: "P1", createdAt: "2026-11-11T00:00:00.000Z",
      origin: { type: "uploaded", fileName: "S1.csv", format: "csv", sourceColumnHeader: "source" },
    });

    const manager = new CompensationManager({
      workspaceKey: "W1",
      workerFactory: () => new RuntimeWorker(),
      byteBudget: 1 << 20,
      fixedWorkspaceBytes: 0,
      copySliceEvents: 1,
      yieldToEventLoop: () => Promise.resolve(),
    });
    try {
      await manager.apply({ profile, targets: [{ sample }] });
    } finally {
      manager.dispose();
    }
    // FL2 less 0.1 of FL1: 10 - 10, 20 - 20, 30 - 30.
    expect(Array.from(sample.compensatedColumnData(1))).toEqual([0, 0, 0]);
  });
});
