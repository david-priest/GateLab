// DriveMenu.tsx — the lab build's "Lab Drive" header menu: sign in, open an experiment from the lab
// Drive, save the workspace open as a new experiment, sign out. Saving is the Workspace menu's Save,
// which writes a Drive workspace back to Drive, and its Save As, which saves a copy there.

import { useEffect, useState } from "react";
import { MenuButton, type MenuEntry } from "../ui/MenuButton";
import { useI18n } from "../ui/i18n";
import type { DriveFile } from "./api";
import type { DriveSession } from "./session";
import type { DriveOpened, DriveTarget } from "./types";

export interface DriveMenuProps {
  readonly session: DriveSession;
  /** The Drive workspace open now, if any. */
  readonly target: DriveTarget | null;
  readonly dirty: boolean;
  readonly disabled: boolean;
  /** A workspace with samples is open, so there is something to save as a new experiment. */
  readonly canSaveAs: boolean;
  /** Ask for the new experiment's name, then upload it (the app's Save As dialog). */
  readonly onSaveAsNewExperiment: () => void;
  /** Load what was opened; false when the app could not, and the current workspace stands. */
  readonly onOpened: (opened: DriveOpened) => Promise<boolean>;
  /** Close the Drive workspace: signing out leaves none of its data in the page. */
  readonly onSignedOut: () => void | Promise<void>;
  readonly onStatus: (message: string | null) => void;
  readonly onError: (message: string | null) => void;
}

type Dialog =
  | { kind: "choose"; files: readonly DriveFile[]; resolve: (file: DriveFile | null) => void }
  | { kind: "missing"; names: readonly string[]; resolve: (pick: boolean) => void }
  | { kind: "name"; count: number; suggested: string; resolve: (name: string | null) => void }
  | { kind: "discard"; action: "open" | "signOut"; resolve: (go: boolean) => void };

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

