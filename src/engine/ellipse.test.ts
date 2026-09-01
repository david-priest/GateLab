// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { covarianceFromAxes, ellipseAxes, ellipseBoundary, ellipseQuadraticForm } from "./ellipse";
import { gateMaskEllipse } from "./gates";
import { importGatingML } from "./gatingml";
import type { EllipseGate } from "./models";

function gate(overrides: Partial<EllipseGate> = {}): EllipseGate {
  return {
    gate_id: "e1", name: "E", gate_type: "ellipse", x_channel: "X", y_channel: "Y",
    mean: [10, 20], covariance: [[4, 0], [0, 1]], distance_square: 1,
    color: "#000", label_offset: null, space: "raw",
    ...overrides,
  };
}

describe("ellipse geometry", () => {
  it("recovers axes and angle from an axis-aligned covariance", () => {
    const { major, minor, angle } = ellipseAxes(gate());
    expect(major).toBeCloseTo(2, 12); // √(4·1)
    expect(minor).toBeCloseTo(1, 12);
    expect(angle).toBeCloseTo(0, 12);
  });

  it("recovers a rotated ellipse", () => {
    // Covariance of a 45°-rotated ellipse with half-axes 2 and 1 at D²=1:
    // R·diag(4,1)·Rᵀ with R = rot(π/4) → [[2.5, 1.5], [1.5, 2.5]].
    const g = gate({ covariance: [[2.5, 1.5], [1.5, 2.5]] });
    const { major, minor, angle } = ellipseAxes(g);
    expect(major).toBeCloseTo(2, 9);
    expect(minor).toBeCloseTo(1, 9);
    expect(angle).toBeCloseTo(Math.PI / 4, 9);
  });

  it("samples a boundary that satisfies the quadratic form exactly", () => {
    const g = gate({ covariance: [[2.5, 1.5], [1.5, 2.5]], distance_square: 3 });
    const { ia, ib, ic } = ellipseQuadraticForm(g);
    for (const [x, y] of ellipseBoundary(g, 16)) {
      const dx = x - g.mean[0];
      const dy = y - g.mean[1];
      expect(ia * dx * dx + 2 * ib * dx * dy + ic * dy * dy).toBeCloseTo(3, 9);
    }
  });
});

describe("ellipse mask", () => {
  it("is boundary-inclusive and rejects outside points", () => {
    const g = gate(); // centre (10,20), half-axes 2 (x) and 1 (y)
    const xs = [10, 12, 12.0001, 10, 10, 8.6, 13];
    const ys = [20, 20, 20, 21, 21.0001, 20.7, 21];
    //          in  edge just-out edge just-out in   out
    expect(Array.from(gateMaskEllipse(xs, ys, g))).toEqual([1, 1, 0, 1, 0, 1, 0]);
  });

  it("selects nothing under a degenerate covariance", () => {
    const g = gate({ covariance: [[1, 1], [1, 1]] }); // det = 0
    expect(Array.from(gateMaskEllipse([10], [20], g))).toEqual([0]);
  });
});

describe("EllipsoidGate import", () => {
  const G = "http://www.isac-net.org/std/Gating-ML/v2.0/gating";
  const T = "http://www.isac-net.org/std/Gating-ML/v2.0/transformations";
  const D = "http://www.isac-net.org/std/Gating-ML/v2.0/datatypes";

  it("imports Cytobank's real CD3+ T cells ellipse, in its declared arcsinh space", () => {
    // Verbatim from Cytobank experiment 573214's own export.
    const xml = `<gating:Gating-ML xmlns:gating="${G}" xmlns:transforms="${T}" xmlns:data-type="${D}">
      <transforms:transformation transforms:id="Tr_Arcsinh_150">
        <transforms:fasinh transforms:T="176.2801790465702" transforms:M="0.43429448190325176" transforms:A="0.0" />
      </transforms:transformation>
      <gating:EllipsoidGate gating:id="Gate_181665697_Q0QzKyBUIGNlbGxz">
        <data-type:custom_info><cytobank><name>CD3+ T cells</name><id>181665697</id>
          <gate_id>4</gate_id><type>EllipseGate</type><definition>{}</definition></cytobank></data-type:custom_info>
        <gating:dimension gating:compensation-ref="uncompensated" gating:transformation-ref="Tr_Arcsinh_150">
          <data-type:fcs-dimension data-type:name="PE-Cy7-A" />
        </gating:dimension>
        <gating:dimension gating:compensation-ref="uncompensated" gating:transformation-ref="Tr_Arcsinh_150">
          <data-type:fcs-dimension data-type:name="PerCP-Cy55-A" />
        </gating:dimension>
        <gating:mean>
          <gating:coordinate data-type:value="2.8250924985060584" />
          <gating:coordinate data-type:value="0.6191386550256537" />
        </gating:mean>
        <gating:covarianceMatrix>
          <gating:row>
            <gating:entry data-type:value="4.101183735447185" />
            <gating:entry data-type:value="0.0" />
          </gating:row>
          <gating:row>
            <gating:entry data-type:value="0.0" />
            <gating:entry data-type:value="1.0252959338618088" />
          </gating:row>
        </gating:covarianceMatrix>
        <gating:distanceSquare data-type:value="1.0" />
      </gating:EllipsoidGate>
    </gating:Gating-ML>`;

    const res = importGatingML(xml, ["PE-Cy7-A", "PerCP-Cy55-A"], {}, "flow");
    expect(res.n_gates_imported).toBe(1);
    const g = Object.values(res.gates)[0] as EllipseGate;
    expect(g.gate_type).toBe("ellipse");
    expect(g.space).toBe("display");
    expect(g.transforms?.["PE-Cy7-A"]?.kind).toBe("asinh");
    expect(g.mean[0]).toBeCloseTo(2.8250924985060584, 12);
    expect(g.covariance[0][0]).toBeCloseTo(4.101183735447185, 12);
    expect(g.distance_square).toBe(1);

    // Membership in the gate's own (arcsinh) space: the centre is inside; a point 2σ out on the
    // major axis is outside at D²=1.
    const m = gateMaskEllipse(
      [2.825, 2.825 + 2 * Math.sqrt(4.1012)],
      [0.619, 0.619],
      g,
    );
    expect(Array.from(m)).toEqual([1, 0]);
  });
});

describe("handle-edit round trip", () => {
  it("covarianceFromAxes inverts ellipseAxes exactly, rotation included", () => {
    const cov: [[number, number], [number, number]] = [[2.5, 1.5], [1.5, 2.5]];
    const g = gate({ covariance: cov, distance_square: 3 });
    const { major, minor, angle } = ellipseAxes(g);
    const back = covarianceFromAxes(major, minor, angle, 3);
    for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
      expect(back[i][j]).toBeCloseTo(cov[i][j], 9);
    }
  });
});
