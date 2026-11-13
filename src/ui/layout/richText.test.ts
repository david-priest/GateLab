import { describe, expect, it } from "vitest";
import {
  insertRichText,
  marksInRange,
  parseRichText,
  plainTextOf,
  richRunsOf,
  serializeRichText,
  superscriptMarkerSigns,
  textOfRuns,
  toggleMark,
  type RichRun,
} from "./richText";

describe("Layout rich text: the tag set", () => {
  it("reads the four tags and the two escapes, and writes them back", () => {
    const source = "<b>CD4</b><sup>+</sup> <i>and</i> CD8<sub>lo</sub>: 3 &lt; 5 &amp; more";
    const runs = parseRichText(source);
    expect(runs).toEqual([
      { bold: true, text: "CD4" },
      { sup: true, text: "+" },
      { text: " " },
      { italic: true, text: "and" },
      { text: " CD8" },
      { sub: true, text: "lo" },
      { text: ": 3 < 5 & more" },
    ]);
    expect(serializeRichText(runs)).toBe(source);
  });

  it("keeps anything that is not one of the four tags as literal text", () => {
    const runs = parseRichText("<u>x</u> <B>y</B> <span>z</span> a&b &gt; &lt");
    expect(runs).toEqual([{ text: "<u>x</u> <B>y</B> <span>z</span> a&b &gt; &lt" }]);
    // Written back, the literal characters are escaped, and read again they are the same words.
    const written = serializeRichText(runs);
    expect(written).toBe("&lt;u>x&lt;/u> &lt;B>y&lt;/B> &lt;span>z&lt;/span> a&amp;b &amp;gt; &amp;lt");
    expect(parseRichText(written)).toEqual(runs);
  });

  it("nests tags, and drops a closing tag with nothing open", () => {
    expect(parseRichText("<b>a<i>b</i></b></i>c")).toEqual([{ bold: true, text: "a" }, { bold: true, italic: true, text: "b" }, { text: "c" }]);
    expect(serializeRichText(parseRichText("<b>a<i>b</i></b>"))).toBe("<b>a</b><b><i>b</i></b>");
  });

  it("reads a plain block's text whole, tags and all", () => {
    expect(richRunsOf("a <b>b</b>", false)).toEqual([{ text: "a <b>b</b>" }]);
    expect(plainTextOf({ text: "a <b>b</b>" })).toBe("a <b>b</b>");
    expect(plainTextOf({ text: "a <b>b</b> &lt;", rich: true })).toBe("a b <");
  });

  it("formats a placeholder as a whole: the filled text takes the formatting", () => {
    const template = serializeRichText([{ bold: true, text: "{population}" }, { sup: true, text: "+" }]);
    expect(template).toBe("<b>{population}</b><sup>+</sup>");
    const filled = template.replace("{population}", "CD4_positive");
    expect(parseRichText(filled)).toEqual([{ bold: true, text: "CD4_positive" }, { sup: true, text: "+" }]);
  });

  it("saves unformatted words as plain text, and formatted ones as rich", () => {
    expect(textOfRuns([{ text: "a < b" }])).toEqual({ text: "a < b", rich: false });
    expect(textOfRuns([{ text: "a < " }, { bold: true, text: "b" }])).toEqual({ text: "a &lt; <b>b</b>", rich: true });
  });
});

describe("Layout rich text: editing", () => {
  const runs: RichRun[] = [{ text: "CD4 " }, { bold: true, text: "CD8" }];
  it("switches a mark on a range: on unless every character has it", () => {
    expect(toggleMark(runs, 0, 3, "bold")).toEqual([{ bold: true, text: "CD4" }, { text: " " }, { bold: true, text: "CD8" }]);
    expect(toggleMark(runs, 4, 7, "bold")).toEqual([{ text: "CD4 CD8" }]);
    expect(toggleMark(runs, 2, 6, "bold")).toEqual([{ text: "CD" }, { bold: true, text: "4 CD8" }]);
    // Superscript and subscript exclude each other.
    expect(toggleMark(toggleMark(runs, 2, 3, "sub"), 2, 3, "sup")).toEqual([{ text: "CD" }, { sup: true, text: "4" }, { text: " " }, { bold: true, text: "CD8" }]);
  });

  it("reads the marks of a range, and of the character before a caret", () => {
    expect(marksInRange(runs, 4, 7)).toEqual({ bold: true, italic: false, sup: false, sub: false });
    expect(marksInRange(runs, 3, 5).bold).toBe(false);
    expect(marksInRange(runs, 7, 7).bold).toBe(true);
    expect(marksInRange(runs, 4, 4).bold).toBe(false);
  });

  it("puts typed text in place of a range with the marks given", () => {
    expect(insertRichText(runs, 3, 3, "+", { sup: true })).toEqual([{ text: "CD4" }, { sup: true, text: "+" }, { text: " " }, { bold: true, text: "CD8" }]);
    expect(insertRichText(runs, 0, 4, "", {})).toEqual([{ bold: true, text: "CD8" }]);
  });
});

describe("Superscript marker signs", () => {
  it("raises the signs after marker names, Unicode minus included", () => {
    const result = superscriptMarkerSigns(richRunsOf("CD4+ CD45RA- PD1hi", false));
    expect(result).toEqual([
      { text: "CD4" }, { sup: true, text: "+" }, { text: " CD45RA" }, { sup: true, text: "-" }, { text: " PD1" }, { sup: true, text: "hi" },
    ]);
    expect(serializeRichText(result)).toBe("CD4<sup>+</sup> CD45RA<sup>-</sup> PD1<sup>hi</sup>");
    expect(serializeRichText(superscriptMarkerSigns(richRunsOf("CD8− CD27int, Ki67lo CD38bright IgDdim", false))))
      .toBe("CD8<sup>−</sup> CD27<sup>int</sup>, Ki67<sup>lo</sup> CD38<sup>bright</sup> IgD<sup>dim</sup>");
  });

  it("leaves words, hyphenated names, numbers and placeholders alone", () => {
    const text = "print the halo HLA-DR well-known 1+1 n = 3- {population}";
    expect(superscriptMarkerSigns(richRunsOf(text, false))).toEqual([{ text }]);
  });

  it("runs into the next marker after a plus, and keeps formatting already there", () => {
    expect(serializeRichText(superscriptMarkerSigns([{ bold: true, text: "CD4+CD8+" }]))).toBe("<b>CD4</b><b><sup>+</sup></b><b>CD8</b><b><sup>+</sup></b>");
  });
});
