import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { fromScale, histogramCounts, scaleTicks, toScale, type HistogramScale } from "../compensationControls/controlHistogram";
import { FEW_EVENTS } from "../compensationControls/spilloverEstimate";
import { measureTube, parseDose, validTitrationGates, type TitrationSeries, type TitrationStatistics, type TitrationTube } from "../compensationControls/titration";
import { percentText, significantNumber } from "./compensationUiFormat";
import { useI18n } from "./i18n";
import { useModalEscape } from "./useModalEscape";
import "./titrationReview.css";

export interface TitrationReviewFile {
  id: string;
  name: string;
  detectors: { id: string; label: string; range: number }[];
  populations: { id: string; name: string }[];
  values: (detector: string) => ArrayLike<number> | null;
  mask: (populationId: string | null) => Uint8Array | null;
}

interface Props {
  files: TitrationReviewFile[];
  series: TitrationSeries[];
  onSave: (series: TitrationSeries[], reviewedId?: string) => void;
  onQc?: (series: TitrationSeries) => void;
  onClose: () => void;
}

type Translate = ReturnType<typeof useI18n>["t"];
type Bound = "negativeLower" | "negativeUpper" | "positiveLower" | "positiveUpper";
const BOUNDS: Bound[] = ["negativeLower", "negativeUpper", "positiveLower", "positiveUpper"];
const BOUND_LABELS = {
  negativeLower: "Lower boundary of the negative events", negativeUpper: "Upper boundary of the negative events",
  positiveLower: "Lower boundary of the positive events", positiveUpper: "Upper boundary of the positive events",
};
const EMPTY_GATES = { negativeLower: null, negativeUpper: null, positiveLower: null, positiveUpper: null };
const METRICS = { stainIndex: "Stain index", negativeSpread: "Negative spread", positiveMedian: "Positive median", negativeMedian: "Negative median" };
type Metric = keyof typeof METRICS;
const num = (value: number | null | undefined) => value == null ? "—" : significantNumber(value, 4);

function newSeries(): TitrationSeries {
  return { id: crypto.randomUUID(), clone: "", conjugate: "", lot: "", detector: "", unit: "", tubes: [], chosenDose: null, note: "" };
}
function seriesName(series: TitrationSeries, t: Translate): string {
  return [series.clone, series.conjugate, series.lot, series.detector].filter(Boolean).join(" · ") || t("Unnamed series");
}

interface TubeSource {
  values: ArrayLike<number>;
  mask: Uint8Array | null;
  events: number[] | null;
  range: number;
  min: number;
  max: number;
}

function sourceFor(file: TitrationReviewFile | undefined, detector: string, population: string | null): TubeSource | null {
  const channel = file?.detectors.find((item) => item.id === detector);
  if (!file || !channel) return null;
  const values = file.values(detector);
  const mask = population === null ? null : file.mask(population);
  if (!values || (population !== null && (!mask || mask.length !== values.length))) return null;
  let min = Infinity, max = -Infinity;
  const events: number[] | null = mask ? [] : null;
  for (let i = 0; i < values.length; i++) {
    if ((mask && !mask[i]) || !Number.isFinite(values[i])) continue;
    events?.push(i);
    min = Math.min(min, values[i]);
    max = Math.max(max, values[i]);
  }
  return { values, mask, events, range: channel.range, min, max };
}

interface TubeRow {
  tube: TitrationTube;
  file?: TitrationReviewFile;
  name: string;
  dose: number | null;
  source: TubeSource | null;
  statistics: TitrationStatistics | null;
  saved: boolean;
}

