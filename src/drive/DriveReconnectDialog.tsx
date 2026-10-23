// DriveReconnectDialog.tsx — "Reconnect to lab Drive": a sign-in lasts an hour, Google Identity
// Services gives no refresh token, and a new token takes a click, because Google's window opens
// only from one. Save, Save As, Save as new experiment and Open experiment wait here once the
// token has run out or is about to; the click gets a new token and the action goes on. Nothing
// open is touched meanwhile, so no unsaved change is lost.

import { useRef, useState } from "react";
import { useI18n } from "../ui/i18n";
import { ModalEscape } from "../ui/useModalEscape";
import type { DriveAuth } from "./auth";
import type { DriveReconnectAction } from "./types";

export interface DriveReconnectDialogProps {
  readonly auth: DriveAuth;
  readonly action: DriveReconnectAction;
  /** The Drive workspace open, if any: named so the member sees what stays unsaved. */
  readonly workspace: string | null;
  readonly onCancel: () => void;
  /** A new token is in hand: the action goes on. */
  readonly onReconnected: () => void;
}

export function DriveReconnectDialog({ auth, action, workspace, onCancel, onReconnected }: DriveReconnectDialogProps) {
  const { t } = useI18n();
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // Cancel stays open while Google's window is up: a reconnect that ends after it does nothing.
  const cancelledRef = useRef(false);
  const account = auth.account();

  // Called from the click itself, so the browser lets Google's window open.
  const reconnect = () => {
    setWorking(true);
    setProblem(null);
    auth.reconnect().then(() => {
      if (!cancelledRef.current) onReconnected();
    }, (cause: unknown) => {
      if (cancelledRef.current) return;
      setProblem(cause instanceof Error ? cause.message : String(cause));
      setWorking(false);
    });
  };
  const cancel = () => {
    cancelledRef.current = true;
    onCancel();
  };

  const then = action === "save"
    ? t("Reconnect, and the workspace is saved to the lab Drive.")
    : action === "copy"
      ? t("Reconnect, and the copy is saved to the lab Drive.")
      : action === "experiment"
        ? t("Reconnect, and the new experiment is saved to the lab Drive.")
        : action === "open"
          ? t("Reconnect, and Open experiment goes on.")
          : t("Reconnect, and the folder can be chosen.");

  return (
    <div className="gl-modal-backdrop">
      <ModalEscape onClose={cancel} />
      <div className="gl-modal gl-drive-reconnect-dialog" role="dialog" aria-modal="true" aria-label={t("Reconnect to lab Drive")}>
        <div className="gl-modal-title">{t("Reconnect to lab Drive")}</div>
        <p className="gl-modal-note">
          {account
            ? t("Sign-in to the lab Drive as {email} lasts an hour, and it has run out.", { email: account.email })
            : t("Sign-in to the lab Drive lasts an hour, and it has run out.")}{" "}
          {then}
        </p>
        <p className="gl-modal-note">
          {workspace
            ? t("Nothing open here is lost: {name} stays as it is, with its unsaved changes, until it is saved.", { name: workspace })
            : t("Nothing open here is lost.")}
        </p>
        {problem && <p className="gl-modal-warning">{problem}</p>}
        <div className="gl-modal-actions">
          <button type="button" className="gl-btn-ghost gl-drive-reconnect-cancel" onClick={cancel}>{t("Cancel")}</button>
          <button type="button" className="gl-btn-primary gl-drive-reconnect-ok" disabled={working} onClick={reconnect}>
            {working ? t("Reconnecting…") : t("Reconnect")}
          </button>
        </div>
      </div>
    </div>
  );
}
