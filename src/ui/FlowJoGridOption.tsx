// FlowJoGridOption.tsx — "Evaluate gates on the recorded grid", as both FlowJo import dialogs offer it:
// the dialog that opens a workspace, and the import dialog of a workspace imported onto the loaded
// files from the Import menu. One component, so the two cannot say different things.

import { useI18n } from "./i18n";

/** What the option's note says either mode leaves continuous: FlowJo's rule is not established. */
export const FLOWJO_GRID_NOT_COVERED =
  "Either way, the grid rule is not established for these, which are evaluated continuously: ellipses, curly and spider quadrants, and polygons with no gate resolution or on a Time, ArcSinh, Logicle or gained linear axis. A rectangle is not clamped on a Time, gained or compensated linear axis, and one lying wholly beyond where the axis clamps is counted as drawn. A polygon with a gate resolution other than 256 is put on a grid of that many channels, which has not been measured.";

/** What off means, said without claiming more of FlowKit than the geometry. */
export const FLOWJO_GRID_OFF_NOTE =
  "Off: every gate is evaluated continuously on the geometry it was drawn with, as FlowKit and Cytobank evaluate gates. Biex axes are read on the same biex table either way; FlowKit's differs from it where the width basis lies between −1 and −3.16.";

/** What either answer does with a polygon GateLab wrote into the workspace itself. */
export const FLOWJO_GRID_GATELAB_POLYGONS =
  "A polygon GateLab wrote into the workspace, and not moved since, comes back as GateLab held it, whichever way this is set.";

export function FlowJoGridOption({
  checked,
  onChange,
  disabled = false,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  /** While the workspace is being read again with the other answer. */
  disabled?: boolean;
}) {
  const { t } = useI18n();
  // Only the checkbox and its name are the label: the notes below it are text to read, and a
  // click on them toggled the option. The list of what either mode leaves continuous is folded
  // away, since it pushed the dialog's buttons below the fold on a short screen.
  return (
    <div className="gl-modal-note">
      <label style={{ display: "flex", alignItems: "flex-start", gap: 7 }}>
        <input
          type="checkbox"
          aria-label={t("Evaluate gates on the recorded grid")}
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span>
          <strong>{t("Evaluate gates on the recorded grid")}</strong>{" "}
          {t("(polygons on the workspace's 256-channel grid, rectangles clamped to the axis)")}
        </span>
      </label>
      <div className="gl-modal-note" style={{ marginLeft: 22 }}>
        {t(FLOWJO_GRID_OFF_NOTE)}
      </div>
      <details style={{ marginLeft: 22 }}>
        <summary>{t("What either way leaves continuous")}</summary>
        <div className="gl-modal-note">
          {t(FLOWJO_GRID_NOT_COVERED)}{" "}
          {t(FLOWJO_GRID_GATELAB_POLYGONS)}
        </div>
      </details>
    </div>
  );
}
