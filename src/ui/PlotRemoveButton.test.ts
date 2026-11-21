import { describe, expect, it } from "vitest";
import { removeButtonPlace } from "./PlotRemoveButton";

const box = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom });

describe("removeButtonPlace", () => {
  it("puts the button in the scatter card's top-right corner, inside its white ring", () => {
    // A cell at (100, 200), 484 px square; the scatter container 7 px in, 470 x 464.
    const at = removeButtonPlace(box(100, 200, 584, 684), box(107, 210, 577, 674), 5, 20);
    expect(at).toEqual({ left: 577 + 5 - 100 - 4 - 20, top: 210 - 5 - 200 + 2 });
  });

  it("follows a histogram card narrower than its cell, not the cell's corner", () => {
    const at = removeButtonPlace(box(100, 200, 584, 684), box(107, 210, 559, 605), 0, 20);
    expect(at.left + 20).toBeLessThanOrEqual(559 - 100);
    expect(at).toEqual({ left: 559 - 100 - 4 - 20, top: 210 - 200 + 2 });
  });

  it("stays inside a cell that clips a plot drawn larger than it", () => {
    const at = removeButtonPlace(box(0, 0, 300, 300), box(7, 10, 420, 410), 5, 20);
    expect(at.left + 20).toBeLessThanOrEqual(300);
    expect(at.top).toBeGreaterThanOrEqual(0);
  });
});
