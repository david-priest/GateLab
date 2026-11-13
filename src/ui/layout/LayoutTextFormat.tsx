// LayoutTextFormat.tsx — the formatting of a Layout text block: how it is drawn on the page, the
// editor's bold, italic, superscript and subscript within the block (Cmd-B, Cmd-I and a small
// bar by the editor), and the inspector's italic, colour, alignment and marker-sign fields for
// the whole block. The block's text is one string; see richText.ts for how it holds formatting.

import { Fragment, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type Dispatch, type ReactNode, type RefObject, type SetStateAction } from "react";
import type { LayoutTextRecipe } from "../../engine/layout";
import { useI18n } from "../i18n";
import {
  RICH_MARKS,
  insertRichText,
  marksInRange,
  marksWithPending,
  richRunsOf,
  superscriptMarkerSigns,
  textOfRuns,
  toggleMark,
  type RichMark,
  type RichRun,
} from "./richText";
import { readRuns, renderRuns, selectOffsets, selectionOffsets } from "./richTextDom";
import "./layoutText.css";

/** The whole-block formatting a text block carries beside its size and weight. */
export type TextBlockFormat = Pick<LayoutTextRecipe, "italic" | "color" | "align" | "rich">;

/** The style of a block's surface for its whole-block formatting; nothing for a block without any, so older blocks draw as before. */
export function textBlockStyle(format: TextBlockFormat | undefined): CSSProperties {
  return {
    ...(format?.italic ? { fontStyle: "italic" } : {}),
    ...(format?.color ? { color: format.color } : {}),
    ...(format?.align ? { textAlign: format.align } : {}),
  };
}

/** A run's elements as React draws them: b outside i outside sup or sub. */
function runElement(run: RichRun, key: number): ReactNode {
  let node: ReactNode = run.text;
  if (run.sub) node = <sub>{node}</sub>;
  if (run.sup) node = <sup>{node}</sup>;
  if (run.italic) node = <i>{node}</i>;
  if (run.bold) node = <b>{node}</b>;
  return <Fragment key={key}>{node}</Fragment>;
}

/** A block's words as drawn: the formatting elements for a rich block, the text alone for a plain one. */
export function RichTextContent({ text, rich }: Readonly<{ text: string; rich?: boolean }>) {
  if (!rich) return <>{text}</>;
  const runs = richRunsOf(text, true);
  return <>{runs.map(runElement)}{runs.at(-1)?.text.endsWith("\n") ? <br /> : null}</>;
}

const MARK_LABEL: Readonly<Record<RichMark, { label: string; title: string; glyph: ReactNode }>> = {
  bold: { label: "Bold", title: "Bold (Cmd-B)", glyph: <b>B</b> },
  italic: { label: "Italic", title: "Italic (Cmd-I)", glyph: <i>I</i> },
  sup: { label: "Superscript", title: "Superscript", glyph: <>x<sup>2</sup></> },
  sub: { label: "Subscript", title: "Subscript", glyph: <>x<sub>2</sub></> },
};

const NO_MARKS: Record<RichMark, boolean> = { bold: false, italic: false, sup: false, sub: false };

/** The four inline marks as buttons by the editor, each pressed when the selection carries it. */
function TextFormatBar({ state, onToggle }: Readonly<{ state: Record<RichMark, boolean>; onToggle: (mark: RichMark) => void }>) {
  const { t } = useI18n();
  return (
    <div className="gl-layout-text-bar" role="toolbar" aria-label={t("Text formatting")}>
      {RICH_MARKS.map((mark) => (
        <button
          key={mark}
          type="button"
          className={"gl-mini-btn" + (state[mark] ? " is-active" : "")}
          aria-label={t(MARK_LABEL[mark].label)}
          aria-pressed={state[mark]}
          title={t(MARK_LABEL[mark].title)}
          // The editor keeps the keyboard and its selection.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onToggle(mark)}
        >
          {MARK_LABEL[mark].glyph}
        </button>
      ))}
    </div>
  );
}

