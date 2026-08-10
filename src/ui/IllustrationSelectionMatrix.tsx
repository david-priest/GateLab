import { useEffect, useMemo, useRef, useState } from "react";
import type { IllustrationPopulationSelection } from "../engine/illustration";
import { useI18n } from "./i18n";

export interface IllustrationMatrixSample {
  id: string;
  name: string;
  eventCount: Readonly<Record<string, number | null>>;
}

export interface IllustrationMatrixPopulation {
  id: string;
  name: string;
  depth: number;
}

interface Props {
  samples: readonly IllustrationMatrixSample[];
  populations: readonly IllustrationMatrixPopulation[];
  value: IllustrationPopulationSelection;
  onChange: (value: Record<string, string[]>) => void;
  populationColor?: (populationId: string) => string;
  onPopulationColorChange?: (populationId: string, color: string) => void;
}

function selectedSet(
  value: IllustrationPopulationSelection,
  sampleId: string,
): Set<string> {
  return new Set(value[sampleId] ?? []);
}

function orderedSelection(
  selected: ReadonlySet<string>,
  populations: readonly IllustrationMatrixPopulation[],
): string[] {
  return populations.flatMap(({ id }) => selected.has(id) ? [id] : []);
}

function selectionState(selected: number, total: number): "none" | "some" | "all" {
  if (selected <= 0 || total <= 0) return "none";
  return selected >= total ? "all" : "some";
}

function MatrixBulkToggle({
  state,
  label,
  onToggle,
}: Readonly<{
  state: "none" | "some" | "all";
  label: string;
  onToggle: () => void;
}>) {
  return (
    <button
      type="button"
      className={`gl-illust-matrix-toggle is-${state}`}
      role="checkbox"
      aria-checked={state === "some" ? "mixed" : state === "all"}
      aria-label={label}
      title={label}
      onClick={onToggle}
    >
      {state === "all" ? "✓" : state === "some" ? "−" : ""}
    </button>
  );
}

/**
 * Sparse Illustration selector. Pointer-drag paints cells with one value; keyboard users can
 * toggle a focused cell with Space/Enter. The component stores only sample/population IDs.
 */
