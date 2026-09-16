// HierarchyModal.tsx — name a new or duplicated population hierarchy, rename the active one,
// or confirm deleting it. Each hierarchy owns its gates: deleting one takes its gates with it,
// and duplicating one copies them.

import { useState } from "react";
import { useI18n } from "./i18n";

export type HierarchyModalMode = "new" | "duplicate" | "rename" | "delete";

export function HierarchyModal({
  mode,
  kind = "hierarchy",
  currentName,
  initialName,
  takenNames,
  onCancel,
  onConfirm,
}: {
  mode: HierarchyModalMode;
  /** What is being named: a tree, or a group of files. */
  kind?: "hierarchy" | "group";
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
  const title = kind === "group"
    ? (mode === "new" ? t("New group") : mode === "rename" ? t("Rename group") : t("Delete group"))
    : mode === "new" ? t("New hierarchy")
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
            {kind === "group"
              ? t("Delete the group \"{name}\"? Its files follow the tree again, their own tailoring kept. This can be undone.", { name: currentName })
              : t("Delete the hierarchy \"{name}\" with its populations and gates? This can be undone.", { name: currentName })}
          </div>
        ) : (
          <>
            <div className="gl-modal-note">
              {kind === "group" && mode === "new"
                ? t("The selected files join it. Its gates start as the tree's; edit with the group chosen to tailor them for every file in it.")
                : mode === "new"
                ? t("A new hierarchy starts with only All Events and no gates of its own.")
                : mode === "duplicate"
                  ? t("The copy holds the same populations over its own copy of every gate, under its own name.", { name: currentName })
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
            {clash && <div className="gl-modal-warning" role="alert">{kind === "group" ? t("Another group already has that name.") : t("Another hierarchy already has that name.")}</div>}
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