// Cache each file's resolved population and last set of intervals while this series is open.
// Typing a dose, replicate or note does not re-extract or re-sort its events.
function readRows(files: TitrationReviewFile[], detector: string) {
  const byId = new Map(files.map((file) => [file.id, file]));
  const cache = new Map<string, {
    population: string | null; source: TubeSource | null; bounds: string; statistics: TitrationStatistics | null;
  }>();
  return (tube: TitrationTube): TubeRow => {
    const file = byId.get(tube.fileId);
    const bounds = JSON.stringify(BOUNDS.map((key) => tube[key]));
    let entry = cache.get(tube.fileId);
    if (!entry || entry.population !== tube.populationId) {
      entry = { population: tube.populationId, source: sourceFor(file, detector, tube.populationId), bounds: "", statistics: null };
      cache.set(tube.fileId, entry);
    }
    if (bounds !== entry.bounds) {
      const { source } = entry;
      entry.statistics = source ? measureTube(source.values, source.mask, tube, source.range) : null;
      entry.bounds = bounds;
    }
    const reviewed = tube.reviewed;
    const saved = !!(!entry.source && reviewed?.detector === detector && reviewed.populationId === tube.populationId && reviewed.statistics);
    return { tube, file, name: file?.name ?? reviewed?.fileName ?? tube.fileId, dose: parseDose(tube.dose),
      source: entry.source, saved, statistics: saved ? reviewed!.statistics : entry.statistics };
  };
}

function rowFindings(row: TubeRow, t: Translate): string[] {
  const { tube, source, saved, statistics } = row;
  const notes: string[] = [];
  if (!source) notes.push(saved ? t("Last saved measurements") : t("Source or population unavailable"));
  if (!validTitrationGates(tube)) notes.push(t("Set ordered, non-overlapping intervals."));
  if (statistics) {
    if (statistics.negativeCount < FEW_EVENTS) notes.push(t("Only {count} negative events (fewer than {limit}).", { count: statistics.negativeCount, limit: FEW_EVENTS }));
    if (statistics.positiveCount < FEW_EVENTS) notes.push(t("Only {count} positive events (fewer than {limit}).", { count: statistics.positiveCount, limit: FEW_EVENTS }));
    if (statistics.negativeSpread === 0) notes.push(t("Zero negative spread. The stain index is undefined."));
    if ((statistics.saturationFraction ?? 0) > 0.01) notes.push(t("{percent} of positive events reach 99% of detector range.", { percent: percentText(statistics.saturationFraction!) }));
  }
  return notes;
}

function seriesScale(rows: TubeRow[]): HistogramScale | null {
  let min = Infinity, max = -Infinity, range = 0;
  for (const { source } of rows) {
    if (!source || source.min > source.max) continue;
    min = Math.min(min, source.min);
    max = Math.max(max, source.max);
    if (Number.isFinite(source.range)) range = Math.max(range, source.range);
  }
  if (min > max) return null;
  const cofactor = Math.max(1e-6, (range || Math.max(1, Math.abs(min), Math.abs(max))) / 2000);
  const lo = toScale(min, cofactor), hi = toScale(max, cofactor);
  const pad = Math.max(0.02, (hi - lo) * 0.025);
  return { lo: lo - pad, hi: hi + pad, cofactor };
}

