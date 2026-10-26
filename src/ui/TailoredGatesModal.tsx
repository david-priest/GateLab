// TailoredGatesModal.tsx — the gates files are gated with at coordinates of their own or their
// group's, how far each moved from the gate it follows, and a reason for each, kept in the
// workspace. The rows come from reports/tailoringReport.ts; this dialog lays them out and edits
// the reasons.

import { useI18n } from "./i18n";
import { ModalEscape } from "./useModalEscape";
import type { NamedTailoredGate } from "../reports/tailoringReport";

interface Props {
  rows: readonly NamedTailoredGate[];
  /** A channel's name as the plots label it. */
  labelOf: (channel: string) => string;
  onReasonChange: (treeId: string, gateId: string, reason: string) => void;
  onExportCsv: () => void;
  onClose: () => void;
}

/** A shift to four significant figures with its sign, thousands separated as the counts are; the CSV keeps plain digits. */
const signedShift = (v: number) =>
  v === 0 ? "0" : (v > 0 ? "+" : "-") + Number(Math.abs(v).toPrecision(4)).toLocaleString("en-US", { maximumFractionDigits: 20 });

export function TailoredGatesModal({ rows, labelOf, onReasonChange, onExportCsv, onClose }: Props) {
  const { t } = useI18n();
  const shiftCell = (row: NamedTailoredGate) => {
    const s = row.shift;
    const x = labelOf(row.xChannel);
    const y = labelOf(row.yChannel);
    if (s.kind === "same") return t("none: switched on at the coordinates it follows");
    if (s.kind === "no-source") return t("the gate it followed is gone");
    if (s.kind === "reshaped") return t("reshaped: {why}", { why: t(s.why) });
    return `${x} ${signedShift(s.dx)}, ${y} ${signedShift(s.dy)}${s.reshaped ? ` · ${t("reshaped")}` : ""}${s.space === "display" ? ` (${t("display units")})` : ""}`;
  };

  return (
    <div className="gl-modal-backdrop" onClick={onClose}>
      <ModalEscape onClose={onClose} />
      <div className="gl-modal gl-chorus-stats gl-tailored-gates" role="dialog" aria-label="Tailored gates" onClick={(e) => e.stopPropagation()}>
        <div className="gl-modal-title">{t("Tailored gates")}</div>
        <div className="gl-modal-note">
          {t("The gates files are gated with at coordinates of their own or their group's, as the file list counts them. The shift is from the gate each follows (the tree's, or the group's for a file of a group): the largest move of any vertex on each axis, in raw channel values (in display units only for a gate drawn on a transformed axis that does not record its transform). A reason typed here is saved with the workspace.")}
        </div>
        <div className="gl-chorus-stats-scroll">
          <table className="gl-stats-table gl-chorus-stats-table">
            <thead>
              <tr>
                <th>{t("File or group")}</th>
                <th>{t("Gate")}</th>
                <th>{t("Follows")}</th>
                <th>{t("Moved by")}</th>
                <th>{t("Reason")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.treeId}\u0000${row.gateId}`}>
                  <td className="gl-stats-name" title={row.fileNames.join(", ")}>
                    {row.owner.kind === "group"
                      ? t("{name} ({count} files)", { name: row.ownerName, count: row.fileNames.length })
                      : row.ownerName}
                  </td>
                  <td>{row.gateName}</td>
                  <td>{row.follows.kind === "group" ? row.follows.name : t("the tree")}</td>
                  <td>{shiftCell(row)}</td>
                  <td>
                    <input
                      type="text"
                      className="gl-tailored-reason"
                      aria-label={t("Reason for {gate} in {owner}", { gate: row.gateName, owner: row.ownerName })}
                      placeholder={t("e.g. population shifted after the stimulation")}
                      value={row.reason}
                      onChange={(e) => onReasonChange(row.treeId, row.gateId, e.target.value)}
                    />
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={5} className="gl-chorus-stats-why">{t("Every file is gated with the tree's gates.")}</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="gl-modal-actions">
          <button onClick={onExportCsv} disabled={rows.length === 0}>{t("Export CSV")}</button>
          <button onClick={onClose}>{t("Close")}</button>
        </div>
      </div>
    </div>
  );
}
