import { useEffect, useRef, useState } from "react";
import type { CoreState } from "../store";
import {
  figureHierarchies,
  prepareFigureSource,
  type FigureSample,
  type FigureSource,
} from "../engine/figure";

/** Mounted only in Illustration. One file per task, with cancellation on tab exit or data changes. */
export function useFigureSources(
  samples: readonly FigureSample[],
  sampleIds: readonly string[],
  state: CoreState,
  dataRevision: string | number,
) {
  const cache = useRef(
    new Map<string, { signature: string; source: FigureSource }>(),
  );
  const [result, setResult] = useState<{
    key: string;
    sources: FigureSource[];
    pending: number;
    error: string | null;
  }>({ key: "", sources: [], pending: sampleIds.length, error: null });
  const trees = figureHierarchies(state);
  // Selection-only gating changes do not invalidate memberships. Geometry, tree, assay and file
  // revisions do. JSON also makes an active↔parked hierarchy switch identity-neutral.
  const key = JSON.stringify([
    dataRevision,
    sampleIds.map((id) => {
      const sample = samples.find((s) => s.id === id),
        tree = sample && trees[sample.hierarchyId];
      return [
        id,
        sample?.name,
        sample?.hierarchyId,
        sample?.sample.dataRevision,
        tree?.gates,
        tree?.populations,
        tree?.root_population_id,
        tree?.source_hierarchy_id,
        tree?.source_gate_ids,
        tree?.source_population_ids,
      ];
    }),
  ]);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const sources: FigureSource[] = [];
    let index = 0;
    setResult({ key, sources: [], pending: sampleIds.length, error: null });
    function next() {
      if (cancelled) return;
      try {
        const id = sampleIds[index++];
        const sample = samples.find((s) => s.id === id);
        const tree = sample && trees[sample.hierarchyId];
        if (sample && tree) {
          const signature = JSON.stringify([
            sample.sample.dataRevision,
            tree.gates,
            tree.populations,
            tree.root_population_id,
          ]);
          const hit = cache.current.get(id);
          const source =
            hit?.signature === signature && hit.source.sample === sample.sample
              ? { ...hit.source, ...sample, tree }
              : prepareFigureSource(sample, tree, state);
          cache.current.set(id, { signature, source });
          sources.push(source);
        }
        setResult({
          key,
          sources: [...sources],
          pending: Math.max(0, sampleIds.length - index),
          error: null,
        });
        if (index < sampleIds.length) timer = setTimeout(next, 0);
        else
          for (const id of cache.current.keys())
            if (!sampleIds.includes(id)) cache.current.delete(id);
      } catch (error) {
        setResult({
          key,
          sources: [],
          pending: 0,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (sampleIds.length) timer = setTimeout(next, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // key deliberately excludes the active gating population and presentation controls.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return {
    ...result,
    pending: result.key === key ? result.pending : sampleIds.length,
    current: result.key === key,
  };
}