/** Cmd-B or Cmd-I (Ctrl on other systems): the mark it switches. */
function markKey(event: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }): RichMark | null {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return null;
  const key = event.key.toLowerCase();
  return key === "b" ? "bold" : key === "i" ? "italic" : null;
}

interface RichStart { runs: RichRun[]; start: number; end: number; pending: RichMark[] }

/** A mark switched at a selection: over the range, or for what is typed next when nothing is selected. */
function applyMark(runs: RichRun[], start: number, end: number, pending: RichMark[], mark: RichMark): RichStart {
  if (start !== end) return { runs: toggleMark(runs, start, end, mark), start, end, pending };
  return { runs, start, end, pending: pending.includes(mark) ? pending.filter((m) => m !== mark) : [...pending, mark] };
}

/**
 * The editor of a text block, as the Layout tab opens it. A plain block is edited in a text field
 * as before; the first mark applied (a key or a button) turns it into the formatting editor at the
 * same selection. A rich block opens in the formatting editor. Leaving either keeps what was typed.
 */
export function LayoutTextEditField({
  areaRef,
  draft,
  setDraft,
  templateText,
  rich,
  style,
  onCommit,
  onEditEnd,
  onFocus,
}: Readonly<{
  areaRef: RefObject<HTMLTextAreaElement>;
  draft: string;
  setDraft: Dispatch<SetStateAction<string>>;
  templateText: string;
  rich?: boolean;
  style: CSSProperties;
  onCommit: (text: string, contentHeight: number, rich?: boolean) => void;
  onEditEnd: () => void;
  onFocus: () => void;
}>) {
  const [richStart, setRichStart] = useState<RichStart | null>(() =>
    rich ? { runs: richRunsOf(templateText, true), start: -1, end: -1, pending: [] } : null,
  );
  const switching = useRef(false);
  if (richStart) {
    return (
      <RichTextEditor
        start={richStart}
        templateText={templateText}
        wasRich={rich === true}
        style={style}
        onCommit={onCommit}
        onEditEnd={onEditEnd}
        onFocus={onFocus}
      />
    );
  }
  const toRich = (mark: RichMark) => {
    const area = areaRef.current;
    const start = area?.selectionStart ?? draft.length;
    const end = area?.selectionEnd ?? draft.length;
    switching.current = true;
    setRichStart(applyMark(richRunsOf(draft, false), start, end, [], mark));
  };
  return (
    <>
      <TextFormatBar state={NO_MARKS} onToggle={toRich} />
      <textarea
        ref={areaRef}
        className="gl-layout-text-surface"
        aria-label="Layout text"
        value={draft}
        style={style}
        onChange={(event) => setDraft(event.target.value)}
        onFocus={onFocus}
        onBlur={(event) => {
          if (switching.current) return;
          if (draft !== templateText) onCommit(draft, event.currentTarget.scrollHeight);
          onEditEnd();
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          const mark = markKey(event);
          if (mark) {
            event.preventDefault();
            toRich(mark);
            return;
          }
          if (event.key === "Escape") event.currentTarget.blur();
        }}
      />
    </>
  );
}