export function IllustrationSelectionMatrix({
  samples,
  populations,
  value,
  onChange,
  populationColor,
  onPopulationColorChange,
}: Readonly<Props>) {
  const { t } = useI18n();
  const [minimumEvents, setMinimumEvents] = useState(1);
  const valueRef = useRef<IllustrationPopulationSelection>(value);
  valueRef.current = value;
  const paintRef = useRef<{ active: boolean; selected: boolean }>({
    active: false,
    selected: false,
  });

  useEffect(() => {
    const stop = () => {
      paintRef.current.active = false;
    };
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, []);

  const selectedCount = useMemo(
    () => samples.reduce((total, sample) => {
      const selected = selectedSet(value, sample.id);
      return total + populations.reduce(
        (sampleTotal, population) => sampleTotal + Number(selected.has(population.id)),
        0,
      );
    }, 0),
    [populations, samples, value],
  );
  const totalCount = samples.length * populations.length;

  const replaceSample = (sampleId: string, nextSelected: ReadonlySet<string>) => {
    const next = {
      ...Object.fromEntries(
        Object.entries(valueRef.current).map(([id, popIds]) => [id, [...popIds]]),
      ),
      [sampleId]: orderedSelection(nextSelected, populations),
    };
    valueRef.current = next;
    onChange(next);
  };

  const setCell = (sampleId: string, popId: string, selected: boolean) => {
    const next = selectedSet(valueRef.current, sampleId);
    if (selected) next.add(popId);
    else next.delete(popId);
    replaceSample(sampleId, next);
  };

  const setAllMatching = (
    predicate: (sample: IllustrationMatrixSample, population: IllustrationMatrixPopulation) => boolean,
  ) => {
    const next: Record<string, string[]> = {
      ...Object.fromEntries(
        Object.entries(valueRef.current).map(([id, popIds]) => [id, [...popIds]]),
      ),
    };
    for (const sample of samples) {
      next[sample.id] = populations.flatMap((population) =>
        predicate(sample, population) ? [population.id] : []);
    }
    valueRef.current = next;
    onChange(next);
  };

  return (
    <section className="gl-illust-matrix-section" aria-label={t("Population × FCS selection")}>
      <div className="gl-picker-head">
        <span className="gl-stats-opt-label">{t("Population × FCS selection")}</span>
        <span className="gl-picker-summary">
          {t("{selected} of {total} combinations selected", {
            selected: selectedCount,
            total: totalCount,
          })}
        </span>
        <div className="gl-picker-actions">
          <button
            type="button"
            className="gl-mini-btn"
            onClick={() => setAllMatching(() => true)}
          >
            {t("All")}
          </button>
          <button
            type="button"
            className="gl-mini-btn"
            onClick={() => setAllMatching(() => false)}
          >
            {t("None")}
          </button>
          <button
            type="button"
            className="gl-mini-btn"
            onClick={() => setAllMatching(
              (sample, population) => (sample.eventCount[population.id] ?? 0) > 0,
            )}
          >
            {t("Non-empty")}
          </button>
          <label className="gl-field-inline gl-illust-matrix-minimum">
            {t("Select ≥")}
            <input
              type="number"
              min={0}
              step={1}
              value={minimumEvents}
              aria-label={t("Minimum population events")}
              onChange={(event) =>
                setMinimumEvents(Math.max(0, Math.round(Number(event.target.value)) || 0))}
            />
            {t("events")}
          </label>
          <button
            type="button"
            className="gl-mini-btn"
            onClick={() => setAllMatching(
              (sample, population) =>
                (sample.eventCount[population.id] ?? 0) >= minimumEvents,
            )}
          >
            {t("Apply")}
          </button>
        </div>
      </div>

      {samples.length === 0 || populations.length === 0 ? (
        <div className="gl-hint">{t("Select at least one FCS file and one population.")}</div>
      ) : (
        <div className="gl-illust-matrix-scroll">
          <table className="gl-illust-matrix">
            <thead>
              <tr>
                <th className="gl-illust-matrix-corner">
                  <span>{t("Population")}</span>
                </th>
                {samples.map((sample) => {
                  const selected = selectedSet(value, sample.id);
                  const state = selectionState(
                    populations.reduce(
                      (count, population) => count + Number(selected.has(population.id)),
                      0,
                    ),
                    populations.length,
                  );
                  return (
                    <th key={sample.id} title={sample.name}>
                      <div className="gl-illust-matrix-column-head">
                        <MatrixBulkToggle
                          state={state}
                          label={t("Toggle all populations for {name}", { name: sample.name })}
                          onToggle={() => {
                            replaceSample(
                              sample.id,
                              state === "all"
                                ? new Set()
                                : new Set(populations.map(({ id }) => id)),
                            );
                          }}
                        />
                        <span>{sample.name}</span>
                      </div>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {populations.map((population) => {
                const selectedInRow = samples.reduce(
                  (count, sample) =>
                    count + Number(selectedSet(value, sample.id).has(population.id)),
                  0,
                );
                const rowState = selectionState(selectedInRow, samples.length);
                return (
                  <tr key={population.id}>
                    <th title={population.name}>
                      <div
                        className="gl-illust-matrix-row-head"
                        style={{ paddingLeft: population.depth * 10 }}
                      >
                        <MatrixBulkToggle
                          state={rowState}
                          label={t("Toggle {name} for all FCS files", { name: population.name })}
                          onToggle={() => {
                            const next = Object.fromEntries(
                              Object.entries(valueRef.current)
                                .map(([id, popIds]) => [id, [...popIds]]),
                            ) as Record<string, string[]>;
                            for (const sample of samples) {
                              const selected = selectedSet(valueRef.current, sample.id);
                              if (rowState === "all") selected.delete(population.id);
                              else selected.add(population.id);
                              next[sample.id] = orderedSelection(selected, populations);
                            }
                            valueRef.current = next;
                            onChange(next);
                          }}
                        />
                        <span>{population.name}</span>
                        {populationColor && onPopulationColorChange ? (
                          <input
                            type="color"
                            className="gl-pop-color"
                            title={t("Population colour")}
                            value={populationColor(population.id)}
                            onPointerDown={(event) => event.stopPropagation()}
                            onChange={(event) =>
                              onPopulationColorChange(population.id, event.target.value)}
                          />
                        ) : null}
                      </div>
                    </th>
                    {samples.map((sample) => {
                      const checked = selectedSet(value, sample.id).has(population.id);
                      const count = sample.eventCount[population.id];
                      const countLabel = count == null
                        ? t("not available")
                        : t("{count} events", { count: count.toLocaleString() });
                      const label = `${sample.name} · ${population.name} · ${countLabel}`;
                      return (
                        <td key={sample.id} className={count === 0 ? "is-empty" : ""}>
                          <button
                            type="button"
                            className={`gl-illust-matrix-cell${checked ? " is-selected" : ""}`}
                            role="checkbox"
                            aria-checked={checked}
                            aria-label={label}
                            title={label}
                            onPointerDown={(event) => {
                              if (event.button !== 0) return;
                              event.preventDefault();
                              const next = !checked;
                              paintRef.current = { active: true, selected: next };
                              setCell(sample.id, population.id, next);
                            }}
                            onPointerEnter={() => {
                              if (paintRef.current.active) {
                                setCell(
                                  sample.id,
                                  population.id,
                                  paintRef.current.selected,
                                );
                              }
                            }}
                            onKeyDown={(event) => {
                              if (event.key !== " " && event.key !== "Enter") return;
                              event.preventDefault();
                              setCell(sample.id, population.id, !checked);
                            }}
                          >
                            {checked ? "✓" : ""}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
