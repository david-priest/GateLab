// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { importGatingML } from "./gatingml";

/**
 * A real Cytobank Gating-ML export of a FLOW experiment, inlined.
 *
 * This is the ground truth for what Cytobank accepts, so it is kept here rather than read from
 * a working directory — the original was moved mid-session and silently skipped these tests.
 * Experiment number, title and URL are replaced; nothing structural is altered.
 *
 * The two facts it pins:
 *   • Cytobank writes transforms:flog for a Log scale — the default a flow experiment gets.
 *     GateLab parsed only logicle and fasinh, so the whole file was rejected as an unsupported
 *     transformation. Every earlier test of Cytobank interchange used CyTOF data, where the
 *     scale is arcsinh and this path is never reached.
 *   • Its BooleanGate references the primitive gate, never another GateSet.
 */
const CYTOBANK_FLOW_EXPORT = `<?xml version="1.0" encoding="UTF-8"?>
<gating:Gating-ML xmlns:gating="http://www.isac-net.org/std/Gating-ML/v2.0/gating" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:transforms="http://www.isac-net.org/std/Gating-ML/v2.0/transformations" xmlns:data-type="http://www.isac-net.org/std/Gating-ML/v2.0/datatypes">
  <data-type:custom_info>
    <cytobank>
      <about>Gating-ML 2.0 export of Cytobank experiment number 000000.</about>
      <cytobank_gating_version>2.0</cytobank_gating_version>
      <experiment_number>000000</experiment_number>
      <experiment_title>flow reference</experiment_title>
      <export_timestamp>2026-08-20T01:49:37.360-07:00</export_timestamp>
    </cytobank>
  </data-type:custom_info>
  <transforms:transformation transforms:id="Tr_Log_1">
    <transforms:flog transforms:T="1.0" transforms:M="1.0" />
  </transforms:transformation>
  <gating:RectangleGate gating:id="Gate_181661209_dGVzdCBnYXRl">
    <data-type:custom_info>
      <cytobank>
        <name>test gate</name>
        <id>181661209</id>
        <gate_id>1</gate_id>
        <type>RectangleGate</type>
        <version>-1</version>
        <compensation_id>0</compensation_id>
        <fcs_file_id />
        <tailored>false</tailored>
        <tailored_per_population>false</tailored_per_population>
        <tailored_per_population_gateset_id />
        <fcs_file_filename />
        <gating_group_id>-1</gating_group_id>
        <gating_group_name>Default group</gating_group_name>
        <file_sync_mode>0</file_sync_mode>
        <pop_sync_mode>0</pop_sync_mode>
        <definition>{"scale":{"x":{"flag":2,"argument":"1","min":1.0,"max":2.14748E9,"bins":256,"size":256},"y":{"flag":2,"argument":"1","min":1.0,"max":2.14748E9,"bins":256,"size":256}},"positive":false,"negative":false,"locked":false,"label":[3.264757697862448,4.945679404102729],"rectangle":{"x1":3.1687995577304924,"y1":1.7990053805762913,"x2":5.519773990963408,"y2":4.657434488957317}}</definition>
      </cytobank>
    </data-type:custom_info>
    <gating:dimension gating:compensation-ref="uncompensated" gating:min="4.168799557730493" gating:max="6.519773990963408" gating:transformation-ref="Tr_Log_1">
      <data-type:fcs-dimension data-type:name="BUV805-A" />
    </gating:dimension>
    <gating:dimension gating:compensation-ref="uncompensated" gating:min="2.7990053805762916" gating:max="5.657434488957317" gating:transformation-ref="Tr_Log_1">
      <data-type:fcs-dimension data-type:name="PE-A" />
    </gating:dimension>
  </gating:RectangleGate>
  <gating:BooleanGate gating:id="GateSet_36734176">
    <data-type:custom_info>
      <cytobank>
        <name>test gate</name>
        <id>36734176</id>
        <gate_set_id>1</gate_set_id>
        <version>-1</version>
        <tailored>false</tailored>
        <tailored_per_population>false</tailored_per_population>
        <compensation_id>0</compensation_id>
        <gating_group_id>-1</gating_group_id>
        <gating_group_name>Default group</gating_group_name>
        <definition>{"gates":[1],"negGates":[],"tailoredPerPopulation":{},"booleanExpression":"gate_1"}</definition>
      </cytobank>
    </data-type:custom_info>
    <gating:and>
      <gating:gateReference gating:ref="Gate_181661209_dGVzdCBnYXRl" />
      <gating:gateReference gating:ref="Gate_181661209_dGVzdCBnYXRl" />
    </gating:and>
  </gating:BooleanGate>
</gating:Gating-ML>
`;

describe("Cytobank flow export imports", () => {
  it("reads a log-scaled Cytobank flow gate into raw space", () => {
    const res = importGatingML(CYTOBANK_FLOW_EXPORT, ["BUV805-A", "PE-A"], {}, "flow");
    expect(res.n_gates_imported).toBe(1);

    const gate = Object.values(res.gates)[0] as {
      name: string; x_channel: string; y_channel: string; vertices: [number, number][];
    };
    expect(gate.name).toBe("test gate");
    expect(gate.x_channel).toBe("BUV805-A");
    expect(gate.y_channel).toBe("PE-A");

    // gating:min for BUV805-A is 4.168799557730493 in flog space with T = M = 1, so the raw
    // value is 10^(4.1688 - 1). The same gate's Cytobank definition JSON carries 3.1688 for
    // that edge, which is log10 of the same number — an independent confirmation that the
    // inverse runs the right way round.
    const xs = gate.vertices.map((v) => v[0]);
    expect(Math.min(...xs)).toBeCloseTo(Math.pow(10, 4.168799557730493 - 1), 3);
    expect(Math.max(...xs)).toBeCloseTo(Math.pow(10, 6.519773990963408 - 1), 0);

    // Raw space, not log space: the gate must sit where the events are, not at ~4.
    expect(Math.min(...xs)).toBeGreaterThan(1000);
  });

  it("leaves a CyTOF import in arcsinh space, unchanged", () => {
    // A log scale is a flow concept. Inverting it for CyTOF would move gates that were already
    // in storage space, so the instrument — not the transform — decides.
    const res = importGatingML(CYTOBANK_FLOW_EXPORT, ["BUV805-A", "PE-A"], {}, "cytof");
    const gate = Object.values(res.gates)[0] as { vertices: [number, number][] };
    expect(Math.min(...gate.vertices.map((v) => v[0]))).toBeCloseTo(4.168799557730493, 6);
  });

  it("is the shape GateLab must write back: no GateSet is ever referenced", () => {
    // Cytobank has no construct for one population referencing another; every GateSet is the
    // AND of its whole ancestor chain of primitive gates. GateLab used to reference the parent
    // GateSet, which is legal Gating-ML and round-trips with itself, but Cytobank rejects it.
    expect(CYTOBANK_FLOW_EXPORT).not.toMatch(/gating:ref="GateSet_/);
    expect(CYTOBANK_FLOW_EXPORT).toMatch(/gating:ref="Gate_/);
    // And its boolean expression names gates only. Matched as a whole token: the file does
    // contain "pop_sync_mode", which a bare "pop_" search would wrongly flag.
    const exprs = [...CYTOBANK_FLOW_EXPORT.matchAll(/"booleanExpression":"([^"]*)"/g)]
      .map((m) => m[1]);
    expect(exprs.length).toBeGreaterThan(0);
    for (const e of exprs) expect(e).not.toMatch(/\bpop_\d+\b/);
  });
});
