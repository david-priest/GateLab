// @vitest-environment jsdom
// A rotated ellipse with a symmetric covariance in a Gating-ML file keeps an exactly symmetric
// covariance when it is imported onto a rescaled axis or restated from scale values by a gain.

import { describe, expect, it } from "vitest";
import { importGatingML } from "./gatingml";
import { gatesFromGatingMlScale } from "./gatingmlGain";
import type { EllipseGate, Gate } from "./models";

const G = "http://www.isac-net.org/std/Gating-ML/v2.0/gating";
const T = "http://www.isac-net.org/std/Gating-ML/v2.0/transformations";
const D = "http://www.isac-net.org/std/Gating-ML/v2.0/datatypes";

function ellipseXml(c: [number, number, number]): string {
  return `<gating:Gating-ML xmlns:gating="${G}" xmlns:transforms="${T}" xmlns:data-type="${D}">
  <transforms:transformation transforms:id="Tr1"><transforms:flin transforms:T="10000" transforms:A="0" /></transforms:transformation>
  <transforms:transformation transforms:id="Tr2"><transforms:flin transforms:T="3000" transforms:A="0" /></transforms:transformation>
  <gating:EllipsoidGate gating:id="E1">
    <gating:dimension gating:compensation-ref="uncompensated" gating:transformation-ref="Tr1"><data-type:fcs-dimension data-type:name="FL1-A" /></gating:dimension>
    <gating:dimension gating:compensation-ref="uncompensated" gating:transformation-ref="Tr2"><data-type:fcs-dimension data-type:name="FL2-A" /></gating:dimension>
    <gating:mean><gating:coordinate data-type:value="0.5" /><gating:coordinate data-type:value="0.5" /></gating:mean>
    <gating:covarianceMatrix>
      <gating:row><gating:entry data-type:value="${c[0]}" /><gating:entry data-type:value="${c[1]}" /></gating:row>
      <gating:row><gating:entry data-type:value="${c[1]}" /><gating:entry data-type:value="${c[2]}" /></gating:row>
    </gating:covarianceMatrix>
    <gating:distanceSquare data-type:value="1" />
  </gating:EllipsoidGate>
</gating:Gating-ML>`;
}

/** Off-diagonal values for a positive-definite matrix with diagonal 0.04, 0.03. */
const offDiagonals = Array.from({ length: 200 }, (_, i) => -0.03 + (0.06 * i) / 199);

describe("a rotated Gating-ML ellipse's covariance", () => {
  it("is exactly symmetric after import on flin axes of different ranges", () => {
    const asymmetric: number[] = [];
    for (const b of offDiagonals) {
      const res = importGatingML(ellipseXml([0.04, b, 0.03]), ["FL1-A", "FL2-A"], {}, "flow");
      const gate = Object.values(res.gates)[0] as EllipseGate;
      expect(gate.gate_type).toBe("ellipse");
      if (gate.covariance[0][1] !== gate.covariance[1][0]) asymmetric.push(b);
    }
    expect(asymmetric).toEqual([]);
  });

  it("is exactly symmetric after restating from scale values with a gain on each axis", () => {
    const asymmetric: number[] = [];
    for (const b of offDiagonals) {
      const gate: Gate = {
        gate_id: "e", name: "CD4_positive", gate_type: "ellipse", x_channel: "FL1-A", y_channel: "FL2-A",
        mean: [500, 500], covariance: [[400, b * 1e4], [b * 1e4, 300]], distance_square: 1,
        space: "raw", color: "#000", label_offset: null,
      };
      const out = gatesFromGatingMlScale({ e: gate }, new Map([["FL1-A", 3.67], ["FL2-A", 1.9]])).gates.e as EllipseGate;
      if (out.covariance[0][1] !== out.covariance[1][0]) asymmetric.push(b);
    }
    expect(asymmetric).toEqual([]);
  });
});
