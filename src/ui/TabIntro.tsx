// TabIntro.tsx — a tab's explanation paragraphs. They show on the tab's first visit with a × that
// hides them; a "?" by the tab's title brings them back. The choice is the viewer's, kept under
// `gatelab.intro.<id>.hidden`; private mode only forgets it, as the panes' folds do.

import { useCallback, useState, type ReactNode } from "react";
import { useI18n } from "./i18n";
import { HelpHint } from "./HelpHint";

export interface TabIntroState {
  id: string;
  shown: boolean;
  hide: () => void;
  show: () => void;
}

const storageKey = (id: string) => `gatelab.intro.${id}.hidden`;

export function useTabIntro(id: string): TabIntroState {
  const [shown, setShown] = useState(() => {
    try {
      return localStorage.getItem(storageKey(id)) !== "1";
    } catch {
      return true;
    }
  });
  const remember = useCallback((hidden: boolean) => {
    setShown(!hidden);
    try {
      if (hidden) localStorage.setItem(storageKey(id), "1");
      else localStorage.removeItem(storageKey(id));
    } catch { /* private mode */ }
  }, [id]);
  const hide = useCallback(() => remember(true), [remember]);
  const show = useCallback(() => remember(false), [remember]);
  return { id, shown, hide, show };
}

/** The explanation, with its ×; nothing once hidden. */
export function TabIntro({ intro, className, children }: { intro: TabIntroState; className?: string; children: ReactNode }) {
  const { t } = useI18n();
  if (!intro.shown) return null;
  return (
    <div className={`gl-tab-intro${className ? ` ${className}` : ""}`} data-intro={intro.id}>
      <div className="gl-tab-intro-text">{children}</div>
      <button
        type="button"
        className="gl-tab-intro-hide"
        aria-label={t("Hide this explanation")}
        title={t("Hide this explanation; the ? beside the title brings it back")}
        onClick={intro.hide}
      >
        ×
      </button>
    </div>
  );
}

/** The "?" that brings the introduction back, as every other hint's "?" looks; nothing while it shows. */
export function TabIntroToggle({ intro }: { intro: TabIntroState }) {
  const { t } = useI18n();
  if (intro.shown) return null;
  return <HelpHint className="gl-tab-intro-show" label={t("Show the explanation")} tooltip={t("Show the introduction")} onClick={intro.show} />;
}
