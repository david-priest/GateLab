import { useEffect, useRef, useState, type ChangeEvent, type InputHTMLAttributes, type KeyboardEvent } from "react";

export interface NumberFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type" | "min" | "max" | "step"> {
  value: number;
  /** Called with the parsed, clamped value when it is committed and differs from `value`. */
  onCommit: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  /** Round the committed value to a whole number. */
  integer?: boolean;
}

/**
 * A number input that keeps what is typed until Enter or leaving the field, then clamps to
 * [min, max] and commits. Committing on every keystroke, with a minimum, makes a value below the
 * minimum impossible to type ("3" for 300 becomes 140 at once); this waits. The spinner arrows
 * and the mouse wheel commit at once, since they produce a whole value. Escape restores the
 * committed value.
 */
export function NumberField({ value, onCommit, min, max, step, integer, onKeyDown, onBlur, onFocus, ...rest }: NumberFieldProps) {
  const [draft, setDraft] = useState(String(value));
  const [editing, setEditing] = useState(false);
  // Escape blurs the field; the blur that follows must not commit the draft being thrown away.
  const cancelled = useRef(false);
  useEffect(() => {
    if (!editing) setDraft(String(value));
  }, [value, editing]);

  const clamp = (raw: string): number | null => {
    if (raw.trim() === "") return null;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return null;
    let next = integer ? Math.round(parsed) : parsed;
    if (min !== undefined) next = Math.max(min, next);
    if (max !== undefined) next = Math.min(max, next);
    return next;
  };
  const commit = (raw: string) => {
    const next = clamp(raw);
    if (next === null) {
      setDraft(String(value));
      return;
    }
    setDraft(String(next));
    if (next !== value) onCommit(next);
  };

  return (
    <input
      {...rest}
      type="number"
      inputMode="decimal"
      value={draft}
      min={min}
      max={max}
      step={step}
      onFocus={(event) => {
        setEditing(true);
        onFocus?.(event);
      }}
      onChange={(event: ChangeEvent<HTMLInputElement>) => {
        setDraft(event.target.value);
        // Typing carries an inputType; the spinner and the wheel do not, and their value is whole.
        const typed = (event.nativeEvent as InputEvent | undefined)?.inputType;
        if (!typed) commit(event.target.value);
      }}
      onBlur={(event) => {
        setEditing(false);
        if (cancelled.current) cancelled.current = false;
        else commit(event.currentTarget.value);
        onBlur?.(event);
      }}
      onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit(event.currentTarget.value);
        } else if (event.key === "Escape") {
          event.preventDefault();
          cancelled.current = true;
          setDraft(String(value));
          event.currentTarget.blur();
        }
        onKeyDown?.(event);
      }}
    />
  );
}
