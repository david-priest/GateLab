// HierarchyModal.tsx — name a new or duplicated population hierarchy, rename the active one,
// or confirm deleting it. The gates are shared by every hierarchy, so deleting one removes
// its populations only.

import { useState } from "react";
import { useI18n } from "./i18n";

export type HierarchyModalMode = "new" | "duplicate" | "rename" | "delete";

export function HierarchyModal({
  mode,
  currentName,
  initialName,
  takenNames,
  onCancel,
  onConfirm,
}: {
  mode: HierarchyModalMode;
  /** Name of the active hierarchy (the one renamed, duplicated or deleted). */
  currentName: string;
  initialName: string;
  takenNames: readonly string[];
  onCancel: () => void;
  onConfirm: (name: string) => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(initialName);
  const trimmed = name.trim();
  const clash = mode !== "delete" && takenNames.some((n) => n === trimmed && n !== (mode === "rename" ? currentName : ""));
  const title =
    mode === "new" ? t("New hierarchy")
      : mode === "duplicate" ? t("Duplicate hierarchy")
        : mode === "rename" ? t("Rename hierarchy")
          : t("Delete hierarchy");
  const canConfirm = mode === "delete" || (trimmed.length > 0 && !clash);
  return (
    <div className="gl-modal-backdrop">
      <div className="gl-modal" style={{ maxWidth: 460 }}>
        <div className="gl-modal-title">{title}</div>
        {mode === "delete" ? (
          <div className="gl-modal-note">
            {t("Delete the hierarchy \"{name}\" and its populations? The gates stay: every hierarchy shares them. This can be undone.", { name: currentName })}
          </div>
        ) : (
          <>
            <div className="gl-modal-note">
              {mode === "new"
                ? t("A new hierarchy starts with only All Events and shares every gate with the others.")
                : mode === "duplicate"
                  ? t("The copy holds the same populations over the same shared gates, under its own name.", { name: currentName })
                  : t("Rename \"{name}\".", { name: currentName })}
            </div>
            <label className="gl-modal-field">
              <span>{t("Name")}</span>
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && canConfirm) onConfirm(trimmed);
                  if (e.key === "Escape") onCancel();
                }}
              />
            </label>
            {clash && <div className="gl-modal-warning" role="alert">{t("Another hierarchy already has that name.")}</div>}
          </>
        )}
        <div className="gl-modal-actions">
          <button className="gl-btn-ghost" onClick={onCancel}>{t("Cancel")}</button>
          <button className={mode === "delete" ? "gl-btn danger" : "gl-btn"} disabled={!canConfirm} onClick={() => onConfirm(trimmed)}>
            {mode === "delete" ? t("Delete") : mode === "rename" ? t("Rename") : t("Create")}
          </button>
        </div>
      </div>
    </div>
  );
}
