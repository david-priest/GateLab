import { useEffect, useMemo, useRef, useState } from "react";
import { figureDisplaySample, figureHierarchies, resolveFigurePopulation, type FigureSample, type FigureSource } from "../engine/figure";
import { correspondingHierarchyId, type StoredHierarchy } from "../engine/hierarchies";
import type { Gate, GateRef, Population, TransformSpec } from "../engine/models";
import { buildCombinedSamplePointCloud } from "../engine/multiSamplePlot";
import { poolCompatibility } from "../engine/pooledPlot";
import type { Sample } from "../engine/sample";
import { buildPlotGates } from "../plots/gatePayload";
import { loadMiniPlots } from "../plots/loadPlots";
import type { CoreState } from "../store";
import { useI18n } from "./i18n";
import { useFigureSources } from "./useFigureSources";
import { ModalEscape } from "./useModalEscape";

const FILES_PER_PAGE = 6;
const POINTS_PER_LAYER = 2500;
const ANCESTOR_COLOUR = "#84939f";
const TARGET_COLOUR = "#d95f02";

interface Plane {
  ancestor: Population;
  gate: Gate | null;
  ref?: GateRef;
  x: string;
  y: string;
}

function planesOnPath(state: CoreState, target: Population, x: string, y: string): Plane[] {
  const planes: Plane[] = [];
  const seen = new Set<string>();
  let child = target;
  while (child.parent_id && !seen.has(child.population_id)) {
    seen.add(child.population_id);
    const ancestor = state.populations[child.parent_id];
    if (!ancestor) break;
    if (!child.gate_refs.length) planes.push({ ancestor, gate: null, x, y });
    for (const ref of child.gate_refs) {
      const gate = state.gates[ref.gate_id];
      if (gate) planes.push({ ancestor, ref, gate, x: gate.x_channel, y: gate.y_channel });
    }
    child = ancestor;
  }
  return planes;
}

