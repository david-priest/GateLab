// TourMenu.tsx — the header's way into the tutorial: start it, take it up where it was ended,
// or start again; and where the demo workspace's source is kept in view.

import { useState } from "react";
import { MenuButton, type MenuEntry } from "../ui/MenuButton";
import { useI18n } from "../ui/i18n";
import { stepIndexOf } from "./tourProgress";
import { DEMO_WORKSPACE_CITATION, TOUR_STEPS } from "./tourScript";
import type { TourProgress } from "./tourTypes";

export function TourMenu({ progress, onStart, onResume }: {
  progress: TourProgress | null;
  onStart: () => void;
  onResume: () => void;
}) {
  const { t } = useI18n();
  const [about, setAbout] = useState(false);
  const paused = progress?.status === "paused" ? stepIndexOf(TOUR_STEPS, progress.stepId) : -1;
  const items: MenuEntry[] = paused >= 0
    ? [
        {
          label: t("Resume at step {index} of {total}: {title}", { index: paused + 1, total: TOUR_STEPS.length, title: t(TOUR_STEPS[paused].title) }),
          className: "gl-tour-resume",
          onClick: onResume,
        },
        { label: t("Start again from the beginning"), className: "gl-tour-start", onClick: onStart },
      ]
    : [
        {
          label: progress?.status === "done" ? t("Start the tutorial again") : t("Start the tutorial"),
          className: "gl-tour-start",
          onClick: onStart,
        },
      ];
  items.push("separator", {
    label: t("About the demo workspace"),
    className: "gl-tour-about",
    title: DEMO_WORKSPACE_CITATION.short,
    onClick: () => setAbout(true),
  });
  const c = DEMO_WORKSPACE_CITATION;
  return (
    <>
      <MenuButton
        label={t("Tutorial")}
        className="gl-tour-menu"
        title={t("A walk through every tab with the demo workspace")}
        items={items}
      />
      {about && (
        <div className="gl-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setAbout(false); }}>
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
