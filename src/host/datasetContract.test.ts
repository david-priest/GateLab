import { describe, expect, it } from "vitest";
import {
  decodeChannelMajorFloat32,
  decodeEventIndexUint32,
} from "./datasetContract";

function float32LittleEndian(values: readonly number[]): ArrayBuffer {
  const payload = new ArrayBuffer(values.length * Float32Array.BYTES_PER_ELEMENT);
  const view = new DataView(payload);
  values.forEach((value, index) => {
    view.setFloat32(index * Float32Array.BYTES_PER_ELEMENT, value, true);
  });
  return payload;
}

function uint32LittleEndian(values: readonly number[]): ArrayBuffer {
  const payload = new ArrayBuffer(values.length * Uint32Array.BYTES_PER_ELEMENT);
  const view = new DataView(payload);
  values.forEach((value, index) => {
    view.setUint32(index * Uint32Array.BYTES_PER_ELEMENT, value, true);
  });
  return payload;
}

describe("GateLab host dataset binary contract", () => {
  it("decodes channel-major R assay bytes into one channel view each", () => {
    const payload = float32LittleEndian([
      1.25, 2.5, 3.75,
      -4.5, 0, 8.25,
    ]);

    const channels = decodeChannelMajorFloat32(payload, 2, 3);

    expect(channels).toHaveLength(2);
    expect([...channels[0]]).toEqual([1.25, 2.5, 3.75]);
    expect([...channels[1]]).toEqual([-4.5, 0, 8.25]);
    expect(channels[0].buffer).toBe(payload);
    expect(channels[1].buffer).toBe(payload);
  });

  it("decodes zero-based original SCE event indices", () => {
    const payload = uint32LittleEndian([0, 1, 4, 8, 9]);
    expect([...decodeEventIndexUint32(payload, 5)]).toEqual([0, 1, 4, 8, 9]);
  });

  it("rejects truncated or dimensionally inconsistent payloads", () => {
    expect(() => decodeChannelMajorFloat32(new ArrayBuffer(20), 2, 3))
      .toThrow("Assay payload has 20 bytes; expected 24.");
    expect(() => decodeEventIndexUint32(new ArrayBuffer(8), 3))
      .toThrow("Event-index payload has 8 bytes; expected 12.");
  });
});
