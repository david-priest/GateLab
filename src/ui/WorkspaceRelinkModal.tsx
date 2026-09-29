import type { WorkspaceFcsRequirement } from "../engine/workspaceRelink";
import { useI18n } from "./i18n";

export function WorkspaceRelinkModal({
  requirements,
  folderSelectionAvailable,
  scanning,
  error,
  override = null,
  onOverride,
  onChoose,
  onCancel,
}: {
  requirements: readonly WorkspaceFcsRequirement[];
  folderSelectionAvailable: boolean;
  scanning: boolean;
  error: string | null;
  /**
   * Same-named files that record another acquisition than the one saved, the only thing standing
   * in the way: offered by name as an explicit choice, never taken unasked.
   */
  override?: readonly { fileName: string; path: string }[] | null;
  onOverride?: () => void;
  onChoose: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
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
              ? "Choose one folder. GateLab will search it and its subfolders for each workspace entry's file name, and relink a file only where its acquisition keywords do not contradict the ones the workspace saved."
              : "Choose all required FCS files together. GateLab will find each workspace entry's file by name, and relink it only where its acquisition keywords do not contradict the ones the workspace saved.",
          )}
        </p>
        <div className="gl-workspace-relink-summary">
          {t("{count} FCS files required", { count: requirements.length })}
        </div>
        <div className="gl-workspace-relink-files">
          {requirements.map((requirement) => (
            <div key={requirement.dataPath} title={requirement.fileName}>
              {requirement.fileName}
            </div>
          ))}
        </div>
        <p className="gl-modal-note">
          {t("GateLab will open the workspace only if every entry has exactly one file that matches it.")}
        </p>
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
          <button
            type="button"
            className="gl-btn"
            disabled={scanning}
            onClick={onChoose}
          >
            {scanning
              ? t("Scanning folder…")
              : t(folderSelectionAvailable ? "Choose FCS folder…" : "Choose all FCS files…")}
          </button>
        </div>
      </div>
    </div>
  );
}