function TubeHistogram({ row, scale, onSplit }: { row: TubeRow; scale: HistogramScale | null; onSplit: (value: number) => void }) {
  const { t } = useI18n();
  const { source, tube } = row;
  const lo = scale?.lo, hi = scale?.hi, cofactor = scale?.cofactor;
  const bins = useMemo(() => source && lo !== undefined && hi !== undefined && cofactor !== undefined
    ? histogramCounts(source.values, { lo, hi, cofactor }, 100, source.events) : null, [source, lo, hi, cofactor]);
  if (!source || !scale || !bins || source.min > source.max) return <p className="gl-hint">{t("No events available for this histogram.")}</p>;
  const left = 40, right = 580, top = 12, bottom = 117;
  const xpos = (value: number) => left + Math.max(0, Math.min(1, (toScale(value, scale.cofactor) - scale.lo) / (scale.hi - scale.lo))) * (right - left);
  const peak = Math.max(1, ...bins);
  const path = Array.from(bins, (count, i) => {
    const x = left + i * (right - left) / bins.length;
    return 'L' + x + ' ' + (bottom - count / peak * (bottom - top)) + 'h' + (right - left) / bins.length;
  }).join(" ");
  const ticks = scaleTicks(scale);
  if (ticks.length < 2) {
    ticks.length = 0;
    for (const at of [0.08, 0.5, 0.92]) {
      const value = fromScale(scale.lo + at * (scale.hi - scale.lo), scale.cofactor);
      ticks.push({ at, value, label: num(value) });
    }
  }
  function band(lower: number | null, upper: number | null, kind: "negative" | "positive") {
    const start = lower === null ? left : xpos(lower), end = upper === null ? right : xpos(upper);
    return <rect className={'tit-' + kind} x={start} y={top} width={Math.max(0, end - start)} height={bottom - top} />;
  }
  return <>
    <svg className="tit-histogram" viewBox="0 0 600 145" role="img" aria-label={t("Event counts on the shared detector axis")}
      onClick={(e) => {
        const svg = e.currentTarget, matrix = svg.getScreenCTM();
        if (!matrix) return;
        const point = svg.createSVGPoint();
        point.x = e.clientX; point.y = e.clientY;
        const { x, y } = point.matrixTransform(matrix.inverse());
        if (x >= left && x <= right && y >= top && y <= bottom) onSplit(fromScale(scale.lo + (x - left) / (right - left) * (scale.hi - scale.lo), scale.cofactor));
      }}>
      {tube.negativeUpper !== null && band(tube.negativeLower, tube.negativeUpper, "negative")}
      {tube.positiveLower !== null && band(tube.positiveLower, tube.positiveUpper, "positive")}
      <path className="tit-hist-counts" d={'M' + left + ' ' + bottom + path + ' V' + bottom + 'Z'} />
      {BOUNDS.map((key) => tube[key] !== null && <line key={key} className={'tit-bound ' + (key.startsWith("negative") ? 'negative' : 'positive')} x1={xpos(tube[key]!)} x2={xpos(tube[key]!)} y1={top} y2={bottom} />)}
      <line className="tit-axis" x1={left} x2={right} y1={bottom} y2={bottom} />
      <text x={left - 5} y={top + 5} textAnchor="end">{num(peak)}</text><text x={left - 5} y={bottom} textAnchor="end">0</text>
      {ticks.map(({ at, label }) => <text key={label} x={left + at * (right - left)} y={bottom + 17} textAnchor="middle">{label}</text>)}
    </svg>
    <p className="gl-hint">{t("The histogram uses a shared arcsinh axis. Click to set the negative upper and positive lower limits, or enter the limits below.")}</p>
  </>;
}

interface DoseGroup { value: number; label: string; rows: TubeRow[] }
function groupByDose(rows: TubeRow[], chosen: string | null): DoseGroup[] {
  const doses = new Map<number, DoseGroup>();
  for (const row of rows) {
    if (row.dose === null) continue;
    const group = doses.get(row.dose) ?? { value: row.dose, label: row.tube.dose, rows: [] };
    if (row.tube.dose === chosen) group.label = chosen;
    group.rows.push(row);
    doses.set(row.dose, group);
  }
  return [...doses.values()].sort((a, b) => a.value - b.value);
}

