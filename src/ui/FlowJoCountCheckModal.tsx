// FlowJoCountCheckModal.tsx — the counts FlowJo recorded in an imported workspace beside
// GateLab's own, one file at a time, with what kind of difference each differing row is. The
// numbers come from engine/flowjoCountCheck.ts; this file only lays them out, as
// ChorusStatisticsModal does for a FACSChorus export.

import { useState } from "react";
import type { FlowJoCheckedPopulation, FlowJoCountCheck, FlowJoFileCheck } from "../engine/flowjoCountCheck";
import { useI18n } from "./i18n";

interface Props {
  check: FlowJoCountCheck;
  onExport: () => void;
  onClose: () => void;
}

const fmt = (n: number | null) => (n === null ? "–" : n.toLocaleString("en-US"));
const pct = (n: number | null) => (n === null ? "–" : `${n.toFixed(2)}%`);
const signed = (n: number | null) => (n === null ? "–" : n === 0 ? "0" : `${n > 0 ? "+" : "−"}${Math.abs(n).toLocaleString("en-US")}`);
const rel = (n: number | null) => (n === null ? "–" : n === 0 ? "0" : `${n > 0 ? "+" : "−"}${(Math.abs(n) * 100).toFixed(2)}%`);

export function FlowJoCountCheckModal({ check, onExport, onClose }: Props) {
  const { t } = useI18n();
  const [which, setWhich] = useState(0);
  const [differingOnly, setDifferingOnly] = useState(false);
  const current: FlowJoFileCheck | null = check.files[which] ?? check.files[0] ?? null;

  const reasonText = (row: FlowJoCheckedPopulation): string => {
    switch (row.reason.kind) {
      // An exact row needs no reason, and one on every row buried the rows that have one.
      case "exact": return "";
      // Short, so the column fits beside a long qualified name; the note above says what each means.
      case "own": return t("at its own gate");
      case "inherited": return t("within {name}, which differs", { name: row.reason.from });
      case "flowjo-only": return t("in FlowJo's record, not in this tree");
      case "gatelab-only": return t("not in FlowJo's record");
      case "unrecorded": return t("no count recorded by FlowJo");
    }
  };
  const rows = current ? (differingOnly ? current.rows.filter((row) => row.delta !== 0) : current.rows) : [];

  return (
    <div className="gl-modal-backdrop" onClick={onClose}>
      <div className="gl-modal gl-chorus-stats gl-flowjo-check" role="dialog" aria-label="Counts against FlowJo" onClick={(e) => e.stopPropagation()}>
        <div className="gl-modal-title">{t("Counts against FlowJo")}</div>
        <div className="gl-modal-note">
          {check.compared > 0 && check.exact === check.compared
            ? t("All {compared} populations compared count exactly as FlowJo recorded.", { compared: check.compared })
            : t("{exact} of {compared} populations compared count exactly as FlowJo recorded.", { exact: check.exact, compared: check.compared })}
          {check.largest
            ? ` ${check.files.length > 1
              ? t("The largest difference is {delta} events ({relative}) on {name}, {file}.", { delta: signed(check.largest.row.delta), relative: rel(check.largest.row.relative), name: check.largest.row.name, file: check.largest.fileName })
              : t("The largest difference is {delta} events ({relative}) on {name}.", { delta: signed(check.largest.row.delta), relative: rel(check.largest.row.relative), name: check.largest.row.name })}`
            : ""}
          {check.flowJoOnly > 0 ? ` ${t("{count} population(s) FlowJo recorded are not in the tree.", { count: check.flowJoOnly })}` : ""}
          <br />
          {t("FlowJo's numbers are the counts stored in the workspace file when it was last saved; GateLab's are counted now, under the gates and compensation as they stand, so a gate edited since the import shows here as a difference. A difference at a population's own gate (every population above it exact) is usually events on the gate's edge, a gate drawn on a biexponential axis evaluated off FlowJo's grid, or a compensation matrix other than the one FlowJo used. A population within one that differs inherits its difference. A population in FlowJo's record and not in the tree was not imported, or has been renamed or removed since.")}
        </div>

        {check.files.length > 1 && (
          <div className="gl-chorus-stats-files">
            {check.files.map((f, i) => (
              <button
                key={`${f.fileName}-${i}`}
                className={`gl-btn-ghost${i === which ? " is-active" : ""}`}
                onClick={() => setWhich(i)}
                aria-pressed={i === which}
                title={t("{exact} of {compared} exact", { exact: f.exact, compared: f.compared })}
              >
                {f.fileName}{f.exact === f.compared ? "" : ` · ${f.compared - f.exact}`}
              </button>
            ))}
          </div>
        )}

        {current ? (
          <>
            <div className="gl-chorus-stats-summary">
              <strong>{current.fileName}</strong> {t("under")} {current.hierarchyName}
              {current.sampleName && current.sampleName !== current.fileName ? ` · ${t("FlowJo sample")} ${current.sampleName}` : ""}
              {" · "}
              {current.flowJoEvents !== null && current.flowJoEvents !== current.fileEvents
                ? <span className="gl-chorus-stats-warn">{t("event totals differ")}: {t("file")} {fmt(current.fileEvents)}, FlowJo {fmt(current.flowJoEvents)} — {t("this file is not the one FlowJo counted")}</span>
                : <>{fmt(current.fileEvents)} {t("events")}</>}
              <br />
              {current.compared} {t("populations compared")}, {current.exact} {t("exact")}
              {current.largest ? `, ${t("largest difference")} ${signed(current.largest.delta)} (${rel(current.largest.relative)}) ${t("on")} ${current.largest.name}` : ""}
              <label className="gl-check" style={{ marginLeft: 12 }}>
                <input type="checkbox" checked={differingOnly} onChange={(e) => setDifferingOnly(e.target.checked)} />
                {t("Differences only")}
              </label>
            </div>
            <div className="gl-chorus-stats-scroll">
              <table className="gl-stats-table gl-chorus-stats-table">
                <thead>
                  <tr>
                    <th>{t("Population")}</th>
                    <th className="gl-stats-num">FlowJo</th>
                    <th className="gl-stats-num">{t("GateLab")}</th>
                    <th className="gl-stats-num">Δ</th>
                    <th className="gl-stats-num">Δ / FlowJo</th>
                    <th className="gl-stats-num">{t("FlowJo % parent")}</th>
                    <th className="gl-stats-num">{t("GateLab % parent")}</th>
                    <th>{t("Why")}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, i) => (
                    <tr key={`${row.name}-${i}`} className={row.delta === null ? "gl-chorus-stats-missing" : row.delta === 0 ? "gl-chorus-stats-exact" : ""}>
                      <td className="gl-stats-name" style={{ paddingLeft: 10 + Math.max(0, row.depth - 1) * 12 }}>{row.name}</td>
                      <td className="gl-stats-num">{fmt(row.flowJoEvents)}</td>
                      <td className="gl-stats-num">{fmt(row.gatelabEvents)}</td>
                      <td className="gl-stats-num">{signed(row.delta)}</td>
                      <td className="gl-stats-num">{rel(row.relative)}</td>
                      <td className="gl-stats-num">{pct(row.flowJoPercentParent)}</td>
                      <td className="gl-stats-num">{pct(row.gatelabPercentParent)}</td>
                      <td className="gl-chorus-stats-why">{reasonText(row)}</td>
                    </tr>
                  ))}
                  {rows.length === 0 && (
                    <tr><td colSpan={8} className="gl-chorus-stats-why">{t("Every population of this file counts exactly as FlowJo recorded.")}</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <div className="gl-modal-note">{t("None of the files this FlowJo workspace's strategies were imported for is loaded.")}</div>
        )}

        {check.unmatched.length > 0 && (
          <div className="gl-modal-note" style={{ marginTop: 10 }}>
            {t("Not compared, because the file is not loaded or cannot be told from another of its name")}: {check.unmatched.join(", ")}
          </div>
        )}

        <div className="gl-modal-actions">
          <button onClick={onExport} disabled={check.files.length === 0}>{t("Export CSV")}</button>
          <button onClick={onClose}>{t("Close")}</button>
        </div>
      </div>
    </div>
  );
}
