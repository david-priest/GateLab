// HelpMenu.tsx — the header's Help menu: the tutorial (take it, take it up where it was ended, or
// start again), where the demo workspace's source is kept in view, and the links and version line
// App passes in. It was the Tutorial menu until David asked for one menu (2026-10-23).

import { useState } from "react";
import { MenuButton, type MenuEntry } from "../ui/MenuButton";
import { useI18n } from "../ui/i18n";
import { ModalEscape } from "../ui/useModalEscape";
import { stepIndexOf } from "./tourProgress";
import { DEMO_WORKSPACE_CITATION, TOUR_STEPS } from "./tourScript";
import type { TourProgress } from "./tourTypes";

export function HelpMenu({ tour, links }: {
  /** The tutorial's state and actions; null where there is no tutorial (the R host). */
  tour: { progress: TourProgress | null; onStart: () => void; onResume: () => void } | null;
  /** The guide, source, issue tracker and version entries, after the tutorial's. */
  links: readonly MenuEntry[];
}) {
  const { t } = useI18n();
  const [about, setAbout] = useState(false);
  const progress = tour?.progress ?? null;
  const paused = progress?.status === "paused" ? stepIndexOf(TOUR_STEPS, progress.stepId) : -1;
  const items: MenuEntry[] = !tour ? [] : paused >= 0
    ? [
        {
          label: t("Resume at step {index} of {total}: {title}", { index: paused + 1, total: TOUR_STEPS.length, title: t(TOUR_STEPS[paused].title) }),
          className: "gl-tour-resume",
          onClick: tour.onResume,
        },
        { label: t("Start again from the beginning"), className: "gl-tour-start", onClick: tour.onStart },
      ]
    : [
        {
          label: progress?.status === "done" ? t("Take the tour again") : t("Take the tour"),
          className: "gl-tour-start",
          title: t("A walk through every tab with the demo workspace"),
          onClick: tour.onStart,
        },
      ];
  if (tour) {
    items.push({
      label: t("About the demo workspace"),
      className: "gl-tour-about",
      title: DEMO_WORKSPACE_CITATION.short,
      onClick: () => setAbout(true),
    });
  }
  items.push(...links);
  const c = DEMO_WORKSPACE_CITATION;
  return (
    <>
      <MenuButton label={t("Help")} className="gl-help-menu" items={items} />
      {about && (
        <div className="gl-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setAbout(false); }}>
          <ModalEscape onClose={() => setAbout(false)} />
          <div className="gl-modal gl-tour-about-modal" role="dialog" aria-modal="true" aria-label={t("The demo workspace")}>
            <div className="gl-modal-title">{t("The demo workspace")}</div>
            <p>{t("The demo workspace is a published gating strategy with its FCS records and compensation: the strategy used to sort B cells for an in vitro assay.")}</p>
            <p className="gl-tour-citation">
              {c.authors} {c.title} <em>{c.journal}</em>{" "}
              <a href={c.url} target="_blank" rel="noopener noreferrer">doi:{c.doi}</a>
            </p>
            <p>{c.figure}: “{c.figureLegend}”</p>
            <div className="gl-modal-actions">
              <button type="button" onClick={() => setAbout(false)}>{t("Close")}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
