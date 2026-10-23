import { useEffect, useState } from "react";
import { useI18n } from "./i18n";

/**
 * The result of an action, shown for a moment at the top of the centre pane, where the action was
 * taken: for a result not otherwise visible, kept short, gone after about 4 s, and never something
 * to close (David, 2026-10-23). The line under the file list keeps it. `seq` changes with every
 * message set, so the same message set again shows again.
 */
/** How long a note stays. */
export const NOTE_MS = 4000;

export function ActionNote({ message, seq }: { message: string | null; seq: number }) {
  const { t } = useI18n();
  const [hiddenSeq, setHiddenSeq] = useState<number | null>(null);
  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setHiddenSeq(seq), NOTE_MS);
    return () => window.clearTimeout(timer);
  }, [message, seq]);
  if (!message || hiddenSeq === seq) return null;
  return (
    <div className="gl-action-note-anchor">
      <div className="gl-action-note" role="status">
        <span>{t(message)}</span>
      </div>
    </div>
  );
}
