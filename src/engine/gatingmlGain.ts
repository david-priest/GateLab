// gatingmlGain.ts — amplifier gain ($PnG) at the Gating-ML boundary.
//
// GateLab keeps every channel as the value the acquisition software wrote. That is FlowJo's
// convention: on the FlowRepository files that carry a gain other than 1 on a gated channel
// (Beckman Gallios FS at 2 or 5, SS at 10), FlowJo's own recorded counts are reproduced by the
// workspace's gate coordinates on the undivided values and not on values divided by $PnG: 53 of
// 59 populations with a FlowJo count of 20 or more within 1% undivided, 2 of 59 divided (six
// Gallios files in FR-FCM-Z2V7, Z2KY and Z2JN, measured 2026-09-24; the GateLab Paper's
// FLOWREPOSITORY.md records the same result over the whole corpus). So a FlowJo workspace's gates
// are imported and exported as they are.
//
// Gating-ML 2.0 is defined on the FCS "scale value" instead (§3.3.4: event values "shall be
// decoded and converted to the form of so-called 'scale values' as specified by the FCS
// specification ... ($DATATYPE, $BYTEORD, $PnB, $PnE, $PnR, $PnG)"), and FCS 3.1 defines the
// scale value of a linearly amplified channel as channel value / $PnG. flowCore's read.FCS does
// the same only when asked (transformation = "linearize-with-PnG-scaling": "This is how the
// channel-to-scale transformation should be done according to the FCS specification (and
// according to Gating-ML 2.0), but lots of software tools are ignoring the $PnG division"), and
// flowio and FlowKit always divide. The ISAC Gating-ML test suite is written that way: its
// data1.fcs carries $P1G = 3.67, and Range1 selects 440 events on scale values against 12,446
// on the stored values.
//
// So a gate is converted where it crosses that boundary, and only there: on import from a
// standard Gating-ML file its coordinates are multiplied by $PnG, and on export they are divided.
// A coordinate declared under a transform (logicle, fasinh, flog) is left alone and the
// transform's top of scale T is scaled instead, which is exact, because each of these transforms
// of x / g with T / g is the same transform of x with T.
//
// Which files are on scale values:
//   • a file GateLab marks with gatelab_format {"gain": "gating-ml"} (its standard exports since
//     2026-09) or {"gain": "stored"};
//   • otherwise, a file GateLab or GateLabR wrote before the mark existed is on stored values,
//     because both wrote GateLab's coordinates unconverted;
//   • a Cytobank file is left on stored values, as GateLab has always read it. Whether Cytobank
//     divides by $PnG is not established: no Cytobank export of a file with a gain other than 1
//     on a gated channel has been available to measure;
//   • a file FlowJo, flowUtils or CytoML wrote is read on stored values (a default, 2026-09, for
//     David to confirm; see gatingmlWriter.ts, writerGainConvention). FlowJo gates stored values in
//     a .wsp, as measured above, and writes the same coordinates into its Gating-ML export;
//     flowUtils and CytoML write flowCore and cytolib gates, which read.FCS's default gates on
//     stored values. None has been measured on a file with a gain other than 1, since no such
//     export exists in any corpus here;
//   • every other file is on scale values, as the standard defines them.
// Which writer wrote a file is decided once, by the marks the edge rule uses too
// (gatingmlWriter.ts, gatingMLWriter).
// Time and the other QC channels are never converted (flowio sets a Time gain to 1 and scales
// Time by $TIMESTEP instead), nor is any channel whose $PnE states logarithmic amplification, on
// which FCS 3.1 does not allow a gain ("$PnG/f/, f not equal to 1, shall not be used together with
// $PnE different from $PnE/0,0/"). That covers a hardware log channel, which GateLab decodes, and a
// FLOAT channel stating a log $PnE, which GateLab reads as stored (statesLogAmplification in
// fcs.ts). On the Guava Muse the latter are the HLog channels, each holding log10 of its HLin
// channel before gain: log10(HLin / g) is HLog − log10(g), not HLog / g, so dividing by $PnG, as
// this module did until 2026-09 and as flowCore's linearize-with-PnG-scaling does, gives no scale
// value at all. flowio and FlowKit decode these channels as 10^(4 · HLog / 10000) / g instead,
// which is no scale value either; a gate on them cannot be made to agree with those readers.

import { statesLogAmplification } from "./fcs";
import { isUnbounded, type Gate, type TransformSpec } from "./models";
import type { Sample } from "./sample";
import { isQcChannel } from "./transforms";
import { gatingMLWriter, writerGainConvention } from "./gatingmlWriter";

/** custom_info element carrying GateLab's format declarations as JSON. */
export const GATELAB_FORMAT_TAG = "gatelab_format";

export type GatingMlGainConvention = "scale" | "stored";

/** Channel key → $PnG for every channel whose Gating-ML scale value differs from its stored one. */
export function gatingMlGains(sample: Sample): Map<string, number> {
  const out = new Map<string, number>();
  sample.channels.forEach((ch) => {
    const src = sample.fcs.channels[ch.columnIndex];
    const g = src?.gain;
    if (g === undefined || !Number.isFinite(g) || g <= 0 || g === 1) return;
    if (src.logAmp || statesLogAmplification(sample.fcs.keywords, ch.columnIndex + 1)) return;
    if (isQcChannel(ch.key) || isQcChannel(ch.pnn)) return;
    out.set(ch.key, g);
  });
  return out;
}

function childByLocalName(el: Element | null, name: string): Element | null {
  if (!el) return null;
  for (const child of Array.from(el.children)) if (child.localName === name) return child;
  return null;
}

