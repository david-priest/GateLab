import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseFcs } from "./fcs";
import { Sample } from "./sample";
import { ARIA_SMALL } from "../testFixtures";

function loadArrayBuffer(path: string): ArrayBuffer {
  const b = readFileSync(path);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

/**
 * The contour density is cached in display pixel space and only rebuilt when the payload's
 * fingerprint changes. Moving a logicle W remaps every point, so the fingerprint has to move with
 * it — otherwise the axes and gates shift while the density stays where it was, which is exactly
 * what happened. Pseudocolour never showed it because its cache is cleared on every render.
 */
describe("a scale change is visible in the plot payload", () => {
  const sample = new Sample(parseFcs(loadArrayBuffer(ARIA_SMALL)));
  const fluor = sample.channels.findIndex((c) => !/^(FSC|SSC|Time)/.test(c.key));
  const other = sample.channels.findIndex((_, i) => i !== fluor);
  const payload = () => sample.plotPayload(fluor, other, "contour");

  it("moves the point data when a logicle W moves — the premise of the whole cache", () => {
    // If this ever fails, the contour freezing is the least of the problems.
    const before = payload();
    sample.setLogicleW(fluor, 1.7);
    const after = payload();
    expect(after.x_b64).not.toBe(before.x_b64);
    // The axis range, however, may NOT move: it is owned by the workspace and pinned across a
    // W change. That is why range-in-the-key was not enough on its own.
    sample.resetLogicleW(fluor);
  });

  it("carries a display binding for each axis", () => {
    const p = payload();
    expect(typeof p.x_binding).toBe("string");
    expect(p.x_binding!.length).toBeGreaterThan(0);
    expect(typeof p.y_binding).toBe("string");
  });

  it("changes the x binding when that channel's logicle W moves", () => {
    const before = payload().x_binding;
    sample.setLogicleW(fluor, 1.5);
    const after = payload().x_binding;
    expect(after).not.toBe(before);
    // ...and the untouched axis keeps its identity, so a redraw is not forced on both.
    expect(payload().y_binding).toBe(payload().y_binding);
    sample.resetLogicleW(fluor);
    expect(payload().x_binding).toBe(before);
  });

  it("changes the binding when a scatter cofactor moves", () => {
    const scatter = sample.channels.findIndex((c) => /^FSC/.test(c.key));
    if (scatter < 0) return;
    const p = () => sample.plotPayload(scatter, other, "contour");
    const before = p().x_binding;
    sample.setScatterCofactor(scatter, 500);
    expect(p().x_binding).not.toBe(before);
    sample.resetScatterCofactor(scatter);
    expect(p().x_binding).toBe(before);
  });
});