function PopulationPanel({ source, trees, live, target, plane, frame }: {
  source: FigureSource;
  trees: Record<string, StoredHierarchy>;
  live: StoredHierarchy;
  target: Population;
  plane: Plane;
  frame: { x: [number, number]; y: [number, number]; reference: Sample };
}) {
  const { t } = useI18n();
  const host = useRef<HTMLDivElement>(null);
  const panel = useMemo(() => {
    const resolve = (pop: Population) => resolveFigurePopulation(
      { hierarchyId: live.id, populationId: pop.population_id, label: pop.name }, source.tree, trees,
    );
    const to = resolve(target);
    const from = resolve(plane.ancestor);
    if (!to.id || !from.id || to.status === "changed" || from.status === "changed") return null;
    if (poolCompatibility(frame.reference, source.sample, plane.x, plane.y)) return null;
    // The assay and panel can match while, for example, the two files' logicle widths differ.
    // Project those axes for drawing only; membership and the gate's raw boundary remain the file's own.
    const project: Record<string, TransformSpec> = {};
    for (const channel of new Set([plane.x, plane.y])) {
      const spec = frame.reference.transformSpec(channel);
      if (JSON.stringify(source.sample.transformSpec(channel)) !== JSON.stringify(spec)) project[channel] = spec;
    }
    const sample = Object.keys(project).length ? figureDisplaySample(source.sample, project) : source.sample;
    const xIndex = sample.index(plane.x);
    const yIndex = sample.index(plane.y);
    const xi = frame.reference.index(plane.x);
    const yi = frame.reference.index(plane.y);
    if (xIndex === undefined || yIndex === undefined || xi === undefined || yi === undefined) return null;
    const foreground = source.gating.masks[to.id];
    const background = source.gating.masks[from.id];
    if (!foreground || !background) return null;
    const cloud = (mask: Uint8Array) => buildCombinedSamplePointCloud([{ id: source.id, name: source.name, sample, xIndex, yIndex, mask }], POINTS_PER_LAYER);
    const parent = cloud(background);
    const selected = cloud(foreground);
    const ownGate = plane.gate && correspondingHierarchyId(live, plane.gate.gate_id, source.tree, trees, "gate");
    if (plane.gate && !ownGate) return null;
    const gates = ownGate ? buildPlotGates(sample, source.tree.gates, [ownGate], {}, plane.x, plane.y, null, [frame.x, frame.y]) : [];
    const xTicks = frame.reference.channelTicks(xi, frame.x);
    const yTicks = frame.reference.channelTicks(yi, frame.y);
    const histogram = plane.x === plane.y;
    return {
      ancestorCount: parent.eventCount, targetCount: selected.eventCount,
      config: {
        x: parent.x, y: parent.y, x_back: selected.x, y_back: selected.y,
        x_range: frame.x, y_range: frame.y,
        x_label: frame.reference.labelForKey(plane.x), y_label: frame.reference.labelForKey(plane.y),
        x_logicle_ticks: xTicks, x_is_logicle: !!xTicks, y_logicle_ticks: yTicks, y_is_logicle: !!yTicks,
        gates, gate_style: { pub_style: true, label_format: "none" },
        display_mode: "scatter", plot_size: 215, point_size: 1.5, point_alpha: 0.58,
        pop_color: ANCESTOR_COLOUR, back_color: TARGET_COLOUR,
        ...(histogram ? {
          x: selected.eventCount ? selected.x : parent.x, y: [], x_back: [], y_back: [], gates: [],
          pop_color: selected.eventCount ? TARGET_COLOUR : ANCESTOR_COLOUR,
          overlay_traces: selected.eventCount ? [{ x: parent.x, color: ANCESTOR_COLOUR }] : [],
          y_label: t("Density relative to peak"),
        } : {}),
      },
    };
  }, [source, trees, live, target, plane, frame, t]);
  useEffect(() => {
    if (host.current && panel?.ancestorCount) loadMiniPlots().renderMiniPlot(host.current, panel.config);
  }, [panel]);
  if (!panel) return <p>{t("Population or gate plane unavailable in this tree.")}</p>;
  return <>
    {panel.ancestorCount > 0
      ? <div ref={host} role="img" aria-label={t("{target} over {ancestor}", { target: target.name, ancestor: plane.ancestor.name })} />
      : <p>{t("No events in {name}.", { name: plane.ancestor.name })}</p>}
    <div>{t("{target} of {ancestor} events", { target: panel.targetCount.toLocaleString(), ancestor: panel.ancestorCount.toLocaleString() })}
      {panel.ancestorCount > 0 && ` (${(100 * panel.targetCount / panel.ancestorCount).toLocaleString(undefined, { maximumFractionDigits: 2 })}%)`}
    </div>
  </>;
}

interface Props {
  state: CoreState;
  population: Population;
  files: readonly FigureSample[];
  checked: readonly string[];
  reference: Sample;
  referenceName: string;
  currentX: string;
  currentY: string;
  rangeOf: (channel: string) => [number, number] | undefined;
  underActiveTree: (id: string) => boolean;
  panelKeyOf: (sample: Sample) => string;
  revision: string;
  onClose: () => void;
}

