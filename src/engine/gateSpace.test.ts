// @vitest-environment jsdom
//
// Phase 1 of the gating-space design: a gate carries the space its vertices are straight in, and
// a display-space gate carries the transform it was drawn under. Its membership must then be
// computable from the gate alone — never from whatever the sample happens to be showing. That is
// the entire difference between a stable Gating-ML gate and a FlowJo one, whose gate moves with
// the view (measured at 43.5% -> 80.5% on one axis flip).
//
// See LabNotes/Coding/GateLab/GateLab — gating space (raw vs display) design.md

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFcs } from "./fcs";
import { Sample, transformFromSpec } from "./sample";
import { getGateMask } from "./gates";
import { gateSpaceBadge } from "./gateSpaceBadge";
import { applyGatingStrategy } from "./populations";
import { newRootPopulation, newPopulation, newGateRef, linkChildToParent, type PopulationMap } from "./models";
import { ARIA_SMALL, FIXTURES_ROOT } from "../testFixtures";
import type { Gate } from "./models";

const BODENMILLER = join(
  FIXTURES_ROOT, "PUBLIC - Screenshot Safe", "Bodenmiller BCR-XL CyTOF benchmark",
  "source-fcs", "PBMC8_30min_patient1_BCR-XL.fcs",
);
function load(path: string): Sample {
  const b = readFileSync(path);
  return new Sample(parseFcs(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)));
}
function q(s: Sample, key: string, p: number): number {
  const col = s.gatingDataFor({ x_channel: key, y_channel: key, space: "raw" } as Gate).column(key)!;
  const v = Array.from(col).filter(Number.isFinite).sort((a, b) => a - b);
  return v[Math.floor((v.length - 1) * p)];
}

describe("transformSpec round-trips the live transform", () => {
  // transformSpec() mirrors the private transform() branch for branch. If they ever drift, every
  // display-space gate silently moves, so the mirror is pinned rather than trusted.
  for (const [label, path] of [["flow", ARIA_SMALL], ["cytof", BODENMILLER]] as const) {
    it(`reproduces every ${label} channel's display coordinates`, () => {
      const s = load(path);
      expect(s.channels.length).toBeGreaterThan(0);
      for (const c of s.channels) {
        const f = transformFromSpec(s.transformSpec(c.key)).forward;
        for (const v of [-1000, -1, 0, 1, 12.5, 500, 12345, 250000]) {
          const live = s.rawToDisplay(c.key, v);
          if (!Number.isFinite(live)) continue;
          expect(f(v), `${c.key} @ ${v}`).toBeCloseTo(live, 6);
        }
      }
    });
  }
});

