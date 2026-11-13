// richTextDom.ts — a Layout text block's runs as page elements and back: <b>, <i>, <sup> and
// <sub> around text nodes, the newlines kept in the text (the surface wraps as pre-wrap). The
// editor, the frame's fit and the export read the same elements.

import { mergeRuns, type RichMark, type RichMarks, type RichRun } from "./richText";

const ELEMENT_MARK: Readonly<Record<string, RichMark>> = { B: "bold", STRONG: "bold", I: "italic", EM: "italic", SUP: "sup", SUB: "sub" };

/** One run's element: b outside i outside sup or sub, or a bare text node. */
export function runNode(run: RichRun, doc: Document = document): Node {
  let node: Node = doc.createTextNode(run.text);
  for (const [mark, tag] of [["sub", "sub"], ["sup", "sup"], ["italic", "i"], ["bold", "b"]] as const) {
    if (!run[mark]) continue;
    const wrap = doc.createElement(tag);
    wrap.appendChild(node);
    node = wrap;
  }
  return node;
}

/**
 * The runs drawn into an element, in place of what it held. Text ending in a newline gets a
 * trailing line break the reader skips, so the empty last line shows and takes the caret.
 */
export function renderRuns(root: HTMLElement, runs: readonly RichRun[]): void {
  root.replaceChildren(...runs.map((run) => runNode(run, root.ownerDocument)));
  if (runs.at(-1)?.text.endsWith("\n")) {
    const tail = root.ownerDocument.createElement("br");
    tail.dataset.tail = "";
    root.appendChild(tail);
  }
}

/** The marks the elements between `node` and `root` give it. */
export function marksAt(node: Node, root: Node): RichMarks {
  const marks: RichMarks = {};
  for (let at: Node | null = node; at && at !== root; at = at.parentNode) {
    const mark = at.nodeType === 1 ? ELEMENT_MARK[(at as Element).tagName] : undefined;
    if (mark) marks[mark] = true;
  }
  return marks;
}

interface Leaf { node: Node; start: number; length: number }

/** The text nodes and line breaks under `root` in order, each with its offset in the words. A last line break is the editor's placeholder and holds nothing. */
function leaves(root: Node): Leaf[] {
  const found: Leaf[] = [];
  let at = 0;
  const walk = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {
        const length = (child as Text).data.length;
        found.push({ node: child, start: at, length });
        at += length;
      } else if (child.nodeName === "BR") {
        found.push({ node: child, start: at, length: 1 });
        at += 1;
      } else walk(child);
    }
  };
  walk(root);
  const last = found.at(-1);
  if (last && last.node.nodeName === "BR" && isLastNode(last.node, root)) found.pop();
  return found;
}

function isLastNode(node: Node, root: Node): boolean {
  for (let at: Node | null = node; at && at !== root; at = at.parentNode) if (at.nextSibling) return false;
  return true;
}

/** The runs the elements under `root` hold, as the editor reads them after typing. */
export function readRuns(root: HTMLElement): RichRun[] {
  return mergeRuns(leaves(root).map((leaf) => ({ ...marksAt(leaf.node, root), text: leaf.node.nodeType === 3 ? (leaf.node as Text).data : "\n" })));
}

/** A point in the elements as an offset in the words. */
export function offsetOf(root: Node, node: Node, offset: number): number {
  const all = leaves(root);
  if (node.nodeType === 3) {
    const leaf = all.find((candidate) => candidate.node === node);
    return leaf ? leaf.start + Math.min(offset, leaf.length) : 0;
  }
  const boundary = node.childNodes[offset] ?? null;
  let count = 0;
  for (const leaf of all) {
    const before = boundary
      ? (boundary.compareDocumentPosition(leaf.node) & Node.DOCUMENT_POSITION_PRECEDING) !== 0 && !boundary.contains(leaf.node)
      : node.contains(leaf.node) || (node.compareDocumentPosition(leaf.node) & Node.DOCUMENT_POSITION_PRECEDING) !== 0;
    if (before) count += leaf.length;
  }
  return count;
}

/** An offset in the words as a point in the elements. */
export function pointAt(root: Node, offset: number): { node: Node; offset: number } {
  const all = leaves(root);
  for (const leaf of all) {
    if (leaf.node.nodeType === 3) {
      if (offset <= leaf.start + leaf.length) return { node: leaf.node, offset: Math.max(0, offset - leaf.start) };
    } else if (offset <= leaf.start) {
      const parent = leaf.node.parentNode!;
      return { node: parent, offset: Array.prototype.indexOf.call(parent.childNodes, leaf.node) };
    }
  }
  const last = all.at(-1);
  if (last && last.node.nodeType !== 3) {
    const parent = last.node.parentNode!;
    return { node: parent, offset: Array.prototype.indexOf.call(parent.childNodes, last.node) + 1 };
  }
  return { node: root, offset: root.childNodes.length };
}

/** The selection inside `root` as offsets in the words, or null when it is elsewhere. */
export function selectionOffsets(root: HTMLElement): { start: number; end: number } | null {
  const selection = root.ownerDocument.getSelection();
  if (!selection || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  return { start: offsetOf(root, range.startContainer, range.startOffset), end: offsetOf(root, range.endContainer, range.endOffset) };
}

export function selectOffsets(root: HTMLElement, start: number, end: number): void {
  const selection = root.ownerDocument.getSelection();
  if (!selection) return;
  const from = pointAt(root, start);
  const to = pointAt(root, end);
  const range = root.ownerDocument.createRange();
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);
  selection.removeAllRanges();
  selection.addRange(range);
}
