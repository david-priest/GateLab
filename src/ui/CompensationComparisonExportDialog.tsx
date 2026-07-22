import { useState, type KeyboardEvent } from "react";
import {
  compensationComparisonDownloadName,
  compensationComparisonPageCount,
  type CompensationComparisonExportFormat,
  type CompensationComparisonExportProgress,
} from "../plots/compensationComparisonExport";
import { useI18n } from "./i18n";

interface Props {
  readonly sampleName: string;
  readonly populationName: string;
  readonly filterLabel: string;
  readonly pairCount: number;
  readonly onExport: (
    format: CompensationComparisonExportFormat,
    onProgress: (progress: CompensationComparisonExportProgress) => void,
  ) => Promise<void>;
  readonly onClose: () => void;
}

const FORMAT_DETAILS: ReadonlyArray<Readonly<{
  format: CompensationComparisonExportFormat;
  title: string;
  detail: string;
}>> = [
  { format: "pdf", title: "PDF", detail: "One multipage A4 landscape document." },
  { format: "png", title: "PNG", detail: "300 DPI numbered pages; multiple pages download as a ZIP." },
  { format: "svg", title: "SVG", detail: "Vector text and axes with embedded high-resolution density layers; multiple pages download as a ZIP." },
];

export function CompensationComparisonExportDialog({
  sampleName,
  populationName,
  filterLabel,
  pairCount,
  onExport,
  onClose,
}: Props) {
  const { t } = useI18n();
  const [format, setFormat] = useState<CompensationComparisonExportFormat>("pdf");
  const [progress, setProgress] = useState<CompensationComparisonExportProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pageCount = compensationComparisonPageCount(pairCount);
  const busy = progress !== null && progress.completedPages < progress.totalPages;
  const fileName = compensationComparisonDownloadName(sampleName, populationName, format, pageCount);

  const runExport = async () => {
    setError(null);
    setProgress({ completedPages: 0, totalPages: pageCount });
    try {
      await onExport(format, setProgress);
      onClose();
    } catch (cause) {
      setProgress(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && !busy) onClose();
  };

  return (
    <div className="gl-modal-backdrop" onKeyDown={handleKeyDown}>
      <div
        className="gl-modal gl-comp-export-modal gl-comp-comparison-export-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="comp-comparison-export-title"
      >
        <div className="gl-modal-title" id="comp-comparison-export-title">{t("Export compensation comparison")}</div>
        <p className="gl-comp-export-intro">
          {t("Export the currently filtered channel pairs as clean paired Original and Compensated biplots. Every pair retains the same frozen events, axes, transform, density scale, and edge piling in both panels.")}
        </p>

        <fieldset className="gl-comp-export-versions gl-comp-comparison-export-formats">
          <legend>{t("Format")}</legend>
          {FORMAT_DETAILS.map((option) => (
            <label key={option.format}>
              <input
                type="radio"
                name="compensation-comparison-export-format"
                value={option.format}
                checked={format === option.format}
                disabled={busy}
                onChange={() => setFormat(option.format)}
              />
              <span><strong>{option.title}</strong><small>{t(option.detail)}</small></span>
            </label>
          ))}
        </fieldset>

        <dl className="gl-comp-export-summary gl-comp-comparison-export-summary">
          <div><dt>{t("File")}</dt><dd title={fileName}>{fileName}</dd></div>
          <div><dt>{t("Scope")}</dt><dd>{t(pairCount === 1 ? "{count} filtered pair · both assays" : "{count} filtered pairs · both assays", { count: pairCount.toLocaleString() })}</dd></div>
          <div><dt>{t("Pages")}</dt><dd>{t(pageCount === 1 ? "{count} A4 landscape page · six pairs per page" : "{count} A4 landscape pages · six pairs per page", { count: pageCount.toLocaleString() })}</dd></div>
          <div><dt>{t("Population")}</dt><dd title={populationName}>{populationName}</dd></div>
          <div><dt>{t("Filter")}</dt><dd title={filterLabel}>{filterLabel}</dd></div>
        </dl>

        {progress && (
          <div className="gl-comp-comparison-export-progress" role="status" aria-live="polite">
            <progress max={Math.max(1, progress.totalPages)} value={progress.completedPages} />
            <span>{t("Rendering page {current} of {total}", { current: Math.min(progress.completedPages + 1, progress.totalPages), total: progress.totalPages })}</span>
          </div>
        )}
        {error && <div className="gl-comp-warning" role="alert">{t(error)}</div>}
        <div className="gl-modal-actions">
          <button type="button" className="gl-btn-ghost" disabled={busy} onClick={onClose}>{t("Cancel")}</button>
          <button type="button" className="gl-btn" disabled={busy || pageCount === 0} onClick={() => void runExport()}>
            {busy ? t("Rendering…") : t("Download {format}", { format: format.toUpperCase() })}
          </button>
        </div>
      </div>
    </div>
  );
}
