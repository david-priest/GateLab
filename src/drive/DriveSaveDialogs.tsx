// DriveSaveDialogs.tsx — the lab build's Save As to the lab Drive, and the progress of a new
// experiment's upload with its Cancel. Save As while a Drive workspace is open saves a copy into
// the lab Drive: beside the workspace in its experiment folder under a new name (the default), or
// as a new experiment with its own folder, its FCS uploaded from this computer.

import { useState } from "react";
import { useI18n } from "../ui/i18n";
import { copyName } from "./save";
import type { DriveTarget } from "./types";
import type { NewExperimentProgress } from "./newExperiment";

export interface DriveSaveAsRequest {
  /** "copy": a new workspace file in the experiment folder; "experiment": a new experiment folder. */
  readonly kind: "copy" | "experiment";
  readonly name: string;
}

export interface DriveSaveAsDialogProps {
  /** The Drive workspace open now; without one only a new experiment is offered. */
  readonly target: DriveTarget | null;
  readonly initial: "copy" | "experiment";
  /** The name a new experiment starts with. */
  readonly suggestedExperiment: string;
  /** What a new experiment would upload ("3 FCS files, 412 MiB"), or why it cannot. */
  readonly uploads: { readonly text: string; readonly problem: string | null };
  readonly onCancel: () => void;
  readonly onSave: (request: DriveSaveAsRequest) => void;
}

const stem = (name: string) => name.replace(/\.gatelab$/i, "");

export function DriveSaveAsDialog({ target, initial, suggestedExperiment, uploads, onCancel, onSave }: DriveSaveAsDialogProps) {
  const { t } = useI18n();
  const [kind, setKind] = useState<"copy" | "experiment">(target ? initial : "experiment");
  const [names, setNames] = useState(() => ({
    copy: target ? stem(copyName(target.name)) : "",
    experiment: suggestedExperiment,
  }));
  const name = names[kind];
  const blocked = !name.trim() || (kind === "experiment" && uploads.problem !== null);
  const save = () => { if (!blocked) onSave({ kind, name: name.trim() }); };

  return (
    <div className="gl-modal-backdrop">
      <div className="gl-modal gl-drive-save-as" role="dialog" aria-modal="true" aria-label={t("Save As in the lab Drive")}>
        <div className="gl-modal-title">{target ? t("Save As in the lab Drive") : t("Save as new experiment")}</div>
        {target && (
          <>
            <label className="gl-modal-check">
              <input type="radio" name="gl-drive-save-as" className="gl-drive-save-as-copy" checked={kind === "copy"} onChange={() => setKind("copy")} />
              <span>{t("A copy in this experiment's folder, {experiment}", { experiment: target.experiment })}</span>
            </label>
            <label className="gl-modal-check">
              <input type="radio" name="gl-drive-save-as" className="gl-drive-save-as-experiment" checked={kind === "experiment"} onChange={() => setKind("experiment")} />
              <span>{t("A new experiment, with its own folder")}</span>
            </label>
          </>
        )}
        <label className="gl-modal-field">
          {kind === "copy" ? t("Workspace file (.gatelab)") : t("Experiment")}
          <input
            type="text"
            value={name}
            spellCheck={false}
            onChange={(event) => setNames((current) => ({ ...current, [kind]: event.target.value }))}
            onKeyDown={(event) => { if (event.key === "Enter") save(); }}
          />
        </label>
        <p className="gl-modal-note">
          {kind === "copy"
            ? t("The copy is written beside {name}, which is not changed, and from now on Save writes to the copy. The FCS files are already in the folder.", { name: target?.name ?? "" })
            : t("A new folder in the lab Drive holds the workspace and its FCS files ({uploads}), uploaded from this computer. From now on Save writes to the new experiment.", { uploads: uploads.text })}
        </p>
        {kind === "experiment" && uploads.problem && <p className="gl-modal-warning">{uploads.problem}</p>}
        <div className="gl-modal-actions">
          <button type="button" className="gl-btn-ghost" onClick={onCancel}>{t("Cancel")}</button>
          <button type="button" className="gl-btn-primary gl-drive-save-as-ok" disabled={blocked} onClick={save}>{t("Save")}</button>
        </div>
      </div>
    </div>
  );
}

export interface DriveUploadDialogProps {
  readonly experiment: string;
  readonly progress: NewExperimentProgress | null;
  readonly cancelling: boolean;
  readonly onCancel: () => void;
}

const mib = (bytes: number) => (bytes / 1048576).toFixed(bytes < 10 * 1048576 ? 1 : 0);

export function DriveUploadDialog({ experiment, progress, cancelling, onCancel }: DriveUploadDialogProps) {
  const { t } = useI18n();
  const step = !progress || progress.phase === "folder"
    ? t("Making the experiment folder")
    : progress.phase === "workspace"
      ? t("Writing the workspace file")
      : `${t("File {index} of {count}", { index: progress.index, count: progress.count })} · ${progress.file ?? ""}` +
        (progress.phase === "checking"
          ? ` · ${t("checking the folder")}`
          : progress.phase === "verifying"
            ? ` · ${t("reading its checksum")}`
            : "");
  return (
    <div className="gl-modal-backdrop">
      <div className="gl-modal gl-drive-upload" role="dialog" aria-modal="true" aria-label={t("Saving to the lab Drive")}>
        <div className="gl-modal-title">{t("Saving as new experiment: {experiment}", { experiment })}</div>
        <p className="gl-modal-note gl-drive-upload-step">{cancelling ? t("Cancelling…") : step}</p>
        <progress
          className="gl-drive-upload-progress"
          style={{ display: "block", width: "100%" }}
          value={progress?.sentBytes ?? 0}
          max={Math.max(1, progress?.totalBytes ?? 1)}
        />
        <p className="gl-modal-note">
          {progress ? t("{sent} of {total} MiB", { sent: mib(progress.sentBytes), total: mib(progress.totalBytes) }) : " "}
        </p>
        <div className="gl-modal-actions">
          {/* Once every file is up, the workspace file is written whole: nothing is left to cancel. */}
          <button
            type="button"
            className="gl-btn-ghost gl-drive-upload-cancel"
            disabled={cancelling || progress?.phase === "workspace"}
            onClick={onCancel}
          >
            {t("Cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
