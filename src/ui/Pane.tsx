// Pane.tsx — one section of the Gating tab's side panel: a header row (its title, a summary, the
// section's own actions and its ⋯ menu, a fold) and a body. The Tree, Gates and Populations
// sections are each one of these, and take what they show as props rather than reading the app,
// so a layout host can place them anywhere (the dockable layout designed next).

import { useEffect, useState, type ReactNode } from "react";
import { MenuButton, type MenuEntry } from "./MenuButton";
import { ChevronIcon, MoreIcon } from "./icons";
import { useI18n } from "./i18n";

/** A pane's fold, kept per viewer under `gatelab.pane.<id>.collapsed`; private mode only forgets it. */
export function usePaneCollapsed(id: string, initial = false): [boolean, (next: boolean | ((was: boolean) => boolean)) => void] {
  const key = `gatelab.pane.${id}.collapsed`;
  const [collapsed, setCollapsed] = useState(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored === null ? initial : stored === "1";
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try { localStorage.setItem(key, collapsed ? "1" : "0"); } catch { /* private mode */ }
  }, [key, collapsed]);
  return [collapsed, setCollapsed];
}

export function Pane({
  id,
  title,
  summary,
  actions,
  menu,
  menuLabel,
  collapsed,
  onToggleCollapsed,
  collapseTitle,
  grow = false,
  className,
  children,
}: {
  /** Names the pane for the layout and for tests: `gl-pane-<id>`. */
  id: string;
  title: string;
  /** A muted word or two after the title: a count, "4 files · 1 tailored". */
  summary?: string | null;
  /** The section's own controls in its header, before the ⋯ menu: kept few. */
  actions?: ReactNode;
  /** The section's ⋯ menu; none when empty. */
  menu?: readonly MenuEntry[];
  menuLabel?: string;
  /** Given with `onToggleCollapsed`, the title is the fold's button. */
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  collapseTitle?: string;
  /** Takes the space left in the panel. */
  grow?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  const { t } = useI18n();
  const foldable = collapsed !== undefined && !!onToggleCollapsed;
  const heading = (
    <>
      <span className="gl-side-title">{title}</span>
      {summary && <span className="gl-pane-summary" title={summary}>{summary}</span>}
    </>
  );
  return (
    <section
      className={`gl-side-section gl-pane gl-pane-${id}${grow ? " gl-side-grow" : ""}${collapsed ? " gl-side-collapsed" : ""}${className ? ` ${className}` : ""}`}
      aria-label={title}
    >
      <div className="gl-side-head">
        {foldable ? (
          <button
            type="button"
            className="gl-side-disclosure"
            aria-expanded={!collapsed}
            title={collapseTitle}
            onClick={onToggleCollapsed}
          >
            <span className="gl-side-disclosure-mark" aria-hidden="true"><ChevronIcon open={!collapsed} size={12} /></span>
            {heading}
          </button>
        ) : (
          <div className="gl-pane-heading">{heading}</div>
        )}
        <span className="gl-pane-actions">
          {actions}
          {menu && menu.length > 0 && (
            <MenuButton label={menuLabel ?? t("{title} actions", { title })} items={menu} icon={<MoreIcon />} className={`gl-pane-menu gl-pane-menu-${id}`} />
          )}
        </span>
      </div>
      {!collapsed && children}
    </section>
  );
}
