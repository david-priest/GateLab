// useTour.ts — the tutorial's state in the app: where the user is, read and kept in the browser,
// the check that moves a step on when the app's context says it is done, and the taking of the
// app to where a step happens. The context is read through a function so a check made on the
// timer sees what the tabs hold now, not what the last render saw.

import { useCallback, useEffect, useRef, useState } from "react";
import { advanceTour, backTour, loadProgress, pauseTour, resumeTour, saveProgress, startTour, stepIndexOf } from "./tourProgress";
import { TOUR_STEPS, unmetNeeds } from "./tourScript";
import type { TourContext, TourNeeds, TourProgress, TourStep } from "./tourTypes";

/** How long the card shows the tick before the next step. */
export const TOUR_REACHED_PAUSE_MS = 900;
/** How often an active step is checked between renders, for state the app holds in a tab. */
export const TOUR_POLL_MS = 400;
/** The least time between two requests to the app to go where a step happens. */
export const TOUR_ARRIVAL_GAP_MS = 350;
/** How many requests one unmet need gets before the tutorial stops asking and the card offers a button. */
export const TOUR_ARRIVAL_ATTEMPTS = 40;

export interface TourState {
  progress: TourProgress | null;
  /** The step on screen, when the tutorial is active. */
  step: TourStep | null;
  index: number;
  total: number;
  /** The step just done, shown with a tick until the next one. */
  reached: boolean;
  /** Gone back to with its condition already met: shown as done, and left for the user to move on. */
  held: boolean;
  /** The app is being taken to where the step happens. */
  arriving: boolean;
  start: () => void;
  resume: () => void;
  end: () => void;
  next: () => void;
  back: () => void;
  /** Take the app to where the step on screen happens. */
  arrive: () => void;
}

/**
 * `arrive` is how the tutorial asks the app to show what a step needs: it is called with the
 * needs not met, again until they are, whenever a step is entered by one of the card's buttons
 * or by the step before it being done. It is not called when the page loads with a tutorial
 * under way, or when the user leaves a step's place by themselves: the card offers a button.
 */
export function useTour(
  readContext: () => TourContext,
  arrive?: (unmet: TourNeeds) => void,
  steps: readonly TourStep[] = TOUR_STEPS,
): TourState {
  const [progress, setProgressState] = useState<TourProgress | null>(() => loadProgress(steps));
  const [reached, setReached] = useState(false);
  const [held, setHeld] = useState(false);
  const [arriving, setArriving] = useState(false);
  const progressRef = useRef(progress);
  const setProgress = useCallback((next: TourProgress | null) => {
    progressRef.current = next;
    setProgressState(next);
    saveProgress(next);
  }, []);
  const readRef = useRef(readContext);
  readRef.current = readContext;
  const arriveRef = useRef(arrive);
  arriveRef.current = arrive;

  const index = progress?.status === "active" ? stepIndexOf(steps, progress.stepId) : -1;
  const step = index >= 0 ? steps[index] : null;

  // What the step saw when it was entered, for the checks that compare.
  const entered = useRef<{ stepId: string; memo: unknown } | null>(null);
  const reachedFor = useRef<string | null>(null);
  const heldFor = useRef<string | null>(null);
  const cameBack = useRef(false);
  // The step the app is being taken to, and how often it has been asked for what is still unmet.
  const arrival = useRef<{ stepId: string; attempts: number; lastAt: number; unmetKey: string } | null>(null);

  /** Every way onto a step goes through here, so each starts clean and the app is taken there. */
  const enter = useCallback((next: TourProgress | null, direction: "forward" | "back") => {
    reachedFor.current = null;
    entered.current = null;
    heldFor.current = null;
    cameBack.current = direction === "back";
    setReached(false);
    setHeld(false);
    const active = next?.status === "active";
    arrival.current = active ? { stepId: next.stepId, attempts: 0, lastAt: 0, unmetKey: "" } : null;
    setArriving(active);
    setProgress(next);
  }, [setProgress]);

  const check = useCallback(() => {
    const current = progressRef.current;
    if (!current || current.status !== "active") return;
    const at = stepIndexOf(steps, current.stepId);
    const active = at >= 0 ? steps[at] : null;
    if (!active) return;
    const ctx = readRef.current();

    // Where the step happens comes first. While the app is on its way there it is asked again
    // for whatever is still unmet, a little apart, until it is there or has been asked enough.
    const unmet = unmetNeeds(active, ctx);
    const pending = arrival.current?.stepId === active.id ? arrival.current : null;
    if (pending) {
      if (!unmet) {
        arrival.current = null;
        setArriving(false);
      } else {
        const unmetKey = JSON.stringify(unmet);
        if (unmetKey !== pending.unmetKey) { pending.unmetKey = unmetKey; pending.attempts = 0; }
        const now = Date.now();
        if (pending.attempts >= TOUR_ARRIVAL_ATTEMPTS) {
          arrival.current = null;
          setArriving(false);
        } else if (now - pending.lastAt >= TOUR_ARRIVAL_GAP_MS) {
          pending.attempts += 1;
          pending.lastAt = now;
          arriveRef.current?.(unmet);
        }
      }
    }

    if (entered.current?.stepId !== active.id) {
      // Nothing of the step is read until the app is there, so a step entered while a workspace
      // is still opening does not remember an empty one. Once it has been read it is watched
      // wherever the app goes: what a step asks for can itself change the tab, as sending a
      // panel to the Layout tab does.
      if (unmet) return;
      const memo = active.enter?.(ctx);
      entered.current = { stepId: active.id, memo };
      // Gone back to a step that is already done: it would bounce straight forward again.
      if (cameBack.current && active.done?.(ctx, memo)) {
        heldFor.current = active.id;
        setHeld(true);
      }
      cameBack.current = false;
    }
    if (!active.done || reachedFor.current === active.id || heldFor.current === active.id) return;
    if (!active.done(ctx, entered.current.memo)) return;
    reachedFor.current = active.id;
    setReached(true);
    window.setTimeout(() => {
      const latest = progressRef.current;
      if (latest && latest.status === "active" && latest.stepId === active.id) enter(advanceTour(steps, latest), "forward");
      else setReached(false);
    }, TOUR_REACHED_PAUSE_MS);
  }, [steps, enter]);

  // Checked after every render of the app and on a timer while a step is active.
  useEffect(() => { check(); });
  useEffect(() => {
    if (!step) return;
    const timer = window.setInterval(check, TOUR_POLL_MS);
    return () => window.clearInterval(timer);
  }, [step, check]);

  const start = useCallback(() => enter(startTour(steps), "forward"), [steps, enter]);
  const resume = useCallback(() => enter(resumeTour(steps, progressRef.current), "forward"), [steps, enter]);
  const end = useCallback(() => {
    if (!progressRef.current) return;
    arrival.current = null;
    setArriving(false);
    setProgress(pauseTour(progressRef.current));
  }, [setProgress]);
  const next = useCallback(() => { if (progressRef.current) enter(advanceTour(steps, progressRef.current), "forward"); }, [steps, enter]);
  const back = useCallback(() => { if (progressRef.current) enter(backTour(steps, progressRef.current), "back"); }, [steps, enter]);
  const arriveNow = useCallback(() => {
    const current = progressRef.current;
    if (!current || current.status !== "active") return;
    arrival.current = { stepId: current.stepId, attempts: 0, lastAt: 0, unmetKey: "" };
    setArriving(true);
    check();
  }, [check]);

  return { progress, step, index, total: steps.length, reached, held, arriving, start, resume, end, next, back, arrive: arriveNow };
}
