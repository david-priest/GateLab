import { useState, type KeyboardEvent } from "react";
import {
  compensationComparisonDownloadName,
  compensationComparisonPageCount,
  type CompensationComparisonExportFormat,
  type CompensationComparisonExportProgress,
} from "../plots/compensationComparisonExport";

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
        <div className="gl-modal-title" id="comp-comparison-export-title">Export compensation comparison</div>
        <p className="gl-comp-export-intro">
          Export the currently filtered channel pairs as clean paired Original and Compensated biplots.
          Every pair retains the same frozen events, axes, transform, density scale, and edge piling in both panels.
        </p>

        <fieldset className="gl-comp-export-versions gl-comp-comparison-export-formats">
          <legend>Format</legend>
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
              <span><strong>{option.title}</strong><small>{option.detail}</small></span>
            </label>
          ))}
        </fieldset>

        <dl className="gl-comp-export-summary gl-comp-comparison-export-summary">
          <div><dt>File</dt><dd title={fileName}>{fileName}</dd></div>
          <div><dt>Scope</dt><dd>{pairCount.toLocaleString()} filtered pair{pairCount === 1 ? "" : "s"} · both assays</dd></div>
          <div><dt>Pages</dt><dd>{pageCount.toLocaleString()} A4 landscape page{pageCount === 1 ? "" : "s"} · six pairs per page</dd></div>
          <div><dt>Population</dt><dd title={populationName}>{populationName}</dd></div>
          <div><dt>Filter</dt><dd title={filterLabel}>{filterLabel}</dd></div>
        </dl>

        {progress && (
          <div className="gl-comp-comparison-export-progress" role="status" aria-live="polite">
            <progress max={Math.max(1, progress.totalPages)} value={progress.completedPages} />
            <span>Rendering page {Math.min(progress.completedPages + 1, progress.totalPages)} of {progress.totalPages}</span>
          </div>
        )}
        {error && <div className="gl-comp-warning" role="alert">{error}</div>}
        <div className="gl-modal-actions">
          <button type="button" className="gl-btn-ghost" disabled={busy} onClick={onClose}>Cancel</button>
          <button type="button" className="gl-btn" disabled={busy || pageCount === 0} onClick={() => void runExport()}>
            {busy ? "Rendering…" : `Download ${format.toUpperCase()}`}
          </button>
        </div>
      </div>
    </div>
  );
}
