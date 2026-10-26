// MembershipModals.tsx — per-event population memberships out of GateLab. The tables come from
// reports/membershipExport.ts; this dialog only chooses the files and reports what was written.

import { useState } from "react";
import { useI18n } from "./i18n";
import { ModalEscape } from "./useModalEscape";
import type { ReportScope } from "./MiflowcytReportModal";

/** What an export wrote, or why it could not. */
export type MembershipExportResult = { written: string[]; notes: string[] } | { error: string };

interface ExportProps {
  viewedName: string | null;
  checkedCount: number;
  allCount: number;
  onExport: (scope: ReportScope) => Promise<MembershipExportResult>;
  onClose: () => void;
}

export function MembershipExportModal({ viewedName, checkedCount, allCount, onExport, onClose }: ExportProps) {
  const { t } = useI18n();
  const [scope, setScope] = useState<ReportScope>(viewedName ? "viewed" : "all");
  const [result, setResult] = useState<MembershipExportResult | null>(null);
  const [running, setRunning] = useState(false);
  const scopeCount = scope === "viewed" ? (viewedName ? 1 : 0) : scope === "checked" ? checkedCount : allCount;

  const run = async () => {
    setRunning(true);
    try {
      setResult(await onExport(scope));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="gl-modal-backdrop" onClick={onClose}>
      <ModalEscape onClose={onClose} />
      <div className="gl-modal gl-membership-export" role="dialog" aria-label="Export event memberships" onClick={(e) => e.stopPropagation()}>
        <div className="gl-modal-title">{t("Export event memberships")}</div>
        <div className="gl-modal-note">
          {t("For each file, a CSV with one row per event in FCS order (event_index from 0) and one column per population, 1 for a member and 0 otherwise, each population named by its path from the top of the tree. A manifest (JSON) beside it records the file, its $FIL, the event count, each population's id and count, and the GateLab version. Each file is read under the tree it is gated under. Several files are written as one zip.")}
        </div>
        <div className="gl-miflowcyt-options">
          <span>{t("Files")}:</span>
          <label className="gl-check">
            <input type="radio" name="membership-scope" checked={scope === "viewed"} disabled={!viewedName} onChange={() => setScope("viewed")} />
            {viewedName ? t("Viewed file ({name})", { name: viewedName }) : t("Viewed file")}
          </label>
          <label className="gl-check">
            <input type="radio" name="membership-scope" checked={scope === "checked"} disabled={checkedCount === 0} onChange={() => setScope("checked")} />
            {t("Checked files ({count})", { count: checkedCount })}
          </label>
          <label className="gl-check">
            <input type="radio" name="membership-scope" checked={scope === "all"} onChange={() => setScope("all")} />
            {t("All files ({count})", { count: allCount })}
          </label>
        </div>
        {result && "error" in result && <div className="gl-modal-note gl-chorus-stats-warn">{result.error}</div>}
        {result && "written" in result && (
          <div className="gl-modal-note">
            {t("Written: {files}.", { files: result.written.join(", ") })}
            {result.notes.length > 0 && <ul>{result.notes.map((note, i) => <li key={i}>{note}</li>)}</ul>}
          </div>
        )}
        <div className="gl-modal-actions">
          <button onClick={() => void run()} disabled={scopeCount === 0 || running}>{running ? t("Exporting…") : t("Export")}</button>
          <button onClick={onClose}>{t("Close")}</button>
        </div>
      </div>
    </div>
  );
}
