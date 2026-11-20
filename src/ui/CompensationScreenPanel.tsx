// CompensationScreenPanel.tsx — the Compensation tab's Check view for a mass-cytometry matrix.
//
// Every pair of the matrix against the file's own events (src/compensationScreen): the matrix
// value beside what the events support, most consequential first. A row selects the pair in the
// coefficient panel beside it; "Stage" puts the suggested value into the working matrix, where
// the next reading shows at once whether it settles the pair. Nothing is applied from here.
import { useMemo, useState } from "react";
import {
  suggestedCoefficient,
  type ScreenPair,
  type ScreenVerdict,
} from "../compensationScreen/screenPairs";
import { screenPercent, screenReading, screenSupport } from "./compensationScreenText";
import { useI18n } from "./i18n";
import type { CompensationScreenState } from "./useCompensationScreen";

type ScreenFilter = "attention" | "bound" | "consistent" | "dim" | "all";

const FILTER_VERDICTS: Record<ScreenFilter, readonly ScreenVerdict[]> = {
  attention: ["above-data", "below-floor"],
  bound: ["upper-bound-only"],
  consistent: ["consistent"],
  dim: ["too-dim"],
  all: ["above-data", "below-floor", "upper-bound-only", "consistent", "too-dim"],
};

const FILTER_LABELS: Record<ScreenFilter, string> = {
  attention: "Needs a look",
  bound: "Upper bound only",
  consistent: "Consistent",
  dim: "Too dim",
  all: "All pairs",
};

export interface ScreenStageEdit {
  readonly source: string;
  readonly receiver: string;
  readonly value: number;
}

export interface CompensationScreenPanelProps {
  readonly state: CompensationScreenState;
  /** The channel's name as the tab shows it. */
  readonly channelLabel: (pnn: string) => string;
  /** The review population's name; null for every event. */
  readonly populationName: string | null;
  readonly selected: Readonly<{ source: string; receiver: string }> | null;
  readonly onSelect: (source: string, receiver: string) => void;
  /** Whether the pair has a staged value in the working matrix. */
  readonly isStaged: (source: string, receiver: string) => boolean;
  /** False while a matrix cannot be edited (no profile, or Apply running). */
  readonly canStage: boolean;
  readonly onStage: (edits: readonly ScreenStageEdit[]) => void;
  readonly onRunAgain: () => void;
}

