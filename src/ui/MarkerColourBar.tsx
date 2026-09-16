// MarkerColourBar.tsx — the key for "Colour by → Channel".
//
// The categorical overlays get a swatch per level; a marker cannot, because there are 255 of
// them. It gets the ramp itself, the channel it stands for, and the values along it.

import { markerColourFraction, markerColourTicks, type MarkerColourScale } from "../engine/markerColour";

/** One label, and where along the ramp it belongs (0 = the low end, 1 = the high end). */
export interface MarkerColourBarTick {
  fraction: number;
  label: string;
}

interface Props {
  label: string;
  scale: MarkerColourScale;
  /** The full palette handed to the renderer: index 0 is the missing colour, then the ramp. */
  palette: string[];
  /**
   * The channel's own axis ticks, in the channel's own labels. Supplied by the caller because
   * this is the same tick machinery the axes use: a bar reading 0.38 beside an axis reading
   * 10K describes the same marker in a language the second one does not speak. Omitted for a
   * channel with no such ticks (CyTOF metals, QC), which falls back to the raw display values.
   */
  ticks?: MarkerColourBarTick[];
  /**
   * The contrast exponent the events were coloured with, so the fallback labels sit where those
   * values fall on the ramp. Without it the fallback spaced them evenly, which is only right at
   * an exponent of 1.
   */
  power?: number;
}

/**
 * The fallback labels, for a channel whose axis carries no tick scheme. Readable across the
 * decades a display axis spans: neither fixed decimals nor plain exponentials work for both
 * ends of a logicle range at once.
 */
function formatTick(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const magnitude = Math.abs(value);
  if (magnitude >= 100_000 || (magnitude > 0 && magnitude < 0.01)) return value.toExponential(1);
  if (magnitude >= 100) return value.toFixed(0);
  if (magnitude >= 1) return value.toFixed(1);
  return value.toFixed(2);
}

/**
 * How close two labels may sit, as a fraction of the bar's width.
 *
 * A logicle channel's decades bunch up in its linear region — on the demo file "-100", "0" and
 * "100" all land within 5% of the bar and print on top of each other. The axis has the width and
 * the tick marks to carry them; a 220px bar does not. 0.12 clears the widest label this uses
 * ("100K") at that width, and the value is a fraction so a wider bar keeps more labels.
 */
const MIN_TICK_GAP = 0.12;

/**
 * Thin colliding labels, keeping BOTH ends. The ends are the two values a reader looks for
 * first, so the last tick displaces whatever it collides with rather than being dropped itself.
 */
function thinTicks(ticks: MarkerColourBarTick[]): MarkerColourBarTick[] {
  if (ticks.length <= 2) return ticks;
  const kept: MarkerColourBarTick[] = [ticks[0]];
  for (const tick of ticks.slice(1)) {
    if (tick.fraction - kept[kept.length - 1].fraction >= MIN_TICK_GAP) kept.push(tick);
  }
  const last = ticks[ticks.length - 1];
  if (kept[kept.length - 1] !== last) {
    while (kept.length > 1 && last.fraction - kept[kept.length - 1].fraction < MIN_TICK_GAP) {
      kept.pop();
    }
    kept.push(last);
  }
  return kept;
}

export function MarkerColourBar({ label, scale, palette, ticks, power }: Props) {
  // Skip index 0: it is the missing colour, and putting it in the gradient would show a grey
  // step at the bottom of a ramp that does not have one.
  const ramp = palette.slice(1);
  const shown: MarkerColourBarTick[] = thinTicks(ticks?.length
    ? ticks
    : markerColourTicks(scale, 3).map((value) => ({
        fraction: markerColourFraction(value, scale, power),
        label: formatTick(value),
      })));
  return (
    <div className="gl-marker-colour-bar">
      <span className="gl-marker-colour-bar-label">{label}</span>
      <span className="gl-marker-colour-bar-scale">
        <span
          className="gl-marker-colour-bar-ramp"
          style={{ backgroundImage: `linear-gradient(to right, ${ramp.join(", ")})` }}
          role="img"
          aria-label={`${label}, ${shown[0]?.label ?? ""} to ${shown[shown.length - 1]?.label ?? ""}`}
        />
        <span className="gl-marker-colour-bar-ticks">
          {shown.map((tick, index) => (
            <span
              key={index}
              style={{ left: `${Math.max(0, Math.min(1, tick.fraction)) * 100}%` }}
            >
              {tick.label}
            </span>
          ))}
        </span>
      </span>
    </div>
  );
}
