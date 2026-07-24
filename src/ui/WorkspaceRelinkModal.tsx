import type { WorkspaceFcsRequirement } from "../engine/workspaceRelink";
import { useI18n } from "./i18n";

export function WorkspaceRelinkModal({
  requirements,
  folderSelectionAvailable,
  scanning,
  error,
  onChoose,
  onCancel,
}: {
  requirements: readonly WorkspaceFcsRequirement[];
  folderSelectionAvailable: boolean;
  scanning: boolean;
  error: string | null;
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
              ? "Choose one folder. GateLab will search it and its subfolders, then match every workspace entry by filename."
              : "Choose all required FCS files together. GateLab will match every workspace entry by filename.",
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
          {t("GateLab will open the workspace only if every filename has one unique match.")}
        </p>
        {error && <div className="gl-modal-warning" role="alert">{error}</div>}
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
