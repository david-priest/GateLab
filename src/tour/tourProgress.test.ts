import { describe, expect, it } from "vitest";
import { advanceTour, backTour, loadProgress, pauseTour, resumeTour, saveProgress, startTour, TOUR_STORAGE_KEY } from "./tourProgress";
import type { TourStep } from "./tourTypes";

const steps: TourStep[] = ["a", "b", "c"].map((id) => ({ id, chapter: "one", title: id, body: id }));

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length() { return this.map.size; }
  clear() { this.map.clear(); }
  getItem(key: string) { return this.map.get(key) ?? null; }
  key(index: number) { return [...this.map.keys()][index] ?? null; }
  removeItem(key: string) { this.map.delete(key); }
  setItem(key: string, value: string) { this.map.set(key, value); }
}

describe("tour progress", () => {
  it("starts at the first step, moves on, ends after the last, and goes back", () => {
    const started = startTour(steps, 1);
    expect(started).toEqual({ stepId: "a", status: "active", updatedAt: 1 });
    const second = advanceTour(steps, started, 2);
    expect(second.stepId).toBe("b");
    const third = advanceTour(steps, second, 3);
    expect(advanceTour(steps, third, 4)).toEqual({ stepId: "c", status: "done", updatedAt: 4 });
    expect(backTour(steps, third, 5).stepId).toBe("b");
    expect(backTour(steps, started, 6).stepId).toBe("a");
  });

  it("keeps the place when ended, and resumes there; a finished tour starts again", () => {
    const paused = pauseTour(advanceTour(steps, startTour(steps, 1), 2), 3);
    expect(paused).toEqual({ stepId: "b", status: "paused", updatedAt: 3 });
    expect(resumeTour(steps, paused, 4)).toEqual({ stepId: "b", status: "active", updatedAt: 4 });
    expect(resumeTour(steps, { stepId: "c", status: "done", updatedAt: 0 }, 5).stepId).toBe("a");
    expect(resumeTour(steps, null, 6).stepId).toBe("a");
  });

  it("round-trips through storage and drops a position that names a step that is gone", () => {
    const storage = new MemoryStorage();
    saveProgress({ stepId: "b", status: "paused", updatedAt: 9 }, storage);
    expect(loadProgress(steps, storage)).toEqual({ stepId: "b", status: "paused", updatedAt: 9 });
    storage.setItem(TOUR_STORAGE_KEY, JSON.stringify({ stepId: "zzz", status: "paused" }));
    expect(loadProgress(steps, storage)).toBeNull();
    storage.setItem(TOUR_STORAGE_KEY, "not json");
    expect(loadProgress(steps, storage)).toBeNull();
    saveProgress(null, storage);
    expect(storage.getItem(TOUR_STORAGE_KEY)).toBeNull();
    expect(loadProgress(steps, null)).toBeNull();
  });
});
