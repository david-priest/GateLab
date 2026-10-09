// quadrantOverlay.ts — a quadrant gate as a small plot draws it. Kept apart from the Illustration
// and Strategy modules, which both draw one and import one another's helpers.

import type { Sample } from "./sample";
import type { QuadrantGate } from "./models";
import { quadrantArmPoints } from "./gates";

/** The two bent dividers of a curly quadrant, in a cell's display units. */
export interface QuadrantArms { h: [number, number][]; v: [number, number][] }

/**
 * A quadrant gate as a cell draws it: the crosshair's centre in the cell's display units and,
 * for a curly quadrant, the two bent arms out to the ends of the cell's ranges. `flipped` says
 * the cell shows the gate's y channel on x. Shared by the Illustration cells and the Strategy
 * panels, so a quadrant is the same shape on both.
 */
export function quadrantOverlayShape(
  sample: Sample,
  gate: QuadrantGate,
  xCh: string,
  yCh: string,
  xRange: [number, number],
  yRange: [number, number] | null,
  flipped: boolean,
): { center: [number, number]; arms?: QuadrantArms } {
  const toCellDisplay = ([vx, vy]: [number, number]): [number, number] => {
    const cellX = flipped ? vy : vx;
    const cellY = flipped ? vx : vy;
    return [sample.gateToDisplay(gate, xCh, cellX), sample.gateToDisplay(gate, yCh, cellY)];
  };
  let arms: QuadrantArms | undefined;
  if (gate.curl && yRange) {
    const originalXDisplayEnd = flipped ? yRange[1] : xRange[1];
    const originalYDisplayEnd = flipped ? xRange[1] : yRange[1];
    const originalXEnd = sample.displayToGate(gate, gate.x_channel, originalXDisplayEnd);
    const originalYEnd = sample.displayToGate(gate, gate.y_channel, originalYDisplayEnd);
    const originalH = quadrantArmPoints(gate.center, gate.curl, "h", originalXEnd).map(toCellDisplay);
    const originalV = quadrantArmPoints(gate.center, gate.curl, "v", originalYEnd).map(toCellDisplay);
    if (originalH.length > 1 && originalV.length > 1) {
      arms = flipped ? { h: originalV, v: originalH } : { h: originalH, v: originalV };
    }
  }
  return { center: toCellDisplay(gate.center), ...(arms ? { arms } : {}) };
}
