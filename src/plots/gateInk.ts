// gateInk.ts — how gates are drawn across the app: in their own colours or all in one ink, at what
// line width, and on what label backing (the Gating tab's Display popover, David 2026-10-23). One
// workspace setting drives every view: the Gating plot, the gate list and population tree, and the
// Strategy, Illustration and Plotting figures, whose own "Coloured gates" boxes mirror it. Gates
// open black. All of it is display only: displayGateColour replaces a gate's colour where it is
// shown, never in the gate itself, so stored colours, the colour picker and everything saved keep
// them. Colour that tells populations apart rather than decorating a gate (Plotting's composition
// bars, colour-by-population, backgating) keeps its palette and does not come through here.
import { createContext, useContext } from "react";

/** The ink of a gate drawn without its colour: the black mini_plot's publication style uses. */
export const GATE_INK = "#000000";
/** A gate's swatch in the lists when gates have no colour: dark, but not the plot's black. */
export const GATE_SWATCH_INK = "#4a5361";
/** The tailoring view's dashed versions of a gate, drawn without colour: dark grey, under the ink. */
export const GATE_REFERENCE_INK = "#555555";

/** 1.2 (David, 2026-10-23); a workspace saved with its own width keeps it. */
export const DEFAULT_GATE_LINE_WIDTH = 1.2;
/** 0.4, so the slider's 0.2 steps land on 1.2. */
export const MIN_GATE_LINE_WIDTH = 0.4;
export const MAX_GATE_LINE_WIDTH = 4;

export const DEFAULT_GATE_LABEL_BACKGROUND = 0.85;

/** The colour a gate is shown in: its own, or the ink when gates have no colour. */
export function displayGateColour(stored: string, coloured: boolean, ink: string = GATE_INK): string {
  return coloured ? stored : ink;
}

/** A gate line width restored from a workspace, clamped to the slider's range; absent is the default. */
export function restoredGateLineWidth(value: unknown): number {
  const v = typeof value === "number" ? value : Number(value);
  return Number.isFinite(v) && value !== null && value !== ""
    ? Math.max(MIN_GATE_LINE_WIDTH, Math.min(MAX_GATE_LINE_WIDTH, v))
    : DEFAULT_GATE_LINE_WIDTH;
}

/** Coloured gates restored from a workspace: only an explicit true turns them on; gates open black. */
export function restoredColouredGates(value: unknown): boolean {
  return value === true;
}

/** A label backing restored from a workspace, 0 to 1; absent is 0.85. */
export function restoredGateLabelBackground(value: unknown): number {
  const v = typeof value === "number" ? value : Number(value);
  return Number.isFinite(v) && value !== null && value !== "" ? Math.max(0, Math.min(1, v)) : DEFAULT_GATE_LABEL_BACKGROUND;
}

/** The gates as the plot draws them: unchanged when coloured, otherwise copies in `ink`. */
export function inkedForDisplay<T extends { color?: string }>(gates: readonly T[], coloured: boolean, ink: string): T[] {
  return coloured ? [...gates] : gates.map((gate) => ({ ...gate, color: displayGateColour(gate.color ?? "", false, ink) }));
}

/** The workspace's gate look and its setters, as every view reads it. */
export interface GateInk {
  coloured: boolean;
  lineWidth: number;
  labelBackground: number;
  setColoured(next: boolean): void;
  setLineWidth(next: number): void;
  setLabelBackground(next: number): void;
}

/** Outside the app (a component on its own, in a test) gates keep their colours and nothing is set. */
export const GateInkContext = createContext<GateInk>({
  coloured: true,
  lineWidth: DEFAULT_GATE_LINE_WIDTH,
  labelBackground: DEFAULT_GATE_LABEL_BACKGROUND,
  setColoured: () => undefined,
  setLineWidth: () => undefined,
  setLabelBackground: () => undefined,
});

export function useGateInk(): GateInk {
  return useContext(GateInkContext);
}

/**
 * A gate's colour swatch, where a swatch only marks the gate's colour (the gate list, the gate
 * pickers, Strategy's checklist): its colour, or null when gates have no colour, and then no
 * swatch is drawn (David, 2026-10-23). Pills and badges that carry text use useGateColour.
 */
export function useGateSwatch(): (stored: string) => string | null {
  const { coloured } = useGateInk();
  return (stored) => (coloured ? stored : null);
}

/** A gate's colour as a list shows it: its own, or a dark swatch when gates have no colour. */
export function useGateColour(): (stored: string) => string {
  const { coloured } = useGateInk();
  return (stored) => displayGateColour(stored, coloured, GATE_SWATCH_INK);
}
