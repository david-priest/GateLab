// AgentSaveConfirm.tsx — the question an agent's save puts to the user: which copy of the
// workspace, written where, on whose request. Nothing is written until the user says Save; Cancel,
// Escape and a click outside all decline. The open workspace is not touched either way. A write
// that fails is reported to the agent and in the app's error line, not retried here: the relay's
// upload slot takes one upload.

import { useI18n } from "../ui/i18n";
import { ModalEscape } from "../ui/useModalEscape";
import type { AgentSaveParams } from "./protocol";

export function AgentSaveConfirm({ request, writer, busy, onSave, onCancel }: {
  request: Pick<AgentSaveParams, "kind" | "target" | "overwrite">;
  /** The name the agent introduced itself with. */
  writer: string;
  /** True while the copy is being written. */
  busy: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const title = t("Save a copy for {agent}?", { agent: writer });
  return (
    <div className="gl-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onCancel(); }}>
      <ModalEscape onClose={() => { if (!busy) onCancel(); }} />
      <div className="gl-modal gl-agent-dialog" role="dialog" aria-modal="true" aria-label={title}>
        <div className="gl-modal-title">{title}</div>
        <p>
          {request.kind === "portable"
            ? t("{agent} asks to save a portable copy of this workspace, holding the workspace and every FCS file, to:", { agent: writer })
            : t("{agent} asks to save a linked copy of this workspace, which finds its FCS files by name, to:", { agent: writer })}
        </p>
        <p><code className="gl-agent-save-path">{request.target}</code></p>
        {request.overwrite && <p role="alert">{t("A file is there already; saving replaces it.")}</p>}
        <p className="gl-hint">{t("Your own workspace file and its unsaved changes stay as they are.")}</p>
        <div className="gl-modal-actions">
          <button type="button" onClick={onCancel} disabled={busy}>{t("Cancel")}</button>
          <button type="button" className="gl-btn-primary" onClick={onSave} disabled={busy}>{busy ? t("Saving…") : t("Save")}</button>
        </div>
      </div>
    </div>
  );
}