/** This dialog is mounted only on request. Preparing a page reuses the Strategy tab's per-file masks. */
export function PopulationReview({ state, population, files, checked, reference, referenceName, currentX, currentY, rangeOf, underActiveTree, panelKeyOf, revision, onClose }: Props) {
  const { t } = useI18n();
  const [which, setWhich] = useState(0);
  const [page, setPage] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal?.();
    return () => element?.close?.();
  }, []);
  const planes = useMemo(() => planesOnPath(state, population, currentX, currentY), [state, population, currentX, currentY]);
  const plane = planes[which] ?? planes[0];
  const trees = useMemo(() => figureHierarchies(state), [state]);
  const live = trees[state.active_hierarchy_id];
  const pageCount = Math.max(1, Math.ceil(checked.length / FILES_PER_PAGE));
  const currentPage = Math.min(page, pageCount - 1);
  const pageFiles = useMemo(() => {
    const panel = panelKeyOf(reference);
    const ids = new Set(checked.slice(currentPage * FILES_PER_PAGE, (currentPage + 1) * FILES_PER_PAGE));
    return files.filter(file => ids.has(file.id)).map(file => {
      const reason = !underActiveTree(file.id) ? "Outside the active tree."
        : file.sample.workspaceScaleContextKey !== reference.workspaceScaleContextKey ? "Different assay layer."
        : panelKeyOf(file.sample) !== panel ? "Different panel." : null;
      return { file, reason };
    });
  }, [checked, currentPage, files, reference, underActiveTree, panelKeyOf]);
  const frame = useMemo(() => {
    if (!plane) return null;
    const x = rangeOf(plane.x);
    const y = plane.x === plane.y ? x : rangeOf(plane.y);
    return x && y ? { x, y, reference } : null;
  }, [plane, rangeOf, reference]);
  const readyIds = useMemo(() => frame ? pageFiles.filter(row => !row.reason).map(row => row.file.id) : [], [frame, pageFiles]);
  const prepared = useFigureSources(files, readyIds, state, revision);
  return <dialog ref={dialog} className="gl-modal-backdrop gl-review-backdrop" aria-label={t("Population review")} onClick={onClose}
    onKeyDown={e => { if (e.key !== "Escape") e.stopPropagation(); }}>
    <ModalEscape onClose={onClose} />
    <section className="gl-modal gl-population-review" onClick={e => e.stopPropagation()}>
      <header><h2>{t("Population review")} · {population.name}</h2>
        <button type="button" className="gl-mini-btn" onClick={onClose}>{t("Close")}</button>
      </header>
      {plane && checked.length > 0 && <>
        <label className="gl-modal-field">{t("Ancestor and gate plane")}
          <select value={planes.indexOf(plane)} onChange={e => setWhich(Number(e.target.value))}>
            {planes.map((item, i) => <option key={i} value={i}>{item.ancestor.name} · {item.ref && !item.ref.include && "NOT "}{item.gate?.name ?? t("Current axes")}{item.ref?.quadrant && ` Q${item.ref.quadrant}`} ({reference.labelForKey(item.x)}{item.y !== item.x && ` × ${reference.labelForKey(item.y)}`})</option>)}
          </select>
        </label>
        <div className="gl-review-legend">
          <span><i style={{ background: TARGET_COLOUR }} />{population.name}</span>
          <span><i style={{ background: ANCESTOR_COLOUR }} />{plane.ancestor.name}</span>
        </div>
        <p className="gl-modal-note">{t("Shared axes from {file}. Each layer shows up to {cap} events. Counts include every event.", { file: referenceName, cap: POINTS_PER_LAYER.toLocaleString() })}</p>
      </>}
      {!checked.length ? <p>{t("Select files in the file list to review them here.")}</p>
        : !plane ? <p>{t("Choose a population with a parent to review its ancestry.")}</p>
        : <div className="gl-review-files">
          {pageFiles.map(({ file, reason }) => {
            const source = prepared.current && prepared.sources.find(entry => entry.id === file.id);
            return <article key={file.id}>
              <h3>{file.fileName || file.name}</h3>
              {reason ? <p>{t(reason)}</p> : !frame ? <p>{t("These axes are unavailable in the viewed file.")}</p>
                : source ? <PopulationPanel source={source} trees={trees} live={live} target={population} plane={plane} frame={frame} />
                : <p>{prepared.current && prepared.error ? prepared.error : prepared.pending ? t("Preparing population masks…") : t("Population or gate plane unavailable in this tree.")}</p>}
            </article>;
          })}
        </div>}
      {pageCount > 1 && <div className="gl-review-pager">
        <button type="button" className="gl-mini-btn" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>{t("Previous")}</button>
        <span>{t("Page {page} of {total}", { page: currentPage + 1, total: pageCount })}</span>
        <button type="button" className="gl-mini-btn" disabled={currentPage + 1 === pageCount} onClick={() => setPage(currentPage + 1)}>{t("Next")}</button>
      </div>}
    </section>
  </dialog>;
}
