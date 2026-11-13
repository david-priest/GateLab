// @vitest-environment jsdom
// What every SVG export shares once composed: physical units, one font, named groups, SVG 1.1
// image references, no hidden or empty nodes; and the PNG resolution chunk.

import { describe, expect, it } from "vitest";
import { crc32, eightBitPngImages, exportId, finishExportSvg, nameCell, pngBitDepth, pngWithResolution, slugId } from "./exportSvg";
import { SCREEN_PX_PER_MM } from "../engine/layout";

const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";
const el = (tag: string, attrs: Record<string, string> = {}, ...children: Element[]) => {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  node.append(...children);
  return node;
};
const text = (content: string, attrs: Record<string, string> = {}) => {
  const node = el("text", attrs);
  node.textContent = content;
  return node;
};

describe("finishExportSvg", () => {
  it("writes the page in millimetres with the drawing's pixels kept in the viewBox", () => {
    const root = el("svg", { width: "1123", height: "794" }) as SVGSVGElement;
    finishExportSvg(root, { widthPx: 1123, heightPx: 794, widthMm: 297, heightMm: 210 });
    expect([root.getAttribute("width"), root.getAttribute("height"), root.getAttribute("viewBox")]).toEqual(["297mm", "210mm", "0 0 1123 794"]);
    // Without a physical size, the screen's 96 pixels per inch decide it.
    const grid = el("svg") as SVGSVGElement;
    finishExportSvg(grid, { widthPx: 508, heightPx: 200 });
    expect(grid.getAttribute("width")).toBe(`${Number((508 / SCREEN_PX_PER_MM).toFixed(3))}mm`);
    expect(grid.getAttribute("viewBox")).toBe("0 0 508 200");
  });

  it("puts one font on every text, whatever the renderer or the page had", () => {
    const root = el("svg", {},
      text("title", { style: "font-family: -apple-system, system-ui; font-size: 9px;" }),
      el("g", { "font-family": "sans-serif" }, text("tick")),
      text("block", { "font-family": "Georgia" }),
    ) as SVGSVGElement;
    finishExportSvg(root, { widthPx: 10, heightPx: 10 });
    const fonts = [...root.querySelectorAll("text")].map((t) => t.getAttribute("font-family"));
    expect(fonts).toEqual(Array(3).fill("Arial, Helvetica, sans-serif"));
    expect(root.querySelector("text")!.getAttribute("style")).not.toContain("font-family");
  });

  it("references images the SVG 1.1 way, once, and fits them to their box", () => {
    const root = el("svg", {}, el("image", { href: "data:image/png;base64,AA==", width: "10", height: "10" })) as SVGSVGElement;
    finishExportSvg(root, { widthPx: 10, heightPx: 10 });
    const image = root.querySelector("image")!;
    expect(image.getAttributeNS(XLINK_NS, "href")).toBe("data:image/png;base64,AA==");
    expect(image.getAttribute("href")).toBeNull();
    expect(image.getAttribute("preserveAspectRatio")).toBe("none");
  });

  it("drops hidden nodes and the groups left empty by dropping them", () => {
    const root = el("svg", {},
      el("g", { class: "x-axis" }, el("g", {}, text("", { style: "display: none; font-size: 9px;" })), el("line")),
      el("g", {}, el("g", {}, text("gone", { display: "none" }))),
      text("kept"),
    ) as SVGSVGElement;
    finishExportSvg(root, { widthPx: 10, heightPx: 10 });
    expect(root.querySelectorAll("text")).toHaveLength(1);
    expect(root.querySelectorAll("g")).toHaveLength(1);
    expect(root.querySelector("g.x-axis line")).not.toBeNull();
  });
});

describe("nameCell", () => {
  it("names the cell, its events, title, labels, axes and each gate as the renderer draws them", () => {
    const label = (name: string) => el("g", {}, el("text", {}, (() => { const s = el("tspan"); s.textContent = name; return s; })(), (() => { const s = el("tspan"); s.textContent = "12.3%"; return s; })()));
    const quadrant = el("g", { class: "quadrant-gate" }, text("Q1"));
    const overlays = el("g", { class: "gate-overlays" }, el("path"), label("Lymphocytes"), el("path"), quadrant);
    const plot = el("g", {},
      el("g", { class: "x-axis" }), el("g", { class: "y-axis" }),
      text("FSC-A"), text("SSC-A", { transform: "rotate(-90)" }),
      overlays,
    );
    const svg = el("svg", {}, text("Lymphocytes · D1"), plot);
    const cell = el("g", {}, el("image"), svg);
    nameCell(cell, "plot-3");
    const ids = (selector: string) => [...cell.querySelectorAll(selector)].map((node) => node.getAttribute("id"));
    expect(cell.getAttribute("id")).toBe("plot-3");
    expect(ids("image")).toEqual(["plot-3-events"]);
    expect(ids("svg > text")).toEqual(["plot-3-title"]);
    expect(ids("svg > g > text")).toEqual(["plot-3-x-label", "plot-3-y-label"]);
    expect(ids("g.x-axis, g.y-axis")).toEqual(["plot-3-x-axis", "plot-3-y-axis"]);
    expect(overlays.getAttribute("id")).toBe("plot-3-gates");
    // The outline path and its label make one group; a path with no label stands alone; a quadrant keeps its group.
    expect([...overlays.children].map((g) => [g.tagName, g.getAttribute("id"), g.children.length])).toEqual([
      ["g", "plot-3-gate-1-Lymphocytes", 2],
      ["g", "plot-3-gate-2", 1],
      ["g", "plot-3-gate-3-Q1", 1],
    ]);
  });
});

