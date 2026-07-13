// DivisionTab.tsx — the Division Profiler, mirroring GateLabR's Division tab. A 1-D histogram of one
// dye channel with DRAGGABLE division-boundary lines (Div0 = brightest = undivided), rendered via the
// reused window.DivisionD3. Boundaries are seeded by KDE peak-finding and then dragged/nudged. "Apply
// to selected" stores a per-sample division profile whose per-event Div0..DivN level becomes a
// Category in the Proportions tab. Optional biplot: dye vs a marker (e.g. Ki-67), coloured by level.

import { useEffect, useMemo, useRef, useState } from "react";
import { usePersistedTabState } from "./tabState";
import type { Derived } from "../store";
import type { Sample } from "../engine/sample";
import { loadDivisionPlots } from "../plots/loadPlots";
import { buildDivisionPayload, seedDivisionBoundaries, spaceEvenly, resizeBoundaries, computeAxisRange } from "../engine/division";

export interface DivisionProfile {
  channelKey: string;
  boundaries: number[];
  n: number;
  colName: string;
}
interface Props {
  sample: Sample;
  sampleName: string;
  derived: Derived;
  savedProfile: DivisionProfile | null;
  onApply: (profile: DivisionProfile) => void;
}

const guessChannel = (keys: string[], re: RegExp, fallback: number) => {
  const i = keys.findIndex((k) => re.test(k));
  return i >= 0 ? i : fallback;
};
function strided(idx: number[], cap: number): number[] {
  if (cap <= 0 || idx.length <= cap) return idx;
  const out = new Array<number>(cap);
  const denom = cap > 1 ? cap - 1 : 1;
  for (let k = 0; k < cap; k++) out[k] = idx[Math.round((k * (idx.length - 1)) / denom)];
  return out;
}