function DosePlot({ groups, selected, chosen, unit, onInspect }: { groups: DoseGroup[]; selected: string | null; chosen: string | null; unit: string; onInspect: (fileId: string) => void }) {
  const { t } = useI18n();
  const id = useId();
  const [metric, setMetric] = useState<Metric>("stainIndex");
  const width = Math.max(420, 90 + groups.length * 68);
  const left = 55, right = width - 40, top = 16, bottom = 121;
  const log = groups.length > 0 && groups[0].value > 0;
  const position = (dose: number) => log ? Math.log10(dose) : dose;
  const start = groups.length ? position(groups[0].value) : 0;
  const end = groups.length ? position(groups[groups.length - 1].value) : 0;
  const x = (dose: number) => start === end ? (left + right) / 2 : left + (position(dose) - start) / (end - start) * (right - left);
  const points = groups.flatMap((group) => group.rows.flatMap((row) => {
    const value = row.statistics?.[metric];
    return value == null ? [] : [{ row, value, x: x(group.value) }];
  }));
  const values = points.map((point) => point.value);
  const lo = Math.min(0, ...values), hi = Math.max(0, ...values);
  const y = (value: number) => bottom - (value - lo) / (hi === lo ? 1 : hi - lo) * (bottom - top);
  let move = true;
  const medianPath = groups.map((group) => {
    const ys = group.rows.flatMap(({ statistics }) => statistics?.[metric] == null ? [] : [statistics[metric]!]).sort((a, b) => a - b);
    if (!ys.length) { move = true; return ""; }
    const mid = Math.floor(ys.length / 2);
    const median = ys.length % 2 === 0 ? ys[mid - 1] / 2 + ys[mid] / 2 : ys[mid];
    const segment = (move ? "M" : "L") + x(group.value) + " " + y(median);
    move = false;
    return segment;
  }).join(" ");
  // Keep the two end labels, then fit the intervening labels on the actual numeric scale.
  const lastX = groups.length > 1 ? right : Infinity;
  let previousX = -Infinity;
  const labelled = new Set(groups.filter((group, index) => {
    const px = x(group.value);
    const include = index === 0 || index === groups.length - 1 || (px - previousX >= 50 && lastX - px >= 50);
    if (include) previousX = px;
    return include;
  }).map((group) => group.value));
  return <section className="tit-plot" aria-labelledby={id}>
    <div className="tit-section-head"><h3 id={id}>{t("Dose response")}</h3>
      <label>{t("Measure")} <select value={metric} onChange={(e) => setMetric(e.target.value as Metric)}>
        {Object.entries(METRICS).map(([key, name]) => <option key={key} value={key}>{t(name)}</option>)}
      </select></label>
    </div>
    {points.length ? <>
      <div className="tit-plot-scroll"><svg viewBox={'0 0 ' + width + ' 176'} style={{ minWidth: groups.length * 50 }} role="group" aria-label={t("Replicate measurements by dose")}>
        {Array.from(new Set([lo, (hi + lo) / 2, hi])).map((value) => <g key={value}>
          <line className="tit-gridline" x1={left - 10} x2={right + 10} y1={y(value)} y2={y(value)} />
          <text x={left - 14} y={y(value) + 4} textAnchor="end">{num(value)}</text>
        </g>)}
        {groups.map((group) => <g key={group.value}>
          {chosen !== null && group.value === parseDose(chosen) && <rect className="tit-chosen" x={x(group.value) - 7} y={top - 4} width={14} height={bottom - top + 8} />}
          <line className="tit-axis" x1={x(group.value)} x2={x(group.value)} y1={bottom} y2={bottom + 4} />
          {labelled.has(group.value) && <text x={x(group.value)} y={bottom + 20} textAnchor="middle">{group.label}</text>}
        </g>)}
        <path className="tit-median" d={medianPath} />
        <text x={(left + right) / 2} y={bottom + 44} textAnchor="middle">{[t("Dose"), unit, log ? t("Log scale") : t("Linear scale")].filter(Boolean).join(" · ")}</text>
        {points.map(({ row, value, x: px }) => {
          const label = t("{file}, dose {dose}, replicate {replicate}, {measure} {value}", { file: row.name, dose: row.tube.dose, replicate: row.tube.replicate, measure: t(METRICS[metric]), value: num(value) });
          return <g key={row.tube.fileId} role="button" tabIndex={0} aria-label={label} aria-pressed={row.tube.fileId === selected}
            className={'tit-point' + (row.saved ? ' saved' : '') + (row.tube.fileId === selected ? ' active' : '')}
            onClick={() => onInspect(row.tube.fileId)} onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onInspect(row.tube.fileId); }
            }}>
            <title>{label}</title><circle className="hit" cx={px} cy={y(value)} r={10} /><circle cx={px} cy={y(value)} r={4} />
          </g>;
        })}
      </svg></div><p className="gl-hint">{t("Select a point to inspect its tube. The line joins dose medians. Hollow points show saved measurements.")}</p>
    </> : <p className="gl-hint">{t("Enter doses and set the intervals to plot this measure.")}</p>}
  </section>;
}

