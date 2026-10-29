// The Compensation tab's Matrices list: the workspace's matrices and each file's embedded one,
// one of them active for every file. Rows come from compensationLibrary.ts; switching, importing,
// renaming and the rest are the App's (they change the workspace), passed in as callbacks.

import { useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import { pickFilesOrInput } from "../engine/fsAccess";
import { copyName, type MatrixLibraryRow, type MatrixSource, type MatrixSwitchPlan } from "./compensationLibrary";
import { CompensationMatrixExportDialog } from "./CompensationMatrixExportDialog";
import { useI18n } from "./i18n";
import { MatrixIcon, MoreIcon } from "./icons";
import { MenuButton, type MenuEntry } from "./MenuButton";

export interface CompensationMatricesProps {
  readonly rows: readonly MatrixLibraryRow[];
  readonly fileCount: number;
  /**
   * Files on their own embedded matrix while the workspace stores matrices: no format writes the
   * two together, so the workspace cannot be saved, nor a checkpoint taken, until they part.
   */
  readonly unsavedEmbeddedFiles?: readonly string[];
  /** An Apply is running: nothing that changes the workspace's matrices starts. */
  readonly busy: boolean;
  readonly planSwitch: (row: MatrixLibraryRow) => MatrixSwitchPlan;
  /** Absent where the active matrix cannot be switched here (a hosted SCE). */
  readonly onUse?: (row: MatrixLibraryRow) => Promise<void>;
  readonly onRename: (row: MatrixLibraryRow, name: string) => void;
  readonly onDuplicate: (row: MatrixLibraryRow) => Promise<void>;
  /**
   * "Duplicate and edit…": stores a copy of the row's matrix under `name` and uses it for every file,
   * so the coefficient editor and its plots work on the copy and the row stays as it was. Absent
   * where the active matrix cannot be switched here (a hosted SCE).
   */
  readonly onDuplicateAndEdit?: (row: MatrixLibraryRow, name: string) => Promise<void>;
  /** Set by the Compensation tab: the copy is active, so the tab shows its coefficient editor. */
  readonly onEditStarted?: (name: string) => void;
  readonly onDelete: (row: MatrixLibraryRow) => void;
  /** Adds the file's matrix to the list without using it; resolves to what to tell the user. */
  readonly onImport: (file: File) => Promise<string>;
}

function sourceText(source: MatrixSource, t: ReturnType<typeof useI18n>["t"]): string {
  if (source.type === "embedded") return t("Embedded · {file}", { file: source.fileName });
  if (source.type === "external") return t("From {file}", { file: source.label });
  if (source.type === "imported") return t("Imported · {file}", { file: source.fileName });
  if (source.type === "edited") return t("Edited from {name}", { name: source.from });
  if (source.type === "empty") return t("Empty");
  return t("Preset · {name}", { name: source.presetId });
}

/** A matrix's short name, M1, M2, …, with the matrix icon; the primary matrix's is filled. */
export function MatrixTag({ row }: { row: Pick<MatrixLibraryRow, "number" | "primary"> }) {
  const { t } = useI18n();
  if (row.number === null) return null;
  const tag = `M${row.number}`;
  return (
    <span
      className={"gl-comp-lib-tag" + (row.primary ? " is-primary" : "")}
      title={row.primary ? t("{tag}, the primary matrix: the one in use when the data came in", { tag }) : tag}
    >
      <MatrixIcon size={12} />
      {tag}
    </span>
  );
}

/** A row's name with its M-number in front, for dialogs and messages. */
export function matrixLabel(row: Pick<MatrixLibraryRow, "number" | "name">): string {
  return row.number === null ? row.name : `M${row.number} ${row.name}`;
}

export function CompensationMatrices({
  rows,
  fileCount,
  unsavedEmbeddedFiles = [],
  busy,
  planSwitch,
  onUse,
  onRename,
  onDuplicate,
  onDuplicateAndEdit,
  onEditStarted,
  onDelete,
  onImport,
}: CompensationMatricesProps) {
  const { t } = useI18n();
  const fileRef = useRef<HTMLInputElement>(null);
  const [renaming, setRenaming] = useState<{ id: string; draft: string } | null>(null);
  const [switching, setSwitching] = useState<MatrixLibraryRow | null>(null);
  /** The row "Duplicate and edit…" copies, and the copy's name. */
  const [editing, setEditing] = useState<{ row: MatrixLibraryRow; copy: string } | null>(null);
  const [deleting, setDeleting] = useState<MatrixLibraryRow | null>(null);
  const [exporting, setExporting] = useState<MatrixLibraryRow | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  const importFile = async (file: File) => {
    setMessage(null);
    try {
      setMessage({ text: await onImport(file), error: false });
    } catch (cause) {
      setMessage({ text: cause instanceof Error ? cause.message : String(cause), error: true });
    }
  };
  const handleFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (file) void importFile(file);
  };
  /** Opens through the shared picker (last-used folder) where the browser has it. */
  const chooseFile = () =>
    void pickFilesOrInput(fileRef.current, { "text/csv": [".csv", ".tsv", ".txt"] }, "Spillover matrix").then((files) => {
      if (files?.[0]) void importFile(files[0]);
    });

  const commitRename = () => {
    if (!renaming) return;
    const row = rows.find(({ id }) => id === renaming.id);
    setRenaming(null);
    if (row && renaming.draft.trim() !== row.name) onRename(row, renaming.draft);
  };

  const duplicate = async (row: MatrixLibraryRow) => {
    setMessage(null);
    try {
      await onDuplicate(row);
    } catch (cause) {
      setMessage({ text: cause instanceof Error ? cause.message : String(cause), error: true });
    }
  };

  const menuFor = (row: MatrixLibraryRow): MenuEntry[] => [
    {
      label: t("Use for the workspace…"),
      className: "gl-comp-lib-use",
      disabled: busy || !onUse || row.unusable !== null || (row.active && row.filesUsing === fileCount),
      title: !onUse
        ? t("The matrix of a hosted SCE is chosen in R.")
        : row.unusable !== null
          ? t("GateLab cannot store this matrix, so only its own file uses it: {reason}", { reason: row.unusable })
          : row.active && row.filesUsing === fileCount
            ? t("Every file is already compensated with this matrix.")
            : undefined,
      onClick: () => setSwitching(row),
    },
    ...(row.canRename
      ? [{
          label: t("Rename…"),
          className: "gl-comp-lib-rename",
          disabled: busy,
          onClick: () => setRenaming({ id: row.id, draft: row.name }),
        }]
      : []),
    {
      label: t("Duplicate and edit…"),
      className: "gl-comp-lib-edit",
      disabled: busy || !onDuplicateAndEdit || row.unusable !== null,
      title: !onDuplicateAndEdit
        ? t("The matrix of a hosted SCE is chosen in R.")
        : row.unusable !== null
          ? t("GateLab cannot store this matrix, so only its own file uses it: {reason}", { reason: row.unusable })
          : t("Copy this matrix, use the copy for every file and edit its coefficients beside the plots. This matrix stays as it is."),
      onClick: () => setEditing({ row, copy: copyName(row.name, new Set(rows.map(({ name }) => name))) }),
    },
    { label: t("Duplicate"), className: "gl-comp-lib-duplicate", disabled: busy || row.unusable !== null, onClick: () => void duplicate(row) },
    { label: t("Export CSV…"), className: "gl-comp-lib-export", onClick: () => setExporting(row) },
    ...(row.canDelete
      ? [{ label: t("Delete…"), className: "gl-comp-lib-delete", danger: true, disabled: busy, onClick: () => setDeleting(row) }]
      : []),
  ];

  // The matrix the files are compensated with now, for the Export button beside Import.
  const activeRow = rows.find(({ active }) => active) ?? null;

  return (
    <section className="gl-comp-matrices" aria-labelledby="comp-matrices-heading">
      <div className="gl-comp-matrices-head">
        <h3 id="comp-matrices-heading">{t("Matrices")}</h3>
        <button type="button" className="gl-mini-btn" disabled={busy} onClick={chooseFile}>
          {t("Import CSV/TSV…")}
        </button>
        <button
          type="button"
          className="gl-mini-btn gl-comp-lib-export-active"
          disabled={!activeRow}
          title={activeRow
            ? t("Download {name}, the matrix in use, as a CSV table that Import CSV/TSV… reads back.", { name: activeRow.name })
            : t("No matrix is in use.")}
          onClick={() => activeRow && setExporting(activeRow)}
        >
          {t("Export CSV…")}
        </button>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain"
        className="gl-sr-only"
        aria-label={t("Import a spillover matrix")}
        onChange={handleFile}
      />
      {rows.length === 0 ? (
        <p className="gl-hint">{t("No matrix yet: the files carry none, and none has been imported.")}</p>
      ) : (
        <ul className="gl-comp-lib-list" aria-label={t("Matrices")}>
          {rows.map((row) => (
            <li key={row.id} className={"gl-comp-lib-row" + (row.active ? " is-active" : "")} data-matrix-id={row.id}>
              <div className="gl-comp-lib-text">
                {renaming?.id === row.id ? (
                  <input
                    className="gl-comp-lib-name-input"
                    aria-label={t("Name of {name}", { name: row.name })}
                    value={renaming.draft}
                    autoFocus
                    maxLength={200}
                    onChange={(event) => setRenaming({ id: row.id, draft: event.currentTarget.value })}
                    onBlur={commitRename}
                    onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
                      if (event.key === "Enter") { event.preventDefault(); commitRename(); }
                      else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setRenaming(null); }
                    }}
                  />
                ) : (
                  <span className="gl-comp-lib-title">
                    <MatrixTag row={row} />
                    <span className="gl-comp-lib-name" title={row.name}>{row.name}</span>
                  </span>
                )}
                <span className="gl-comp-lib-meta">
                  {row.primary ? `${t("Primary")} · ` : ""}
                  {sourceText(row.source, t)}
                  {" · "}
                  {t("{count} channels", { count: row.channelCount })}
                  {row.active && row.filesUsing !== fileCount
                    ? ` · ${t("{used} of {files} files", { used: row.filesUsing, files: fileCount })}`
                    : ""}
                </span>
                {row.unusable !== null && (
                  <span className="gl-comp-lib-unusable" title={row.unusable}>{t("Only its own file can use it")}</span>
                )}
              </div>
              {row.active && <span className="gl-comp-lib-active">{t("Active")}</span>}
              <MenuButton
                label={t("{name}: matrix actions", { name: row.name })}
                items={menuFor(row)}
                icon={<MoreIcon size={16} />}
                className="gl-comp-lib-menu"
              />
            </li>
          ))}
        </ul>
      )}
      {unsavedEmbeddedFiles.length > 0 && (
        <p className="gl-hint gl-comp-lib-unsaved">
          {t("The workspace cannot be saved while files use their own embedded matrix beside stored matrices: {files}. Use a matrix for the workspace, set those files to Original, or delete the stored matrices no file uses.", {
            files: unsavedEmbeddedFiles.join(", "),
          })}
        </p>
      )}
      {message && (
        <div className={message.error ? "gl-comp-error" : "gl-comp-status"} role={message.error ? "alert" : "status"}>
          {message.text}
        </div>
      )}
      {editing && onDuplicateAndEdit && (
        <MatrixSwitchDialog
          row={editing.row}
          copy={editing.copy}
          plan={planSwitch(editing.row)}
          revertible={unsavedEmbeddedFiles.length === 0}
          busy={busy}
          onUse={async (row) => {
            await onDuplicateAndEdit(row, editing.copy);
            setMessage(null);
            onEditStarted?.(editing.copy);
          }}
          onClose={() => setEditing(null)}
        />
      )}
      {switching && onUse && (
        <MatrixSwitchDialog
          row={switching}
          plan={planSwitch(switching)}
          revertible={unsavedEmbeddedFiles.length === 0}
          busy={busy}
          onUse={async (row) => {
            await onUse(row);
            // An import's "not in use" no longer holds once a matrix is used.
            setMessage(null);
          }}
          onClose={() => setSwitching(null)}
        />
      )}
      {deleting && (
        <div className="gl-modal-backdrop" onKeyDown={(event) => { if (event.key === "Escape") setDeleting(null); }}>
          <div className="gl-modal gl-comp-lib-dialog" role="dialog" aria-modal="true" aria-labelledby="comp-matrix-delete-title">
            <div className="gl-modal-title" id="comp-matrix-delete-title">{t("Delete {name}?", { name: matrixLabel(deleting) })}</div>
            <p>{t("It leaves the workspace's list of matrices. No file is compensated with it.")}</p>
            <div className="gl-modal-actions">
              <button type="button" className="gl-btn-ghost" autoFocus onClick={() => setDeleting(null)}>{t("Cancel")}</button>
              <button
                type="button"
                className="gl-btn gl-btn-danger"
                onClick={() => { onDelete(deleting); setDeleting(null); }}
              >
                {t("Delete")}
              </button>
            </div>
          </div>
        </div>
      )}
      {exporting && (
        <CompensationMatrixExportDialog
          profileLabel={exporting.name}
          installedLabel={exporting.name}
          installedMatrix={exporting.exportMatrix}
          onClose={() => setExporting(null)}
        />
      )}
    </section>
  );
}