describe("a display-space gate is pinned to its own transform", () => {
  const probe = load(ARIA_SMALL);
  const fluor = probe.channels.map((c, i) => ({ key: c.key, i })).filter(({ i }) => probe.isLogicleChannel(i));

  it("does not move when the display transform changes underneath it", () => {
    const s = load(ARIA_SMALL);
    const [x, y] = [fluor[0].key, fluor[1].key];
    const toD = (k: string, v: number) => s.rawToDisplay(k, v);
    // Vertices in DISPLAY space, as a gate drawn on the transformed axes would be.
    const gate: Gate = {
      gate_id: "d", name: "pinned", gate_type: "polygon",
      x_channel: x, y_channel: y,
      vertices: [
        [toD(x, q(s, x, 0.10)), toD(y, q(s, y, 0.10))],
        [toD(x, q(s, x, 0.90)), toD(y, q(s, y, 0.10))],
        [toD(x, q(s, x, 0.90)), toD(y, q(s, y, 0.90))],
        [toD(x, q(s, x, 0.10)), toD(y, q(s, y, 0.90))],
      ],
      color: "#377eb8", label_offset: null,
      space: "display",
      transforms: s.gateTransformSnapshot(x, y),
    };

    const before = Array.from(getGateMask(gate, s.gatingDataFor(gate)));
    const nIn = before.reduce((a, v) => a + v, 0);
    expect(nIn).toBeGreaterThan(0);
    expect(nIn).toBeLessThan(before.length);

    const xi = s.index(x)!, yi = s.index(y)!;
    const displayBefore = s.rawToDisplay(x, q(s, x, 0.5));
    for (const w of [0.1, 1.0, 2.0]) {
      s.setLogicleW(xi, w);
      s.setLogicleW(yi, w);
      expect(Array.from(getGateMask(gate, s.gatingDataFor(gate))), `W=${w}`).toEqual(before);
    }
    // The sample's own display really did move; the gate simply stopped listening to it.
    expect(s.rawToDisplay(x, q(s, x, 0.5))).not.toBeCloseTo(displayBefore, 6);
  });

  it("selects different events from a raw gate with the same vertex numbers", () => {
    // The two spaces are genuinely different gates — not a distinction without a difference.
    const s = load(ARIA_SMALL);
    const [x, y] = [fluor[0].key, fluor[1].key];
    const verts: [number, number][] = [
      [s.rawToDisplay(x, q(s, x, 0.2)), s.rawToDisplay(y, q(s, y, 0.2))],
      [s.rawToDisplay(x, q(s, x, 0.8)), s.rawToDisplay(y, q(s, y, 0.2))],
      [s.rawToDisplay(x, q(s, x, 0.8)), s.rawToDisplay(y, q(s, y, 0.8))],
    ];
    const base = { gate_id: "g", name: "n", gate_type: "polygon" as const, x_channel: x, y_channel: y,
                   vertices: verts, color: "#000", label_offset: null };
    const disp: Gate = { ...base, space: "display", transforms: s.gateTransformSnapshot(x, y) };
    const raw: Gate = { ...base, space: "raw" };
    const nDisp = Array.from(getGateMask(disp, s.gatingDataFor(disp))).reduce((a, v) => a + v, 0);
    const nRaw = Array.from(getGateMask(raw, s.gatingDataFor(raw))).reduce((a, v) => a + v, 0);
    expect(nDisp).toBeGreaterThan(0);
    expect(nDisp).not.toBe(nRaw);
  });
});

describe("drawing round-trips through either space", () => {
  const probe = load(ARIA_SMALL);
  const fluor = probe.channels.map((c, i) => ({ key: c.key, i })).filter(({ i }) => probe.isLogicleChannel(i));

  // A vertex read off the plot must come back to the same place on the plot, or a gate does not
  // land where it was drawn. Exact for a display gate (no conversion at all when its snapshot is
  // the current transform); a round trip through the logicle for a raw one.
  it("puts a drawn vertex back where it was drawn", () => {
    const s = load(ARIA_SMALL);
    const [x, y] = [fluor[0].key, fluor[1].key];
    for (const space of ["raw", "display"] as const) {
      const f = s.newGateSpaceFields(space, x, y);
      for (const ch of [x, y]) {
        for (const dv of [-0.5, 0, 0.25, 1.5, 3.0, 4.2]) {
          const stored = s.displayToGate(f, ch, dv);
          expect(s.gateToDisplay(f, ch, stored), `${space} ${ch} @ ${dv}`).toBeCloseTo(dv, 6);
        }
      }
    }
  });

  it("stores display vertices verbatim, and raw vertices as raw", () => {
    const s = load(ARIA_SMALL);
    const [x] = [fluor[0].key];
    const disp = s.newGateSpaceFields("display", x, fluor[1].key);
    const raw = s.newGateSpaceFields("raw", x, fluor[1].key);
    // Drawn at display coordinate 2.0 on the current axes.
    expect(s.displayToGate(disp, x, 2.0)).toBeCloseTo(2.0, 9); // untouched
    expect(s.displayToGate(raw, x, 2.0)).toBeCloseTo(s.displayToRaw(x, 2.0), 6);
    expect(s.displayToGate(raw, x, 2.0)).not.toBeCloseTo(2.0, 3); // genuinely a different number
  });

  it("snapshots only the two axes the gate is drawn on", () => {
    const s = load(ARIA_SMALL);
    const [x, y] = [fluor[0].key, fluor[1].key];
    const f = s.newGateSpaceFields("display", x, y);
    expect(Object.keys(f.transforms ?? {}).sort()).toEqual([x, y].sort());
    expect(s.newGateSpaceFields("raw", x, y).transforms).toBeUndefined();
  });
});

