// StatsTab.tsx — Statistics tab. Single-sample view = GateLabR's compute_population_stats (one
// row per population with Count / % Parent / % Total + per-channel MFIs). Multi-sample adds a
// sample selector and an "All samples" compare view (populations × samples for one metric).

import { useMemo, useState } from "react";
import { usePersistedTabState } from "./tabState";
import { recompute, type CoreState, type Derived } from "../store";
import type { Sample } from "../engine/sample";
import { computePopulationStats, MFI_STATS, type StatType, type ValueSpace } from "../engine/stats";
import { significantNumber } from "./compensationUiFormat";
import { populationTreeOrder } from "../engine/populations";
import { TreeConnectors } from "./TreeConnectors";
import { useI18n } from "./i18n";

interface SampleRef {
  id: string;
  name: string;
  sample: Sample;
}
interface Props {
  samples: SampleRef[];
  activeSampleId: string | null;
  state: CoreState;
  derived: Derived; // the active sample's derived (reused to avoid recomputing it)
  defaultChannels: string[];
  /** Aggregate Sample revision snapshot; includes inactive samples used by compare/view modes. */
  dataRevisionKey: string;
}

const BASE_STATS: { key: StatType; label: string }[] = [
  { key: "count", label: "Count" },
  { key: "pct_parent", label: "% Parent" },
  { key: "pct_total", label: "% Total" },
];
const ALL_STAT_OPTS = [...BASE_STATS, ...MFI_STATS.map((s) => ({ key: s.key, label: s.label }))];
const COMPARE = "__all__";
const COMPARE_METRICS: { key: "count" | "pct_parent" | "pct_total"; label: string }[] = [
  { key: "count", label: "Count" },
  { key: "pct_parent", label: "% Parent" },
  { key: "pct_total", label: "% Total" },
];