/**
 * "Use for the workspace…": what switching does, before it does it. The user agrees that gate
 * membership may change (David, 2026-10-23), and a file the matrix cannot compensate refuses the
 * switch by name rather than being left uncompensated.
 */
function MatrixSwitchDialog({
  row,
  copy,
  plan,
  revertible,
  busy,
  onUse,
  onClose,
}: {
  row: MatrixLibraryRow;
  /** "Duplicate and edit…": the copy's name. The copy, not the row, is used for the workspace. */
  copy?: string;
  plan: MatrixSwitchPlan;
  /** False where the workspace as it stands cannot be written, so Revert workspace cannot return to it. */
  revertible: boolean;
  busy: boolean;
  onUse: (row: MatrixLibraryRow) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [agreed, setAgreed] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refused = plan.uncovered.length > 0;

  const confirm = async () => {
    setRunning(true);
    setError(null);
    try {
      await onUse(row);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="gl-modal-backdrop" onKeyDown={(event) => { if (event.key === "Escape" && !running) onClose(); }}>
      <div className="gl-modal gl-comp-lib-dialog gl-comp-lib-switch" role="dialog" aria-modal="true" aria-labelledby="comp-matrix-switch-title">
        <div className="gl-modal-title" id="comp-matrix-switch-title">
          {copy === undefined ? t("Use {name} for the workspace", { name: matrixLabel(row) }) : t("Duplicate and edit {name}", { name: matrixLabel(row) })}
        </div>
        {copy === undefined ? (
          <p>{t("Every file in the workspace ({count}) is compensated with {name}.", { count: plan.fileCount, name: row.name })}</p>
        ) : (
          <>
            <p className="gl-comp-lib-copy">
              {t("GateLab stores a copy, {copy}, and compensates every file in the workspace ({count}) with it, so the plots show each coefficient you change. {name} stays in the list as it is; use it again to go back.", {
                copy,
                count: plan.fileCount,
                name: row.name,
              })}
            </p>
            <p>{t("Edited coefficients change no file until you choose Apply revised matrix, which asks again.")}</p>
          </>
        )}
        <p>
          {plan.gateCount > 0
            ? t("Membership is recomputed for {gates} gates and {populations} populations drawn on channels this matrix compensates.", {
                gates: plan.gateCount,
                populations: plan.populationCount,
              })
            : t("No gate is drawn on a channel this matrix compensates.")}
        </p>
        {plan.leavingEmbedded.length > 0 && (
          <p className="gl-comp-lib-leaving">
            {t("Leaving their own embedded matrix: {files}.", { files: plan.leavingEmbedded.join(", ") })}
          </p>
        )}
        {!revertible && !refused && (
          <p className="gl-comp-lib-irreversible">
            {t("The workspace as it stands cannot be saved, so Revert workspace cannot return to it afterwards; it returns to the last state that was saved or checkpointed.")}
          </p>
        )}
        {refused && (
          <div className="gl-comp-error gl-comp-lib-uncovered" role="alert">
            <p>{t("These files cannot be compensated with this matrix, so it cannot be used for the workspace:")}</p>
            <ul>
              {plan.uncovered.map((file) => (
                <li key={file.name}>
                  {file.wrongInstrument
                    ? t("{file}: not a file of this instrument kind", { file: file.name })
                    : file.missingChannels.length > 0
                      ? t("{file}: lacks {channels}", { file: file.name, channels: file.missingChannels.join(", ") })
                      : t("{file}: {reason}", { file: file.name, reason: file.message ?? "" })}
                </li>
              ))}
            </ul>
            <p>{t("Remove these files from the workspace, or choose a matrix that covers their channels.")}</p>
          </div>
        )}
        {!refused && (
          <label className="gl-comp-gate-acknowledgement">
            <input
              type="checkbox"
              checked={agreed}
              disabled={running}
              onChange={(event) => setAgreed(event.currentTarget.checked)}
            />
            <span>{t("I agree that gate membership may change.")}</span>
          </label>
        )}
        {error && <div className="gl-comp-error" role="alert">{error}</div>}
        <div className="gl-modal-actions">
          <button type="button" className="gl-btn-ghost" disabled={running} onClick={onClose}>{t("Cancel")}</button>
          <button
            type="button"
            className="gl-btn"
            disabled={refused || !agreed || running || busy}
            onClick={() => void confirm()}
          >
            {running ? t("Compensating…") : copy === undefined ? t("Use for the workspace") : t("Make the copy and edit")}
          </button>
        </div>
      </div>
    </div>
  );
}