describe("the whole strategy evaluates each gate in its own space", () => {
  const probe = load(ARIA_SMALL);
  const fluor = probe.channels.map((c, i) => ({ key: c.key, i })).filter(({ i }) => probe.isLogicleChannel(i));

  // The regression that shipped: getGateMask was space-aware but applyGatingStrategy still handed
  // ONE raw AssayData to every gate, so a display-space gate's arcsinh vertices (~6-8) were tested
  // against raw values (~1e4) and every population read 0.0%. Exercised through the real
  // evaluation path, because testing getGateMask directly is exactly what missed it.
  it("counts a display-space population, not zero", () => {
    const s = load(ARIA_SMALL);
    const [x, y] = [fluor[0].key, fluor[1].key];
    const f = s.newGateSpaceFields("display", x, y);
    const gate: Gate = {
      gate_id: "g", name: "disp", gate_type: "polygon", x_channel: x, y_channel: y,
      vertices: ([[0.10, 0.10], [0.90, 0.10], [0.90, 0.90], [0.10, 0.90]] as [number, number][])
        .map(([px, py]) => [
          s.rawToDisplay(x, q(s, x, px)), s.rawToDisplay(y, q(s, y, py)),
        ] as [number, number]),
      color: "#000", label_offset: null, ...f,
    };
    const root = newRootPopulation(s.fcs.nEvents);
    const pop = newPopulation("in", [newGateRef(gate.gate_id, true)], root.population_id);
    const pops: PopulationMap = { [root.population_id]: root, [pop.population_id]: pop };
    linkChildToParent(pops, pop.population_id, root.population_id);

    applyGatingStrategy({ [gate.gate_id]: gate }, pops, root.population_id, s.gateAssayData());

    expect(pops[pop.population_id].event_count).toBeGreaterThan(0);
    expect(pops[pop.population_id].event_count).toBeLessThan(s.fcs.nEvents);
  });

  it("counts raw and display gates correctly in the SAME strategy", () => {
    // A mixed workspace is the normal case once anything is imported; one shared AssayData
    // cannot serve both, which is the structural reason evaluation resolves columns per gate.
    const s = load(ARIA_SMALL);
    const [x, y] = [fluor[0].key, fluor[1].key];
    const verts = ([[0.15, 0.15], [0.85, 0.15], [0.85, 0.85]] as [number, number][]);
    const rawGate: Gate = {
      gate_id: "r", name: "raw", gate_type: "polygon", x_channel: x, y_channel: y,
      vertices: verts.map(([px, py]) => [q(s, x, px), q(s, y, py)] as [number, number]),
      color: "#000", label_offset: null, space: "raw",
    };
    const dispGate: Gate = {
      gate_id: "d", name: "disp", gate_type: "polygon", x_channel: x, y_channel: y,
      vertices: verts.map(([px, py]) =>
        [s.rawToDisplay(x, q(s, x, px)), s.rawToDisplay(y, q(s, y, py))] as [number, number]),
      color: "#000", label_offset: null, ...s.newGateSpaceFields("display", x, y),
    };
    const root = newRootPopulation(s.fcs.nEvents);
    const pr = newPopulation("r", [newGateRef("r", true)], root.population_id);
    const pd = newPopulation("d", [newGateRef("d", true)], root.population_id);
    const pops: PopulationMap = {
      [root.population_id]: root, [pr.population_id]: pr, [pd.population_id]: pd,
    };
    linkChildToParent(pops, pr.population_id, root.population_id);
    linkChildToParent(pops, pd.population_id, root.population_id);

    applyGatingStrategy({ r: rawGate, d: dispGate }, pops, root.population_id, s.gateAssayData());

    expect(pops[pr.population_id].event_count).toBeGreaterThan(0);
    expect(pops[pd.population_id].event_count).toBeGreaterThan(0);
  });
});

