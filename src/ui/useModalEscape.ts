import { useEffect, useRef } from "react";

/**
 * Escape closes a dialog the way it closes popovers and menus. A dialog calls the hook, or mounts
 * <ModalEscape> inside its backdrop, with what its Cancel or Close button does. Dialogs stack: one
 * opened over another takes Escape first, and the one beneath stays open. A control inside the
 * dialog that has already used the key (a field restoring its value, a list closing) marks it with
 * preventDefault, and the dialog then stays open. A null `onClose` (a dialog that cannot be left
 * while it works) leaves the key alone.
 */
const openDialogs: object[] = [];

export function useModalEscape(onClose: (() => void) | null | undefined): void {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const enabled = !!onClose;
  useEffect(() => {
    if (!enabled) return;
    const token = {};
    openDialogs.push(token);
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      if (openDialogs[openDialogs.length - 1] !== token) return;
      event.preventDefault();
      onCloseRef.current?.();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      const at = openDialogs.indexOf(token);
      if (at >= 0) openDialogs.splice(at, 1);
    };
  }, [enabled]);
}

/** The hook as an element, for a dialog written inline in JSX, where a hook cannot be called. */
export function ModalEscape({ onClose }: { onClose: (() => void) | null | undefined }): null {
  useModalEscape(onClose);
  return null;
}
