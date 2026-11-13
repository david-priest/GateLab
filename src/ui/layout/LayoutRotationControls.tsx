// LayoutRotationControls.tsx — quarter turns of text blocks and placed images on the Layout tab:
// "Rotate left" and "Rotate right" in the inspector and the item's menu, shown only when every
// item they act on can be turned, and the box a turned item's content is drawn in on the page.
// The model and the frame swap are in layoutRotation.ts.

import type { ReactNode } from "react";
import type { LayoutItem } from "../../engine/layout";
import type { MenuEntry } from "../MenuButton";
import { useI18n } from "../i18n";
import { canTurn, canTurnAll, turnedBoxStyle, turnOf, type LayoutTurn, type TurnDirection } from "./layoutRotation";
import "./layoutRotation.css";

type Translate = (source: string, values?: Readonly<Record<string, string | number>>) => string;
type Turnable = Pick<LayoutItem, "recipe" | "rotation" | "locked">;

const LEFT_TIP = "Turn the text or image 90° anticlockwise; its frame turns about its centre";
const RIGHT_TIP = "Turn the text or image 90° clockwise; its frame turns about its centre";

/** Whether every item can be turned and at least one is unlocked. */
const anyUnlocked = (items: readonly Turnable[]) => items.some((item) => !item.locked && canTurn(item));

/** The inspector's two buttons, for a selection of text blocks and placed images only; nothing for any other. */
export function LayoutRotationButtons({ items, onTurn }: Readonly<{ items: readonly Turnable[]; onTurn: (direction: TurnDirection) => void }>) {
  const { t } = useI18n();
  if (!canTurnAll(items)) return null;
  const disabled = !anyUnlocked(items);
  const turn = items.length === 1 ? turnOf(items[0]) : 0;
  return (
    <div className="gl-layout-item-actions gl-layout-rotation">
      <button type="button" className="gl-mini-btn" disabled={disabled} onClick={() => onTurn("left")} title={t(LEFT_TIP)}>{t("Rotate left")}</button>
      <button type="button" className="gl-mini-btn" disabled={disabled} onClick={() => onTurn("right")} title={t(RIGHT_TIP)}>{t("Rotate right")}</button>
      {turn !== 0 && <span className="gl-hint gl-layout-rotation-state">{t("Turned {degrees}°", { degrees: turn })}</span>}
    </div>
  );
}

/** The item menu's two entries, for items that are all text blocks and placed images; none for any other. */
export function rotationMenuEntries(t: Translate, items: readonly Turnable[], onTurn: (direction: TurnDirection) => void): MenuEntry[] {
  if (!canTurnAll(items)) return [];
  const disabled = !anyUnlocked(items);
  return [
    { label: t("Rotate left"), disabled, onClick: () => onTurn("left") },
    { label: t("Rotate right"), disabled, onClick: () => onTurn("right") },
  ];
}

/**
 * A turned item's content on the page: laid out in a box the frame's size, width and height
 * swapped for a quarter turn, and turned about the frame's centre. With no turn, the content as it is.
 */
export function LayoutTurned({ turn, width, height, children }: Readonly<{ turn: LayoutTurn | undefined; width: number; height: number; children: ReactNode }>) {
  const style = turnedBoxStyle(turn ?? 0, width, height);
  if (!style) return <>{children}</>;
  return <div className="gl-layout-turned" data-turn={turn} style={style}>{children}</div>;
}
