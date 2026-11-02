// pdfText.ts — text the PDF writer's standard fonts can set.
//
// jsPDF's built-in Helvetica encodes WinAnsi only. A string with any other character is written as
// two-byte text, which Helvetica then draws a byte at a time: every letter followed by a gap, and
// the odd character as another glyph. A population named "CD19+CD3−" (U+2212, the minus GateLab's
// names carry) came out as "C D 1 9 + C D 3"" in the Strategy tab's PDF. The signs a marker name
// uses are rewritten to the WinAnsi characters that look like them; SVG and PNG exports keep the
// names as they are.

const PDF_SUBSTITUTES: Readonly<Record<string, string>> = {
  "−": "–", // minus sign → en dash, a minus's width in Helvetica
  "⁻": "–", // superscript minus
  "⁺": "+", // superscript plus
  "‐": "-", // hyphen
  "‑": "-", // non-breaking hyphen
  " ": " ", // thin space
  " ": " ", // narrow no-break space
  " ": " ", // figure space
};

const PATTERN = new RegExp(`[${Object.keys(PDF_SUBSTITUTES).join("")}]`, "g");

/** `text` with the characters the PDF fonts cannot set replaced by ones they can. */
export function pdfText(text: string): string {
  return text.replace(PATTERN, (c) => PDF_SUBSTITUTES[c] ?? c);
}

/** Every text node under `root` passed through pdfText, for an SVG built for the PDF writer. */
export function pdfTextInSvg(root: Node): void {
  const doc = root.ownerDocument ?? (root as Document);
  const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const value = node.nodeValue ?? "";
    const next = pdfText(value);
    if (next !== value) node.nodeValue = next;
  }
}
