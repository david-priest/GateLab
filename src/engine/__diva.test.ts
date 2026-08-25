// @vitest-environment jsdom
import { it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
const BASE = "/Users/davidpriest/My Drive (davidpriest@cider.osaka-u.ac.jp)/Wing Lab/Large Projects/GateLab Paper/GateLab-2026-08-15-B flowjo-and-cytobank-concordance/data/bass12-priest2024-s6/source";
const DIVA = `${BASE}/diva-experiment/B cell assay 12.xml`;
const WSP = `${BASE}/flowjo-workspace/25-Sep-2023.wsp`;
it.runIf(existsSync(DIVA) && existsSync(WSP))("pairs", { timeout: 60000 }, () => {
  const dp = new DOMParser();
  const dd = dp.parseFromString(readFileSync(DIVA, "utf-8"), "text/xml");
  const wd = dp.parseFromString(readFileSync(WSP, "utf-8"), "text/xml");
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
  const pairsByScale = new Map<number, [number, number][]>();
  for (const pop of Array.from(node.getElementsByTagName("Population"))) {
    const name = pop.getAttribute("name")!;
    const dg = divaGates.get(name);
    if (!dg) continue;
    const gate = pop.getElementsByTagName("gating:PolygonGate")[0] ?? pop.getElementsByTagName("gating:RectangleGate")[0];
    if (!gate) continue;
    let w: [number, number][];
    if (gate.tagName.includes("Rectangle")) {
      const dn = Array.from(gate.getElementsByTagName("gating:dimension"));
      w = [[Number(dn[0].getAttribute("gating:min")), Number(dn[1].getAttribute("gating:min"))],
           [Number(dn[0].getAttribute("gating:max")), Number(dn[1].getAttribute("gating:max"))]];
      // Diva rect corners → per-axis min/max to align.
      const xs = dg.pts.map((p) => p[0]), ys = dg.pts.map((p) => p[1]);
      const dpts: [number, number][] = [[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]];
      for (let i = 0; i < 2; i++) {
        if (dg.lx) { const a = pairsByScale.get(dg.sx) ?? []; a.push([dpts[i][0], w[i][0]]); pairsByScale.set(dg.sx, a); }
        if (dg.ly) { const a = pairsByScale.get(dg.sy) ?? []; a.push([dpts[i][1], w[i][1]]); pairsByScale.set(dg.sy, a); }
      }
    } else {
      const vs = Array.from(gate.getElementsByTagName("gating:vertex")).map((v) =>
        Array.from(v.getElementsByTagName("gating:coordinate")).map((c) => Number(c.getAttribute("data-type:value"))) as [number, number]);
      if (vs.length !== dg.pts.length) continue;
      // Assume same vertex order (FlowJo converted 1:1); verify monotonic sanity later.
      vs.forEach((wp, i) => {
        if (dg.lx) { const a = pairsByScale.get(dg.sx) ?? []; a.push([dg.pts[i][0], wp[0]]); pairsByScale.set(dg.sx, a); }
        if (dg.ly) { const a = pairsByScale.get(dg.sy) ?? []; a.push([dg.pts[i][1], wp[1]]); pairsByScale.set(dg.sy, a); }
      });
    }
  }
  for (const [scale, pairs] of [...pairsByScale.entries()].sort((a, b) => a[0] - b[0])) {
    const ps = pairs.sort((a, b) => a[0] - b[0]);
    console.log(`scale ${scale}: ${ps.length} pairs`);
    for (const [b, r] of ps) console.log(`   bin ${b.toFixed(2).padStart(9)}  raw ${r.toFixed(3).padStart(14)}`);
  }
});
