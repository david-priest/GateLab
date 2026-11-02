// @vitest-environment jsdom
// The PDF writer's standard fonts set WinAnsi only: a population named with a Unicode minus came
// out letter-spaced in the Strategy tab's PDF ("C D 1 9 + C D 3"").
import { describe, expect, it } from "vitest";
import { jsPDF } from "jspdf";
import { pdfText, pdfTextInSvg } from "./pdfText";

/** The bytes jsPDF writes for one line of text. */
function written(text: string): string {
  const doc = new jsPDF({ unit: "pt", format: [200, 100], compress: false });
  doc.text(text, 10, 50);
  return doc.output().split("\n").find((line) => / Tj$/.test(line))!;
}

describe("pdfText", () => {
  it("rewrites the signs of marker names to characters the PDF fonts set one byte each", () => {
    expect(written("CD19+CD3−")).toContain("\u0000"); // the failure: two-byte text
    expect(pdfText("CD19+CD3−")).toBe("CD19+CD3–");
    expect(pdfText("CD45RB−IgD+")).toBe("CD45RB–IgD+");
    expect(pdfText("PD1⁺ CD45RA⁻")).toBe("PD1+ CD45RA–");
    for (const name of ["CD19+CD3−", "PD1⁺ CD45RA⁻", "10 000 events"]) {
      expect(written(pdfText(name))).not.toContain("\u0000");
    }
    expect(written(pdfText("CD19+CD3−"))).toBe("(CD19+CD3\u0096) Tj");
  });

  it("leaves text the fonts already set as it is", () => {
    for (const name of ["Naive", "CD19+CD3-", "Early Mem 31.4%", "LightLoss (Violet)-A"]) expect(pdfText(name)).toBe(name);
  });

  it("rewrites every text node of an SVG built for the writer", () => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.innerHTML = '<text>CD19+CD3−: 61.3%</text><g><text><tspan>CD45RB−IgD+</tspan></text></g>';
    pdfTextInSvg(svg);
    expect([...svg.querySelectorAll("text")].map((t) => t.textContent)).toEqual(["CD19+CD3–: 61.3%", "CD45RB–IgD+"]);
  });
});
