// @vitest-environment jsdom
import { it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { biexTransform } from "./biex";
const BASE = "/Users/davidpriest/My Drive (davidpriest@cider.osaka-u.ac.jp)/Wing Lab/Large Projects/GateLab Paper/GateLab-2026-08-15-B flowjo-and-cytobank-concordance/data/bass12-priest2024-s6/source";
it.runIf(existsSync(`${BASE}/diva-experiment/B cell assay 12.xml`))("fit", { timeout: 60000 }, () => {
  const dp = new DOMParser();
  const dd = dp.parseFromString(readFileSync(`${BASE}/diva-experiment/B cell assay 12.xml`, "utf-8"), "text/xml");
  const wd = dp.parseFromString(readFileSync(`${BASE}/flowjo-workspace/25-Sep-2023.wsp`, "utf-8"), "text/xml");
  // pairs per scale, as before (polygon vertex order assumed matching)
  const pairs = new Map<number, [number, number][]>();
  const divaGates = new Map<string, { sx: number; sy: number; lx: boolean; ly: boolean; pts: [number, number][] }>();
  for (const g of Array.from(dd.querySelectorAll("worksheet_template > gates > gate"))) {
    const reg = g.querySelector("region");
    if (!reg) continue;
    const t = (tag: string) => g.querySelector(`:scope > ${tag}`)?.textContent ?? "";
    divaGates.set(t("name"), {
      sx: Number(t("x_parameter_scale_value")), sy: Number(t("y_parameter_scale_value")),
      lx: t("is_x_parameter_scaled") === "true", ly: t("is_y_parameter_scaled") === "true",
      pts: Array.from(reg.querySelectorAll("point")).map((p) => [Number(p.getAttribute("x")), Number(p.getAttribute("y"))]),
    });
  }
  const node = Array.from(wd.getElementsByTagName("SampleNode")).find((n) => n.getAttribute("name") === "19319.fcs")!;
  for (const pop of Array.from(node.getElementsByTagName("Population"))) {
    const dg = divaGates.get(pop.getAttribute("name")!);
    if (!dg) continue;
    const gate = pop.getElementsByTagName("gating:PolygonGate")[0] ?? pop.getElementsByTagName("gating:RectangleGate")[0];
    if (!gate) continue;
    let w: [number, number][], d: [number, number][];
    if (gate.tagName.includes("Rectangle")) {
      const dn = Array.from(gate.getElementsByTagName("gating:dimension"));
      w = [[Number(dn[0].getAttribute("gating:min")), Number(dn[1].getAttribute("gating:min"))],
           [Number(dn[0].getAttribute("gating:max")), Number(dn[1].getAttribute("gating:max"))]];
      const xs = dg.pts.map((p) => p[0]), ys = dg.pts.map((p) => p[1]);
      d = [[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]];
    } else {
      const vs = Array.from(gate.getElementsByTagName("gating:vertex")).map((v) =>
        Array.from(v.getElementsByTagName("gating:coordinate")).map((c) => Number(c.getAttribute("data-type:value"))) as [number, number]);
      if (vs.length !== dg.pts.length) continue;
      w = vs; d = dg.pts;
    }
    d.forEach((dpnt, i) => {
      if (dg.lx) { const a = pairs.get(dg.sx) ?? []; a.push([dpnt[0], w[i][0]]); pairs.set(dg.sx, a); }
      if (dg.ly) { const a = pairs.get(dg.sy) ?? []; a.push([dpnt[1], w[i][1]]); pairs.set(dg.sy, a); }
    });
  }
  const MAXR = 316227.7660168379;
  const candidates: Record<string, (bin: number, s: number) => number> = {
    "A: d=bin*256/4096": (bin, s) => {
      const t = biexTransform({ maxValue: MAXR, pos: 4.5, neg: 0, widthBasis: -s * MAXR / 2621440, channelRange: 256 });
      return t.inverse(bin * 256 / 4096);
    },
    "B: d=bin/4096*fwd(262144)": (bin, s) => {
      const t = biexTransform({ maxValue: MAXR, pos: 4.5, neg: 0, widthBasis: -s * MAXR / 2621440, channelRange: 256 });
      return t.inverse((bin / 4096) * t.forward(262144));
    },
    "C: maxValue=262144, w=-s/10": (bin, s) => {
      const t = biexTransform({ maxValue: 262144, pos: 4.5, neg: 0, widthBasis: -s / 10, channelRange: 256 });
      return t.inverse(bin * 256 / 4096);
    },
  };
  for (const [label, f] of Object.entries(candidates)) {
    let worst = 0, wAt = "", sum = 0, n = 0;
    for (const [s, ps] of pairs) for (const [bin, raw] of ps) {
      const got = f(bin, s);
      const span = 262144;
      const d = Math.abs(got - raw) / span;
      sum += d; n++;
      if (d > worst) { worst = d; wAt = `scale ${s} bin ${bin.toFixed(1)}: wsp ${raw.toFixed(1)} got ${got.toFixed(1)}`; }
    }
    console.log(`${label}:  mean ${(sum / n).toExponential(2)}  worst ${worst.toExponential(2)}  (${wAt})`);
  }
});
