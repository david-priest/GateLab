import { useMemo, useState } from "react";
import { figurePopulationApplies, resolveFigurePopulation, type FigureSample, type FigureSpec } from "../engine/figure";
import type { StoredHierarchy } from "../engine/hierarchies";
import { namedChannel, namedFmo, namedUnstained } from "../compensationControls/controlNames";
import type { TitrationSeries } from "../compensationControls/titration";
import { NO_TITLE } from "../engine/layoutTitle";
import { ChannelChecklist } from "./ChannelChecklist";
import { useI18n } from "./i18n";
import type { PanelPage } from "./layoutHandoff/everyPage";

interface Props {
  files: readonly FigureSample[];
  figure: Pick<FigureSpec, "sampleIds" | "populations" | "populationOverrides" | "samplePopulations">;
  trees: Record<string, StoredHierarchy>;
  reviewedSeries?: TitrationSeries;
  onCreate: (sheets: PanelPage[]) => void;
}

function timeChannels(file: FigureSample) {
  return file.sample.channels.filter((c) => /^time$/i.test(c.pnn) || /^time$/i.test(c.key));
}

/** Layout resolves these file-local population ids against the live workspace when it draws. */
function reviewRows(file: FigureSample, { figure, trees, reviewedSeries }: Props) {
  const tree = trees[file.hierarchyId];
  if (!tree?.root_population_id) throw new Error("No gating tree for " + file.name);
  const ids = new Set([tree.root_population_id]);
  if (reviewedSeries) {
    const tube = reviewedSeries.tubes.find((row) => row.fileId === file.id);
    if (!tube || (tube.populationId && !tree.populations[tube.populationId])) {
      throw new Error("Missing reviewed population · " + file.name);
    }
    if (tube.populationId) ids.add(tube.populationId);
    return Array.from(ids, (id) => ({ id, label: tree.populations[id].name }));
  }
  const localSelection = figure.samplePopulations && new Set(
    (figure.samplePopulations[file.id] ?? []).map((ref) => resolveFigurePopulation(ref, tree, trees).id),
  );
  for (const ref of figure.populations) {
    if (!figurePopulationApplies(ref, file, trees, figure)) continue;
    const override = figure.populationOverrides?.[file.id]?.[JSON.stringify([ref.hierarchyId, ref.populationId])];
    const match = resolveFigurePopulation(override ? { ...ref, hierarchyId: tree.id, populationId: override } : ref, tree, trees);
    if (!match.id || match.status === "changed") throw new Error(file.name + " · " + ref.label + " (" + match.status + ")");
    if (!localSelection || localSelection.has(match.id)) ids.add(match.id);
  }
  return Array.from(ids, (id) => ({ id, label: tree.populations[id].name }));
}

