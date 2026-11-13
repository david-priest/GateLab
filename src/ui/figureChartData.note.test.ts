// The note under a chart panel that names files: short enough to sit under the panel. Synthetic
// file names D1 … D20.

import { describe, expect, it } from "vitest";
import { namesListed } from "./figureChartData";

describe("names in a panel's note", () => {
  const files = (n: number) => Array.from({ length: n }, (_, i) => `D${i + 1}.fcs`);

  it("names every file when there are up to four", () => {
    expect(namesListed(files(1))).toBe("D1.fcs");
    expect(namesListed(files(4))).toBe("D1.fcs, D2.fcs, D3.fcs, D4.fcs");
  });

  it("names three and counts the rest when there are more", () => {
    expect(namesListed(files(5))).toBe("D1.fcs, D2.fcs, D3.fcs and 2 more");
    expect(namesListed(files(20))).toBe("D1.fcs, D2.fcs, D3.fcs and 17 more");
  });
});