export function StatsTab({ samples, activeSampleId, state, derived, defaultChannels, dataRevisionKey }: Props) {
  const { t } = useI18n();
  const [viewSampleId, setViewSampleId] = useState<string>(() => activeSampleId ?? samples[0]?.id ?? "");
  const [statTypes, setStatTypes] = usePersistedTabState<Set<StatType>>(
    "stats.statTypes",
    () => new Set<StatType>(["count", "pct_parent", "pct_total", "median"]),
  );
  const [valueSpace, setValueSpace] = usePersistedTabState<ValueSpace>("stats.valueSpace", "raw");
  const [channels, setChannels] = usePersistedTabState<string[]>("stats.channels", () => defaultChannels.slice(0, 2));
  const [compareMetric, setCompareMetric] = usePersistedTabState<"count" | "pct_parent" | "pct_total">("stats.compareMetric", "pct_total");
  const [copied, setCopied] = useState(false);

  const isCompare = viewSampleId === COMPARE;
  const viewEntry =
    samples.find((s) => s.id === viewSampleId) ?? samples.find((s) => s.id === activeSampleId) ?? samples[0] ?? null;
  const labelSample = viewEntry?.sample ?? samples[0]?.sample ?? null;
  const allChannels = labelSample?.channels.map((c) => c.key) ?? [];
  const labelOf = (k: string) => labelSample?.labelForKey(k) ?? k;
  // MFI column headers embed the channel identity key ("<key>::<suffix>") — show the display name.
  const colHeader = (c: { key: string; label: string }) => {
    const parts = c.key.split("::");
    return parts.length === 2 ? `${labelOf(parts[0])} ${parts[1]}` : c.label;
  };
  const anyMfi = MFI_STATS.some((s) => statTypes.has(s.key));
  const root = state.root_population_id ?? "";

  // Per-sample Derived: reuse the active sample's; recompute the others on demand.
  const derivedFor = (id: string): Derived => {
    const e = samples.find((s) => s.id === id);
    if (!e) return derived;
    return e.id === activeSampleId ? derived : recompute(e.sample, state);
  };

  // Single-sample detailed table.
  const table = useMemo(() => {
    if (isCompare || !viewEntry) return null;
    const d = derivedFor(viewEntry.id);
    return computePopulationStats(
      viewEntry.sample,
      state.populations,
      root,
      d.masks,
      d.stats.event_count,
      anyMfi ? channels : [],
      [...statTypes],
      valueSpace,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCompare, viewEntry, activeSampleId, derived, state.populations, state.gate_version, root, channels, statTypes, valueSpace, anyMfi, dataRevisionKey]);

  // All-samples compare table: rows = populations, columns = samples, cell = one metric.
  const compare = useMemo(() => {
    if (!isCompare) return null;
    const order = populationTreeOrder(state.populations, state.root_population_id ?? null);
    const perSample = samples.map((e) => ({ name: e.name, d: derivedFor(e.id) }));
    const rows = order.map(({ popId, depth, isLastPath }) => ({
      popId,
      depth,
      isLastPath,
      name: state.populations[popId]?.name ?? popId,
      cells: perSample.map(({ d }) => {
        if (compareMetric === "count") return d.stats.event_count[popId] ?? null;
        const src = compareMetric === "pct_parent" ? d.stats.percent_of_parent : d.stats.percent_of_total;
        return depth === 0 ? 100 : src[popId] ?? null;
      }),
    }));
    return { sampleNames: perSample.map((p) => p.name), rows };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCompare, samples, activeSampleId, derived, state.populations, state.gate_version, compareMetric, dataRevisionKey]);

  const toggleStat = (k: StatType) =>
    setStatTypes((prev) => {
      const n = new Set(prev);
      n.has(k) ? n.delete(k) : n.add(k);
      return n;
    });
  const toggleChannel = (ch: string) =>
    setChannels((prev) => (prev.includes(ch) ? prev.filter((c) => c !== ch) : [...prev, ch]));

  const fmtCount = (v: number | null) => (v == null ? "—" : v.toLocaleString());
  /**
   * MFI columns carry a measured value, not a count, and their magnitude depends entirely on
   * the value space: raw runs to tens of thousands, a logicle display coordinate lives in
   * [0, 1]. Significant figures suit both, where a fixed number of decimal places suits
   * neither. Four is enough to separate channels without implying precision the statistic
   * does not have.
   */
  const isMfiColumn = (key: string) => key.includes("::");
  const fmtMfi = (v: number | null) => (v == null ? "—" : significantNumber(v, 4));
  const fmtCell = (metric: string, v: number | null) =>
    v == null ? "—" : metric === "count" ? v.toLocaleString() : `${v}%`;

  const buildCsv = (): string => {
    if (isCompare && compare) {
      return ["Population", ...compare.sampleNames].join(",") + "\n" +
        compare.rows.map((r) => [JSON.stringify(r.name), ...r.cells.map((c) => c ?? "")].join(",")).join("\n");
    }
    if (table) {
      return ["Population", ...table.columns.map((c) => c.label)].join(",") + "\n" +
        table.rows.map((r) => [
          JSON.stringify(r.name),
          ...table.columns.map((c) => {
            const v = r.cells[c.key];
            if (v == null) return "";
            // Six significant figures rather than the four on screen: an exported file is read
            // by something else, and full float noise (0.48391827364) helps nobody either.
            return isMfiColumn(c.key) ? significantNumber(v, 6) : v;
          }),
        ].join(",")).join("\n");
    }
    return "";
  };
  const copyCsv = () => {
    navigator.clipboard?.writeText(buildCsv()).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  };
  // Dated file download (R's Statistics-tab downloadHandler), alongside the clipboard copy.
  const downloadCsv = () => {
    const csv = buildCsv();
    if (!csv) return;
    const stamp = new Date().toISOString().slice(0, 10);
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `gatelab_stats_${stamp}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const empty = samples.length === 0 || (!isCompare && (!table || table.rows.length === 0));

  return (
    <div className="gl-tab-panel gl-tab-fill gl-plotting-workspace gl-stats-workspace">
      <div className="gl-plotting-head">
        <strong>{t("Statistics")}</strong>
        <span>{t("Population counts and statistics per file")}</span>
        <span className="gl-plotting-head-actions">
          <button className="gl-btn-ghost" onClick={downloadCsv} disabled={empty}>{t("Download CSV")}</button>
          <button className="gl-btn-ghost" onClick={copyCsv} disabled={empty}>
            {copied ? t("Copied ✓") : t("Copy CSV")}
          </button>
        </span>
      </div>
      <aside className="gl-plotting-inspector" aria-label={t("Statistics controls")}>
        <section className="gl-stats-opt-group">
          <h3>{t("File")}</h3>
          <select aria-label={t("Statistics file")} value={viewSampleId} onChange={(e) => setViewSampleId(e.target.value)}>
            {samples.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
                {e.id === activeSampleId ? ` (${t("active")})` : ""}
              </option>
            ))}
            {samples.length > 1 && <option value={COMPARE}>{t("All samples (compare)")}</option>}
          </select>
        </section>
        {isCompare ? (
          <section className="gl-stats-opt-group">
            <h3>{t("Metric")}</h3>
            {COMPARE_METRICS.map((m) => (
              <label key={m.key} className="gl-check">
                <input type="radio" name="cmp-metric" checked={compareMetric === m.key} onChange={() => setCompareMetric(m.key)} />
                {t(m.label)}
              </label>
            ))}
          </section>
        ) : (
          <>
            <section className="gl-stats-opt-group">
              <h3>{t("Statistics")}</h3>
              {ALL_STAT_OPTS.map((s) => (
                <label key={s.key} className="gl-check">
                  <input type="checkbox" checked={statTypes.has(s.key)} onChange={() => toggleStat(s.key)} />
                  {t(s.label)}
                </label>
              ))}
            </section>
            <section className="gl-stats-opt-group">
              <h3>{t("MFI space")}</h3>
              {(["raw", "transformed"] as ValueSpace[]).map((v) => (
                <label key={v} className="gl-check">
                  <input type="radio" name="mfi-space" checked={valueSpace === v} onChange={() => setValueSpace(v)} />
                  {v === "raw" ? t("Raw") : t("Transformed")}
                </label>
              ))}
            </section>
            {anyMfi && (
              <section className="gl-stats-opt-group gl-stats-channel-picker">
                <h3>{t("Channels")} <span>{channels.length} {t("selected")}</span></h3>
                <div className="gl-plotting-actions">
                  <button className="gl-mini-btn" onClick={() => setChannels(allChannels)}>{t("All")}</button>
                  <button className="gl-mini-btn" onClick={() => setChannels([])}>{t("None")}</button>
                </div>
                <div className="gl-plotting-filelist" aria-label={t("Statistics channels")}>
                  {allChannels.map((channel) => (
                    <label className="gl-check" key={channel}>
                      <input type="checkbox" checked={channels.includes(channel)} onChange={() => toggleChannel(channel)} />
                      {labelOf(channel)}
                    </label>
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </aside>
      <div className="gl-prop-body">
      {empty ? (
        <p className="gl-tab-empty">{samples.length === 0
          ? t("No file to tabulate: check a file, or view one, under this tree.")
          : t("No populations yet — draw a gate to populate the tree.")}</p>
      ) : (
      <div className="gl-stats-scroll">
        {isCompare && compare ? (
          <table className="gl-stats-table">
            <thead>
              <tr>
                <th className="gl-stats-name">{t("Population")}</th>
                {compare.sampleNames.map((n, i) => (
                  <th key={i} className="gl-stats-num" title={n}>{n}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {compare.rows.map((r) => (
                <tr key={r.popId}>
                  <td className="gl-stats-name">
                    <span className="gl-stats-tree-cell">
                      <TreeConnectors depth={r.depth} isLastPath={r.isLastPath} fill />
                      <span className="gl-stats-tree-label">{r.name}</span>
                    </span>
                  </td>
                  {r.cells.map((c, i) => (
                    <td key={i} className="gl-stats-num">{fmtCell(compareMetric, c)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ) : table ? (
          <table className="gl-stats-table">
            <thead>
              <tr>
                <th className="gl-stats-name">{t("Population")}</th>
                {table.columns.map((c) => (
                  <th key={c.key} className="gl-stats-num">{colHeader(c)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((r) => (
                <tr key={r.popId} className={r.popId === state.active_population_id ? "active" : ""}>
                  <td className="gl-stats-name">
                    <span className="gl-stats-tree-cell">
                      <TreeConnectors depth={r.depth} isLastPath={r.isLastPath} fill />
                      <span className="gl-stats-tree-label">{r.name}</span>
                    </span>
                  </td>
                  {table.columns.map((c) => (
                    <td key={c.key} className="gl-stats-num">
                      {c.key === "pct_parent" || c.key === "pct_total"
                        ? r.cells[c.key] == null ? "—" : `${r.cells[c.key]}%`
                        : isMfiColumn(c.key)
                          ? fmtMfi(r.cells[c.key])
                          : fmtCount(r.cells[c.key])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>
      )}
      </div>
    </div>
  );
}