export function DriveMenu({
  session, target, dirty, disabled, canSaveAs, onSaveAsNewExperiment, onOpened, onSignedOut, onStatus, onError,
}: DriveMenuProps) {
  const { t } = useI18n();
  const [, setAuthVersion] = useState(0);
  const [working, setWorking] = useState(false);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [name, setName] = useState("");
  const [chosen, setChosen] = useState<string | null>(null);

  useEffect(() => session.auth.subscribe(() => setAuthVersion((version) => version + 1)), [session]);
  // Google's sign-in library is loaded before the click that signs in, so its window is not blocked.
  useEffect(() => { void session.auth.prepare().catch(() => undefined); }, [session]);

  const account = session.auth.account();
  let live = false;
  try {
    session.auth.token();
    live = true;
  } catch {
    live = false;
  }

  const ask = <T,>(make: (resolve: (value: T) => void) => Dialog): Promise<T> =>
    new Promise<T>((resolve) => setDialog(make((value) => { setDialog(null); resolve(value); })));

  async function signIn(): Promise<void> {
    onError(null);
    try {
      const signedIn = await session.auth.signIn();
      onStatus(t("Signed in to the lab Drive as {email}", { email: signedIn.email }));
    } catch (cause) {
      onError(messageOf(cause));
    }
  }

  async function signOut(): Promise<void> {
    if (target && dirty && !(await ask<boolean>((resolve) => ({ kind: "discard", action: "signOut", resolve })))) return;
    session.auth.signOut();
    await onSignedOut();
  }

  async function openExperiment(): Promise<void> {
    if (target && dirty && !(await ask<boolean>((resolve) => ({ kind: "discard", action: "open", resolve })))) return;
    onError(null);
    setWorking(true);
    try {
      const opened = await session.openExperiment({
        progress: (message) => onStatus(message),
        chooseWorkspace: (files) => {
          setChosen(files[0]?.id ?? null);
          return ask((resolve) => ({ kind: "choose", files, resolve }));
        },
        askMissing: (names) => ask((resolve) => ({ kind: "missing", names, resolve })),
        nameNewWorkspace: (count, suggested) => {
          setName(suggested);
          return ask((resolve) => ({ kind: "name", count, suggested, resolve }));
        },
      });
      if (!opened) {
        onStatus(t("Open experiment cancelled · current workspace unchanged"));
        return;
      }
      await onOpened(opened);
    } catch (cause) {
      onStatus(null);
      onError(messageOf(cause));
    } finally {
      setWorking(false);
    }
  }

  const items: MenuEntry[] = [];
  if (!account) {
    items.push({ label: t("Sign in…"), className: "gl-drive-sign-in", onClick: () => void signIn() });
  } else {
    items.push({ label: account.email, title: account.name ?? account.email, disabled: true, onClick: () => undefined });
    if (live) {
      items.push({
        label: t("Open experiment…"),
        className: "gl-drive-open",
        title: t("Open an experiment folder in the lab Drive and select its files: the workspace and its FCS"),
        disabled: disabled || working,
        onClick: () => void openExperiment(),
      });
      items.push({
        label: t("Save as new experiment…"),
        className: "gl-drive-save-new",
        title: t("Make a new experiment folder in the lab Drive and upload this workspace and its FCS files into it"),
        disabled: disabled || working || !canSaveAs,
        onClick: onSaveAsNewExperiment,
      });
    } else {
      items.push({
        label: t("Reconnect…"),
        className: "gl-drive-reconnect",
        title: t("Sign-in to the lab Drive lasts an hour; reconnect to open or save. Nothing open here is lost."),
        onClick: () => void signIn(),
      });
    }
    if (target) {
      items.push({ label: t("Open: {name}", { name: target.name }), title: `${target.experiment}/${target.name}`, disabled: true, onClick: () => undefined });
    }
    items.push("separator");
    items.push({
      label: t("Sign out"),
      className: "gl-drive-sign-out",
      title: t("Forget the sign-in and close the lab Drive workspace; nothing of it stays in this page"),
      disabled: working,
      onClick: () => void signOut(),
    });
  }
  const label = !account
    ? t("Lab Drive")
    : live
      ? t("Lab Drive · {email}", { email: account.email })
      : t("Lab Drive · reconnect");

  return (
    <>
      <MenuButton
        label={label}
        className="gl-drive-menu"
        title={t("Open and save experiments in the lab's Google Drive")}
        items={items}
      />
      {dialog?.kind === "choose" && (
        <div className="gl-modal-backdrop">
          <div className="gl-modal" role="dialog" aria-modal="true" aria-label={t("Which workspace?")}>
            <div className="gl-modal-title">{t("Which workspace?")}</div>
            <p className="gl-modal-note">{t("More than one workspace file was picked. Open which?")}</p>
            <div className="gl-modal-preview">
              {dialog.files.map((file) => (
                <label key={file.id} className="gl-modal-check">
                  <input
                    type="radio"
                    name="gl-drive-workspace"
                    checked={chosen === file.id}
                    onChange={() => setChosen(file.id)}
                  />
                  <span>
                    {file.name}
                    {file.modifiedTime ? ` · ${new Date(file.modifiedTime).toLocaleString()}` : ""}
                    {file.lastModifyingUser?.displayName ? ` · ${file.lastModifyingUser.displayName}` : ""}
                  </span>
                </label>
              ))}
            </div>
            <div className="gl-modal-actions">
              <button type="button" className="gl-btn-ghost" onClick={() => dialog.resolve(null)}>{t("Cancel")}</button>
              <button
                type="button"
                className="gl-btn-primary"
                disabled={!chosen}
                onClick={() => dialog.resolve(dialog.files.find((file) => file.id === chosen) ?? null)}
              >
                {t("Open")}
              </button>
            </div>
          </div>
        </div>
      )}
      {dialog?.kind === "missing" && (
        <div className="gl-modal-backdrop">
          <div className="gl-modal" role="dialog" aria-modal="true" aria-label={t("Files still to pick")}>
            <div className="gl-modal-title">{t("Files still to pick")}</div>
            <p className="gl-modal-note">
              {t("The workspace needs {count} more FCS files than were picked: {names}. Pick them in the experiment folder; GateLab reaches a file only once it is picked.", {
                count: dialog.names.length,
                names: dialog.names.join(", "),
              })}
            </p>
            <div className="gl-modal-actions">
              <button type="button" className="gl-btn-ghost" onClick={() => dialog.resolve(false)}>{t("Cancel")}</button>
              <button type="button" className="gl-btn-primary gl-drive-pick-missing" onClick={() => dialog.resolve(true)}>{t("Pick them…")}</button>
            </div>
          </div>
        </div>
      )}
      {dialog?.kind === "name" && (
        <div className="gl-modal-backdrop">
          <div className="gl-modal" role="dialog" aria-modal="true" aria-label={t("New workspace in the lab Drive")}>
            <div className="gl-modal-title">{t("New workspace in the lab Drive")}</div>
            <p className="gl-modal-note">
              {t("{count} FCS files were picked without a workspace. They open as a new workspace, and the first Save writes it into their folder as:", { count: dialog.count })}
            </p>
            <label className="gl-modal-field">
              {t("Workspace file")}
              <input
                type="text"
                value={name}
                spellCheck={false}
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter" && name.trim()) dialog.resolve(name); }}
              />
            </label>
            <div className="gl-modal-actions">
              <button type="button" className="gl-btn-ghost" onClick={() => dialog.resolve(null)}>{t("Cancel")}</button>
              <button type="button" className="gl-btn-primary gl-drive-name-ok" disabled={!name.trim()} onClick={() => dialog.resolve(name)}>{t("Open")}</button>
            </div>
          </div>
        </div>
      )}
      {dialog?.kind === "discard" && (
        <div className="gl-modal-backdrop">
          <div className="gl-modal" role="dialog" aria-modal="true" aria-label={t("Unsaved changes")}>
            <div className="gl-modal-title">{t("Unsaved changes")}</div>
            <p className="gl-modal-warning">
              {dialog.action === "open"
                ? t("{name} has changes not saved to the lab Drive, and GateLab keeps no copy of a Drive workspace in this browser. Opening another experiment loses them.", { name: target?.name ?? "" })
                : t("{name} has changes not saved to the lab Drive, and GateLab keeps no copy of a Drive workspace in this browser. Signing out closes it and loses them.", { name: target?.name ?? "" })}
            </p>
            <div className="gl-modal-actions">
              <button type="button" className="gl-btn-ghost" onClick={() => dialog.resolve(false)}>{t("Cancel")}</button>
              <button type="button" className="gl-btn gl-btn-danger gl-drive-discard" onClick={() => dialog.resolve(true)}>
                {dialog.action === "open" ? t("Discard and open") : t("Discard and sign out")}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