describe("editing an existing gate cannot change its space", () => {
  const probe = load(ARIA_SMALL);
  const fluor = probe.channels.map((c, i) => ({ key: c.key, i })).filter(({ i }) => probe.isLogicleChannel(i));

  // The "New gates in" preference feeds gate CREATION only. Every edit conversion reads the space
  // off the gate being edited, so dragging a vertex on a display-space gate while the preference
  // says raw (or vice versa) lands correctly and leaves the gate's own space untouched.
  it("converts a dragged vertex into the gate's space, whatever the current preference", () => {
    const s = load(ARIA_SMALL);
    const [x, y] = [fluor[0].key, fluor[1].key];
    const disp: Gate = {
      gate_id: "d", name: "d", gate_type: "polygon", x_channel: x, y_channel: y,
      vertices: [[1, 1], [2, 1], [2, 2]], color: "#000", label_offset: null,
      ...s.newGateSpaceFields("display", x, y),
    } as Gate;
    const raw: Gate = {
      gate_id: "r", name: "r", gate_type: "polygon", x_channel: x, y_channel: y,
      vertices: [[1, 1], [2, 1], [2, 2]], color: "#000", label_offset: null, space: "raw",
    };

    // The same on-screen position, dragged on each gate, stores two different numbers — each in
    // its own gate's space — and each renders back to the same screen position.
    const screen = 2.35;
    const storedDisp = s.displayToGate(disp, x, screen);
    const storedRaw = s.displayToGate(raw, x, screen);
    expect(storedDisp).toBeCloseTo(screen, 9);            // display gate: no conversion
    expect(storedRaw).toBeCloseTo(s.displayToRaw(x, screen), 6);
    expect(storedDisp).not.toBeCloseTo(storedRaw, 3);
    expect(s.gateToDisplay(disp, x, storedDisp)).toBeCloseTo(screen, 6);
    expect(s.gateToDisplay(raw, x, storedRaw)).toBeCloseTo(screen, 6);

    // And the edit never rewrites what the gate declares about itself.
    expect(disp.space).toBe("display");
    expect(Object.keys(disp.transforms ?? {}).sort()).toEqual([x, y].sort());
  });

  it("still lands correctly when the display has moved since the gate was drawn", () => {
    // A display gate is pinned to its own transform, so editing it under a DIFFERENT one must
    // route through raw rather than assume the screen coordinate is already in the gate's space.
    const s = load(ARIA_SMALL);
    const [x, y] = [fluor[0].key, fluor[1].key];
    const g: Gate = {
      gate_id: "d", name: "d", gate_type: "polygon", x_channel: x, y_channel: y,
      vertices: [[1, 1], [2, 1], [2, 2]], color: "#000", label_offset: null,
      ...s.newGateSpaceFields("display", x, y),
    } as Gate;

    s.setLogicleW(s.index(x)!, 1.75); // the view moves; the gate does not
    const screen = 2.35;
    const stored = s.displayToGate(g, x, screen);
    expect(stored).not.toBeCloseTo(screen, 3); // no longer a no-op — the spaces have diverged
    expect(s.gateToDisplay(g, x, stored)).toBeCloseTo(screen, 6); // but it round-trips
  });
});

