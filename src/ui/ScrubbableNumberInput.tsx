import {
  useRef,
  useState,
  type InputHTMLAttributes,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useI18n } from "./i18n";

type Props = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "type" | "value" | "onChange"
> & Readonly<{
  value: string;
  onValueChange: (value: string) => void;
  scrubStep?: number;
}>;

/**
 * A normal editable number input with an additional vertical scrub gesture. Clicking still
 * focuses the field; dragging its body upward/downward changes by one step per four pixels.
 * The native stepper strip on the right is deliberately excluded from scrubbing.
 */
export function ScrubbableNumberInput({
  value,
  onValueChange,
  scrubStep,
  className = "",
  disabled,
  min,
  max,
  step,
  title,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onLostPointerCapture,
  ...rest
}: Props) {
  const { t } = useI18n();
  const dragRef = useRef<Readonly<{
    pointerId: number;
    startY: number;
    startValue: number;
    step: number;
    decimals: number;
    lastSteps: number;
  }> | null>(null);
  const [scrubbing, setScrubbing] = useState(false);

  const finishScrub = (event: ReactPointerEvent<HTMLInputElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) {
      dragRef.current = null;
      setScrubbing(false);
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    }
  };

  return (
    <input
      {...rest}
      type="number"
      className={`gl-scrubbable-number${scrubbing ? " is-scrubbing" : ""}${className ? ` ${className}` : ""}`}
      value={value}
      disabled={disabled}
      min={min}
      max={max}
      step={step}
      title={title ?? t("Type a value, use the arrows, or drag vertically to adjust")}
      onChange={(event) => onValueChange(event.currentTarget.value)}
      onPointerDown={(event) => {
        onPointerDown?.(event);
        if (event.defaultPrevented || disabled || event.button !== 0) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientX >= bounds.right - 18) return;
        const startValue = Number(value);
        const resolvedStep = (scrubStep ?? Number(step)) || 0.1;
        if (!Number.isFinite(startValue) || !(resolvedStep > 0)) return;
        const stepText = String(resolvedStep);
        const decimals = stepText.includes("e-")
          ? Number(stepText.split("e-")[1])
          : stepText.includes(".")
            ? stepText.split(".")[1].length
            : 0;
        dragRef.current = {
          pointerId: event.pointerId,
          startY: event.clientY,
          startValue,
          step: resolvedStep,
          decimals,
          lastSteps: 0,
        };
        event.currentTarget.setPointerCapture?.(event.pointerId);
      }}
      onPointerMove={(event) => {
        onPointerMove?.(event);
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        const distance = drag.startY - event.clientY;
        if (Math.abs(distance) < 3) return;
        const steps = distance > 0 ? Math.floor(distance / 4) : Math.ceil(distance / 4);
        if (steps === drag.lastSteps) return;
        let next = drag.startValue + steps * drag.step;
        const lower = min === undefined ? Number.NEGATIVE_INFINITY : Number(min);
        const upper = max === undefined ? Number.POSITIVE_INFINITY : Number(max);
        if (Number.isFinite(lower)) next = Math.max(lower, next);
        if (Number.isFinite(upper)) next = Math.min(upper, next);
        dragRef.current = { ...drag, lastSteps: steps };
        setScrubbing(true);
        onValueChange(next.toFixed(Math.min(10, drag.decimals)));
        event.preventDefault();
      }}
      onPointerUp={(event) => {
        onPointerUp?.(event);
        finishScrub(event);
      }}
      onPointerCancel={(event) => {
        onPointerCancel?.(event);
        finishScrub(event);
      }}
      onLostPointerCapture={(event) => {
        onLostPointerCapture?.(event);
        if (dragRef.current?.pointerId === event.pointerId) {
          dragRef.current = null;
          setScrubbing(false);
        }
      }}
    />
  );
}
