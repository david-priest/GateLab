import { describe, expect, it } from "vitest";
import {
  compensatedAssayCacheId,
  compensatedBindingSignature,
  digestFcsBytes,
  validateCachedCompensatedAssay,
} from "./compensationCache";
import type { Sha256Digest } from "./compensationProfile";
import type { PersistedCompensatedLayerBinding } from "./workspaceCompensation";

const digest = (character: string) => `sha256:${character.repeat(64)}` as Sha256Digest;

function binding(cofactor = 5): PersistedCompensatedLayerBinding {
  return {
    profileId: "profile-a",
    profileHash: digest("a"),
    matrixHash: digest("b"),
    kind: "cytof-spillover",
    method: "nnls",
    includedPnns: ["Y89Di", "In115Di"],
    channelBindings: [
      { pnn: "Y89Di", fcsColumnIndex: 1, matrixSourceIndex: 0, matrixReceiverIndex: 0, included: true },
      { pnn: "In115Di", fcsColumnIndex: 2, matrixSourceIndex: 1, matrixReceiverIndex: 1, included: true },
    ],
    transformBinding: { kind: "cytof-asinh", cofactor },
  };
}

describe("compensation cache identity", () => {
  it("hashes exact FCS bytes with SHA-256", async () => {
    const bytes = new TextEncoder().encode("abc");
    await expect(digestFcsBytes(bytes)).resolves.toBe(
      "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("separates transform bindings even when source bytes and profile are identical", () => {
    expect(compensatedAssayCacheId(digest("c"), binding(5)))
      .not.toBe(compensatedAssayCacheId(digest("c"), binding(10)));
    expect(compensatedBindingSignature(binding(5)))
      .not.toBe(compensatedBindingSignature(binding(10)));
  });
});

describe("validateCachedCompensatedAssay", () => {
  it("accepts only complete, exact Float32 output bindings", () => {
    const expected = binding();
    const fcsDigest = digest("c");
    const columns = [
      { pnn: "Y89Di", fcsColumnIndex: 1, values: Float32Array.from([1, 2, 3]) },
      { pnn: "In115Di", fcsColumnIndex: 2, values: Float32Array.from([4, 5, 6]) },
    ];
    const record = {
      schema: "gatelab.compensated-assay-cache.v1",
      id: compensatedAssayCacheId(fcsDigest, expected),
      createdAt: "2026-07-19T00:00:00.000Z",
      fcsDigest,
      bindingSignature: compensatedBindingSignature(expected),
      eventCount: 3,
      byteLength: 24,
      columns,
    };

    expect(validateCachedCompensatedAssay(record, fcsDigest, expected, 3)?.columns)
      .toHaveLength(2);
    expect(validateCachedCompensatedAssay(
      { ...record, columns: [columns[1], columns[0]] },
      fcsDigest,
      expected,
      3,
    )).toBeNull();
    expect(validateCachedCompensatedAssay(
      { ...record, bindingSignature: "stale" },
      fcsDigest,
      expected,
      3,
    )).toBeNull();
    expect(validateCachedCompensatedAssay(
      { ...record, columns: [columns[0], { ...columns[1], values: new Float64Array([4, 5, 6]) }] },
      fcsDigest,
      expected,
      3,
    )).toBeNull();
  });
});
