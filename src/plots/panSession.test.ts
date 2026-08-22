// @vitest-environment jsdom
//
// The wiring, driven with REAL DOM events. panGesture.test.ts checks the maths; this checks that
// the events actually reach it — specifically that a Shift keydown with no mouse movement
// switches the mode, which is the case that made Shift feel unreliable ("sometimes pressing
// shift does not trigger the zoom ability and it stays on move").

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { startPanSession, type PlotRect, type Range } from "./panGesture";

const RECT: PlotRect = { left: 100, top: 50, width: 400, height: 400 };
const XR: Range = [0, 100];
const YR: Range = [0, 100];

interface Harness {
  ranges: { xr: Range; yr: Range }[];
  ended: number;
  dispose: () => void;
}

let h: Harness;

function begin(mods: { shiftKey?: boolean; altKey?: boolean } = {}): Harness {
  const ranges: { xr: Range; yr: Range }[] = [];
  const state = { ended: 0 };
  let live = { xr: XR, yr: YR };
  const dispose = startPanSession(
    { clientX: 300, clientY: 250, shiftKey: !!mods.shiftKey, altKey: !!mods.altKey },
    RECT, XR, YR,
    {
      liveRanges: () => live,
      onRanges: (xr, yr) => { live = { xr, yr }; ranges.push({ xr, yr }); },
      onEnd: () => { state.ended++; },
    },
    window,
  );
  return { ranges, get ended() { return state.ended; }, dispose } as Harness;
}

const move = (x: number, y: number, mods: { shiftKey?: boolean; altKey?: boolean } = {}, buttons = 1) =>
  window.dispatchEvent(new MouseEvent("mousemove", {
    clientX: x, clientY: y, buttons, shiftKey: !!mods.shiftKey, altKey: !!mods.altKey,
  }));

const key = (type: "keydown" | "keyup", k: string, mods: { shiftKey?: boolean; altKey?: boolean }) =>
  window.dispatchEvent(new KeyboardEvent(type, {
    key: k, shiftKey: !!mods.shiftKey, altKey: !!mods.altKey,
  }));

/** A stretch pins the min of both axes; a pan moves both ends. */
const isStretch = (a: { xr: Range; yr: Range }, b: { xr: Range; yr: Range }) =>
  Math.abs(a.xr[0] - b.xr[0]) < 1e-9 && Math.abs(a.yr[0] - b.yr[0]) < 1e-9 &&
  (Math.abs(a.xr[1] - b.xr[1]) > 1e-9 || Math.abs(a.yr[1] - b.yr[1]) > 1e-9);

afterEach(() => { h?.dispose(); });

describe("a Shift press with no mouse movement", () => {
  beforeEach(() => { h = begin(); });

  it("switches an in-flight pan to stretch — the reported bug", () => {
    move(320, 265);
    move(340, 280);
    expect(h.ranges.length).toBeGreaterThan(0);
    const atPress = h.ranges[h.ranges.length - 1];

    key("keydown", "Shift", { shiftKey: true });   // pointer has NOT moved
    // Exactly ONE move afterwards. That is what isolates the key path: the keydown must have
    // already rebased, so this single move stretches. If the modifier were only sampled from
    // mouse events, this move would spend itself on the rebase and produce nothing.
    move(360, 295, { shiftKey: true });

    expect(h.ranges.length).toBeGreaterThan(0);
    const after = h.ranges[h.ranges.length - 1];
    expect(after).not.toBe(atPress);               // the move did produce a range...
    expect(isStretch(atPress, after)).toBe(true);  // ...and it was a stretch
  });

  it("switches back to pan the instant Shift is released", () => {
    key("keydown", "Shift", { shiftKey: true });
    move(340, 280, { shiftKey: true });
    move(360, 295, { shiftKey: true });
    const stretched = h.ranges[h.ranges.length - 1];
    expect(isStretch(h.ranges[h.ranges.length - 2], stretched)).toBe(true);

    key("keyup", "Shift", {});                     // still no mouse movement
    move(380, 310);                                 // one move only
    const last = h.ranges[h.ranges.length - 1];
    expect(isStretch(stretched, last)).toBe(false); // both ends move again
    expect(Math.abs(last.xr[0] - stretched.xr[0])).toBeGreaterThan(1e-9);
  });

  it("ignores keys that are not modifiers", () => {
    move(320, 265);
    const n = h.ranges.length;
    key("keydown", "a", {});
    key("keydown", "Escape", {});
    expect(h.ranges.length).toBe(n);               // no step, no range written
  });

  it("treats Option/Alt the same as Shift", () => {
    move(320, 265);
    const atPress = h.ranges[h.ranges.length - 1];
    key("keydown", "Alt", { altKey: true });
    move(340, 280, { altKey: true });               // one move only, as above
    expect(isStretch(atPress, h.ranges[h.ranges.length - 1])).toBe(true);
  });
});

describe("the session ends exactly once, and stops listening when it does", () => {
  it("ends on mouseup and ignores everything after", () => {
    h = begin();
    move(320, 265);
    window.dispatchEvent(new MouseEvent("mouseup", { clientX: 320, clientY: 265 }));
    expect(h.ended).toBe(1);

    const n = h.ranges.length;
    move(400, 330);
    key("keydown", "Shift", { shiftKey: true });
    expect(h.ranges.length).toBe(n);               // fully detached
    expect(h.ended).toBe(1);                        // and not ended twice
  });

  it("ends when the window is lost mid-drag", () => {
    h = begin();
    move(320, 265);
    window.dispatchEvent(new Event("blur"));
    expect(h.ended).toBe(1);
    const n = h.ranges.length;
    move(400, 330);
    expect(h.ranges.length).toBe(n);
  });

  it("ends on a move with no button held — a mouseup delivered outside the window", () => {
    // Without this the drag stayed live and panned on every later pointer move, with no button
    // pressed at all, which is the other way the gesture read as stuck.
    h = begin();
    move(320, 265);
    const n = h.ranges.length;
    move(340, 280, {}, 0);                          // buttons === 0
    expect(h.ended).toBe(1);
    expect(h.ranges.length).toBe(n);                // that move did not pan
  });

  it("is idempotent when disposed after it already ended", () => {
    h = begin();
    window.dispatchEvent(new MouseEvent("mouseup", {}));
    h.dispose();
    expect(h.ended).toBe(1);
  });
});

describe("a drag started with Shift already held", () => {
  it("stretches from the first move", () => {
    h = begin({ shiftKey: true });
    move(340, 280, { shiftKey: true });
    move(360, 295, { shiftKey: true });
    expect(h.ranges.length).toBeGreaterThan(1);
    expect(h.ranges[0].xr[0]).toBe(XR[0]);          // min pinned from the outset
    expect(h.ranges[0].yr[0]).toBe(YR[0]);
    expect(h.ranges[0].xr[1]).not.toBe(XR[1]);      // and the max really moved
  });
});
