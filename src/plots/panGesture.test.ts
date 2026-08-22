// Shift is a LIVE modifier during a navigate drag. It was latched at mousedown, so pressing it
// after the drag began did nothing and releasing it mid-drag left the view still stretching --
// the key read as stuck down until the next mousedown. cytof_plot.js's own pan always re-read it
// per move, so the two handlers on one plot disagreed about what Shift means.

import { describe, it, expect } from "vitest";
import { panGestureStart, panGestureStep, panModeFor, type PlotRect, type Range } from "./panGesture";

const RECT: PlotRect = { left: 100, top: 50, width: 400, height: 400 };
const XR: Range = [0, 100];
const YR: Range = [0, 100];

const at = (x: number, y: number, mods: { shiftKey?: boolean; altKey?: boolean } = {}) => ({
  clientX: x, clientY: y, shiftKey: !!mods.shiftKey, altKey: !!mods.altKey,
});

/** Run a whole drag, returning the ranges each move produced (null where it only rebased). */
function drag(down: ReturnType<typeof at>, moves: ReturnType<typeof at>[]) {
  let state = panGestureStart(down, XR, YR, RECT);
  const out: ({ xr: Range; yr: Range } | null)[] = [];
  let live = { xr: XR, yr: YR };
  for (const m of moves) {
    const step = panGestureStep(state, m, RECT, live);
    state = step.state;
    if (step.ranges) live = step.ranges;
    out.push(step.ranges);
  }
  return { state, steps: out, live };
}

describe("which mode a drag is in", () => {
  it("stretches while either modifier is held, pans otherwise", () => {
    expect(panModeFor({ shiftKey: false, altKey: false })).toBe("pan");
    expect(panModeFor({ shiftKey: true, altKey: false })).toBe("stretch");
    expect(panModeFor({ shiftKey: false, altKey: true })).toBe("stretch");
  });

  it("STOPS stretching the moment shift is released — the reported bug", () => {
    const d = drag(at(300, 250, { shiftKey: true }), [
      at(320, 250, { shiftKey: true }),   // stretching
      at(340, 250),                       // shift released: rebase only
      at(360, 250),                       // now panning
    ]);
    expect(d.state.mode).toBe("pan");
    expect(d.steps[1]).toBeNull();                       // the release rebased, produced nothing
    // A pan moves BOTH ends of the axis by the same amount; a stretch pins the min.
    const last = d.steps[2]!;
    expect(last.xr[0]).not.toBeCloseTo(XR[0], 6);
    expect(last.xr[1] - last.xr[0]).toBeCloseTo(d.live.xr[1] - d.live.xr[0], 6);
  });

  it("STARTS stretching when shift is pressed mid-drag", () => {
    const d = drag(at(300, 250), [
      at(320, 250),                       // panning
      at(340, 250, { shiftKey: true }),   // shift pressed: rebase only
      at(360, 250, { shiftKey: true }),   // now stretching
    ]);
    expect(d.state.mode).toBe("stretch");
    expect(d.steps[1]).toBeNull();
    // Stretch pins the min end of both axes to the range in force at the rebase.
    const last = d.steps[2]!;
    expect(last.xr[0]).toBeCloseTo(d.state.base.xr[0], 9);
    expect(last.yr[0]).toBeCloseTo(d.state.base.yr[0], 9);
  });

  it("survives being toggled repeatedly without drifting or blowing up", () => {
    const d = drag(at(300, 250), [
      at(310, 250), at(320, 250, { shiftKey: true }), at(330, 250, { shiftKey: true }),
      at(340, 250), at(350, 250), at(360, 250, { altKey: true }), at(370, 250, { altKey: true }),
    ]);
    for (const s of d.steps) {
      if (!s) continue;
      for (const r of [s.xr, s.yr]) {
        expect(Number.isFinite(r[0])).toBe(true);
        expect(Number.isFinite(r[1])).toBe(true);
        expect(r[1]).toBeGreaterThan(r[0]); // never inverted or degenerate
      }
    }
  });

  it("rebases where the cursor is, not where the drag began", () => {
    // Rebasing on the mousedown position would make the view jump back on every modifier change.
    const d = drag(at(150, 400), [
      at(300, 250),                      // panned a long way
      at(300, 250, { shiftKey: true }),  // rebase
    ]);
    expect(d.state.base.px).toBe(300);
    expect(d.state.base.py).toBe(250);
    expect(d.state.base.xr).toEqual(d.steps[0]!.xr); // the range in force, not the original
  });
});

describe("a modifier pressed without moving the mouse", () => {
  // Pressing Shift does not generate a mouse move. Sampling the modifier only from mouse events
  // meant the mode changed on the NEXT move, if one ever came -- so holding the pointer still
  // and pressing Shift left the gesture panning, which is what "it stays on move" was.
  it("switches mode from a key event at the unchanged pointer position", () => {
    const down = at(300, 250);
    let state = panGestureStart(down, XR, YR, RECT);
    const moved = panGestureStep(state, at(340, 280), RECT, { xr: XR, yr: YR });
    state = moved.state;
    expect(state.mode).toBe("pan");

    // Shift pressed; the pointer has NOT moved since the last move event.
    const keyed = panGestureStep(state, at(340, 280, { shiftKey: true }), RECT, moved.ranges!);
    expect(keyed.state.mode).toBe("stretch");
    expect(keyed.ranges).toBeNull();               // rebase only
    expect(keyed.state.base.px).toBe(340);         // ...at the position it is actually at
    expect(keyed.state.base.py).toBe(280);
    expect(keyed.state.base.xr).toEqual(moved.ranges!.xr);
  });

  it("switches back on release, again without a mouse move", () => {
    let state = panGestureStart(at(300, 250, { shiftKey: true }), XR, YR, RECT);
    const stretched = panGestureStep(state, at(340, 280, { shiftKey: true }), RECT, { xr: XR, yr: YR });
    state = stretched.state;
    expect(state.mode).toBe("stretch");

    const released = panGestureStep(state, at(340, 280), RECT, stretched.ranges!);
    expect(released.state.mode).toBe("pan");
    expect(released.ranges).toBeNull();
  });

  it("produces no range change when the modifier is unchanged and the pointer has not moved", () => {
    // A key that is not a modifier, or a repeat, must not nudge the view.
    const down = at(300, 250);
    const state = panGestureStart(down, XR, YR, RECT);
    const same = panGestureStep(state, at(300, 250), RECT, { xr: XR, yr: YR });
    expect(same.state.mode).toBe("pan");
    expect(same.ranges!.xr).toEqual(XR);
    expect(same.ranges!.yr).toEqual(YR);
  });
});

describe("the stretch itself", () => {
  it("pins the minimum and moves the maximum", () => {
    const d = drag(at(300, 250, { shiftKey: true }), [at(200, 350, { shiftKey: true })]);
    const r = d.steps[0]!;
    expect(r.xr[0]).toBe(XR[0]);
    expect(r.yr[0]).toBe(YR[0]);
    expect(r.xr[1]).not.toBeCloseTo(XR[1], 6);
  });

  it("does not divide by zero at the very edges of the plot", () => {
    // The fractional position is clamped away from 0 and 1 precisely for this.
    for (const [x, y] of [[RECT.left, RECT.top], [RECT.left + RECT.width, RECT.top + RECT.height]]) {
      const d = drag(at(300, 250, { shiftKey: true }), [at(x, y, { shiftKey: true })]);
      const r = d.steps[0]!;
      expect(Number.isFinite(r.xr[1])).toBe(true);
      expect(Number.isFinite(r.yr[1])).toBe(true);
    }
  });
});