export function CompensationScreenPanel({
  state,
  channelLabel,
  populationName,
  selected,
  onSelect,
  isStaged,
  canStage,
  onStage,
  onRunAgain,
}: CompensationScreenPanelProps) {
  const { t } = useI18n();
  const [filter, setFilter] = useState<ScreenFilter>("attention");
  const result = state.result;
  const counts = useMemo(() => {
    const tally: Record<ScreenFilter, number> = { attention: 0, bound: 0, consistent: 0, dim: 0, all: 0 };
    for (const pair of result?.pairs ?? []) {
      tally.all++;
      for (const key of ["attention", "bound", "consistent", "dim"] as const) {
        if (FILTER_VERDICTS[key].includes(pair.verdict)) tally[key]++;
      }
    }
    return tally;
  }, [result]);
  const rows = useMemo(
    () => (result?.pairs ?? []).filter((pair) => FILTER_VERDICTS[filter].includes(pair.verdict)),
    [filter, result],
  );
  const oxide = result?.oxide?.shared ? result.oxide : null;
  // Every oxide pair the matrix holds a value for, read or not: a run's oxide moves them together.
  const oxideEdits = useMemo<ScreenStageEdit[]>(() => {
    if (!oxide || !result) return [];
    return result.pairs
      .filter((pair) => pair.interaction === "oxide (+16)" && pair.coefficient > 0)
      .map((pair) => ({ source: pair.source, receiver: pair.receiver, value: pair.coefficient * oxide.ratio }));
  }, [oxide, result]);
  const running = state.status === "running";

  const renderRow = (pair: ScreenPair) => {
    const reading = screenReading(pair);
    const support = screenSupport(pair);
    const suggestion = suggestedCoefficient(pair);
    const isSelected = selected?.source === pair.source && selected.receiver === pair.receiver;
    const staged = isStaged(pair.source, pair.receiver);
    const name = `${channelLabel(pair.source)} → ${channelLabel(pair.receiver)}`;
    return (
      <tr
        key={`${pair.source}>${pair.receiver}`}
        className={`${isSelected ? "is-selected" : ""}${staged ? " is-staged" : ""}`}
        aria-selected={isSelected}
        onClick={() => onSelect(pair.source, pair.receiver)}
      >
        <th scope="row">
          <button type="button" className="gl-comp-screen-pair" onClick={() => onSelect(pair.source, pair.receiver)}>
            <strong>{name}</strong>
            <small>
              {pair.source} → {pair.receiver}
              {` · ${pair.interaction === "other" ? t("no physical route") : pair.interaction}`}
              {pair.receiverUnlabelled ? ` · ${t("receiver has no antibody")}` : ""}
            </small>
          </button>
        </th>
        <td className="is-number">
          {screenPercent(pair.coefficient)}
          {staged && <em>{t("staged")}</em>}
        </td>
        <td className="is-number">{t(support.text, support.values)}</td>
        <td>
          <span className={`gl-comp-screen-reading is-${reading.tone}`} title={t(reading.detail, reading.values)}>
            {t(reading.label)}
          </span>
        </td>
        <td>
          {suggestion !== null && (
            <button
              type="button"
              className="gl-mini-btn"
              disabled={!canStage}
              aria-label={t("Stage {value} for {pair}", { value: screenPercent(suggestion), pair: name })}
              onClick={(event) => {
                event.stopPropagation();
                onSelect(pair.source, pair.receiver);
                onStage([{ source: pair.source, receiver: pair.receiver, value: suggestion }]);
              }}
            >
              {t("Stage {value}", { value: screenPercent(suggestion) })}
            </button>
          )}
        </td>
      </tr>
    );
  };

  return (
    <section className="gl-comp-attention gl-comp-screen" aria-labelledby="comp-screen-heading">
      <div className="gl-comp-attention-head">
        <div>
          <h3 id="comp-screen-heading">{t("Matrix against the events")}</h3>
          <p>{t("Each pair's matrix value beside the coefficient this file's stored counts support. Spillover puts a floor under the receiver that rises with the source; a marker on the same cells only adds counts above it. A reading is a prompt to look at the pair, and nothing here changes the matrix until you apply it.")}</p>
        </div>
        <div className="gl-comp-attention-actions">
          <button type="button" className="gl-btn-ghost" disabled={running} onClick={onRunAgain}>
            {t("Read again")}
          </button>
        </div>
      </div>
      <div className="gl-comp-screen-scope" role="status" aria-live="polite">
        {running ? (
          <>
            <progress max={Math.max(1, state.total)} value={state.completed} />
            <span>{t("Reading {completed} of {total} source channels…", { completed: state.completed, total: state.total })}</span>
          </>
        ) : result ? (
          <span>
            {t("{pairs} pairs read from {events} events of {population}.", {
              pairs: result.pairs.length.toLocaleString(),
              events: result.eventCount.toLocaleString(),
              population: populationName ?? t("All Events"),
            })}
          </span>
        ) : (
          <span>{t("Not read yet.")}</span>
        )}
        {populationName === null && (
          <small>{t("Every event is in scope. Beads, debris and doublets carry signal in many channels at once and can be read as spillover: choose a population of single cells under Review scope.")}</small>
        )}
        {result && result.unreadSources.length > 0 && (
          <small>
            {t("{count} source channels could not be read (too few events, or no range): {channels}", {
              count: result.unreadSources.length,
              channels: result.unreadSources.map(({ source }) => channelLabel(source)).join(", "),
            })}
          </small>
        )}
      </div>
      {oxide && (
        <div className="gl-comp-screen-oxide">
          <div>
            <strong>{t("Oxide (+16) pairs share a factor of {ratio}", { ratio: oxide.ratio.toFixed(2) })}</strong>
            <span>
              {t("Across {count} oxide pairs these events support {low} to {high} times the matrix value. Oxide formation follows the run's plasma conditions, so a matrix from another run can be off by one factor in every oxide pair.", {
                count: oxide.pairs.length,
                low: oxide.lowestRatio.toFixed(2),
                high: oxide.highestRatio.toFixed(2),
              })}
            </span>
          </div>
          <button
            type="button"
            className="gl-mini-btn"
            disabled={!canStage || oxideEdits.length === 0}
            onClick={() => onStage(oxideEdits)}
          >
            {t("Stage {count} oxide values × {ratio}", { count: oxideEdits.length, ratio: oxide.ratio.toFixed(2) })}
          </button>
        </div>
      )}
      {result && (
        <>
          <div className="gl-comp-screen-filters" role="tablist" aria-label={t("Pairs by reading")}>
            {(Object.keys(FILTER_LABELS) as ScreenFilter[]).map((key) => (
              <button
                type="button"
                role="tab"
                key={key}
                aria-selected={filter === key}
                className={`gl-chip${filter === key ? " active" : ""}`}
                onClick={() => setFilter(key)}
              >
                {t(FILTER_LABELS[key])} ({counts[key]})
              </button>
            ))}
          </div>
          {rows.length === 0 ? (
            <div className="gl-comp-attention-empty">
              {t(filter === "attention"
                ? "No pair's matrix value disagrees with these events."
                : "No pair has this reading.")}
            </div>
          ) : (
            <div className="gl-comp-screen-table-wrap">
              <table className="gl-comp-screen-table">
                <thead>
                  <tr>
                    <th scope="col">{t("Source → receiver")}</th>
                    <th scope="col" className="is-number">{t("Matrix")}</th>
                    <th scope="col" className="is-number">{t("Events support")}</th>
                    <th scope="col">{t("Reading")}</th>
                    <th scope="col"><span className="gl-sr-only">{t("Stage")}</span></th>
                  </tr>
                </thead>
                <tbody>{rows.map(renderRow)}</tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
