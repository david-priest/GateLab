// tourProgress.ts — where the user is in the tutorial, kept in the browser so the tutorial can
// be ended and taken up again at the same step, and the pure moves between steps.

import type { TourProgress, TourStep } from "./tourTypes";

export const TOUR_STORAGE_KEY = "gatelab.tour.v1";

function storageOf(storage?: Storage | null): Storage | null {
  if (storage !== undefined) return storage;
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** The saved position, or null when there is none or it names a step that no longer exists. */
export function loadProgress(steps: readonly TourStep[], storage?: Storage | null): TourProgress | null {
  const store = storageOf(storage);
  if (!store) return null;
  try {
    const raw = store.getItem(TOUR_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<TourProgress>;
    if (typeof parsed.stepId !== "string" || !steps.some((step) => step.id === parsed.stepId)) return null;
    if (parsed.status !== "active" && parsed.status !== "paused" && parsed.status !== "done") return null;
    return { stepId: parsed.stepId, status: parsed.status, updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0 };
  } catch {
    return null;
  }
}

export function saveProgress(progress: TourProgress | null, storage?: Storage | null): void {
  const store = storageOf(storage);
  if (!store) return;
  try {
    if (progress) store.setItem(TOUR_STORAGE_KEY, JSON.stringify(progress));
    else store.removeItem(TOUR_STORAGE_KEY);
  } catch {
    // A blocked store only costs the resume; the tutorial still runs.
  }
}

export function stepIndexOf(steps: readonly TourStep[], stepId: string | null | undefined): number {
  return stepId ? steps.findIndex((step) => step.id === stepId) : -1;
}

const at = (steps: readonly TourStep[], index: number, status: TourProgress["status"], now: number): TourProgress => ({
  stepId: steps[Math.max(0, Math.min(steps.length - 1, index))].id,
  status,
  updatedAt: now,
});

/** From the beginning. */
export function startTour(steps: readonly TourStep[], now = Date.now()): TourProgress {
  return at(steps, 0, "active", now);
}

/** Where it was ended; from the beginning when it was finished or never started. */
export function resumeTour(steps: readonly TourStep[], progress: TourProgress | null, now = Date.now()): TourProgress {
  if (!progress || progress.status === "done") return startTour(steps, now);
  return { ...progress, status: "active", updatedAt: now };
}

/** The next step, or done after the last. */
export function advanceTour(steps: readonly TourStep[], progress: TourProgress, now = Date.now()): TourProgress {
  const index = stepIndexOf(steps, progress.stepId);
  if (index < 0) return startTour(steps, now);
  if (index >= steps.length - 1) return { ...progress, status: "done", updatedAt: now };
  return at(steps, index + 1, "active", now);
}

export function backTour(steps: readonly TourStep[], progress: TourProgress, now = Date.now()): TourProgress {
  const index = stepIndexOf(steps, progress.stepId);
  return at(steps, Math.max(0, index - 1), "active", now);
}

/** Ended by the user: the position is kept for Resume. */
export function pauseTour(progress: TourProgress, now = Date.now()): TourProgress {
  return { ...progress, status: "paused", updatedAt: now };
}
