// @vitest-environment jsdom
// A figure or strategy block's HTML headings export where the page shows their words: each
// wrapped line at its own line box, or, unmeasured, one line by the heading's padding and alignment.

import { afterEach, describe, expect, it, vi } from "vitest";
import { headingLineBoxes, placeHeadingLines, type HeadingBox } from "./layoutHeadingExport";

const frame = { box: { left: 100, top: 40, width: 200, height: 60 }, padding: { left: 6, right: 6, top: 20 }, fontSize: 10 };
const halfZoom = (box: HeadingBox) => ({ left: box.left / 2, top: box.top / 2, width: box.width / 2, height: box.height / 2 });

describe("placeHeadingLines", () => {
  it("writes each measured line at its own box, in page pixels, with its spaces trimmed", () => {
    const measured = [
      { text: "CD4_positive of ", left: 240, top: 80, width: 120, height: 24 },
      { text: "Lymphocytes", left: 260, top: 104, width: 90, height: 24 },
    ];
    expect(placeHeadingLines("CD4_positive of Lymphocytes", measured, { ...frame, align: "center" }, halfZoom)).toEqual([
      { text: "CD4_positive of", x: 120, y: 40 + 8.2, anchor: "start" },
      { text: "Lymphocytes", x: 130, y: 52 + 8.2, anchor: "start" },
    ]);
  });

  it.each([
    ["left", 106, "start"],
    ["start", 106, "start"],
    ["center", 200, "middle"],
    ["right", 294, "end"],
  ] as const)("unmeasured, sets a %s-aligned heading in its content box below its top padding", (align, x, anchor) => {
    expect(placeHeadingLines("  D1 ", null, { ...frame, align }, halfZoom)).toEqual([{ text: "D1", x, y: 40 + 20 + 8.2, anchor }]);
  });
});

describe("headingLineBoxes", () => {
  afterEach(() => vi.restoreAllMocks());

  it("groups characters into the lines the browser wrapped them to, each from its first word", () => {
    const title = document.createElement("th");
    title.textContent = "ab cd";
    // a, b and the space on the first line; c and d on the second, 8 px apart.
    const boxes = [[10, 0], [18, 0], [26, 0], [10, 14], [18, 14]];
    let start = 0;
    vi.spyOn(document, "createRange").mockReturnValue({
      setStart: (_node: Node, offset: number) => { start = offset; },
      setEnd: () => {},
      getBoundingClientRect: () => {
        const [left, top] = boxes[start];
        return { left, top, width: 8, height: 12, right: left + 8, bottom: top + 12 } as DOMRect;
      },
    } as unknown as Range);
    expect(headingLineBoxes(title)).toEqual([
      { text: "ab ", left: 10, top: 0, width: 24, height: 12 },
      { text: "cd", left: 10, top: 14, width: 16, height: 12 },
    ]);
  });
});
