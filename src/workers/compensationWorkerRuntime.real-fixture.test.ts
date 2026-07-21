import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseFcs, type FcsFile, type NumericColumn } from "../engine/fcs";
import {
  COMPENSATION_WORKER_PROTOCOL,
  type ApplyChunkCompleteResponse,
  type CompensationWorkerResponse,
} from "./compensationProtocol";
import { createCompensationWorkerRuntime } from "./compensationWorkerRuntime";

const FIXTURE_ROOT =
  "/Users/davidpriest/code/gatelabr-test-fcs/conventional_comp_AriaIII";
const PAIRS = [
  ["sample_Bcell_check.fcs", "sample_Bcell_check_COMPENSATED.fcs"],
  ["sample_Bmem_purity_large.fcs", "sample_Bmem_purity_large_COMPENSATED.fcs"],
  ["sample_Bmem_purity_small.fcs", "sample_Bmem_purity_small_COMPENSATED.fcs"],
  ["sample_PBMC_check.fcs", "sample_PBMC_check_COMPENSATED.fcs"],
] as const;

const IDENTITY = {
  jobId: "real-flow-apply",
  jobToken: "real-flow-token",
  profileHash: "real-flow-profile",
  bindingKey: "real-flow-binding",
} as const;

function loadFcs(path: string): FcsFile {
  const bytes = readFileSync(path);
  return parseFcs(bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ));
}

function namedColumn(fcs: FcsFile, pnn: string): NumericColumn {
  const index = fcs.channels.findIndex(({ name }) => name === pnn);
  if (index < 0) throw new Error(`Missing FCS channel ${pnn}.`);
  return fcs.columns[index];
}

async function eventually<T>(read: () => T | undefined): Promise<T> {
  for (let attempt = 0; attempt < 2_000; attempt++) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Timed out waiting for compensation worker response.");
}

function firstMismatch(actual: ArrayLike<number>, expected: ArrayLike<number>): number | null {
  if (actual.length !== expected.length) return 0;
  for (let event = 0; event < actual.length; event++) {
    if (!Object.is(actual[event], expected[event])) return event;
  }
  return null;
}

describe.runIf(PAIRS.every(([raw, reference]) =>
  existsSync(`${FIXTURE_ROOT}/${raw}`) &&
  existsSync(`${FIXTURE_ROOT}/compensated_reference/${reference}`)
))("real FCS compensation worker Apply", () => {
  for (const [rawName, referenceName] of PAIRS) {
    it(`${rawName}: irregular worker chunks remain byte-identical to flowCore`, async () => {
      const raw = loadFcs(`${FIXTURE_ROOT}/${rawName}`);
      const reference = loadFcs(
        `${FIXTURE_ROOT}/compensated_reference/${referenceName}`,
      );
      const spillover = raw.spillover!;
      const measured = spillover.channels.map((pnn) => namedColumn(raw, pnn));
      const originalBytes = measured.map((column) =>
        new Uint8Array(column.buffer, column.byteOffset, column.byteLength).slice()
      );
      const installed = spillover.channels.map(() => new Float32Array(raw.nEvents));
      const receiverBindings = spillover.channels.map((pnn, matrixIndex) => ({
        pnn,
        fcsColumnIndex: raw.channels.findIndex(({ name }) => name === pnn),
        matrixSourceIndex: matrixIndex,
        matrixReceiverIndex: matrixIndex,
      }));
      const responses: CompensationWorkerResponse[] = [];
      const runtime = createCompensationWorkerRuntime({
        emit: (response) => responses.push(response),
        microbatchEvents: 31,
      });

      runtime.dispatch({
        protocol: COMPENSATION_WORKER_PROTOCOL,
        type: "start-apply",
        method: "matrix-inverse",
        ...IDENTITY,
        sourceChannels: spillover.channels,
        receiverChannels: spillover.channels,
        channelBindings: receiverBindings,
        matrix: spillover.matrix,
        totalEvents: raw.nEvents,
        channelCount: spillover.channels.length,
        byteBudget: 8 * 1024 * 1024,
      });
      const started = await eventually(() => responses.find(
        (response) => response.type === "apply-started",
      ));
      expect(started.receiverBindings).toEqual(receiverBindings);
      expect(started.sourceBindings).toEqual(receiverBindings);

      const wireChunkEvents = 137;
      let chunkIndex = 0;
      for (let startEvent = 0; startEvent < raw.nEvents; startEvent += wireChunkEvents) {
        const endEvent = Math.min(startEvent + wireChunkEvents, raw.nEvents);
        runtime.dispatch({
          protocol: COMPENSATION_WORKER_PROTOCOL,
          type: "apply-chunk",
          ...IDENTITY,
          chunkIndex,
          startEvent,
          measuredColumns: measured.map((column) =>
            Float64Array.from(column.slice(startEvent, endEvent))
          ),
        });
        const completed = await eventually(() => responses.find(
          (response): response is ApplyChunkCompleteResponse =>
            response.type === "apply-chunk-complete" &&
            response.chunkIndex === chunkIndex,
        ));
        expect(completed.outputBindings).toEqual(receiverBindings);
        for (let channel = 0; channel < installed.length; channel++) {
          installed[channel].set(completed.columns[channel], startEvent);
        }
        chunkIndex++;
      }
      const complete = await eventually(() => responses.find(
        (response) => response.type === "apply-complete",
      ));
      expect(complete.outputBindings).toEqual(receiverBindings);
      expect(complete.allFinite).toBe(true);

      for (let channel = 0; channel < spillover.channels.length; channel++) {
        expect(
          firstMismatch(
            installed[channel],
            namedColumn(reference, spillover.channels[channel]),
          ),
          `${spillover.channels[channel]} differs after worker chunking`,
        ).toBeNull();
        expect(
          new Uint8Array(
            measured[channel].buffer,
            measured[channel].byteOffset,
            measured[channel].byteLength,
          ),
        ).toEqual(originalBytes[channel]);
      }
    });
  }
});
