// icons.tsx — small inline SVG icons (no emoji). 16×16, stroke = currentColor.

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

/** Navigate / pan — arrow cursor. */
export function NavigateIcon() {
  return (
    <svg {...base}>
      <path d="M3 2l9 5-4 1.4L6.5 13 3 2z" />
    </svg>
  );
}

/** Rectangle gate. */
export function RectIcon() {
  return (
    <svg {...base}>
      <rect x="2.5" y="4" width="11" height="8" rx="1" />
    </svg>
  );
}

/** Polygon gate. */
export function PolyIcon() {
  return (
    <svg {...base}>
      <polygon points="8,2 14,6.5 11.5,13.5 4.5,13.5 2,6.5" />
    </svg>
  );
}

/** Quadrant gate — crosshair. */
export function QuadIcon() {
  return (
    <svg {...base}>
      <rect x="2.5" y="2.5" width="11" height="11" rx="1" />
      <line x1="8" y1="2.5" x2="8" y2="13.5" />
      <line x1="2.5" y1="8" x2="13.5" y2="8" />
    </svg>
  );
}
