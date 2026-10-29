// icons.tsx — small inline SVG icons (no emoji). 16×16, stroke = currentColor.

import type { ReactNode } from "react";

const base = {
  width: 16,
  height: 16,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.4,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

type IconProps = { size?: number };

/** Interface icons, in place of text glyphs (▸ ▾ × ↶ ↷ ⟲ ⟳ ← → ↑ ↓ ⧉ ⋮⋮). Decorative: the button
 *  that holds one carries the label. Sized 16 by default, like the draw tools. */
function UiIcon({ size = 16, className, filled, children }: IconProps & { className?: string; filled?: boolean; children: ReactNode }) {
  return (
    <svg
      {...base}
      width={size}
      height={size}
      {...(filled ? { fill: "currentColor", stroke: "none" } : {})}
      className={className ? `gl-icon ${className}` : "gl-icon"}
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/** Locked: a padlock, for a row that cannot be edited. */
export function LockIcon({ size = 12 }: { size?: number }) {
  return (
    <svg {...base} width={size} height={size} aria-hidden="true">
      <rect x="3.5" y="7" width="9" height="6.5" rx="1" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </svg>
  );
}

/** Disclosure: points right when closed and turns down when open (.gl-icon-chevron in tokens.css). */
export function ChevronIcon({ open = false, size }: IconProps & { open?: boolean }) {
  // The turn is on a wrapping span, not on the svg, whose transform origin engines treat differently.
  return (
    <span className={open ? "gl-icon-chevron is-open" : "gl-icon-chevron"} aria-hidden="true">
      <UiIcon size={size}>
        <path d="M6 3.5l4.5 4.5L6 12.5" />
      </UiIcon>
    </span>
  );
}

/** A dropdown's trigger: the menu opens below. */
export function ChevronDownIcon({ size }: IconProps) {
  return (
    <UiIcon size={size}>
      <path d="M3.5 6l4.5 4.5L12.5 6" />
    </UiIcon>
  );
}

/** Close a dialog or popover, or remove an item. */
export function CloseIcon({ size }: IconProps) {
  return (
    <UiIcon size={size}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </UiIcon>
  );
}

/** Undo. */
export function UndoIcon({ size }: IconProps) {
  return (
    <UiIcon size={size}>
      <path d="M5.5 4l-3 3 3 3" />
      <path d="M2.5 7H10a3 3 0 0 1 0 6H7" />
    </UiIcon>
  );
}

/** Redo. */
export function RedoIcon({ size }: IconProps) {
  return (
    <UiIcon size={size}>
      <path d="M10.5 4l3 3-3 3" />
      <path d="M13.5 7H6a3 3 0 0 0 0 6h3" />
    </UiIcon>
  );
}

/** Reset to the automatic or recorded value: an anticlockwise turn. */
/** Reset: drawn light (gl-icon-light, styles.css) beside the zoom buttons, as they are. */
export function ResetIcon({ size }: IconProps) {
  return (
    <UiIcon size={size} className="gl-icon-light">
      <path d="M2 8a6 6 0 1 0 6-6 6.5 6.5 0 0 0-4.5 1.8L2 5.3" />
      <path d="M2 2v3.3h3.3" />
    </UiIcon>
  );
}

/** Draw again, such as a new random seed: a clockwise turn. */
export function RefreshIcon({ size }: IconProps) {
  return (
    <UiIcon size={size}>
      <path d="M14 8a6 6 0 1 1-6-6 6.5 6.5 0 0 1 4.5 1.8L14 5.3" />
      <path d="M14 2v3.3h-3.3" />
    </UiIcon>
  );
}

export function ArrowLeftIcon({ size }: IconProps) {
  return (
    <UiIcon size={size}>
      <path d="M13 8H3M7 4L3 8l4 4" />
    </UiIcon>
  );
}

export function ArrowRightIcon({ size }: IconProps) {
  return (
    <UiIcon size={size}>
      <path d="M3 8h10M9 4l4 4-4 4" />
    </UiIcon>
  );
}

export function ArrowUpIcon({ size }: IconProps) {
  return (
    <UiIcon size={size}>
      <path d="M8 13V3M4 7l4-4 4 4" />
    </UiIcon>
  );
}

export function ArrowDownIcon({ size }: IconProps) {
  return (
    <UiIcon size={size}>
      <path d="M8 3v10M4 9l4 4 4-4" />
    </UiIcon>
  );
}

/** Remove one, or a partly checked box. */
export function MinusIcon({ size }: IconProps) {
  return (
    <UiIcon size={size}>
      <path d="M3 8h10" />
    </UiIcon>
  );
}

/** Duplicate. */
export function DuplicateIcon({ size }: IconProps) {
  return (
    <UiIcon size={size}>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1" />
      <path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
    </UiIcon>
  );
}

/** Drag handle on a reorderable row. */
export function GripIcon({ size }: IconProps) {
  return (
    <UiIcon size={size} filled>
      <circle cx="6" cy="4" r="1.1" />
      <circle cx="10" cy="4" r="1.1" />
      <circle cx="6" cy="8" r="1.1" />
      <circle cx="10" cy="8" r="1.1" />
      <circle cx="6" cy="12" r="1.1" />
      <circle cx="10" cy="12" r="1.1" />
    </UiIcon>
  );
}

/** Navigate / pan — arrow cursor. */
export function NavigateIcon() {
  return (
    <svg {...base}>
      <path d="M3 1.5l10.5 5.8-4.7 1.6L6.9 14.5 3 1.5z" />
    </svg>
  );
}

/** Rectangle gate. */
export function RectIcon() {
  return (
    <svg {...base}>
      <rect x="1.75" y="3.25" width="12.5" height="9.5" rx="1" />
    </svg>
  );
}

/** Ellipse gate. */
export function EllipseIcon() {
  return (
    <svg {...base}>
      <ellipse cx="8" cy="8" rx="6.5" ry="4.5" />
    </svg>
  );
}

/** Polygon gate. */
export function PolyIcon() {
  return (
    <svg {...base}>
      <polygon points="8,1.5 14.5,6.3 12,14.25 4,14.25 1.5,6.3" />
    </svg>
  );
}

/** Quadrant gate — crosshair. */
export function QuadIcon() {
  return (
    <svg {...base}>
      <rect x="1.75" y="1.75" width="12.5" height="12.5" rx="1" />
      <line x1="8" y1="1.75" x2="8" y2="14.25" />
      <line x1="1.75" y1="8" x2="14.25" y2="8" />
    </svg>
  );
}

/** Histogram view — bars on an axis. */
export function HistogramIcon() {
  return (
    <svg {...base}>
      <path d="M2 13.5h12" />
      <path d="M3.5 13.5V9h2v4.5M6.5 13.5V4h2v9.5M9.5 13.5V7h2v6.5" />
    </svg>
  );
}

/** Range gate — an interval with its two ends. */
export function RangeIcon() {
  return (
    <svg {...base}>
      <path d="M3 4.5v7M13 4.5v7M3 8h10" />
    </svg>
  );
}

/** Bisector — two ranges meeting at one line. */
export function BisectorIcon() {
  return (
    <svg {...base}>
      <path d="M8 3v10M2 8h4.5M9.5 8H14" />
      <path d="M4.5 6.5L2.5 8l2 1.5M11.5 6.5l2 1.5-2 1.5" />
    </svg>
  );
}

/** Swap X and Y — a curved arrow from the X axis to the Y axis, headed at both ends; as light as Zoom in. */
export function SwapAxesIcon() {
  return (
    <svg {...base} width={15} height={15} strokeWidth={1.15} className="gl-icon-light">
      <path d="M12.5 11.5C7 11.5 4.5 9 4.5 3.5" />
      <path d="M2.8 5.3L4.5 3.5l1.7 1.8M10.7 9.8l1.8 1.7-1.8 1.7" />
    </svg>
  );
}

/** Zoom in — a magnifier with a plus; light, 15 px at a 1.15 stroke ("too heavy", David 2026-10-23). */
export function ZoomInIcon() {
  return (
    <svg {...base} width={15} height={15} strokeWidth={1.15} className="gl-icon-light">
      <circle cx="7" cy="7" r="4.25" />
      <path d="M10.2 10.2L13.5 13.5M5.3 7h3.4M7 5.3v3.4" />
    </svg>
  );
}

/** Zoom out — a magnifier with a minus, as light as Zoom in. */
export function ZoomOutIcon() {
  return (
    <svg {...base} width={15} height={15} strokeWidth={1.15} className="gl-icon-light">
      <circle cx="7" cy="7" r="4.25" />
      <path d="M10.2 10.2L13.5 13.5M5.3 7h3.4" />
    </svg>
  );
}

/** A gate's own version, branched off the tree's: the mark of a gate's tailoring scope. */
export function BranchIcon({ size = 16 }: { size?: number }) {
  return (
    <svg {...base} width={size} height={size} aria-hidden="true">
      <circle cx="4.5" cy="3.5" r="1.5" />
      <circle cx="4.5" cy="12.5" r="1.5" />
      <circle cx="11.5" cy="5.5" r="1.5" />
      <path d="M4.5 5v6M11.5 7c0 2.6-7 2.2-7 4" />
    </svg>
  );
}

/** More actions: the ⋯ of a header or a row, opening its menu. */
export function MoreIcon({ size = 14 }: { size?: number }) {
  return (
    <svg {...base} width={size} height={size} fill="currentColor" stroke="none" aria-hidden="true">
      <circle cx="3.5" cy="8" r="1.3" />
      <circle cx="8" cy="8" r="1.3" />
      <circle cx="12.5" cy="8" r="1.3" />
    </svg>
  );
}

/** A compensation matrix: a small grid, beside the matrix's M-number. */
export function MatrixIcon({ size = 12 }: { size?: number }) {
  return (
    <UiIcon size={size}>
      <rect x="2" y="2" width="12" height="12" rx="1.5" />
      <path d="M6 2v12M10 2v12M2 6h12M2 10h12" />
    </UiIcon>
  );
}

/** Plot type: pseudocolour, a cloud whose middle is hot. */
export function PseudocolorIcon({ size = 14 }: { size?: number }) {
  return (
    <svg {...base} width={size} height={size} stroke="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6" fill="#4f7cd8" />
      <circle cx="8" cy="8" r="4" fill="#4fbf8a" />
      <circle cx="8" cy="8" r="2.2" fill="#e8b23a" />
      <circle cx="8" cy="8" r="1" fill="#d9463b" />
    </svg>
  );
}

/** Plot type: dots, one per event. */
export function DotsIcon({ size = 14 }: { size?: number }) {
  return (
    <svg {...base} width={size} height={size} fill="currentColor" stroke="none" aria-hidden="true">
      {[[4, 5], [7, 3.5], [10, 6], [6, 8.5], [9, 9.5], [12, 10], [4.5, 11.5], [8, 12.5], [11.5, 4]].map(([x, y]) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1" />)}
    </svg>
  );
}

/** Plot type: contours, nested density lines. */
export function ContourIcon({ size = 14 }: { size?: number }) {
  return (
    <svg {...base} width={size} height={size} aria-hidden="true">
      <ellipse cx="8" cy="8" rx="6.2" ry="5" />
      <ellipse cx="8.4" cy="8.2" rx="3.8" ry="3" />
      <ellipse cx="8.8" cy="8.4" rx="1.5" ry="1.1" />
    </svg>
  );
}

/** A small downward caret: the tailoring switch's ▾ of choices. */
export function CaretIcon({ size = 10 }: { size?: number }) {
  return (
    <svg {...base} width={size} height={size} fill="currentColor" stroke="none" aria-hidden="true">
      <path d="M3.5 6h9L8 11z" />
    </svg>
  );
}

/** Add: a new population. */
export function PlusIcon({ size = 12 }: { size?: number }) {
  return (
    <svg {...base} width={size} height={size} aria-hidden="true">
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}

/** A hint, read on hover: the "?" in a circle. */
export function HelpIcon({ size = 13 }: { size?: number }) {
  return (
    <svg {...base} width={size} height={size} aria-hidden="true">
      <circle cx="8" cy="8" r="6.2" />
      <path d="M6.2 6.3a1.9 1.9 0 0 1 3.6.6c0 1.2-1.8 1.5-1.8 2.7" />
      <circle cx="8" cy="11.6" r="0.4" fill="currentColor" />
    </svg>
  );
}

/** A menu item that is on. */
export function CheckIcon({ size = 12 }: { size?: number }) {
  return (
    <svg {...base} width={size} height={size} aria-hidden="true">
      <path d="M3 8.5l3.2 3L13 4.5" />
    </svg>
  );
}
