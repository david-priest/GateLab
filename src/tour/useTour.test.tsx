// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TOUR_STORAGE_KEY } from "./tourProgress";
import type { TourContext, TourNeeds, TourStep } from "./tourTypes";
import { TOUR_ARRIVAL_ATTEMPTS, TOUR_POLL_MS, TOUR_REACHED_PAUSE_MS, useTour, type TourState } from "./useTour";

const base: TourContext = {
  host: "browser", activeTab: "one", workspaceName: "", files: [], pooled: false, rootId: null, populations: {}, gates: {},
  activePopulationId: null, selectedGateId: null, axes: { x: null, y: null, xScale: null, yScale: null, xLinearOffered: false, yLinearOffered: false, rangeKey: "[]" }, displayMode: "pseudocolor", maxEvents: 5,
  strategy: null, illustration: null, layout: { items: 0, sheets: 1, allEvents: false }, proportions: { populations: 0 },
  metadataColumns: [], divisionProfiles: 0, assayLayer: "original", compensation: { pairSelected: false, view: "matrix", galleryLayer: "compensated", matrixKey: "[]" },
  scales: { adjusted: [], fitted: [], locked: false },
  signals: { layoutExports: 0, statsDownloads: 0, workspaceSaves: 0 },
};

// Four steps: one to read, one on another tab that waits for a change, one done by a state, one to read.
const anywhere = { workspace: false } as const;
const steps: TourStep[] = [
  { id: "a", chapter: "x", title: "A", body: "a", needs: anywhere },
  { id: "b", chapter: "x", title: "B", body: "b", needs: { workspace: false, tab: "two" }, enter: (ctx) => ctx.maxEvents, done: (ctx, memo) => ctx.maxEvents !== memo },
  { id: "c", chapter: "x", title: "C", body: "c", needs: anywhere, done: (ctx) => ctx.pooled },
  { id: "d", chapter: "x", title: "D", body: "d", needs: anywhere },
];

let host: HTMLDivElement;
let root: Root;
let app: TourContext;
let tour: TourState;
let arrive: ReturnType<typeof vi.fn<(unmet: TourNeeds) => void>>;

function Harness() {
  tour = useTour(() => app, arrive, steps);
  return null;
}
const mount = () => act(() => root.render(<Harness />));
const tick = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  localStorage.removeItem(TOUR_STORAGE_KEY);
  app = { ...base };
  arrive = vi.fn<(unmet: TourNeeds) => void>();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.removeItem(TOUR_STORAGE_KEY);
});