export function QcSheets(props: Props) {
  const { files, figure, onCreate, reviewedSeries } = props;
  const { t } = useI18n();
  const [mode, setMode] = useState<"time" | "control">("time");
  const [sources, setSources] = useState<Record<string, string>>({});
  const [markers, setMarkers] = useState<string[]>([]);
  const [error, setError] = useState("");
  const controlMode = !!reviewedSeries || mode === "control";
  // Control tubes can give the same detector different marker labels. Match them by $PnN.
  const axes = useMemo(() => files.map((file) => {
    const channels = controlMode
      ? file.sample.channels.filter((_, index) => file.sample.isFluorChannel(index))
      : file.sample.channels;
    const byId = new Map<string, typeof channels[number] | null>();
    for (const c of channels) {
      const id = controlMode ? c.pnn : c.key;
      byId.set(id, byId.has(id) ? null : c);
    }
    const fileNames = { fileName: file.fileName ?? file.name, labels: ["TUBE NAME", "$SMNO", "$SRC"].map((k) => file.sample.fcs.keywords[k] ?? "") };
    const suggested = controlMode && !namedFmo(fileNames) && !namedUnstained(fileNames)
      ? namedChannel(fileNames, channels).channel : null;
    return { file, byId, suggested };
  }), [files, controlMode]);
  const options = [...(axes[0]?.byId ?? [])].flatMap(([key, c]) =>
    c && key !== reviewedSeries?.detector && !/^time$/i.test(c.pnn) && !/^time$/i.test(c.key) && axes.every((a) => a.byId.get(key))
      ? [{ key, label: controlMode ? key : files[0].sample.labelForKey(c.key) }] : []);
  const receivers = options.filter((c) => markers.includes(c.key));
  const missingTime = !controlMode && files.find((f) => timeChannels(f).length !== 1);
  const missingFile = files.length !== figure.sampleIds.length;
  const xFor = ({ file, suggested, byId }: typeof axes[number]) => controlMode
    ? byId.get(reviewedSeries?.detector ?? sources[file.id] ?? suggested ?? "")?.key : timeChannels(file)[0]?.key;
  const missingSource = axes.find((axis) => !xFor(axis));
  const missingReceiver = axes.find((axis) => !receivers.some((r) => axis.byId.get(r.key)?.key !== xFor(axis)));
  const ready = files.length > 0 && !missingFile && !missingTime && !missingSource && !missingReceiver;

  function createSheets() {
    if (!ready) return;
    try {
      const sheets = axes.map((axis): PanelPage => {
        const { file, byId } = axis;
        const x = xFor(axis)!;
        const ys = receivers.map((c) => byId.get(c.key)!).filter((c) => c.key !== x);
        const rows = reviewRows(file, props);
        const panels = rows.flatMap((row, i) => ys.map((y, j) => ({
          recipe: { kind: "biplot" as const, sampleId: file.id, populationId: row.id, xChannel: x, yChannel: y.key,
            displayMode: "pseudocolor" as const, title: NO_TITLE },
          cell: { row: i, column: j },
        })));
        const tube = reviewedSeries?.tubes.find((item) => item.fileId === file.id);
        const label = controlMode
            ? t("{file} · {channel} control", { file: file.name, channel: file.sample.labelForKey(x) })
            : t("{file} · acquisition over time", { file: file.name });
        return {
          label: tube && reviewedSeries ? [label, [tube.dose, reviewedSeries.unit].filter(Boolean).join(" "), tube.replicate].filter(Boolean).join(" · ") : label,
          recipes: panels.map((p) => p.recipe), cells: panels.map((p) => p.cell),
          headings: { rows: rows.map((r) => ({ text: r.label, template: "{population}" })),
            columns: ys.map((y) => ({ text: file.sample.labelForKey(y.key) })) },
        };
      });
      setError("");
      onCreate(sheets);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return <fieldset className="gl-figure-fields">
    {!reviewedSeries && <label>{t("Sheet type")} <select value={mode} onChange={(e) => { setMode(e.target.value as typeof mode); setMarkers([]); setError(""); }}>
      <option value="time">{t("Acquisition over time")}</option>
      <option value="control">{t("Single-stained controls")}</option>
    </select></label>}
    <p>{t("Each selected file gets a Layout sheet. Rows show all events and the selected populations. Columns show the Y channels.")}</p>
    {reviewedSeries && <p>{t("Primary channel")} · {reviewedSeries.detector}</p>}
    {controlMode && !reviewedSeries && axes.map(({ file, suggested, byId }) => <label key={file.id}>
      {t("Primary channel")} · {file.name}
      <select value={sources[file.id] ?? suggested ?? ""} onChange={(e) => setSources({ ...sources, [file.id]: e.target.value })}>
        <option value="">{t("Choose channel…")}</option>
        {[...byId].map(([id, c]) => c && <option key={id} value={id}>{id} · {file.sample.labelForKey(c.key)}</option>)}
      </select>
    </label>)}
    {missingTime && <p role="status">{t("A unique Time channel is required")} · {missingTime.name}</p>}
    {missingFile && <p role="status">{t("A selected file is missing.")}</p>}
    <ChannelChecklist label={t("Y channels shared by the selected files")} options={options} checked={markers}
      onToggle={(keys, on) => setMarkers((prev) => on ? [...new Set([...prev, ...keys])] : prev.filter((k) => !keys.includes(k)))} />
    {controlMode && missingSource && <p role="status">{t(reviewedSeries ? "The reviewed detector is unavailable" : "Choose a primary channel")} · {missingSource.file.name}</p>}
    {!missingSource && missingReceiver && <p role="status">{t("Select a Y channel different from the X channel")} · {missingReceiver.file.name}</p>}
    {error && <p role="alert">{error}</p>}
    <button type="button" disabled={!ready} onClick={createSheets}>{t("Create QC sheets in Layout")}</button>
  </fieldset>;
}