describe("the space badge", () => {
  const probe = load(ARIA_SMALL);
  const fluor = probe.channels.map((c, i) => ({ key: c.key, i })).filter(({ i }) => probe.isLogicleChannel(i));

  const mk = (x: string, y: string, extra: Partial<Gate> = {}): Gate => ({
    gate_id: "g", name: "n", gate_type: "polygon", x_channel: x, y_channel: y,
    vertices: [[0, 0], [1, 0], [1, 1]], color: "#000", label_offset: null, ...extra,
  } as Gate);

  it("reads RR for a raw gate", () => {
    const s = load(ARIA_SMALL);
    // Starred because these axes are logicle: the gate is raw, so it is being viewed through a
    // transform it was not drawn in. The star is covered on its own below.
    const b = gateSpaceBadge(s, mk(fluor[0].key, fluor[1].key, { space: "raw" }));
    expect(b?.text.replace("*", "")).toBe("RR");
    expect(b?.hint).toContain("cannot change");
  });

  it("reads one letter per axis for a display gate", () => {
    const s = load(ARIA_SMALL);
    const scatter = s.channels.findIndex((_c, i) => s.transformKind(i) === "asinh");
    const x = s.channels[scatter].key;   // arcsinh scatter
    const y = fluor[0].key;              // logicle fluorescence
    const g = mk(x, y, { space: "display", transforms: s.gateTransformSnapshot(x, y) });
    const b = gateSpaceBadge(s, g);
    expect(b?.text).toBe("AL");
    expect(b?.hint).toContain("arcsinh (cofactor 150)");
    expect(b?.hint).toContain("logicle");
  });

  it("reads N for an axis the user set to linear", () => {
    const s = load(ARIA_SMALL);
    const scatter = s.channels.findIndex((_c, i) => s.transformKind(i) === "asinh");
    s.setScatterScale(scatter, "linear");
    const x = s.channels[scatter].key;
    const y = fluor[0].key;
    const g = mk(x, y, { space: "display", transforms: s.gateTransformSnapshot(x, y) });
    expect(gateSpaceBadge(s, g)?.text).toBe("NL");
  });

  it("stars a polygon whose current view differs from the space it was drawn in", () => {
    const s = load(ARIA_SMALL);
    const [x, y] = [fluor[0].key, fluor[1].key];
    const g = mk(x, y, { space: "display", transforms: s.gateTransformSnapshot(x, y) });
    expect(gateSpaceBadge(s, g)?.text).toBe("LL"); // drawn and viewed under the same transform

    s.setLogicleW(s.index(x)!, 1.75); // the view moves; the gate does not
    const b = gateSpaceBadge(s, g);
    expect(b?.text).toBe("LL*");
    expect(b?.hint).toContain("dragging it far will change its shape");
  });

  it("stars a raw polygon only while an axis is actually transformed", () => {
    const s = load(ARIA_SMALL);
    const scatter = s.channels.findIndex((_c, i) => s.transformKind(i) === "asinh");
    const other = s.channels.findIndex((_c, i) => s.transformKind(i) === "asinh" && i !== scatter);
    const g = mk(s.channels[scatter].key, s.channels[other].key, { space: "raw" });
    expect(gateSpaceBadge(s, g)?.text).toBe("RR*"); // raw gate seen through arcsinh axes

    s.setScatterScale(scatter, "linear");
    s.setScatterScale(other, "linear");
    expect(gateSpaceBadge(s, g)?.text).toBe("RR"); // linear axes ARE raw — nothing to warn about
  });

  it("never stars a rectangle, which cannot be reshaped by a drag", () => {
    // Its corners move nonlinearly too, but it stays an axis-aligned box, so there is no surprise
    // to flag — and starring every rectangle would drown the signal on the gates that can.
    const s = load(ARIA_SMALL);
    const [x, y] = [fluor[0].key, fluor[1].key];
    const r = mk(x, y, { gate_type: "rectangle", space: "raw" });
    expect(gateSpaceBadge(s, r)?.text).toBe("RR");
  });

  it("is suppressed on CyTOF, where it would never vary", () => {
    const s = load(BODENMILLER);
    expect(gateSpaceBadge(s, mk(s.channels[0].key, s.channels[1].key))).toBeNull();
  });
});

describe("an absent space keeps the pre-field meaning", () => {
  it("reads flow gates raw and CyTOF gates in display space", () => {
    const flow = load(ARIA_SMALL);
    const cytof = load(BODENMILLER);
    const g = (s: Sample): Gate => ({
      gate_id: "g", name: "n", gate_type: "polygon",
      x_channel: s.channels[0].key, y_channel: s.channels[1].key,
      vertices: [[0, 0], [1, 0], [1, 1]], color: "#000", label_offset: null,
    });
    expect(flow.gateSpace(g(flow))).toBe("raw");
    expect(cytof.gateSpace(g(cytof))).toBe("display");
    // And the columns follow: a legacy CyTOF gate still reads the current display space.
    const c = cytof.channels[0].key;
    const legacy = Array.from(cytof.gatingDataFor(g(cytof)).column(c)!).slice(0, 5);
    expect(legacy).toEqual(Array.from(cytof.gatingData().column(c)!).slice(0, 5));
  });
});