/**
 * Which convention a Gating-ML document's coordinates follow; see the header. A GateLab mark
 * decides; otherwise the writer does, by the same identification the edge rule uses
 * (gatingmlWriter.ts, gatingMLWriter and writerGainConvention): every recognised writer is on
 * stored values and any other file on scale values.
 *
 * FlowJo, flowUtils and CytoML are read on stored values by default (2026-09), pending David's
 * decision; writerGainConvention is where that is changed.
 */
export function gatingMlGainConvention(xmlText: string): GatingMlGainConvention {
  return gainConventionOf(new DOMParser().parseFromString(xmlText, "application/xml").documentElement);
}

/** gatingMlGainConvention of a parsed document's root element. */
export function gainConventionOf(root: Element): GatingMlGainConvention {
  const mark = childByLocalName(childByLocalName(root, "custom_info"), GATELAB_FORMAT_TAG);
  if (mark) {
    try {
      const parsed: unknown = JSON.parse(mark.textContent ?? "{}");
      const gain = parsed && typeof parsed === "object" ? (parsed as { gain?: unknown }).gain : undefined;
      if (gain === "gating-ml") return "scale";
      if (gain === "stored") return "stored";
    } catch {
      // A malformed mark reads as no mark.
    }
  }
  return writerGainConvention(gatingMLWriter(root));
}

/**
 * The importer holds an open side of a Gating-ML range as ±UNBOUNDED, the largest double (models.ts;
 * fix/gatingml-hardening). It means "no bound" and is not scaled. It was ±1e9 until 2026-09, and a
 * coordinate at or beyond 1e9 was then left unscaled as if it were that stand-in, though real raw
 * values reach past it (a detector width on the public S8 file reaches -2.15e9).
 */
const scaleCoord = (v: number, k: number): number => (isUnbounded(v) ? v : v * k);

/** A transform of x / g, restated as the same transform of x: its scale parameter times g. */
export function scaleTransformSpec(spec: TransformSpec, g: number): TransformSpec | null {
  switch (spec.kind) {
    case "identity": return spec;
    case "asinh": return { ...spec, cofactor: spec.cofactor * g };
    case "logicle": return { ...spec, T: spec.T * g };
    case "flog": return { ...spec, T: spec.T * g };
    case "wsplog": return { ...spec, offset: spec.offset * g };
    case "biex": return null; // FlowJo's biex is not a scale family; it never arrives from Gating-ML
    // FlowJo's channel grid (fix/flowjo-grid) comes back from GateLab's own Gating-ML mark only, and
    // is quantised on its own axis: no gain restates it.
    case "flowjoChannels": return null;
  }
}

/**
 * Gates imported from Gating-ML scale values, restated on the stored values GateLab gates.
 * Returns new gate objects for the converted ones and the names of those converted; gates on no
 * channel in `gains` are returned unchanged. A gate with an axis that cannot be converted is left
 * as it is and named in `unconverted`.
 */
export function gatesFromGatingMlScale(
  gates: Record<string, Gate>,
  gains: ReadonlyMap<string, number>,
): { gates: Record<string, Gate>; converted: string[]; unconverted: string[] } {
  const out: Record<string, Gate> = {};
  const converted: string[] = [];
  const unconverted: string[] = [];
  for (const [id, gate] of Object.entries(gates)) {
    const gx = gains.get(gate.x_channel) ?? 1;
    const gy = gains.get(gate.y_channel) ?? 1;
    if (gx === 1 && gy === 1) {
      out[id] = gate;
      continue;
    }
    // Per axis: a factor on the coordinates (raw or identity axes), or a rescaled transform.
    let ok = true;
    const transforms = gate.transforms ? { ...gate.transforms } : undefined;
    const factor = (channel: string, g: number): number => {
      if (g === 1) return 1;
      if (gate.space !== "display") return g;
      const spec = transforms?.[channel];
      if (!spec || spec.kind === "identity") return g;
      // FlowJo's grid, restored from GateLab's mark: FlowJo's own cells on stored values, whatever
      // the ring beside it was written in, so nothing is restated. It was named as not converted.
      if (spec.kind === "flowjoChannels") return 1;
      const scaled = scaleTransformSpec(spec, g);
      if (!scaled) { ok = false; return 1; }
      transforms![channel] = scaled;
      return 1;
    };
    // One channel on both axes (a one-dimensional range) must be scaled once, not twice.
    const kx = factor(gate.x_channel, gx);
    const ky = gate.y_channel === gate.x_channel ? kx : factor(gate.y_channel, gy);
    if (!ok) {
      out[id] = gate;
      unconverted.push(gate.name);
      continue;
    }
    const withTransforms = transforms ? { transforms } : {};
    if (gate.gate_type === "quadrant") {
      out[id] = { ...gate, ...withTransforms, center: [scaleCoord(gate.center[0], kx), scaleCoord(gate.center[1], ky)] };
    } else if (gate.gate_type === "ellipse") {
      const c = gate.covariance;
      out[id] = {
        ...gate,
        ...withTransforms,
        mean: [gate.mean[0] * kx, gate.mean[1] * ky],
        covariance: [[c[0][0] * kx * kx, c[0][1] * kx * ky], [c[1][0] * ky * kx, c[1][1] * ky * ky]],
      };
    } else {
      out[id] = {
        ...gate,
        ...withTransforms,
        vertices: gate.vertices.map(([x, y]) => [scaleCoord(x, kx), scaleCoord(y, ky)]),
      };
    }
    converted.push(gate.name);
  }
  return { gates: out, converted, unconverted };
}
