// @vitest-environment jsdom
// Placed images: a file's type told from its bytes, its natural size read from them, the 8 MB
// limit, the frame it is placed in, and a hostile SVG made safe: nothing that runs, loads or
// reaches outside the file survives, its ids are prefixed and its style rules confined to it.

import { describe, expect, it } from "vitest";
import { createLayoutSheet, mmToPx, pageSizePx } from "../../engine/layout";
import {
  bitmapNaturalSize,
  formatBytes,
  PLACED_IMAGE_BYTES_LIMIT,
  placedImageFrame,
  placedImageSrc,
  readPlacedImage,
  sanitizePlacedSvg,
  sniffMediaType,
  storedBytes,
  svgNaturalSize,
  svgTextOfSrc,
} from "./placedImage";
import { HOSTILE_SVG, jpegHeader, pngHeader } from "./placedImage.fixtures";

const t = (source: string, values?: Readonly<Record<string, string | number>>) =>
  source.replace(/\{(\w+)\}/g, (whole, key: string) => (values && key in values ? String(values[key]) : whole));

describe("Reading a file as a placed image", () => {
  it("tells the type from the bytes and reads a bitmap's size from its header", () => {
    expect(sniffMediaType(pngHeader(2, 3))).toBe("image/png");
    expect(sniffMediaType(jpegHeader(4, 5))).toBe("image/jpeg");
    expect(sniffMediaType(new TextEncoder().encode('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe("image/svg+xml");
    expect(sniffMediaType(new TextEncoder().encode("%PDF-1.7\n"))).toBeNull();
    expect(sniffMediaType(new TextEncoder().encode("GIF89a"))).toBeNull();
    expect(bitmapNaturalSize(pngHeader(640, 480), "image/png")).toEqual({ width: 640, height: 480 });
    expect(bitmapNaturalSize(jpegHeader(1024, 300), "image/jpeg")).toEqual({ width: 1024, height: 300 });
    expect(bitmapNaturalSize(new Uint8Array([0xff, 0xd8, 0x00]), "image/jpeg")).toBeNull();
  });

  it("reads an SVG's size from its width and height in any unit, or its viewBox", () => {
    const svg = (attrs: string) => new DOMParser().parseFromString(`<svg xmlns="http://www.w3.org/2000/svg" ${attrs}/>`, "image/svg+xml").documentElement;
    expect(svgNaturalSize(svg('width="40" height="20"'))).toEqual({ width: 40, height: 20 });
    expect(svgNaturalSize(svg('width="25.4mm" height="1in"'))).toEqual({ width: 96, height: 96 });
    expect(svgNaturalSize(svg('width="72pt" viewBox="0 0 10 5"'))).toEqual({ width: 96, height: 48 });
    expect(svgNaturalSize(svg('viewBox="0 0 300 200" width="100%"'))).toEqual({ width: 300, height: 200 });
    expect(svgNaturalSize(svg(""))).toEqual({ width: 300, height: 150 });
  });

  it("keeps an SVG's text and a bitmap's data URL, with name, type and natural size", async () => {
    const svgText = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20"/></svg>';
    const svg = await readPlacedImage(new File([svgText], "schematic_D1.svg", { type: "image/svg+xml" }), t);
    expect(svg).toEqual({ recipe: { kind: "image", fileName: "schematic_D1.svg", mediaType: "image/svg+xml", naturalWidth: 40, naturalHeight: 20, content: svgText } });
    // A PNG named .jpg is a PNG.
    const png = await readPlacedImage(new File([pngHeader(800, 600) as BlobPart], "control.jpg"), t);
    expect(png).toMatchObject({ recipe: { fileName: "control.jpg", mediaType: "image/png", naturalWidth: 800, naturalHeight: 600 } });
    expect("recipe" in png && png.recipe.content.startsWith("data:image/png;base64,iVBORw0KGgo")).toBe(true);
    const jpeg = await readPlacedImage(new File([jpegHeader(30, 10) as BlobPart], "treated.jpeg"), t);
    expect(jpeg).toMatchObject({ recipe: { mediaType: "image/jpeg", naturalWidth: 30, naturalHeight: 10 } });
  });

  it("refuses a file over 8 MB, naming the limit, and a file that is not an SVG, PNG or JPEG", async () => {
    expect(PLACED_IMAGE_BYTES_LIMIT).toBe(8 * 1024 * 1024);
    const big = new File([new Uint8Array(PLACED_IMAGE_BYTES_LIMIT + 1)], "B1.png");
    expect(await readPlacedImage(big, t)).toEqual({ error: "B1.png is 8.0 MB; a placed image can be at most 8.0 MB." });
    const atLimit = new Uint8Array(PLACED_IMAGE_BYTES_LIMIT);
    atLimit.set(pngHeader(10, 10));
    expect(await readPlacedImage(new File([atLimit], "B2.png"), t)).toHaveProperty("recipe");
    expect(await readPlacedImage(new File(["%PDF-1.7"], "figure.pdf"), t)).toEqual({ error: "figure.pdf is not an SVG, PNG or JPEG file." });
    expect(await readPlacedImage(new File(["<svg xmlns='http://www.w3.org/2000/svg'><unclosed></svg>"], "broken.svg"), t)).toEqual({ error: "broken.svg could not be read as SVG." });
  });

  it("states sizes as people read them, and a stored size as the bytes the workspace keeps", () => {
    expect([formatBytes(812), formatBytes(34 * 1024), formatBytes(1.25 * 1024 * 1024)]).toEqual(["812 B", "34 KB", "1.3 MB"]);
    expect(storedBytes({ content: "<svg>µ</svg>" })).toBe(13);
  });
});

describe("The frame an image is placed in", () => {
  it("is its natural size, or scaled down, proportions kept, to fit inside the page's margins", () => {
    const page = createLayoutSheet("S").page;
    const size = pageSizePx(page);
    const room = { width: size.width - 2 * mmToPx(page.marginMm), height: size.height - 2 * mmToPx(page.marginMm) };
    expect(placedImageFrame({ naturalWidth: 200, naturalHeight: 100 }, page)).toEqual({ width: 200, height: 100 });
    const wide = placedImageFrame({ naturalWidth: 4000, naturalHeight: 1000 }, page);
    expect(wide.width).toBeLessThanOrEqual(room.width);
    expect(wide.width).toBeGreaterThanOrEqual(room.width - 1);
    expect(wide.width / wide.height).toBeCloseTo(4, 1);
    const tall = placedImageFrame({ naturalWidth: 1000, naturalHeight: 3000 }, page);
    expect(tall.height).toBeLessThanOrEqual(room.height);
    expect(tall.height).toBeGreaterThanOrEqual(room.height - 1);
    expect(tall.width / tall.height).toBeCloseTo(1 / 3, 2);
  });
});

describe("A placed SVG made safe", () => {
  it("keeps the drawing and nothing that runs, loads or reaches outside the file", () => {
    const svg = sanitizePlacedSvg(HOSTILE_SVG)!;
    const markup = new XMLSerializer().serializeToString(svg);
    expect(svg.querySelectorAll("script, foreignObject, set, animate, iframe")).toHaveLength(0);
    expect(markup).not.toMatch(/script|foreignObject|iframe|alert|javascript:|example\.org|other\.svg|@import/i);
    expect([svg, ...svg.querySelectorAll("*")].flatMap((el) => [...el.attributes].map((a) => a.name)).filter((name) => /^on/i.test(name))).toEqual([]);
    // What is drawn stays: the rectangle, its gradient by fragment, the texts, the embedded image and the use of a fragment.
    expect(svg.querySelector("rect")!.getAttribute("fill")).toBe("url(#grad)");
    expect(svg.querySelector("rect")!.getAttribute("filter")).toBe("none");
    expect([...svg.querySelectorAll("text")].map((el) => el.textContent)).toEqual(["D1", "control"]);
    const images = [...svg.querySelectorAll("image")];
    expect(images.map((el) => el.getAttribute("href") ?? el.getAttribute("xlink:href"))).toEqual([null, "data:image/png;base64,iVBORw0KGgo="]);
    expect([...svg.querySelectorAll("use")].map((el) => el.getAttribute("href") ?? el.getAttribute("xlink:href"))).toEqual(["#box", null]);
    expect(svg.querySelector("style")!.textContent).toContain(".cls-1 { fill: #336699; }");
    expect(svg.getAttribute("preserveAspectRatio")).toBe("none");
  });

  it("prefixes its ids, the references follow, and its style rules apply only inside it", () => {
    const svg = sanitizePlacedSvg(HOSTILE_SVG, { idPrefix: "image-3-", scope: "image-3-art" })!;
    expect(svg.getAttribute("id")).toBe("image-3-art");
    expect([...svg.querySelectorAll("[id]")].map((el) => el.getAttribute("id"))).toEqual(["image-3-grad", "image-3-grad-stop", "image-3-box"]);
    expect(svg.querySelector("rect")!.getAttribute("fill")).toBe("url(#image-3-grad)");
    expect(svg.querySelector("use")!.getAttribute("href")).toBe("#image-3-box");
    const css = svg.querySelector("style")!.textContent!;
    expect(css).toContain("#image-3-art .cls-1 {");
    expect(css).toContain("#image-3-art #image-3-grad-stop {");
    expect(css).toContain("#image-3-art rect {");
    expect(css).not.toContain("example.org");
  });

  it("gives an SVG without a viewBox its natural size as one, so it stretches as the page draws it", () => {
    const svg = sanitizePlacedSvg('<svg xmlns="http://www.w3.org/2000/svg" width="10mm" height="5mm"><rect width="10" height="5"/></svg>')!;
    expect(svg.getAttribute("viewBox")).toBe("0 0 37.8 18.9");
  });

  it("is what the page's <img> shows, as a data URL; a bitmap shows its own data URL", () => {
    const src = placedImageSrc({ kind: "image", fileName: "h.svg", mediaType: "image/svg+xml", naturalWidth: 120, naturalHeight: 60, content: HOSTILE_SVG });
    expect(src.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
    const text = svgTextOfSrc(src)!;
    expect(text).not.toMatch(/script|onload|onclick|example\.org|javascript:/i);
    expect(text).toContain('width="120"');
    const png = "data:image/png;base64,iVBORw0KGgo=";
    expect(placedImageSrc({ kind: "image", fileName: "p.png", mediaType: "image/png", naturalWidth: 1, naturalHeight: 1, content: png })).toBe(png);
    expect(svgTextOfSrc(png)).toBeNull();
  });
});
