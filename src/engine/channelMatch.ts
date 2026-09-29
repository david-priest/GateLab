// channelMatch.ts — how a channel name another program wrote is compared with the loaded file's.
//
// Every importer that finds a gate's or a matrix's channel by something looser than its exact name
// compares names through these two functions, so that a name finds the same channel whichever
// door it came in by, and the same channel GateLabR's importer finds (GateLabR PR #63,
// inst/app/R/gatingml_import.R: .gml_punctuation_insensitive and .gml_metal_spellings).
//
// Until 2026-09 GateLab's own versions lost information that tells two channels apart:
//   • ignoring case and punctuation kept a-z and 0-9 only, so every letter outside ASCII went with
//     the punctuation, and TCRγδ and TCRαβ were both "tcr": a gate on one, over data with the
//     other, was read there without a word; so were IFN-α on IFN-γ, IL-1α on IL-1β and CD8β on
//     CD8α. The "+" and "-" of a name went too, so CD3- was read on CD3+;
//   • the metal step kept any name's first one to three letters and two or three digits, whatever
//     the name was, so on mass cytometry data, whose channels GateLab keys by marker, CD11c was
//     read on CD11b and CD62L on CD62P.

/**
 * The elements whose natural isotopes reach a mass cytometer's range (75 to 209), each with the
 * masses of its lightest and heaviest natural isotope. GateLabR's .GML_METAL_MASSES, entry for entry.
 */
export const METAL_MASSES: Readonly<Record<string, readonly [number, number]>> = {
  Ge: [70, 76], As: [75, 75], Se: [74, 82], Br: [79, 81], Kr: [78, 86], Rb: [85, 87],
  Sr: [84, 88], Y: [89, 89], Zr: [90, 96], Nb: [93, 93], Mo: [92, 100], Ru: [96, 104],
  Rh: [103, 103], Pd: [102, 110], Ag: [107, 109], Cd: [106, 116], In: [113, 115],
  Sn: [112, 124], Sb: [121, 123], Te: [120, 130], I: [127, 127], Xe: [124, 136],
  Cs: [133, 133], Ba: [130, 138], La: [138, 139], Ce: [136, 142], Pr: [141, 141],
  Nd: [142, 150], Sm: [144, 154], Eu: [151, 153], Gd: [152, 160], Tb: [159, 159],
  Dy: [156, 164], Ho: [165, 165], Er: [162, 170], Tm: [169, 169], Yb: [168, 176],
  Lu: [175, 176], Hf: [174, 180], Ta: [180, 181], W: [180, 186], Re: [185, 187],
  Os: [184, 192], Ir: [191, 193], Pt: [190, 198], Au: [197, 197], Hg: [196, 204],
  Tl: [203, 205], Pb: [204, 208], Bi: [209, 209],
};

/** A metal a channel name spells: the spelling as written, its element as written, and its mass. */
export interface MetalSpelling {
  /** The spelling as the name writes it, "Di" or "Dd" included: "Nd145Di", "145Nd". */
  text: string;
  /** The element's symbol as written, which is its own case: "Nd". */
  element: string;
  mass: number;
  /** The element in lower case followed by the mass, which two spellings of one metal share: "nd145". */
  metal: string;
}

const WORD = /[\p{L}\p{N}]/u;
const ASCII_LETTER = /[A-Za-z]/;
const ASCII_ALNUM = /[A-Za-z0-9]/;

/**
 * Every match of `re` (global) in `text` whose preceding character does not match `notBefore`, found
 * as a regular expression with that look-behind finds them: a candidate refused for what precedes
 * it is tried again one character on, and an accepted one resumes the search after itself. Written
 * out rather than as a look-behind, which a browser before Safari 16.4 cannot parse.
 */
function matchesNotAfter(re: RegExp, text: string, notBefore: RegExp): RegExpExecArray[] {
  const out: RegExpExecArray[] = [];
  re.lastIndex = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (m.index > 0 && notBefore.test(text[m.index - 1])) {
      re.lastIndex = m.index + 1;
      continue;
    }
    out.push(m);
    if (m[0].length === 0) re.lastIndex++;
  }
  return out;
}

/**
 * Every metal a channel name spells, in the order it spells them. A metal is an element's symbol in
 * its own case (an upper-case letter and at most one lower-case one) with a mass within that
 * element's natural isotopes (METAL_MASSES), either way round, optionally followed by "Di" or "Dd",
 * and not run into a longer word or number: "Nd145Di", "145Nd", "CD4 (Nd145Di)" and "BC2(Pr141)Dd"
 * each spell one. A marker name spells none: "CD45" is not cadmium 45 (the symbol is not in its
 * case), "CD45RA", "CD11c" and "CD62L" have no symbol in its case either, "B220" names no isotope
 * of boron, and "Ki67" and "Ly108" name no element.
 */
export function metalSpellings(name: string): MetalSpelling[] {
  if (typeof name !== "string" || !name) return [];
  const found: { at: number; spelling: MetalSpelling }[] = [];
  const take = (m: RegExpExecArray, element: string, massText: string) => {
    const mass = Number(massText);
    const span = Object.prototype.hasOwnProperty.call(METAL_MASSES, element) ? METAL_MASSES[element] : undefined;
    if (!span || mass < span[0] || mass > span[1]) return;
    found.push({ at: m.index, spelling: { text: m[0], element, mass, metal: `${element.toLowerCase()}${mass}` } });
  };
  // Symbol then mass: not after a letter, and not run into a lower-case letter or a digit.
  for (const m of matchesNotAfter(/([A-Z][a-z]?)([0-9]{2,3})(?:[Dd][IiDd])?(?![a-z0-9])/g, name, ASCII_LETTER)) {
    take(m, m[1], m[2]);
  }
  // Mass then symbol: not after a letter or a digit, and not run into a lower-case letter.
  for (const m of matchesNotAfter(/([0-9]{2,3})([A-Z][a-z]?)(?:[Dd][IiDd])?(?![a-z])/g, name, ASCII_ALNUM)) {
    take(m, m[2], m[1]);
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.spelling);
}

/**
 * The metal a channel name spells (metalSpellings), the first where it spells more than one, as
 * the element in lower case followed by the mass; "" where it spells none. "CD3 (Y89Di)" gives
 * "y89", "140Ce_Beads" "ce140", and "CD11c" "".
 */
export function metalOf(name: string): string {
  return metalSpellings(name)[0]?.metal ?? "";
}

/**
 * A channel name with its case folded and its punctuation removed, keeping every letter and digit of
 * any script and every sign. FlowJo writes a detector as "v-FLT525_30-E-A" where the FCS file calls
 * it "v-FLT525/30-E-A", and the separator is all the two disagree about; "b-FLT525/30-B-A" stays
 * another name. A sign is kept: every "+", and every "-" but one between two letters or digits,
 * which is a separator, as in FITC-A; a dash with a space on either side is therefore a sign, as in
 * GateLabR. The minus sign U+2212 is read as "-" first.
 */
export function punctuationInsensitive(name: string): string {
  const chars = Array.from(name.toLowerCase().replace(/−/g, "-"));
  const word = (c: string | undefined) => c !== undefined && WORD.test(c);
  let out = "";
  chars.forEach((c, i) => {
    if (c === "+" || word(c)) out += c;
    else if (c === "-" && !(word(chars[i - 1]) && word(chars[i + 1]))) out += c;
  });
  return out;
}
