// DriveSaveDialogs.tsx — the lab build's Save As to the lab Drive, and the progress of a new
// experiment's upload with its Cancel. Save As while a Drive workspace is open saves a copy into
// the lab Drive: beside the workspace in its experiment folder under a new name (the default), or
// as a new experiment with its own folder, its FCS uploaded from this computer. A new experiment's
// folder is made in the lab folder, or in a folder inside it, at any depth, chosen in the picker.

import { useState } from "react";
import { useI18n } from "../ui/i18n";
import { ModalEscape } from "../ui/useModalEscape";
import { copyName } from "./save";
import type { DriveFolderRequest, DriveLocation, DriveTarget } from "./types";
import type { NewExperimentProgress } from "./newExperiment";

export interface DriveSaveAsRequest {
  /** "copy": a new workspace file in the experiment folder; "experiment": a new experiment folder. */
  readonly kind: "copy" | "experiment";
  readonly name: string;
  /** Where a new experiment's folder is made; null or absent for the lab folder itself. */
  readonly location?: DriveLocation | null;
}

/** "Lab folder / Project / Subfolder": where a new experiment goes. */
export function locationText(location: DriveLocation | null | undefined, labFolder = "Lab folder"): string {
  return [labFolder, ...(location?.path ?? [])].join(" / ");
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
  /**
   * Choose a new experiment's location in the picker (the session's chooseLocation); `askFolder` is
   * asked before a folder above it that GateLab cannot read yet is chosen.
   */
  readonly chooseLocation: (askFolder: (request: DriveFolderRequest) => Promise<boolean>) => Promise<DriveLocation | null>;
}

const stem = (name: string) => name.replace(/\.gatelab$/i, "");

export function DriveSaveAsDialog({ target, initial, suggestedExperiment, uploads, onCancel, onSave, chooseLocation }: DriveSaveAsDialogProps) {
  const { t } = useI18n();
  const [kind, setKind] = useState<"copy" | "experiment">(target ? initial : "experiment");
  const [names, setNames] = useState(() => ({
    copy: target ? stem(copyName(target.name)) : "",
    experiment: suggestedExperiment,
  }));
  /** Where the new experiment goes; null for the lab folder itself. */
  const [location, setLocation] = useState<DriveLocation | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [asking, setAsking] = useState<{ child: string; resolve: (pick: boolean) => void } | null>(null);
  const [locationProblem, setLocationProblem] = useState<string | null>(null);
  const name = names[kind];
  const blocked = !name.trim() || (kind === "experiment" && (uploads.problem !== null || choosing));
  const save = () => { if (!blocked) onSave({ kind, name: name.trim(), location: kind === "experiment" ? location : null }); };
  const choose = () => {
    setChoosing(true);
    setLocationProblem(null);
    chooseLocation((request) => new Promise<boolean>((resolve) => setAsking({
      child: request.kind === "above" ? request.child : "",
      resolve: (pick) => { setAsking(null); resolve(pick); },
    })))
      .then((chosen) => { if (chosen) setLocation(chosen.path.length > 0 ? chosen : null); },
        (cause: unknown) => setLocationProblem(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setChoosing(false));
  };

  return (
    <div className="gl-modal-backdrop">
      <ModalEscape onClose={kind === "experiment" && asking ? () => asking.resolve(false) : onCancel} />
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
        {kind === "experiment" && (
          <div className="gl-modal-field gl-drive-location">
            {t("Location")}
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <span className="gl-drive-location-path">{locationText(location, t("Lab folder"))}</span>
              <button type="button" className="gl-btn-ghost gl-drive-location-choose" disabled={choosing} onClick={choose}>
                {t("Choose a folder…")}
              </button>
              {location && (
                <button type="button" className="gl-btn-ghost gl-drive-location-reset" disabled={choosing} onClick={() => setLocation(null)}>
                  {t("Lab folder")}
                </button>
              )}
            </div>
          </div>
        )}
        {kind === "experiment" && asking && (
          <div className="gl-drive-location-ask">
            <p className="gl-modal-note">
              {t("\"{child}\" is inside a folder GateLab has not been given, so it cannot yet see that it is in the lab folder. Choose the folder that holds \"{child}\"; this is asked once for each folder. If that folder is not in the lab folder, cancel.", { child: asking.child })}
            </p>
            <div className="gl-modal-actions">
              <button type="button" className="gl-btn-ghost" onClick={() => asking.resolve(false)}>{t("Cancel")}</button>
              <button type="button" className="gl-btn-primary gl-drive-location-above" onClick={() => asking.resolve(true)}>{t("Choose that folder…")}</button>
            </div>
          </div>
        )}
        {kind === "experiment" && locationProblem && <p className="gl-modal-warning">{locationProblem}</p>}
        <p className="gl-modal-note">
          {kind === "copy"
            ? t("The copy is written beside {name}, which is not changed, and from now on Save writes to the copy. The FCS files are already in the folder.", { name: target?.name ?? "" })
            : t("A new folder in {location} holds the workspace and its FCS files ({uploads}), uploaded from this computer. From now on Save writes to the new experiment.", {
                location: locationText(location, t("Lab folder")),
                uploads: uploads.text,
              })}
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