/** The formatting editor: the block's runs as elements the user types into, read back after every change. */
function RichTextEditor({
  start,
  templateText,
  wasRich,
  style,
  onCommit,
  onEditEnd,
  onFocus,
}: Readonly<{
  start: RichStart;
  templateText: string;
  wasRich: boolean;
  style: CSSProperties;
  onCommit: (text: string, contentHeight: number, rich?: boolean) => void;
  onEditEnd: () => void;
  onFocus: () => void;
}>) {
  const ref = useRef<HTMLDivElement>(null);
  const runs = useRef<RichRun[]>(start.runs);
  /** Marks switched with nothing selected, for what is typed next at `pendingAt`. */
  const pending = useRef<{ marks: RichMark[]; at: number }>({ marks: start.pending, at: start.start });
  const [state, setState] = useState<Record<RichMark, boolean>>(NO_MARKS);

  const refresh = () => {
    const root = ref.current;
    if (!root) return;
    const at = selectionOffsets(root);
    if (!at) return;
    if (pending.current.marks.length && (at.start !== at.end || at.start !== pending.current.at)) pending.current = { marks: [], at: -1 };
    const base = marksInRange(runs.current, at.start, at.end);
    const marks = marksWithPending(base, pending.current.marks);
    setState({ bold: !!marks.bold, italic: !!marks.italic, sup: !!marks.sup, sub: !!marks.sub });
  };

  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    renderRuns(root, runs.current);
    root.focus({ preventScroll: true });
    const length = runs.current.reduce((sum, run) => sum + run.text.length, 0);
    const from = start.start < 0 ? length : start.start;
    const to = start.end < 0 ? length : start.end;
    selectOffsets(root, from, to);
    if (pending.current.at < 0) pending.current.at = from;
    refresh();
    // The editor opens on the runs as they are then; what it holds after is its own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onSelection = () => refresh();
    // Text put in by other means than a key press (an input method, dictation, an automation)
    // takes a pending mark too.
    const root = ref.current;
    const onBeforeInput = (event: InputEvent) => {
      if (!pending.current.marks.length || event.isComposing || event.inputType !== "insertText" || !event.data) return;
      event.preventDefault();
      insert(event.data);
    };
    document.addEventListener("selectionchange", onSelection);
    root?.addEventListener("beforeinput", onBeforeInput);
    return () => {
      document.removeEventListener("selectionchange", onSelection);
      root?.removeEventListener("beforeinput", onBeforeInput);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** A change made here rather than by the browser: the runs drawn again and the caret put back. */
  const replace = (next: RichRun[], from: number, to: number) => {
    const root = ref.current;
    if (!root) return;
    runs.current = next;
    renderRuns(root, next);
    selectOffsets(root, from, to);
    refresh();
  };

  const toggle = (mark: RichMark) => {
    const root = ref.current;
    if (!root) return;
    const at = selectionOffsets(root) ?? { start: pending.current.at, end: pending.current.at };
    const lo = Math.min(at.start, at.end), hi = Math.max(at.start, at.end);
    const next = applyMark(runs.current, lo, hi, pending.current.marks, mark);
    pending.current = { marks: next.pending, at: lo };
    if (lo !== hi) replace(next.runs, lo, hi);
    else refresh();
  };

  const insert = (text: string) => {
    const root = ref.current;
    if (!root) return;
    const at = selectionOffsets(root);
    if (!at) return;
    const lo = Math.min(at.start, at.end), hi = Math.max(at.start, at.end);
    const marks = marksWithPending(marksInRange(runs.current, lo, lo === hi ? lo : hi), pending.current.marks);
    pending.current = { marks: [], at: -1 };
    replace(insertRichText(runs.current, lo, hi, text, marks), lo + text.length, lo + text.length);
  };

  return (
    <>
      <TextFormatBar state={state} onToggle={toggle} />
      <div
        ref={ref}
        className="gl-layout-text-surface is-rich-editor"
        role="textbox"
        aria-multiline="true"
        aria-label="Layout text"
        contentEditable
        suppressContentEditableWarning
        tabIndex={0}
        style={style}
        onFocus={onFocus}
        onInput={(event) => {
          runs.current = readRuns(event.currentTarget);
          refresh();
        }}
        onPaste={(event) => {
          event.preventDefault();
          insert(event.clipboardData.getData("text/plain").replace(/\r\n?/g, "\n"));
        }}
        onBlur={(event) => {
          const saved = textOfRuns(runs.current);
          if (saved.text !== templateText || saved.rich !== wasRich) onCommit(saved.text, event.currentTarget.scrollHeight, saved.rich);
          onEditEnd();
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.nativeEvent.isComposing) return;
          const mark = markKey(event);
          if (mark) {
            event.preventDefault();
            toggle(mark);
            return;
          }
          if (event.key === "Escape") {
            event.currentTarget.blur();
            return;
          }
          if (event.key === "Enter") {
            event.preventDefault();
            insert("\n");
            return;
          }
          // A mark switched with nothing selected applies to the next character typed.
          if (pending.current.marks.length && event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
            event.preventDefault();
            insert(event.key);
          }
        }}
      />
    </>
  );
}

