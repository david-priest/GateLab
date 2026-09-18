// The "Revert workspace" dialog: the checkpoints GateLab kept of this workspace in the
// browser, newest first, one of which the user chooses to go back to.

import { useState } from "react";
import { CHECKPOINT_REASON_LABELS, checkpointAge, type WorkspaceCheckpoint } from "../engine/workspaceHistory";
import { useI18n } from "./i18n";

export function WorkspaceHistoryModal({ checkpoints, loading, onRevert, onCancel }: {
  /** Newest first, as listWorkspaceCheckpoints returns them. */
  checkpoints: readonly WorkspaceCheckpoint[];
  loading: boolean;
  onRevert: (checkpoint: WorkspaceCheckpoint) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [chosenId, setChosenId] = useState<string | null>(null);
  const chosen = checkpoints.find((checkpoint) => checkpoint.id === chosenId) ?? null;
  // The newest "as opened" checkpoint is the workspace as it was when this file was last opened.
  const openedId = checkpoints.find((checkpoint) => checkpoint.reason === "after-workspace-open")?.id;
  return (
    <div className="gl-modal-backdrop">
      <div className="gl-modal gl-modal-history">
        <div className="gl-modal-title">{t("Revert workspace")}</div>
        <p className="gl-modal-note">
          {t("GateLab keeps checkpoints of this workspace in this browser: as it was opened, every two minutes while it changes, and before anything destructive. Choose one to go back to. The current state is kept as a checkpoint first, so a revert can itself be reverted.")}
        </p>
        {loading ? (
          <p className="gl-hint">{t("Reading checkpoints…")}</p>
        ) : checkpoints.length === 0 ? (
          <p className="gl-hint">{t("No checkpoints yet for this workspace.")}</p>
        ) : (
          <div className="gl-modal-history-list" role="radiogroup" aria-label={t("Checkpoints")}>
            {checkpoints.map((checkpoint) => (
              <label key={checkpoint.id} className={checkpoint.id === chosenId ? "is-chosen" : undefined} title={new Date(checkpoint.createdAt).toLocaleString()}>
                <input
                  type="radio"
                  name="workspace-checkpoint"
                  value={checkpoint.id}
                  checked={chosenId === checkpoint.id}
                  onChange={() => setChosenId(checkpoint.id)}
                />
                <span className="gl-modal-history-when">{checkpointAge(checkpoint.createdAt)}</span>
                <span className="gl-modal-history-what">
                  <strong>
                    {t(CHECKPOINT_REASON_LABELS[checkpoint.reason] ?? checkpoint.reason)}
                    {checkpoint.id === openedId ? ` · ${t("the workspace as it was opened")}` : ""}
                  </strong>
                  <small>{t("{samples} files · {gates} gates · {populations} populations", checkpoint.summary)}</small>
                </span>
              </label>
            ))}
          </div>
        )}
        <div className="gl-modal-actions">
          <button className="gl-btn-ghost" onClick={onCancel}>{t("Cancel")}</button>
          <button className="gl-btn" disabled={!chosen} onClick={() => chosen && onRevert(chosen)}>{t("Revert to this checkpoint")}</button>
        </div>
      </div>
    </div>
  );
}