describe("useTour", () => {
  it("takes the app to where a step happens when Next enters it, and reads the step only once there", () => {
    mount();
    act(() => tour.start());
    expect(tour.step?.id).toBe("a");
    expect(arrive).not.toHaveBeenCalled();
    expect(tour.arriving).toBe(false);

    // Next onto a step on another tab: the app is asked to go there, and asked again until it has.
    act(() => tour.next());
    expect(tour.step?.id).toBe("b");
    expect(arrive).toHaveBeenCalledTimes(1);
    expect(arrive).toHaveBeenLastCalledWith({ tab: "two" });
    expect(tour.arriving).toBe(true);
    tick(TOUR_POLL_MS);
    expect(arrive).toHaveBeenCalledTimes(2);

    // What changes before the app is there is not what the step compares against.
    app = { ...app, maxEvents: 7 };
    tick(TOUR_POLL_MS);
    expect(tour.reached).toBe(false);
    app = { ...app, activeTab: "two" };
    tick(TOUR_POLL_MS);
    expect(tour.arriving).toBe(false);
    const asked = arrive.mock.calls.length;
    tick(TOUR_POLL_MS * 3);
    expect(arrive).toHaveBeenCalledTimes(asked);
    expect(tour.reached).toBe(false);
    expect(tour.step?.id).toBe("b");

    // Done once there: the tick, then the next step.
    app = { ...app, maxEvents: 9 };
    tick(TOUR_POLL_MS);
    expect(tour.reached).toBe(true);
    tick(TOUR_REACHED_PAUSE_MS);
    expect(tour.step?.id).toBe("c");
    expect(tour.reached).toBe(false);
  });

  it("does not move the app when the page loads with a tutorial under way, or when the user wanders off", () => {
    localStorage.setItem(TOUR_STORAGE_KEY, JSON.stringify({ stepId: "b", status: "active", updatedAt: 1 }));
    mount();
    expect(tour.step?.id).toBe("b");
    tick(TOUR_POLL_MS * 4);
    expect(arrive).not.toHaveBeenCalled();
    expect(tour.arriving).toBe(false);
    // The card's button asks for it.
    act(() => tour.arrive());
    expect(arrive).toHaveBeenCalledWith({ tab: "two" });
    expect(tour.arriving).toBe(true);
    app = { ...app, activeTab: "two" };
    tick(TOUR_POLL_MS);
    expect(tour.arriving).toBe(false);
    // Left again by the user: not followed.
    const asked = arrive.mock.calls.length;
    app = { ...app, activeTab: "one" };
    tick(TOUR_POLL_MS * 4);
    expect(arrive).toHaveBeenCalledTimes(asked);
    expect(tour.arriving).toBe(false);
  });

  it("stops asking for a place the app does not reach", () => {
    mount();
    act(() => tour.start());
    act(() => tour.next());
    tick(TOUR_POLL_MS * (TOUR_ARRIVAL_ATTEMPTS + 10));
    expect(arrive).toHaveBeenCalledTimes(TOUR_ARRIVAL_ATTEMPTS);
    expect(tour.arriving).toBe(false);
    expect(tour.step?.id).toBe("b");
  });

  it("holds a step gone back to that is already done, where it would bounce forward", () => {
    mount();
    act(() => tour.start());
    act(() => tour.next());
    act(() => tour.next());
    expect(tour.step?.id).toBe("c");
    // Done by the app's state: forward, it moves on by itself.
    app = { ...app, pooled: true };
    tick(TOUR_POLL_MS);
    expect(tour.reached).toBe(true);
    tick(TOUR_REACHED_PAUSE_MS);
    expect(tour.step?.id).toBe("d");
    // Back onto it: already done, shown as such, and it stays.
    act(() => tour.back());
    expect(tour.step?.id).toBe("c");
    expect(tour.held).toBe(true);
    expect(tour.reached).toBe(false);
    tick(TOUR_REACHED_PAUSE_MS * 4);
    expect(tour.step?.id).toBe("c");
    // Back again goes further back; Next goes on, and the hold does not follow.
    act(() => tour.next());
    expect(tour.step?.id).toBe("d");
    expect(tour.held).toBe(false);
    act(() => tour.back());
    act(() => tour.back());
    expect(tour.step?.id).toBe("b");
    expect(tour.held).toBe(false);
  });

  it("still sees a step done when doing it moved the app to another tab", () => {
    mount();
    act(() => tour.start());
    act(() => tour.next());
    app = { ...app, activeTab: "two" };
    tick(TOUR_POLL_MS);
    expect(tour.step?.id).toBe("b");
    expect(tour.arriving).toBe(false);
    // What the step asks for is done, and doing it has left the step's tab.
    app = { ...app, maxEvents: 11, activeTab: "three" };
    tick(TOUR_POLL_MS);
    expect(tour.reached).toBe(true);
    tick(TOUR_REACHED_PAUSE_MS);
    expect(tour.step?.id).toBe("c");
  });

  it("ends and resumes at the same step, and goes there again on Resume", () => {
    mount();
    act(() => tour.start());
    act(() => tour.next());
    app = { ...app, activeTab: "two" };
    tick(TOUR_POLL_MS);
    act(() => tour.end());
    expect(tour.step).toBeNull();
    expect(JSON.parse(localStorage.getItem(TOUR_STORAGE_KEY)!).status).toBe("paused");
    // Elsewhere when it is taken up again.
    app = { ...app, activeTab: "one" };
    arrive.mockClear();
    act(() => tour.resume());
    expect(tour.step?.id).toBe("b");
    expect(arrive).toHaveBeenCalledWith({ tab: "two" });
  });
});