/** A whole-block change to the selected text blocks, as the inspector makes it. */
export interface TextBlockPatch {
  fontSize?: number;
  bold?: boolean;
  italic?: boolean;
  /** A colour, or null for the page's text colour. */
  color?: string | null;
  align?: "left" | "center" | "right";
  /** Set the marker signs after marker names as superscripts. */
  markerSigns?: true;
}

/** The italic, colour, alignment and marker-sign parts of a patch, applied to a text recipe in place. */
export function applyTextFormat(recipe: LayoutTextRecipe, patch: TextBlockPatch): void {
  if (patch.italic === true) recipe.italic = true;
  else if (patch.italic === false) delete recipe.italic;
  if (typeof patch.color === "string") recipe.color = patch.color.toLowerCase();
  else if (patch.color === null) delete recipe.color;
  if (patch.align === "center" || patch.align === "right") recipe.align = patch.align;
  else if (patch.align === "left") delete recipe.align;
  if (patch.markerSigns) {
    const saved = textOfRuns(superscriptMarkerSigns(richRunsOf(recipe.text, recipe.rich)));
    if (saved.rich) {
      recipe.text = saved.text;
      recipe.rich = true;
    }
  }
}

const DEFAULT_TEXT_COLOUR = "#1e293b";

/** The inspector's italic, colour, alignment and marker-sign fields for the selected text blocks. */
export function LayoutTextFormatFields({
  texts,
  onChange,
}: Readonly<{
  texts: readonly TextBlockFormat[];
  onChange: (patch: TextBlockPatch) => void;
}>) {
  const { t } = useI18n();
  if (!texts.length) return null;
  const colours = [...new Set(texts.map((text) => text.color ?? DEFAULT_TEXT_COLOUR))];
  const aligns = [...new Set(texts.map((text) => text.align ?? "left"))];
  return (
    <>
      <label className="gl-check">
        <input type="checkbox" checked={texts.every((text) => text.italic === true)} onChange={(event) => onChange({ italic: event.target.checked })} />
        {t("Italic")}
      </label>
      <label className="gl-field-inline" title={colours.length > 1 ? t("The selected text blocks differ: {values}", { values: colours.join(", ") }) : undefined}>
        {t("Text colour")}
        <input type="color" aria-label={t("Text colour")} value={colours[0]} onChange={(event) => onChange({ color: event.target.value })} />
        {texts.some((text) => text.color) && (
          <button type="button" className="gl-mini-btn" onClick={() => onChange({ color: null })} title={t("The page's text colour")}>{t("Default")}</button>
        )}
      </label>
      <label className="gl-field-inline">
        {t("Align")}
        <select aria-label={t("Text alignment")} value={aligns.length === 1 ? aligns[0] : ""} onChange={(event) => onChange({ align: event.target.value as TextBlockPatch["align"] })}>
          {aligns.length > 1 && <option value="" disabled>{t("mixed")}</option>}
          <option value="left">{t("Left")}</option>
          <option value="center">{t("Centre")}</option>
          <option value="right">{t("Right")}</option>
        </select>
      </label>
      <button
        type="button"
        className="gl-mini-btn"
        onClick={() => onChange({ markerSigns: true })}
        title={t("Set +, -, hi, lo, dim, bright and int after a marker name as superscripts (CD4+ becomes CD4 with a raised +)")}
      >
        {t("Superscript marker signs")}
      </button>
    </>
  );
}

/** The inspector's hint under a rich block's read-only Text field. */
export function RichTextFieldHint() {
  const { t } = useI18n();
  return <p className="gl-hint">{t("This text has formatting; double-click it on the page to edit it.")}</p>;
}
