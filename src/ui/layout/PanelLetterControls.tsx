// PanelLetterControls.tsx — the Layout tab's controls for panel letters: the toolbar's two
// buttons, the sheet's letter style (Style tab, and the inspector when a letter is selected), and
// what the inspector says about a selected letter. The letters themselves are in panelLetters.ts.

import type { LayoutLetterStyle } from "../../engine/layout";
import { useI18n } from "../i18n";
import { NumberField } from "../NumberField";

export function PanelLetterButtons({
  canAdd,
  canRemove,
  onAdd,
  onRemove,
}: Readonly<{ canAdd: boolean; canRemove: boolean; onAdd: () => void; onRemove: () => void }>) {
  const { t } = useI18n();
  return (
    <>
      <button className="gl-mini-btn" type="button" onClick={onAdd} disabled={!canAdd} title={t("Letter each selected plot, chart or figure at its top left, in reading order; with nothing selected, every one on the sheet. An item that has a letter keeps it.")}>
        {t("Panel letters")}
      </button>
      <button className="gl-mini-btn" type="button" onClick={onRemove} disabled={!canRemove} title={t("Remove the panel letters of the selection; with nothing selected, every panel letter on the sheet")}>
        {t("Remove panel letters")}
      </button>
    </>
  );
}

/** The sheet's letter style: size, bold, and upper or lower case. */
export function PanelLetterStyleFields({
  style,
  onChange,
}: Readonly<{ style: LayoutLetterStyle; onChange: (patch: Partial<LayoutLetterStyle>) => void }>) {
  const { t } = useI18n();
  return (
    <div className="gl-layout-letter-style" role="group" aria-label={t("Panel letters")}>
      <label className="gl-field-inline">
        {t("Letter size")}
        <NumberField aria-label={t("Letter size")} min={6} max={72} integer value={style.fontSize} onCommit={(fontSize) => onChange({ fontSize })} />
      </label>
      <label className="gl-check">
        <input type="checkbox" aria-label={t("Bold")} checked={style.bold} onChange={(event) => onChange({ bold: event.target.checked })} />
        {t("Bold")}
      </label>
      <label className="gl-field-inline">
        {t("Letters")}
        <select aria-label={t("Letters")} value={style.case} onChange={(event) => onChange({ case: event.target.value === "lower" ? "lower" : "upper" })}>
          <option value="upper">{t("A, B, C")}</option>
          <option value="lower">{t("a, b, c")}</option>
        </select>
      </label>
    </div>
  );
}

/** The Style tab's section for the sheet's panel letters. */
export function PanelLetterStyleSection({
  style,
  onChange,
}: Readonly<{ style: LayoutLetterStyle; onChange: (patch: Partial<LayoutLetterStyle>) => void }>) {
  const { t } = useI18n();
  return (
    <section className="gl-layout-letter-section">
      <h4>{t("Panel letters")}</h4>
      <p className="gl-hint">{t("How the sheet's panel letters are drawn. A letter sits at the top left of its item and moves with it; letters are given in reading order, rows from the top and left to right within a row, and renumber when items move.")}</p>
      <PanelLetterStyleFields style={style} onChange={onChange} />
    </section>
  );
}

/** What the inspector shows for a selected letter: the item it belongs to, and the sheet's letter style. */
export function PanelLetterInspector({
  owner,
  style,
  onChange,
}: Readonly<{ owner: string; style: LayoutLetterStyle; onChange: (patch: Partial<LayoutLetterStyle>) => void }>) {
  const { t } = useI18n();
  return (
    <>
      <p className="gl-layout-letter-owner">{t("Panel letter of {item}", { item: owner })}</p>
      <p className="gl-hint">{t("The letter is its item's place in reading order and is not edited as text. Drag it to set where it sits against its item; its size and style are the sheet's.")}</p>
      <PanelLetterStyleFields style={style} onChange={onChange} />
    </>
  );
}
