import type { WorkspaceFcsRequirement } from "../engine/workspaceRelink";
import { useI18n } from "./i18n";

export function WorkspaceRelinkModal({
  requirements,
  found = new Map(),
  folderSelectionAvailable,
  fileSelectionAvailable = folderSelectionAvailable,
  scanning,
  note = null,
  error,
  override = null,
  onOverride,
  onChoose,
  onCancel,
}: {
  requirements: readonly WorkspaceFcsRequirement[];
  /** The entries already matched by earlier choices, by data path, with where each file was found. */
  found?: ReadonlyMap<string, string>;
  folderSelectionAvailable: boolean;
  /** Whether single files can be chosen as well as a folder. */
  fileSelectionAvailable?: boolean;
  scanning: boolean;
  /** What the last choice found and what is still to find. */
  note?: string | null;
  error: string | null;
  /**
   * Same-named files that record another acquisition than the one saved, the only thing standing
   * in the way: offered by name as an explicit choice, never taken unasked.
   */
  override?: readonly { fileName: string; path: string }[] | null;
  onOverride?: () => void;
  onChoose: (mode: "folder" | "files") => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const remaining = requirements.filter((requirement) => !found.has(requirement.dataPath)).length;
  return (
    <div className="gl-modal-backdrop">
      <div
        className="gl-modal gl-workspace-relink-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t("Locate linked FCS files")}
      >
        <div className="gl-modal-title">{t("Locate linked FCS files")}</div>
        <p className="gl-workspace-relink-intro">
          {t(
            folderSelectionAvailable
              ? "Choose a folder. GateLab will search it and its subfolders for each workspace entry's file name, and relink a file only where its acquisition keywords do not contradict the ones the workspace saved. Files in more than one folder: choose the folders one after another, or choose the files themselves."
              : "Choose the required FCS files. GateLab will find each workspace entry's file by name, and relink it only where its acquisition keywords do not contradict the ones the workspace saved. Files can be chosen in several goes.",
          )}
        </p>
        <div className="gl-workspace-relink-summary">
          {found.size
            ? t("{found} of {count} FCS files found · {remaining} to find", { found: found.size, count: requirements.length, remaining })
            : t("{count} FCS files required", { count: requirements.length })}
        </div>
        <div className="gl-workspace-relink-files">
          {requirements.map((requirement) => {
            const where = found.get(requirement.dataPath);
            return (
              <div
                key={requirement.dataPath}
                className={where ? "is-found" : undefined}
                title={where ? t("{file} — found at {path}", { file: requirement.fileName, path: where }) : requirement.fileName}
              >
                <span className="gl-workspace-relink-mark" aria-hidden="true">{where ? "✓" : "·"}</span>
                <span className="gl-workspace-relink-name">{requirement.fileName}</span>
                {where && <small className="gl-workspace-relink-where">{where}</small>}
              </div>
            );
          })}
        </div>
        <p className="gl-modal-note">
          {t("GateLab will open the workspace only if every entry has exactly one file that matches it.")}
        </p>
        {note && <div className="gl-modal-note gl-workspace-relink-progress" role="status">{note}</div>}
        {error && <div className="gl-modal-warning" role="alert">{error}</div>}
        {override && override.length > 0 && onOverride && (
          <div className="gl-modal-note">
            {t("Each of these files is named like one the workspace was saved with, but records another acquisition. Use them only if they are the files you mean:")}
            {" "}
            {override.map((o) => t("{path} as {file}", { path: o.path, file: o.fileName })).join(", ")}
            {" "}
            <button type="button" className="gl-btn-ghost" disabled={scanning} onClick={onOverride}>
              {t("Relink to these files anyway")}
            </button>
          </div>
        )}
        <div className="gl-modal-actions">
          <button
            type="button"
            className="gl-btn-ghost"
            disabled={scanning}
            onClick={onCancel}
          >
            {t("Cancel workspace open")}
          </button>
          {folderSelectionAvailable && fileSelectionAvailable && (
            <button
              type="button"
              className="gl-btn-ghost"
              disabled={scanning}
              title={t("Choose the files themselves, from anywhere")}
              onClick={() => onChoose("files")}
            >
              {t("Choose files…")}
            </button>
          )}
          <button
            type="button"
            className="gl-btn"
            disabled={scanning}
            onClick={() => onChoose(folderSelectionAvailable ? "folder" : "files")}
          >
            {scanning
              ? t("Scanning folder…")
              : folderSelectionAvailable
                ? t(found.size ? "Choose another folder…" : "Choose FCS folder…")
                : t(found.size ? "Choose more FCS files…" : "Choose all FCS files…")}
          </button>
        </div>
      </div>
    </div>
  );
}