describe("ids", () => {
  it("folds words to a valid id", () => {
    expect(slugId("FSC SSC · Plot 2")).toBe("FSC-SSC-Plot-2");
    expect(slugId("  · ")).toBe("");
    expect(exportId("plot", 4, "Live cells")).toBe("plot-4-Live-cells");
    expect(exportId("plot", 4)).toBe("plot-4");
  });
});

describe("pngWithResolution", () => {
  const png = () => {
    const bytes: number[] = [137, 80, 78, 71, 13, 10, 26, 10];
    const chunk = (type: string, data: number[]) => {
      const length = [(data.length >>> 24) & 255, (data.length >>> 16) & 255, (data.length >>> 8) & 255, data.length & 255];
      const body = [...type].map((c) => c.charCodeAt(0)).concat(data);
      const crc = crc32(Uint8Array.from(body));
      bytes.push(...length, ...body, (crc >>> 24) & 255, (crc >>> 16) & 255, (crc >>> 8) & 255, crc & 255);
    };
    chunk("IHDR", [0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]);
    chunk("IEND", []);
    return Uint8Array.from(bytes);
  };

  it("matches the CRC-32 PNG chunks carry", () => {
    // zlib.crc32(b"pHYs" + 11811.to_bytes(4) * 2 + b"\x01") in Python.
    const data = Uint8Array.from([0x70, 0x48, 0x59, 0x73, 0, 0, 0x2e, 0x23, 0, 0, 0x2e, 0x23, 1]);
    expect(crc32(data)).toBe(2024095606);
  });

  it("writes the resolution after the header, replacing one already there", () => {
    const out = pngWithResolution(png(), 300);
    expect(out).toHaveLength(png().length + 21);
    const view = new DataView(out.buffer);
    expect(view.getUint32(33)).toBe(9);
    expect(String.fromCharCode(...out.subarray(37, 41))).toBe("pHYs");
    expect([view.getUint32(41), view.getUint32(45), out[49]]).toEqual([11811, 11811, 1]);
    expect(view.getUint32(50)).toBe(2024095606);
    const again = pngWithResolution(out, 600);
    expect(again).toHaveLength(out.length);
    expect(new DataView(again.buffer).getUint32(41)).toBe(23622);
  });

  it("leaves bytes that are not a PNG alone", () => {
    const bytes = Uint8Array.from([1, 2, 3]);
    expect(pngWithResolution(bytes, 300)).toBe(bytes);
  });
});

describe("16-bit PNG images before the PDF writer", () => {
  // 1 × 1 RGB PNGs, 8 and 16 bits a sample (written with Python's zlib).
  const PNG8 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC";
  const PNG16 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABEAIAAADA54+dAAAAC0lEQVR4nGNgAAMAAAcAAbKGrPQAAAAASUVORK5CYII=";
  const bytes = (uri: string) => Uint8Array.from(atob(uri.split(",")[1]), (c) => c.charCodeAt(0));

  it("reads the bit depth from the PNG header", () => {
    expect(pngBitDepth(bytes(PNG8))).toBe(8);
    expect(pngBitDepth(bytes(PNG16))).toBe(16);
    expect(pngBitDepth(Uint8Array.from([1, 2, 3]))).toBeNull();
  });

  it("writes only the 16-bit PNG images again, through either href", async () => {
    const root = new DOMParser().parseFromString(
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">` +
        `<image id="a" href="${PNG16}"/><image id="b" xlink:href="${PNG16}"/>` +
        `<image id="c" href="${PNG8}"/><image id="d" href="data:image/jpeg;base64,/9j/4AAQ"/></svg>`,
      "image/svg+xml",
    ).documentElement;
    const seen: string[] = [];
    const changed = await eightBitPngImages(root, async (uri) => {
      seen.push(uri);
      return PNG8;
    });
    expect(changed).toBe(2);
    expect(seen).toEqual([PNG16, PNG16]);
    const href = (id: string) => {
      const image = root.querySelector(`#${id}`)!;
      return image.getAttribute("href") ?? image.getAttributeNS("http://www.w3.org/1999/xlink", "href");
    };
    expect([href("a"), href("b"), href("c")]).toEqual([PNG8, PNG8, PNG8]);
    expect(href("d")).toBe("data:image/jpeg;base64,/9j/4AAQ");
  });

  it("leaves an image the browser cannot draw as it was", async () => {
    const root = new DOMParser().parseFromString(`<svg xmlns="http://www.w3.org/2000/svg"><image href="${PNG16}"/></svg>`, "image/svg+xml").documentElement;
    const changed = await eightBitPngImages(root, () => Promise.reject(new Error("decode")));
    expect(changed).toBe(0);
    expect(root.querySelector("image")!.getAttribute("href")).toBe(PNG16);
  });
});
