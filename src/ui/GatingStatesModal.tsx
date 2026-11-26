// The "Gating states" dialog: the gating saved under a name, to return to later. The current
// gating is saved from the field at the top; a saved state chosen in the list is restored, updated
// to the current gating, renamed or deleted. The states themselves are gatingStates.ts's.

import { useState } from "react";
import { checkpointAge } from "../engine/workspaceHistory";
import { gatingStateSummary, type SavedGatingState } from "../gatingStates";
import { useI18n } from "./i18n";
import { ModalEscape } from "./useModalEscape";

export function GatingStatesModal({ states, currentIds, suggestedName, onSave, onRestore, onUpdate, onRename, onDelete, onClose }: {
  /** In the order they were saved. */
  states: readonly SavedGatingState[];
  /** The states the gating as it is now matches: restoring one of them would change nothing. */
  currentIds: ReadonlySet<string>;
  /** The name a state saved without one takes. */
  suggestedName: string;
  onSave: (name: string) => void;
  onRestore: (id: string) => void;
  /** The saved state takes the gating as it is now, keeping its name. */
  onUpdate: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [chosenId, setChosenId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  // Update and Delete write over a saved state, which Undo does not bring back: each asks once.
  const [asking, setAsking] = useState<{ what: "update" | "delete"; id: string } | null>(null);
  const chosen = states.find((saved) => saved.id === chosenId) ?? null;
  const asked = asking && asking.id === chosen?.id ? asking.what : null;

  const save = () => {
    onSave(name.trim() || suggestedName);
    setName("");
  };
  const commitRename = () => {
    if (!renaming) return;
    const next = renaming.name.trim();
    if (next) onRename(renaming.id, next);
    setRenaming(null);
  };
  const choose = (id: string) => {
    setChosenId(id);
    setAsking(null);
  };

  return (
    <div className="gl-modal-backdrop">
      <ModalEscape onClose={onClose} />
      <div className="gl-modal gl-modal-history gl-modal-gating-states">
        <div className="gl-modal-title">{t("Gating states")}</div>
        <p className="gl-modal-note">
          {t("Save the gating as it is now under a name, and return to it later. A state holds every tree with its gates and populations, the groups, and the tree each file is under; compensation, scales and the files stay as they are. The states are saved with the workspace. Restoring one replaces the current gating, and Undo brings that back.")}
        </p>
        <form className="gl-gating-state-save" onSubmit={(event) => { event.preventDefault(); save(); }}>
          <input
            aria-label={t("Name for the current gating")}
            placeholder={suggestedName}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <button type="submit" className="gl-btn">{t("Save the current gating")}</button>
        </form>
        {states.length === 0 ? (
          <p className="gl-hint">{t("No gating states saved yet in this workspace.")}</p>
        ) : (
          <div className="gl-modal-history-list" role="radiogroup" aria-label={t("Saved gating states")}>
            {states.map((saved) => {
              const summary = gatingStateSummary(saved);
              return (
                <label key={saved.id} className={saved.id === chosenId ? "is-chosen" : undefined} title={saved.savedAt ? new Date(saved.savedAt).toLocaleString() : undefined}>
                  <input
                    type="radio"
                    name="gating-state"
                    value={saved.id}
                    checked={chosenId === saved.id}
                    onChange={() => choose(saved.id)}
                  />
                  <span className="gl-modal-history-when">{checkpointAge(saved.savedAt)}</span>
                  <span className="gl-modal-history-what">
                    {renaming?.id === saved.id ? (
                      <input
                        autoFocus
                        aria-label={t("Name")}
                        value={renaming.name}
                        onChange={(event) => setRenaming({ id: saved.id, name: event.target.value })}
                        onBlur={commitRename}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") { event.preventDefault(); commitRename(); }
                          // The field takes Escape for itself: the dialog stays open.
                          if (event.key === "Escape") { event.preventDefault(); setRenaming(null); }
                        }}
                      />
                    ) : (
                      <strong onDoubleClick={() => { choose(saved.id); setRenaming({ id: saved.id, name: saved.name }); }}>
                        {saved.name}
                        {currentIds.has(saved.id) ? ` · ${t("the gating as it is now")}` : ""}
                      </strong>
                    )}
                    <small>
                      {t("{gates} gates · {populations} populations", summary)}
                      {summary.trees > 1 ? ` · ${t("{trees} trees", summary)}` : ""}
                    </small>
                  </span>
                </label>
              );
            })}
          </div>
        )}
        {chosen && asked ? (
          <div className="gl-modal-actions gl-gating-state-asking" role="alert">
            <span>
              {asked === "delete"
                ? t("Delete the saved state \"{name}\"? Undo does not bring it back.", { name: chosen.name })
                : t("Replace the saved state \"{name}\" with the gating as it is now? Undo does not bring the saved one back.", { name: chosen.name })}
            </span>
            <button className="gl-btn-ghost" onClick={() => setAsking(null)}>{t("Cancel")}</button>
            {asked === "delete" ? (
              <button className="gl-btn gl-btn-danger" onClick={() => { onDelete(chosen.id); setAsking(null); setChosenId(null); }}>{t("Delete")}</button>
            ) : (
              <button className="gl-btn" onClick={() => { onUpdate(chosen.id); setAsking(null); }}>{t("Replace")}</button>
            )}
          </div>
        ) : (
          <div className="gl-modal-actions">
            <button className="gl-btn-ghost gl-gating-state-delete" disabled={!chosen} onClick={() => chosen && setAsking({ what: "delete", id: chosen.id })}>{t("Delete")}</button>
            <button className="gl-btn-ghost" disabled={!chosen} onClick={() => chosen && setRenaming({ id: chosen.id, name: chosen.name })}>{t("Rename")}</button>
            <button
              className="gl-btn-ghost"
              disabled={!chosen || currentIds.has(chosen.id)}
              title={t("The chosen state takes the gating as it is now and keeps its name")}
              onClick={() => chosen && setAsking({ what: "update", id: chosen.id })}
            >{t("Update")}</button>
            <span className="gl-gating-state-spacer" />
            <button className="gl-btn-ghost" onClick={onClose}>{t("Close")}</button>
            <button
              className="gl-btn"
              disabled={!chosen || currentIds.has(chosen.id)}
              title={chosen && currentIds.has(chosen.id) ? t("The gating is already as this state has it") : undefined}
              onClick={() => chosen && onRestore(chosen.id)}
            >{t("Restore this state")}</button>
          </div>
        )}
      </div>
    </div>
  );
}
