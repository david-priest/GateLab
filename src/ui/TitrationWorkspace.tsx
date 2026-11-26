import { useMemo, useState } from "react";
import { measureTube, readTitrationSeries, type TitrationSeries } from "../compensationControls/titration";
import { figureHierarchies, prepareFigureSource, type FigureSample, type FigureSource } from "../engine/figure";
import type { CoreState } from "../store";
import { QcSheets } from "./QcSheets";
import { TitrationReview, type TitrationReviewFile } from "./TitrationReview";
import { useI18n } from "./i18n";
import type { PanelPage } from "./layoutHandoff/everyPage";
import { ModalEscape } from "./useModalEscape";

interface Props {
  samples: readonly FigureSample[];
  state: CoreState;
  record: unknown;
  onSave: (value: { version: 1; series: TitrationSeries[] }) => void;
  onPages?: (pages: PanelPage[]) => void;
  onClose: () => void;
}

/** Only mounted while a review is open. Resolve a file's gating masks on the first named gate. */
export function TitrationWorkspace({ samples, state, record, onSave, onPages, onClose }: Props) {
  const { t } = useI18n();
  const [qc, setQc] = useState<TitrationSeries | null>(null);
  const trees = useMemo(() => figureHierarchies(state), [state]);
  const flow = useMemo(() => samples.filter((f) => f.sample.instrument === "flow" && !f.sample.hostedAssayId), [samples]);
  const files = useMemo(() => flow.map((file): TitrationReviewFile => {
    const { sample } = file;
    const tree = trees[file.hierarchyId];
    const detectorIndices = new Map<string, number | null>();
    sample.channels.forEach((c, i) => {
      if (sample.isFluorChannel(i) && !sample.isDerivedChannel(i)) {
        detectorIndices.set(c.pnn, detectorIndices.has(c.pnn) ? null : i);
      }
    });
    const detectors = [...detectorIndices].flatMap(([id, i]) => i === null ? [] :
      [{ id, label: sample.labelForKey(sample.channels[i].key), range: sample.channels[i].range }]);
    let gating: FigureSource["gating"] | undefined;
    return {
      id: file.id, name: file.fileName || file.name, detectors,
      populations: Object.values(tree?.populations ?? {}).filter((p) => p.population_id !== tree?.root_population_id)
        .map((p) => ({ id: p.population_id, name: p.name })),
      values: (detector) => {
        const i = detectorIndices.get(detector);
        return i == null ? null : sample.originalColumnData(i);
      },
      mask: (id) => {
        if (!id || !tree?.populations[id]) return null;
        gating ??= prepareFigureSource(file, tree, state).gating;
        const mask = gating.masks[id];
        return mask?.length === sample.fcs.nEvents ? mask : null;
      },
    };
  }), [flow, trees, state]);
  const saved = useMemo(() => {
    if (record === undefined) return [];
    if (!record || typeof record !== "object" || !("version" in record) || record.version !== 1
        || !("series" in record) || !Array.isArray(record.series)) return null;
    return readTitrationSeries(record.series);
  }, [record]);

  function save(next: TitrationSeries[], reviewedId?: string) {
    const series = next.map((s) => {
      const previous = saved?.find((item) => item.id === s.id);
      if (s.id !== reviewedId && previous && JSON.stringify(previous) === JSON.stringify(s)) return previous;
      return { ...s, tubes: s.tubes.map((tube) => {
        const file = files.find((f) => f.id === tube.fileId);
        const detector = file?.detectors.find((d) => d.id === s.detector);
        const values = file?.values(s.detector);
        const mask = file?.mask(tube.populationId) ?? null;
        if (!file || !detector || !values || (tube.populationId !== null && !mask)) return tube;
        return { ...tube, reviewed: {
          detector: detector.id, populationId: tube.populationId, fileName: file.name,
          assay: "original" as const, eventCount: values.length,
          statistics: measureTube(values, mask, tube, detector.range),
        } };
      }) };
    });
    onSave({ version: 1, series });
  }

  if (saved === null) return <div className="gl-modal-backdrop"><section className="gl-modal" role="dialog" aria-modal="true" aria-label={t("Titration review")}>
    <ModalEscape onClose={onClose} /><p>{t("This workspace contains an unsupported titration review format.")}</p>
    <button type="button" autoFocus onClick={onClose}>{t("Close")}</button>
  </section></div>;
  return <>
    <TitrationReview files={files} series={saved} onSave={save} onClose={onClose} onQc={onPages ? setQc : undefined} />
    {qc && onPages && <TitrationQc key={qc.id} series={qc} files={flow} trees={trees} onClose={() => setQc(null)}
      onCreate={(pages) => { onPages(pages); onClose(); }} />}
  </>;
}

function TitrationQc({ series, files, trees, onClose, onCreate }: {
  series: TitrationSeries; files: readonly FigureSample[]; trees: ReturnType<typeof figureHierarchies>;
  onClose: () => void; onCreate: (pages: PanelPage[]) => void;
}) {
  const { t } = useI18n();
  const ids = series.tubes.map((tube) => tube.fileId);
  return <dialog className="gl-modal gl-titration-qc" ref={(el) => { if (el && !el.open) el.showModal(); }}
    onCancel={(e) => { e.preventDefault(); onClose(); }} aria-label={t("Control QC sheets")}>
    <ModalEscape onClose={onClose} />
    <h2>{t("Control QC sheets")}</h2>
    <p>{t("These plots use the workspace display assay and each tube’s reviewed cleanup population.")}</p>
    <QcSheets files={files.filter((file) => ids.includes(file.id))} figure={{ sampleIds: ids, populations: [] }}
      trees={trees} reviewedSeries={series} onCreate={onCreate} />
    <button type="button" autoFocus onClick={onClose}>{t("Back to titration")}</button>
  </dialog>;
}
