import { useMemo, useState, type KeyboardEvent } from "react";
import type { CompensationMatrixInput } from "../engine/compensationProfile";
import {
  compensationMatrixCsvFileName,
  compensationMatrixRImportSnippet,
  serializeCompensationMatrixCsv,
  type CompensationMatrixExportVariant,
} from "../engine/compensationMatrixExport";

interface Props {
  readonly profileLabel: string;
  readonly installedLabel: string;
  readonly installedMatrix: CompensationMatrixInput;
  readonly workingMatrix?: CompensationMatrixInput | null;
  readonly pendingEditCount?: number;
  readonly onClose: () => void;
}

export function CompensationMatrixExportDialog({
  profileLabel,
  installedLabel,
  installedMatrix,
  workingMatrix = null,
  pendingEditCount = 0,
  onClose,
}: Props) {
  const [variant, setVariant] = useState<CompensationMatrixExportVariant>("installed");
  const [message, setMessage] = useState<string | null>(null);
  const selectedMatrix = variant === "working" && workingMatrix
    ? workingMatrix
    : installedMatrix;
  const fileName = compensationMatrixCsvFileName(profileLabel, variant);
  const rSnippet = useMemo(
    () => compensationMatrixRImportSnippet(fileName),
    [fileName],
  );

  const downloadCsv = () => {
    setMessage(null);
    try {
      const csv = serializeCompensationMatrixCsv(selectedMatrix);
      const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = fileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const copyRCode = async () => {
    if (!navigator.clipboard?.writeText) {
      setMessage("Clipboard access is unavailable; select the R code below and copy it manually.");
      return;
    }
    try {
      await navigator.clipboard.writeText(rSnippet);
      setMessage("R import code copied.");
    } catch {
      setMessage("Clipboard access was denied; select the R code below and copy it manually.");
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") onClose();
  };

  return (
    <div className="gl-modal-backdrop" onKeyDown={handleKeyDown}>
      <div
        className="gl-modal gl-comp-export-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="comp-export-title"
      >
        <div className="gl-modal-title" id="comp-export-title">Export spill matrix</div>
        <p className="gl-comp-export-intro">
          Coefficients are exported as exact fractions, not the rounded percentages shown in the matrix.
          Source channels are rows and receiver channels are columns. The CSV can be imported by GateLab or base R.
        </p>

        {workingMatrix && pendingEditCount > 0 && (
          <fieldset className="gl-comp-export-versions">
            <legend>Matrix version</legend>
            <label>
              <input
                type="radio"
                name="compensation-export-version"
                value="installed"
                checked={variant === "installed"}
                onChange={() => setVariant("installed")}
              />
              <span><strong>{installedLabel}</strong><small>Current applied scientific record</small></span>
            </label>
            <label>
              <input
                type="radio"
                name="compensation-export-version"
                value="working"
                checked={variant === "working"}
                onChange={() => setVariant("working")}
              />
              <span>
                <strong>Working draft</strong>
                <small>{pendingEditCount} pending edit{pendingEditCount === 1 ? "" : "s"}; not yet applied</small>
              </span>
            </label>
          </fieldset>
        )}

        <dl className="gl-comp-export-summary">
          <div><dt>File</dt><dd>{fileName}</dd></div>
          <div><dt>Dimensions</dt><dd>{selectedMatrix.sourceChannels.length} sources × {selectedMatrix.receiverChannels.length} receivers</dd></div>
          <div><dt>Units</dt><dd>Fractions (2.9% is written as 0.029)</dd></div>
        </dl>

        <div className="gl-comp-export-r-head">
          <div>
            <strong>Import in R</strong>
            <span>Run after placing the CSV in the R working directory.</span>
          </div>
          <button type="button" className="gl-mini-btn" onClick={() => void copyRCode()}>
            Copy R code
          </button>
        </div>
        <pre className="gl-comp-export-code"><code>{rSnippet}</code></pre>
        {message && (
          <div className={message.includes("copied") ? "gl-comp-status" : "gl-comp-warning"} role="status">
            {message}
          </div>
        )}
        <div className="gl-modal-actions">
          <button type="button" className="gl-btn-ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="gl-btn" onClick={downloadCsv}>Download CSV</button>
        </div>
      </div>
    </div>
  );
}
