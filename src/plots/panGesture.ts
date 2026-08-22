/**
 * The navigate-mode drag: pan, or "anchored stretch" while Shift/Option is held.
 *
 * Extracted from App so the modifier's semantics can be tested. They were the bug: the handler
 * decided pan-vs-stretch ONCE at mousedown and never looked again, so pressing Shift after the
 * drag started did nothing and releasing it mid-drag left the view still stretching -- the key
 * felt stuck down until the next mousedown re-read it. cytof_plot.js's own pan (_onPanMove)
 * always re-read the modifier per move, so two handlers on the same plot disagreed about what
 * Shift means.
 *
 * Shift is the primary modifier because Alt/Option is intercepted by the OS on some platforms.
 */

export type Range = [number, number];
export type PanMode = "pan" | "stretch";

/** Where the gesture is measured from. Replaced on every mode change (see step). */
export interface PanBase {
  xr: Range;
  yr: Range;
  /** Pointer position, in client pixels, that this base was taken at. */
  px: number;
  py: number;
}

export interface PanState {
  mode: PanMode;
  base: PanBase;
  /** The data point under the pointer at `base`; it is what tracks the cursor while stretching. */
  grab: { gx: number; gy: number };
}

/** The plot's data area in client pixels. */
export interface PlotRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PointerLike {
  clientX: number;
  clientY: number;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * Kept away from the exact edges: the stretch divides by the pointer's fractional position, so
 * 0 or 1 would send an axis to infinity.
 */
export const clampF = (f: number): number => Math.min(0.98, Math.max(0.02, f));

export const panModeFor = (ev: { altKey: boolean; shiftKey: boolean }): PanMode =>
  ev.altKey || ev.shiftKey ? "stretch" : "pan";

const grabbedAt = (base: PanBase, rect: PlotRect): { gx: number; gy: number } => ({
  gx: base.xr[0] + clampF((base.px - rect.left) / rect.width) * (base.xr[1] - base.xr[0]),
  gy: base.yr[1] - clampF((base.py - rect.top) / rect.height) * (base.yr[1] - base.yr[0]),
});

/** The state a drag starts in, from the mousedown event. */
export function panGestureStart(ev: PointerLike, xr: Range, yr: Range, rect: PlotRect): PanState {
  const base: PanBase = { xr, yr, px: ev.clientX, py: ev.clientY };
  return { mode: panModeFor(ev), base, grab: grabbedAt(base, rect) };
}

/**
 * One pointer move.
 *
 * `live` is the range the drag has already produced, used only when the mode changes: rebasing
 * on the range in force keeps the switch happening where the cursor is, instead of jumping back
 * to wherever the drag began. A mode change produces no range of its own -- it only rebases, and
 * the next move acts in the new mode.
 */
export function panGestureStep(
  state: PanState,
  ev: PointerLike,
  rect: PlotRect,
  live: { xr: Range; yr: Range },
): { state: PanState; ranges: { xr: Range; yr: Range } | null } {
  const wants = panModeFor(ev);
  if (wants !== state.mode) {
    const base: PanBase = { xr: live.xr, yr: live.yr, px: ev.clientX, py: ev.clientY };
    return { state: { mode: wants, base, grab: grabbedAt(base, rect) }, ranges: null };
  }
  const { base, grab } = state;
  if (state.mode === "stretch") {
    // Anchored stretch: min pinned; the grabbed data point follows the cursor, so the max end
    // moves and the data stretches or compresses. FACS Chorus style.
    const fx = clampF((ev.clientX - rect.left) / rect.width);
    const fy = clampF((ev.clientY - rect.top) / rect.height);
    return {
      state,
      ranges: {
        xr: [base.xr[0], base.xr[0] + (grab.gx - base.xr[0]) / fx],
        yr: [base.yr[0], (grab.gy - base.yr[0] * fy) / (1 - fy)],
      },
    };
  }
  // Pan: the data moves 1:1 with the cursor (y inverted -- screen-down is data-up).
  const ddx = ((ev.clientX - base.px) / rect.width) * (base.xr[1] - base.xr[0]);
  const ddy = ((ev.clientY - base.py) / rect.height) * (base.yr[1] - base.yr[0]);
  return {
    state,
    ranges: {
      xr: [base.xr[0] - ddx, base.xr[1] - ddx],
      yr: [base.yr[0] + ddy, base.yr[1] + ddy],
    },
  };
}

// ── the drag session ────────────────────────────────────────────────────────────────────────
//
// Turning DOM events into gesture steps is where the remaining risk lives: the maths above is
// pure and easy to check, but "does a keydown with no mouse movement actually reach it" is not.
// So the wiring lives here too, driven through a window-like object a test can substitute.

export interface PanSessionHooks {
  /** The range this drag has already produced. Consulted only when the mode changes. */
  liveRanges: () => { xr: Range; yr: Range };
  onRanges: (xr: Range, yr: Range) => void;
  onEnd: () => void;
}

/** The subset of `window` a session listens on. Loose enough that a test can pass a stub. */
export interface PanEventTarget {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addEventListener(type: string, listener: any, capture?: boolean): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  removeEventListener(type: string, listener: any, capture?: boolean): void;
}

/**
 * Wire one navigate drag. Returns a disposer; the session also ends itself on mouseup, on losing
 * the window, and on any move with no button held (a mouseup delivered outside the window never
 * arrives, and without this the drag stayed live and panned on every later pointer move).
 */
export function startPanSession(
  start: PointerLike,
  rect: PlotRect,
  xr: Range,
  yr: Range,
  hooks: PanSessionHooks,
  target: PanEventTarget,
): () => void {
  let gesture = panGestureStart(start, xr, yr, rect);
  let last: PointerLike = { ...start };
  let ended = false;

  const step = (ev: PointerLike) => {
    last = ev;
    const next = panGestureStep(gesture, ev, rect, hooks.liveRanges());
    gesture = next.state;
    if (next.ranges) hooks.onRanges(next.ranges.xr, next.ranges.yr);
  };

  const onMove = (ev: MouseEvent) => {
    if (ended) return;
    if (ev.buttons === 0) { end(); return; }
    step({ clientX: ev.clientX, clientY: ev.clientY, shiftKey: ev.shiftKey, altKey: ev.altKey });
  };

  // Shift is a KEY, and pressing a key does not move the mouse. Sampling the modifier only from
  // mouse events meant that pressing Shift while holding still did nothing at all -- the mode
  // changed on the next mouse move, if one ever came, so the gesture "stayed on move" for as
  // long as the pointer sat still. Feeding the key event back through at the LAST known position
  // makes the switch happen on the keypress, which is what a modifier is supposed to do.
  const onKey = (ev: KeyboardEvent) => {
    if (ended) return;
    if (ev.key !== "Shift" && ev.key !== "Alt" && ev.key !== "Meta") return;
    step({ ...last, shiftKey: ev.shiftKey, altKey: ev.altKey });
  };

  const end = () => {
    if (ended) return;
    ended = true;
    target.removeEventListener("mousemove", onMove);
    target.removeEventListener("mouseup", end);
    target.removeEventListener("blur", end);
    target.removeEventListener("keydown", onKey, true);
    target.removeEventListener("keyup", onKey, true);
    hooks.onEnd();
  };

  target.addEventListener("mousemove", onMove);
  target.addEventListener("mouseup", end);
  target.addEventListener("blur", end);
  // Capture phase: a focused control inside the app must not swallow the modifier.
  target.addEventListener("keydown", onKey, true);
  target.addEventListener("keyup", onKey, true);
  return end;
}
