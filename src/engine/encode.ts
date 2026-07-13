// encode.ts — Float32 → base64, matching GateLabR's data_utils.R:encode_float32_base64
// (R uses writeBin(size=4, endian="little")). The reused D3 modules decode these
// `*_b64` payload fields back into Float32Array, so the byte layout must match:
// little-endian float32, which is the native Float32Array layout on x86/ARM.

export function encodeFloat32Base64(values: ArrayLike<number>): string {
  const f = values instanceof Float32Array ? values : Float32Array.from(values as number[]);
  const bytes = new Uint8Array(f.buffer, f.byteOffset, f.byteLength);
  let bin = "";
  const CHUNK = 0x8000; // avoid arg-count limits on String.fromCharCode.apply
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return btoa(bin);
}

// Uint8 → base64 (for the colour-overlay per-point palette indices; cytof_plot.js decodes it
// with atob + charCodeAt into a Uint8Array).
export function encodeUint8Base64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return btoa(bin);
}

// Inverse — decode a base64 float32 payload back to a Float32Array (for tests /
// round-trip checks against the D3 decoder).
export function decodeFloat32Base64(b64: string): Float32Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}