function ratioSeries(series: TitrationSeries): boolean {
  return series.tubes.some((tube) => /[/:]/.test(tube.dose)) &&
    series.tubes.every((tube) => /[/:]/.test(tube.dose) || parseDose(tube.dose) === 0);
}

function conflictsWithDoseUnit(series: TitrationSeries): boolean {
  const unit = series.unit.trim();
  // A colon denotes a fraction of stock. It cannot supply an absolute concentration.
  return !!unit && series.tubes.some((tube) => tube.dose.includes(":"))
    && !/dilution|ratio|fraction|^v\/v$|^fold$|希釈|比率/i.test(unit);
}

function validateSeries(series: TitrationSeries, t: Translate): string | null {
  if (!series.clone.trim() || !series.detector) return t("Enter a clone and detector.");
  if (!series.tubes.length) return t("Add at least one tube.");
  if (conflictsWithDoseUnit(series)) return t("Use dilution ratios or convert all doses to the same concentration unit.");
  if (series.tubes.some((tube) => parseDose(tube.dose) === null || !tube.replicate.trim())) return t("Enter a numeric dose or dilution and a replicate for each tube.");
  if (!series.unit.trim() && !ratioSeries(series)) return t("Enter a unit for the concentrations.");
  if (series.tubes.some((tube) => BOUNDS.some((key) => tube[key] !== null) && !validTitrationGates(tube))) return t("Set ordered, non-overlapping intervals.");
  return null;
}

function trapTab(e: KeyboardEvent<HTMLDivElement>) {
  if (e.key !== "Tab") return;
  const controls = e.currentTarget.querySelectorAll<HTMLElement>('button:enabled, input:enabled, textarea:enabled, select:enabled, [tabindex="0"]');
  const last = controls[controls.length - 1], first = controls[0];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
  if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
}

