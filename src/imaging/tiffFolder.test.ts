import { describe, expect, it } from "vitest";
import { inferTiffNaming, planesFromTiff, tiffChannelNames, tiffEventIndexOf, tiffFileNameFor, tiffLightLossSlot, tiffSubfolderFor } from "./tiffFolder";
import type { TiffPage } from "./tiff";

describe("the extractor's naming", () => {
  it("is read from one file name, and names every other file from it", () => {
    const naming = inferTiffNaming("Tube A_00000002.tiff")!;
    expect(naming).toEqual({ prefix: "Tube A_", digits: 8, suffix: ".tiff", layout: "subfolders" });
    expect(tiffFileNameFor(naming, 11082)).toBe("Tube A_00011082.tiff");
    expect(tiffEventIndexOf("Tube A_00011082.tiff", naming)).toBe(11082);
    expect(tiffEventIndexOf("Tube B_00011082.tiff", naming)).toBeNull();
    expect(tiffEventIndexOf("Tube A_x.tiff", naming)).toBeNull();
    expect(inferTiffNaming("Cell_Cycle_000011.tif")).toMatchObject({ prefix: "Cell_Cycle_", digits: 6, suffix: ".tif" });
    expect(inferTiffNaming("notes.txt")).toBeNull();
    expect(inferTiffNaming("Tube_12.tiff")).toBeNull();
    expect(tiffSubfolderFor(0)).toBe("00000000");
    expect(tiffSubfolderFor(9999)).toBe("00000000");
    expect(tiffSubfolderFor(10000)).toBe("00010000");
    expect(tiffSubfolderFor(123456)).toBe("00120000");
  });
});

describe("pages as planes", () => {
  const page = (name: string, fill: (t: number, c: number) => number, width = 104, height = 3): TiffPage => {
    const data = new Float32Array(width * height);
    for (let t = 0; t < height; t++) for (let c = 0; c < width; c++) data[t * width + c] = fill(t, c);
    return { name, width, height, data, xResolution: 73.3, yResolution: 88 };
  };
  const pages = [page("LightLoss (Imaging)", (t) => 1000 + t), page("FSC", (t, c) => c * 10 + t), page("SSC (Imaging)", (_t, c) => -c)];

  it("transposes time and carrier, names the slots from the pages, and takes the aspect from the resolution", () => {
    const planes = planesFromTiff(pages);
    expect(planes.rows).toBe(104);
    expect(planes.cols).toBe(3);
    expect(planes.slots).toEqual([2, 3, 4]);
    expect(planes.aspect).toBeCloseTo(88 / 73.3, 4);
    // FSC: plane[carrier * cols + t] = page[t * 104 + carrier] = carrier * 10 + t.
    expect(planes.planes[1][5 * 3 + 2]).toBe(52);
    expect(planes.planes[2][7 * 3 + 0]).toBe(-7);
    expect(tiffChannelNames(pages)).toEqual(new Map([[2, "LightLoss (Imaging)"], [3, "FSC"], [4, "SSC (Imaging)"]]));
    expect(tiffLightLossSlot(pages)).toBe(2);
    expect(tiffLightLossSlot(pages.slice(1))).toBeNull();
  });

  it("takes only the slots asked for, and a default aspect without a resolution", () => {
    const planes = planesFromTiff(pages.map((p) => ({ ...p, xResolution: undefined, yResolution: undefined })), { slots: [4, 9] });
    expect(planes.slots).toEqual([4]);
    expect(planes.aspect).toBe(1.2);
  });
});