export function DivisionTab({ sample, sampleName, derived, savedProfile, onApply }: Props) {
  const keys = sample.channels.map((c) => c.key);
  const [dyeIdx, setDyeIdx] = useState(() => guessChannel(keys, /CFSE|CTV|CellTrace|Violet|Tag/i, 0));
  const [yMarker, setYMarker] = usePersistedTabState<string>("div.yMarker", ""); // "" = none
  const [n, setN] = useState(6);
  const [bins, setBins] = usePersistedTabState("div.bins", 120);
  const [subsample, setSubsample] = usePersistedTabState("div.subsample", 50000);
  const [pointAlpha, setPointAlpha] = usePersistedTabState("div.pointAlpha", 0.4);
  const [colName, setColName] = usePersistedTabState("div.colName", "div");
  const [xmin, setXmin] = useState<number | "">("");
  const [xmax, setXmax] = useState<number | "">("");
  const [boundaries, setBoundaries] = useState<number[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);
  const seqRef = useRef(0);

  // Full active-population dye values (for range + seeding); subsampled only for the histogram draw.
  const maskedDye = useMemo(() => {
    const col = sample.displayColumn(dyeIdx);
    const mask = derived.activeMask;
    const out: number[] = [];
    for (let i = 0; i < col.length; i++) if (!mask || mask[i]) out.push(col[i]);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sample, dyeIdx, derived]);

  const autoRange = useMemo(() => computeAxisRange(maskedDye), [maskedDye]);
  const xRange: [number, number] = [
    xmin === "" ? autoRange[0] : xmin,
    xmax === "" ? autoRange[1] : xmax,
  ];

  const reseed = (nn = n) => setBoundaries(seedDivisionBoundaries(maskedDye, nn));

  // Seed when the dye channel / sample changes (new distribution → fresh ladder).
  useEffect(() => {
    if (savedProfile && savedProfile.channelKey === keys[dyeIdx]) {
      setBoundaries(savedProfile.boundaries);
      setN(savedProfile.n);
    } else {
      setBoundaries(seedDivisionBoundaries(maskedDye, n));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dyeIdx, sampleName]);

  // Receive dragged boundaries from division_plot.js.
  useEffect(() => {
    const { bus } = loadDivisionPlots();
    return bus.on("division_gates", (v) => {
      const b = (v as { boundaries?: number[] }).boundaries;
      if (Array.isArray(b)) setBoundaries(b.slice().sort((x, y) => x - y));
    });
  }, []);

  // Render (debounced).
  useEffect(() => {
    if (!containerRef.current) return;
    const id = setTimeout(() => {
      const { api } = loadDivisionPlots();
      const dyeCol = sample.displayColumn(dyeIdx);
      const mask = derived.activeMask;
      const maskIdx: number[] = [];
      for (let i = 0; i < dyeCol.length; i++) if (!mask || mask[i]) maskIdx.push(i);
      const idx = strided(maskIdx, subsample);
      const dyeValues = idx.map((i) => dyeCol[i]);
      const yIdx = yMarker ? sample.index(yMarker) : undefined;
      let biplotDye: number[] | undefined;
      let markerValues: number[] | undefined;
      let yRange: [number, number] | undefined;
      if (yIdx !== undefined) {
        const bIdx = strided(maskIdx, Math.min(subsample, 30000));
        const yCol = sample.displayColumn(yIdx);
        biplotDye = bIdx.map((i) => dyeCol[i]);
        markerValues = bIdx.map((i) => yCol[i]);
        yRange = computeAxisRange(markerValues);
      }
      api.render(buildDivisionPayload({
        dyeValues,
        xLabel: sample.channelLabel(dyeIdx),
        xRange,
        bins: Math.max(10, Math.min(1000, bins || 120)), // clamp at use; the input holds raw typed value
        boundaries,
        seq: ++seqRef.current,
        biplotDye,
        markerValues,
        yLabel: yIdx !== undefined ? sample.channelLabel(yIdx) : undefined,
        yRange,
        pointAlpha,
      }));
    }, 180);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sample, dyeIdx, boundaries, bins, subsample, yMarker, pointAlpha, xRange[0], xRange[1], derived]);

  // Change # divisions IN PLACE (add at the dim end / drop the dimmest), preserving manual fits —
  // only reseed when there are no boundaries yet (R app.R:3859-3886), instead of a full reseed.
  const changeN = (nn: number) => {
    const v = Math.max(1, Math.min(11, nn));
    setN(v);
    setBoundaries((prev) => resizeBoundaries(prev, v, () => seedDivisionBoundaries(maskedDye, v)));
  };
  const shift = (dir: -1 | 1) => {
    const span = xRange[1] - xRange[0];
    const d = dir * span * 0.02;
    setBoundaries((b) => b.map((x) => Math.max(xRange[0], Math.min(xRange[1], x + d))));
  };
  // Apply writes the profile to the ACTIVE sample only (the button label says so). R's multi-sample
  // "Apply to selected" (app.R:4190-4218) is intentionally deferred until GateLab has a global
  // sample-inclusion set; it would then loop the selected samples here.
  const apply = () => onApply({ channelKey: keys[dyeIdx], boundaries: [...boundaries].sort((a, b) => a - b), n, colName: colName.trim() || "div" });

  return (
    <div className="gl-tab-panel">
      <div className="gl-strategy-controls">
        <label className="gl-field-inline">
          Dye channel
          <select value={dyeIdx} onChange={(e) => setDyeIdx(+e.target.value)}>
            {sample.channels.map((_, i) => <option key={i} value={i}>{sample.channelLabel(i)}</option>)}
          </select>
        </label>
        <label className="gl-field-inline">
          # divisions
          <input type="number" min={1} max={11} value={n} onChange={(e) => changeN(+e.target.value || 1)} />
        </label>
        <button className="gl-mini-btn" onClick={() => changeN(n - 1)}>−</button>
        <button className="gl-mini-btn" onClick={() => changeN(n + 1)}>+</button>
        <button className="gl-mini-btn" onClick={() => reseed()}>Re-seed</button>
        <button className="gl-mini-btn" onClick={() => setBoundaries((prev) => (prev.length >= 2 ? spaceEvenly(prev) : seedDivisionBoundaries(maskedDye, n)))}>Space evenly</button>
        <button className="gl-mini-btn" onClick={() => shift(-1)}>← shift</button>
        <button className="gl-mini-btn" onClick={() => shift(1)}>shift →</button>
      </div>

      <div className="gl-strategy-controls">
        <label className="gl-field-inline">Bins<input type="number" min={10} max={1000} value={bins} onChange={(e) => setBins(e.target.value === "" ? 0 : +e.target.value)} onBlur={(e) => setBins(Math.max(10, Math.min(1000, +e.target.value || 120)))} /></label>
        <label className="gl-field-inline">Subsample<input type="number" min={1000} step={1000} value={subsample} onChange={(e) => setSubsample(Math.max(1000, +e.target.value || 50000))} /></label>
        <label className="gl-field-inline">X min<input type="number" step={0.2} value={xmin} placeholder="auto" onChange={(e) => setXmin(e.target.value === "" ? "" : +e.target.value)} /></label>
        <label className="gl-field-inline">X max<input type="number" step={0.2} value={xmax} placeholder="auto" onChange={(e) => setXmax(e.target.value === "" ? "" : +e.target.value)} /></label>
        <span className="gl-ctl-sep" />
        <label className="gl-field-inline">
          Y marker
          <select value={yMarker} onChange={(e) => setYMarker(e.target.value)}>
            <option value="">(none)</option>
            {sample.channels.map((c, i) => <option key={c.key} value={c.key}>{sample.channelLabel(i)}</option>)}
          </select>
        </label>
        <label className="gl-field-inline">Opacity<input type="range" min={0.02} max={1} step={0.05} value={pointAlpha} onChange={(e) => setPointAlpha(+e.target.value)} /></label>
        <span className="gl-ctl-sep" />
        <label className="gl-field-inline">Column<input type="text" value={colName} onChange={(e) => setColName(e.target.value)} style={{ width: 70 }} /></label>
        <button className="gl-mini-btn gl-btn-apply" onClick={apply}>Apply to {sampleName}</button>
      </div>

      <div className="gl-hint gl-panel-hint">
        Div0 = brightest (undivided); drag the black lines to fit the dilution peaks. Apply writes a
        per-event Div0..Div{n} level for <strong>{sampleName}</strong>, usable as a Proportions Category.
      </div>
      <div id="division-plot-container" ref={containerRef} className="gl-division-container" style={{ maxWidth: 820, flex: "none", overflow: "visible" }} />
    </div>
  );
}
