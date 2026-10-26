// MiflowcytReportModal.tsx — the MIFlowCyt report: the items only the author can supply, kept in
// the workspace as they are typed, and the files to report on. The report itself is built by
// reports/miflowcytReport.ts from what GateLab holds; this file only collects and lays out.

import { useState } from "react";
import type { MiflowcytAuthorInput } from "../reports/miflowcytReport";
import { MIFLOWCYT_AUTHOR_FIELDS, splitKeywords } from "../reports/miflowcytAuthor";
import { useI18n } from "./i18n";
import { ModalEscape } from "./useModalEscape";

export type ReportScope = "viewed" | "checked" | "all";

interface Props {
  author: MiflowcytAuthorInput;
  onAuthorChange: (next: MiflowcytAuthorInput) => void;
  viewedName: string | null;
  checkedCount: number;
  allCount: number;
  onDownload: (format: "html" | "md", scope: ReportScope, minEvents: number | null) => void;
  onClose: () => void;
}

const SECTIONS: { key: "overview" | "specimen" | "analysis"; title: string }[] = [
  { key: "overview", title: "Experiment overview" },
  { key: "specimen", title: "Flow sample" },
  { key: "analysis", title: "Data analysis" },
];

export function MiflowcytReportModal({ author, onAuthorChange, viewedName, checkedCount, allCount, onDownload, onClose }: Props) {
  const { t } = useI18n();
  const [scope, setScope] = useState<ReportScope>(viewedName ? "viewed" : "all");
  const [minText, setMinText] = useState("");
  // Keywords are typed as one line; split on every change would eat the comma being typed.
  const [keywordText, setKeywordText] = useState((author.keywords ?? []).join(", "));
  const minEvents = minText.trim() === "" ? null : Number(minText);
  const minValid = minEvents === null || (Number.isInteger(minEvents) && minEvents > 0);
  const scopeCount = scope === "viewed" ? (viewedName ? 1 : 0) : scope === "checked" ? checkedCount : allCount;

  const set = (key: keyof MiflowcytAuthorInput, value: string) => {
    if (key === "keywords") {
      setKeywordText(value);
      onAuthorChange({ ...author, keywords: splitKeywords(value) });
    } else {
      onAuthorChange({ ...author, [key]: value });
    }
  };

  return (
    <div className="gl-modal-backdrop" onClick={onClose}>
      <ModalEscape onClose={onClose} />
      <div className="gl-modal gl-miflowcyt" role="dialog" aria-label="MIFlowCyt report" onClick={(e) => e.stopPropagation()}>
        <div className="gl-modal-title">{t("MIFlowCyt report")}</div>
        <div className="gl-modal-note">
          {t("A report organised as MIFlowCyt 1.0 (Lee et al., Cytometry A 2008): the instrument and parameter keywords the data carry, the compensation applied with its matrix, every gate's boundary in the space it is evaluated in, and each population's count with its denominator named. The items below are the author's to supply; they are saved with the workspace, and any left empty is listed in the report as not recorded.")}
        </div>

        <div className="gl-miflowcyt-fields">
          {SECTIONS.map((section) => (
            <fieldset key={section.key} className="gl-miflowcyt-section">
              <legend>{t(section.title)}</legend>
              {MIFLOWCYT_AUTHOR_FIELDS.filter((f) => f.section === section.key).map((f) => {
                const value = f.key === "keywords" ? keywordText : (author[f.key] as string | undefined) ?? "";
                return (
                  <label key={f.key} className="gl-miflowcyt-field">
                    <span>{t(f.label)}</span>
                    {f.multiline
                      ? <textarea rows={2} value={value} placeholder={t(f.placeholder)} onChange={(e) => set(f.key, e.target.value)} />
                      : <input type="text" value={value} placeholder={t(f.placeholder)} onChange={(e) => set(f.key, e.target.value)} />}
                  </label>
                );
              })}
            </fieldset>
          ))}
        </div>

        <div className="gl-miflowcyt-options">
          <span>{t("Files")}:</span>
          <label className="gl-check">
            <input type="radio" name="miflowcyt-scope" checked={scope === "viewed"} disabled={!viewedName} onChange={() => setScope("viewed")} />
            {viewedName ? t("Viewed file ({name})", { name: viewedName }) : t("Viewed file")}
          </label>
          <label className="gl-check">
            <input type="radio" name="miflowcyt-scope" checked={scope === "checked"} disabled={checkedCount === 0} onChange={() => setScope("checked")} />
            {t("Checked files ({count})", { count: checkedCount })}
          </label>
          <label className="gl-check">
            <input type="radio" name="miflowcyt-scope" checked={scope === "all"} onChange={() => setScope("all")} />
            {t("All files ({count})", { count: allCount })}
          </label>
          <label className="gl-check" title={t("Counts below this are marked in the report's statistics tables. Empty: none are marked.")}>
            {t("Mark counts below")}
            <input type="number" min={1} step={1} value={minText} onChange={(e) => setMinText(e.target.value)} style={{ width: 80, marginLeft: 6 }} aria-invalid={!minValid} />
            {t("events")}
          </label>
        </div>

        <div className="gl-modal-actions">
          <button onClick={() => onDownload("html", scope, minEvents)} disabled={scopeCount === 0 || !minValid}>{t("Download HTML")}</button>
          <button onClick={() => onDownload("md", scope, minEvents)} disabled={scopeCount === 0 || !minValid}>{t("Download Markdown")}</button>
          <button onClick={onClose}>{t("Close")}</button>
        </div>
      </div>
    </div>
  );
}
