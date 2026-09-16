// ChorusStatisticsModal.tsx — a FACSChorus statistics export beside GateLab's own counts, one
// recording at a time, with a reason against every row that differs. The numbers come from
// engine/chorusStatistics.ts; this file only lays them out.

import { useState } from "react";
import type { ChorusImportRecord, ChorusStatistics, ChorusStatisticsComparison, ComparedPopulation, RecordingComparison } from "../engine/chorusStatistics";
import { useI18n } from "./i18n";

interface Props {
  stats: ChorusStatistics;
  comparison: ChorusStatisticsComparison;
  /** The Chorus import the compared trees came from, if any. */
  record: ChorusImportRecord | null;
  onClose: () => void;
}

const fmt = (n: number | null) => (n === null ? "–" : n.toLocaleString("en-US"));
const pct = (n: number | null) => (n === null ? "–" : `${n.toFixed(2)}%`);
const signed = (n: number | null) => (n === null ? "–" : n === 0 ? "0" : `${n > 0 ? "+" : "−"}${Math.abs(n).toLocaleString("en-US")}`);
const rel = (n: number | null) => (n === null ? "–" : n === 0 ? "0" : `${n > 0 ? "+" : "−"}${(Math.abs(n) * 100).toFixed(2)}%`);

/** Chorus writes sort times in UTC with no zone designator. */
function localTime(iso: string): string {
  const d = new Date(/(Z|[+-]\d\d:?\d\d)$/.test(iso) ? iso : `${iso}Z`);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function ChorusStatisticsModal({ stats, comparison, record, onClose }: Props) {
  const { t } = useI18n();
  const [which, setWhich] = useState(0);
  const current: RecordingComparison | null = comparison.recordings[which] ?? comparison.recordings[0] ?? null;

  const reasonText = (row: ComparedPopulation): string => {
    switch (row.reason.kind) {
      case "exact": return t("linear axes: exact");
      case "moved": return t("moved after this tree was taken; the export counts the current gate");
      case "biexponential": return `${t("biexponential axes")}: ${row.reason.axes.join(", ")}`;
      case "inherited": return `${t("inherits from")} ${row.reason.from}`;
      case "automatic": return t("Chorus's automatic saturation gate, not applied here");
      case "chorus-only": return t("in the export, not in this tree");
      case "gatelab-only": return t("in this tree, not in the export");
      case "unknown": return t("not a gate of the Chorus import, so its axes are not known");
    }
  };

  return (
    <div className="gl-modal-backdrop" onClick={onClose}>
      <div className="gl-modal gl-chorus-stats" role="dialog" aria-label="FACSChorus statistics" onClick={(e) => e.stopPropagation()}>
        <div className="gl-modal-title">{t("FACSChorus statistics")}</div>
        <div className="gl-modal-note">
          {stats.experimentName ? `${stats.experimentName}` : t("statistics export")}
          {stats.cytometer ? ` · ${stats.cytometer}` : ""}
          {stats.exportedAt ? ` · ${t("exported")} ${stats.exportedAt}` : ""}
          {` · ${stats.recordings.length} ${t("recordings")}`}
          {record && (
            <>
              <br />
              {t("Tree imported from")} {record.experimentName} · {record.treeLabel}
              {record.kind === "sort" && record.sortedAt ? ` (${t("snapshot of a sort started")} ${localTime(record.sortedAt)})` : ""}
            </>
          )}
          <br />
          {t("Chorus counts under the gates current when it exported; a sort's snapshot differs wherever a gate moved after that sort. A gate on linear axes is the same test in Chorus and here. A gate on Chorus's biexponential axes has edges straight in Chorus's display but straight in raw here, because the automatic R value is not in the file, so its count differs near the axes and every population beneath it inherits the difference.")}
          {record?.kind === "sort" && (
            <> {t("This tree is a sort's snapshot, so the export may describe later gates.")}</>
          )}
          {record?.kind === "recording" && (
            <> {t("This tree is the one the file was recorded under, so the export may describe later gates.")}</>
          )}
        </div>

        {comparison.recordings.length > 1 && (
          <div className="gl-chorus-stats-files">
            {comparison.recordings.map((r, i) => (
              <button
                key={r.fileName}
                className={`gl-btn-ghost${i === which ? " is-active" : ""}`}
                onClick={() => setWhich(i)}
                aria-pressed={i === which}
              >
                {r.fileName}
              </button>
            ))}
          </div>
        )}

        {current ? (
          <>
            <div className="gl-chorus-stats-summary">
              <strong>{current.fileName}</strong> {t("under")} {current.hierarchyName} · {t("recording")} {current.recordingName}
              {" · "}
              {current.recordingEvents !== null && current.recordingEvents !== current.fileEvents
                ? <span className="gl-chorus-stats-warn">{t("event totals differ")}: {t("file")} {fmt(current.fileEvents)}, {t("recording")} {fmt(current.recordingEvents)} — {t("this file is not the recording the export describes")}</span>
                : <>{fmt(current.fileEvents)} {t("events")}</>}
              <br />
              {current.compared} {t("populations compared")}, {current.exact} {t("exact")}
              {current.largest ? `, ${t("largest difference")} ${signed(current.largest.delta)} (${rel(current.largest.relative)}) ${t("on")} ${current.largest.name}` : ""}
            </div>
            <div className="gl-chorus-stats-scroll">
              <table className="gl-stats-table gl-chorus-stats-table">
                <thead>
                  <tr>
                    <th>{t("Population")}</th>
                    <th className="gl-stats-num">{t("Chorus")}</th>
                    <th className="gl-stats-num">{t("GateLab")}</th>
                    <th className="gl-stats-num">Δ</th>
                    <th className="gl-stats-num">Δ / {t("Chorus")}</th>
                    <th className="gl-stats-num">{t("Chorus % parent")}</th>
                    <th className="gl-stats-num">{t("GateLab % parent")}</th>
                    <th>{t("Why")}</th>
                  </tr>
                </thead>
                <tbody>
                  {current.rows.map((row, i) => (
                    <tr key={`${row.name}-${i}`} className={row.delta === null ? "gl-chorus-stats-missing" : row.delta === 0 ? "gl-chorus-stats-exact" : ""}>
                      <td className="gl-stats-name" style={{ paddingLeft: 10 + Math.max(0, row.depth - 1) * 12 }}>{row.name}</td>
                      <td className="gl-stats-num">{fmt(row.chorusEvents)}</td>
                      <td className="gl-stats-num">{fmt(row.gatelabEvents)}</td>
                      <td className="gl-stats-num">{signed(row.delta)}</td>
                      <td className="gl-stats-num">{rel(row.relative)}</td>
                      <td className="gl-stats-num">{pct(row.chorusPercentParent)}</td>
                      <td className="gl-stats-num">{pct(row.gatelabPercentParent)}</td>
                      <td className="gl-chorus-stats-why">{reasonText(row)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <div className="gl-modal-note">{t("No loaded file has the name of a recording in this export.")}</div>
        )}

        {(comparison.unmatchedRecordings.length > 0 || comparison.unmatchedFiles.length > 0) && (
          <div className="gl-modal-note" style={{ marginTop: 10 }}>
            {comparison.unmatchedRecordings.length > 0 && (
              <div>{t("Recordings in the export with no loaded file of that name")}: {comparison.unmatchedRecordings.join(", ")}</div>
            )}
            {comparison.unmatchedFiles.length > 0 && (
              <div>{t("Loaded files with no recording of that name")}: {comparison.unmatchedFiles.join(", ")}</div>
            )}
          </div>
        )}

        <div className="gl-modal-actions">
          <button onClick={onClose}>{t("Close")}</button>
        </div>
      </div>
    </div>
  );
}