export function TitrationReview({ files, series, onSave, onQc, onClose }: Props) {
  const { t } = useI18n();
  const titleId = useId();
  const [draft, setDraft] = useState<TitrationSeries[]>(() => series.length ? series : [newSeries()]);
  const [activeId, setActiveId] = useState<string | null>(() => draft[0]?.id ?? null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [addingFile, setAddingFile] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const selectRef = useRef<HTMLSelectElement>(null);
  const previousRecords = useRef(series);
  useModalEscape(onClose);
  useEffect(() => {
    const previous = document.activeElement;
    selectRef.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  // Saving may attach a fresh measurement snapshot to each reviewed tube.
  useEffect(() => {
    if (saved && !dirty && previousRecords.current !== series) { setDraft(series); previousRecords.current = series; }
  }, [series, saved, dirty]);

  const active = draft.find((item) => item.id === activeId);
  const readRow = useMemo(() => readRows(files, active?.detector ?? ""), [files, active?.detector]);
  const rows = useMemo(() => (active?.tubes ?? []).map(readRow).sort((a, b) => {
    if (a.dose === null) return b.dose === null ? 0 : 1;
    return b.dose === null ? -1 : a.dose - b.dose || a.tube.replicate.localeCompare(b.tube.replicate, undefined, { numeric: true });
  }), [readRow, active?.tubes]);
  const scale = useMemo(() => seriesScale(rows), [rows]);
  const selected = rows.find((r) => r.tube.fileId === selectedFile) ?? rows[0];
  const detectors = useMemo(() => new Map(files.flatMap((file) => file.detectors.map((d) => [d.id, d.label] as const))), [files]);
  const available = files.filter((file) => !active?.tubes.some((tube) => tube.fileId === file.id)
    && (!active?.detector || file.detectors.some((detector) => detector.id === active.detector)));
  const addId = available.some((file) => file.id === addingFile) ? addingFile : available[0]?.id ?? "";
  const groups = groupByDose(rows, active?.chosenDose ?? null);
  const invalid = draft.map((item) => ({ id: item.id, name: seriesName(item, t), reason: validateSeries(item, t) })).find((item) => item.reason);
  const saveDisabled = !!invalid || (!draft.length && !dirty);
  const setChanged = () => { setDirty(true); setSaved(false); };
  function update(change: Partial<TitrationSeries>) {
    if (!active) return;
    const next = { ...active, ...change };
    if (next.chosenDose !== null && !next.tubes.some((tube) => tube.dose === next.chosenDose)) {
      const old = parseDose(next.chosenDose);
      next.chosenDose = old === null ? null : next.tubes.find((tube) => parseDose(tube.dose) === old)?.dose ?? null;
    }
    setDraft(draft.map((item) => item.id === active.id ? next : item));
    setChanged();
  }
  function updateTube(fileId: string, change: Partial<TitrationTube>) {
    if (!active) return;
    const changedSource = change.populationId !== undefined || BOUNDS.some((key) => key in change);
    update({ tubes: active.tubes.map((tube) => tube.fileId === fileId
      ? { ...tube, ...change, ...(changedSource ? { reviewed: undefined } : {}) } : tube) });
  }
  function chooseSeries(id: string | null) {
    setActiveId(id); setSelectedFile(null); setAddingFile("");
  }
  function save() {
    if (saveDisabled) return;
    previousRecords.current = series;
    onSave(draft, active?.id);
    setDirty(false); setSaved(true);
  }

  return <div className="gl-modal-backdrop">
    <div className="gl-modal tit-review" role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={trapTab}>
      <h2 className="gl-modal-title" id={titleId}>{t("Antibody titration review")}</h2>
      <div className="tit-toolbar">
        <label>{t("Antibody series")} <select ref={selectRef} value={active?.id ?? ""} onChange={(e) => chooseSeries(e.target.value)}>
          {!draft.length && <option value="">—</option>}
          {draft.map((item) => <option key={item.id} value={item.id}>{seriesName(item, t)}</option>)}
        </select></label>
        <button className="gl-mini-btn" onClick={() => { const next = newSeries(); setDraft([...draft, next]); chooseSeries(next.id); setChanged(); }}>{t("Add series")}</button>
        {active && <button className="gl-mini-btn" onClick={() => {
          const remaining = draft.filter((item) => item.id !== active.id); setDraft(remaining); chooseSeries(remaining[0]?.id ?? null); setChanged();
        }}>{t("Remove series")}</button>}
      </div>
      <div className="tit-scroll">
      {active && <>
        <div className="tit-meta">
          {(["clone", "conjugate", "lot"] as const).map((key) => <label key={key}>{t({ clone: "Clone", conjugate: "Conjugate", lot: "Lot" }[key])}
            <input value={active[key]} onChange={(e) => update({ [key]: e.target.value })} /></label>)}
          <label>{t("Detector")}<select value={active.detector} onChange={(e) => update({ detector: e.target.value, chosenDose: null, tubes: active.tubes.map((tube) => ({ ...tube, ...EMPTY_GATES, reviewed: undefined })) })}>
            <option value="">{t("Choose detector")}</option>
            {active.detector && !detectors.has(active.detector) && <option value={active.detector}>{active.detector}</option>}
            {[...detectors].map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select></label>
          <label>{t("Dose unit")}<input value={active.unit} placeholder={t("e.g. µg/mL or dilution")} onChange={(e) => update({ unit: e.target.value })} /></label>
        </div>
        <div className="tit-columns">
          <section className="tit-tubes">
            <h3>{t("Tubes")} <span className="tit-subtle">({rows.length})</span></h3>
            <div className="tit-add"><select aria-label={t("Workspace tube")} value={addId} disabled={!available.length || !active.detector} onChange={(e) => setAddingFile(e.target.value)}>
              {!available.length && <option value="">{t("No available tubes")}</option>}
              {available.map((file) => <option key={file.id} value={file.id}>{file.name}</option>)}
            </select><button className="gl-mini-btn" disabled={!addId || !active.detector} onClick={() => {
              update({ tubes: [...active.tubes, { fileId: addId, dose: "", replicate: "1", populationId: null, ...EMPTY_GATES }] }); setSelectedFile(addId); setAddingFile("");
            }}>{t("Add tube")}</button></div>
            <p className="gl-hint">{t("Enter a concentration or a dilution such as 1:200. Tubes are ordered by increasing dose.")}</p>
            {rows.length > 0 && <div className="tit-table-wrap"><table><thead><tr>
              {[t("Tube"), t("Dose"), t("Replicate"), t("Stain index"), t("Remove")].map((label) => <th key={label}>{label}</th>)}
            </tr></thead><tbody>
              {rows.map((row) => <tr key={row.tube.fileId} className={selected === row ? "active" : ""}>
                <th scope="row"><button className="tit-row-pick" aria-pressed={selected === row} onClick={() => setSelectedFile(row.tube.fileId)}>{row.name}</button>
                  {!row.source && <small>{row.saved ? t("Last saved measurements") : t("Source or population unavailable")}</small>}</th>
                <td><input aria-label={t("Dose for {file}", { file: row.name })} value={row.tube.dose} onChange={(e) => updateTube(row.tube.fileId, { dose: e.target.value })} /></td>
                <td><input aria-label={t("Replicate for {file}", { file: row.name })} value={row.tube.replicate} onChange={(e) => updateTube(row.tube.fileId, { replicate: e.target.value })} /></td>
                <td>{num(row.statistics?.stainIndex)}</td>
                <td><button className="gl-mini-btn tit-remove" aria-label={t("Remove {file}", { file: row.name })} onClick={() => update({ tubes: active.tubes.filter((tube) => tube.fileId !== row.tube.fileId) })}>×</button></td>
              </tr>)}
            </tbody></table></div>}
            {!conflictsWithDoseUnit(active) && <DosePlot key={active.id} groups={groups} unit={active.unit.trim() || (ratioSeries(active) ? t("Dilution") : "")} selected={selected?.tube.fileId ?? null} chosen={active.chosenDose} onInspect={setSelectedFile} />}
            <div className="tit-choice">
              <label>{t("Chosen dose")} <select value={active.chosenDose ?? ""} onChange={(e) => update({ chosenDose: e.target.value || null })}>
                <option value="">{t("Undecided")}</option>
                {groups.map((g) => <option key={g.value} value={g.label}>{g.label} {active.unit}</option>)}
              </select></label>
              <label>{t("Review note")}<textarea rows={2} value={active.note} onChange={(e) => update({ note: e.target.value })} /></label>
            </div>
          </section>
          <section className="tit-inspector">
            <div className="tit-section-head"><h3>{selected?.name ?? t("Tube distribution")}</h3><span>{t("Original assay · linear values")}</span></div>
            {selected ? <>
              <label className="tit-pop">{t("Population")} <select value={selected.tube.populationId ?? ""} disabled={!selected.file} onChange={(e) => updateTube(selected.tube.fileId, { populationId: e.target.value || null })}>
                <option value="">{t("All events")}</option>
                {selected.tube.populationId && !selected.file?.populations.some((p) => p.id === selected.tube.populationId) && <option value={selected.tube.populationId}>{selected.tube.populationId}</option>}
                {selected.file?.populations.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select></label>
              <TubeHistogram row={selected} scale={scale} onSplit={(value) => updateTube(selected.tube.fileId, { negativeUpper: value, positiveLower: value })} />
              <div className="tit-gates">
                {(["negative", "positive"] as const).map((kind) => <fieldset key={kind} className={'tit-gate ' + kind}><legend>{kind === "negative" ? t("Negative interval") : t("Positive interval")}</legend>
                  {(["Lower", "Upper"] as const).map((side) => {
                    const key = (kind + side) as Bound;
                    return <label key={key}>{side === "Lower" ? t("Lower (inclusive)") : t("Upper (exclusive)")}
                      <input type="number" step="any" aria-label={t(BOUND_LABELS[key])} value={selected.tube[key] ?? ""}
                        onChange={(e) => updateTube(selected.tube.fileId, { [key]: Number.isFinite(e.target.valueAsNumber) ? e.target.valueAsNumber : null })} />
                    </label>;
                  })}
                </fieldset>)}
              </div>
              {rows.length > 1 && <button className="gl-mini-btn" disabled={!validTitrationGates(selected.tube)} onClick={() => {
                const { negativeLower, negativeUpper, positiveLower, positiveUpper } = selected.tube;
                update({ tubes: active.tubes.map((tube) => BOUNDS.every((key) => tube[key] === selected.tube[key]) ? tube
                  : { ...tube, negativeLower, negativeUpper, positiveLower, positiveUpper, reviewed: undefined }) });
              }}>{t("Apply these intervals to all tubes in this series")}</button>}
              <h4>{selected.saved ? t("Last saved measurements") : t("Current measurements")}</h4>
              <dl className="tit-statistics">
                {([
                  [t("Negative events"), selected.statistics?.negativeCount.toLocaleString()], [t("Positive events"), selected.statistics?.positiveCount.toLocaleString()],
                  [t("Negative median"), num(selected.statistics?.negativeMedian)], [t("Positive median"), num(selected.statistics?.positiveMedian)],
                  [t("Negative spread"), num(selected.statistics?.negativeSpread)], [t("Stain index"), num(selected.statistics?.stainIndex)],
                ] as const).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value ?? "—"}</dd></div>)}
                <div><dt>{t("Positive events near detector ceiling")}</dt><dd>{selected.statistics?.saturationFraction == null ? "—" : percentText(selected.statistics.saturationFraction)}</dd></div>
              </dl>
              <p className="gl-hint">{t("Negative spread is half the 84.13th–15.87th percentile interval. Stain index is the difference between the positive and negative medians divided by twice the negative spread.")}</p>
              {rowFindings(selected, t).filter((line) => line !== t("Last saved measurements")).map((line) => <p key={line} className="tit-warning">{line}</p>)}
            </> : <p className="gl-hint">{t("Add a tube to inspect its distribution.")}</p>}
          </section>
        </div>
      </>}
      </div>
      <div className="gl-modal-actions tit-actions">
        <span role="status">{invalid ? (invalid.id === active?.id ? invalid.reason : invalid.name + " · " + invalid.reason) : saved ? t("Review saved to workspace.") : ""}</span>
        {active && onQc && <button className="gl-btn-ghost" disabled={saveDisabled || !rows.some((row) => row.source && validTitrationGates(row.tube))}
          onClick={() => { save(); onQc(active); }}>{t("Save and view control QC")}</button>}
        <button className="gl-btn-ghost" onClick={onClose}>{dirty ? t("Cancel") : t("Close")}</button>
        <button className="gl-btn" disabled={saveDisabled} onClick={save}>{t("Save review")}</button>
      </div>
    </div>
  </div>;
}
