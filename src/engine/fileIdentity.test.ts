// Whether an FCS file is the acquisition a workspace recorded. Synthetic records throughout; the
// formats are the ones measured on the FlowRepository corpus (2026-09-24), where these rules left
// no false contradiction on any pairing whose counts agree with FlowJo's.

import { describe, expect, it } from "vitest";
import {
  compareIdentity,
  describeAgreement,
  describeContradiction,
  identityKeywords,
  pairFile,
  sameFileName,
  sameIdentityValue,
  type RecordedIdentity,
} from "./fileIdentity";

describe("comparing one identity keyword", () => {
  it("reads $TOT as an integer, whatever the padding", () => {
    expect(sameIdentityValue("$TOT", "0000000000000010000", "10000")).toBe(true);
    expect(sameIdentityValue("$TOT", " 7362 ", "7362")).toBe(true);
    expect(sameIdentityValue("$TOT", "10222", "7362")).toBe(false);
  });

  it("reads $DATE as a calendar date, in any of FlowJo's and the cytometers' formats", () => {
    // FlowJo wrote '12_17_2018' for a file whose $DATE is '12/17/2018'.
    expect(sameIdentityValue("$DATE", "12_17_2018", "12/17/2018")).toBe(true);
    expect(sameIdentityValue("$DATE", "17-DEC-2018", "12/17/2018")).toBe(true);
    expect(sameIdentityValue("$DATE", "17-Dec-18", "2018-12-17")).toBe(true);
    // FACSDiva writes a tube's begin as an ISO date-time.
    expect(sameIdentityValue("$DATE", "2023-07-20T11:54:39", "20-JUL-2023")).toBe(true);
    // dd/mm and mm/dd are both accepted when the text does not say which.
    expect(sameIdentityValue("$DATE", "05/06/2020", "06-MAY-2020")).toBe(true);
    expect(sameIdentityValue("$DATE", "05/06/2020", "05-JUN-2020")).toBe(true);
    expect(sameIdentityValue("$DATE", "01-JAN-2024", "02-FEB-2024")).toBe(false);
  });

  // Year first with a month name was read day-first: "2018-Oct-25" became 2025-10-2018, and a
  // file dated 25-OCT-2018 was reported as another acquisition.
  it("reads a year-first date with a month name", () => {
    expect(sameIdentityValue("$DATE", "2018-Oct-25", "25-OCT-2018")).toBe(true);
    expect(sameIdentityValue("$DATE", "2018-Oct-25", "10/25/2018")).toBe(true);
    expect(sameIdentityValue("$DATE", "2018-Oct-25", "26-OCT-2018")).toBe(false);
  });

  // A comma or a weekday made the text unreadable, and it stood for itself: "Oct 25, 2018" read
  // as a contradiction of 25-OCT-2018.
  it("reads a date written with a comma or a weekday", () => {
    expect(sameIdentityValue("$DATE", "Oct 25, 2018", "25-OCT-2018")).toBe(true);
    expect(sameIdentityValue("$DATE", "October 25, 2018", "10/25/2018")).toBe(true);
    expect(sameIdentityValue("$DATE", "Thu, 25 Oct 2018", "25-OCT-2018")).toBe(true);
    expect(sameIdentityValue("$DATE", "Thursday, October 25, 2018", "2018-10-25")).toBe(true);
    expect(sameIdentityValue("$DATE", "Oct 25, 2018", "26-OCT-2018")).toBe(false);
    expect(sameIdentityValue("$DATE", "Fri, 26 Oct 2018", "25-OCT-2018")).toBe(false);
  });

  // A weekday after the date, and an ordinal day, still made the text unreadable.
  it("reads a date with a weekday after it or an ordinal day", () => {
    expect(sameIdentityValue("$DATE", "25 Oct 2018 (Thu)", "25-OCT-2018")).toBe(true);
    expect(sameIdentityValue("$DATE", "25 Oct 2018 Thursday", "25-OCT-2018")).toBe(true);
    expect(sameIdentityValue("$DATE", "October 25th, 2018", "10/25/2018")).toBe(true);
    expect(sameIdentityValue("$DATE", "1st Oct 2018", "01-OCT-2018")).toBe(true);
    expect(sameIdentityValue("$DATE", "October 22nd, 2018", "22-OCT-2018")).toBe(true);
    expect(sameIdentityValue("$DATE", "October 23rd, 2018", "2018-10-23")).toBe(true);
    expect(sameIdentityValue("$DATE", "25 Oct 2018 (Thu)", "26-OCT-2018")).toBe(false);
    expect(sameIdentityValue("$DATE", "October 25th, 2018", "26-OCT-2018")).toBe(false);
  });

  it("reads a time to whole seconds, dropping fractions and FCS 3.0's sixtieths", () => {
    expect(sameIdentityValue("$BTIM", "10:48:03", "10:48:03.27")).toBe(true);
    expect(sameIdentityValue("$ETIM", "10:50:30:15", "10:50:30")).toBe(true);
    expect(sameIdentityValue("$BTIM", "2023-07-20T11:54:39", "11:54:39")).toBe(true);
    expect(sameIdentityValue("$BTIM", "1:05:00 PM", "13:05:00")).toBe(true);
    expect(sameIdentityValue("$BTIM", "11:02:10", "11:56:55")).toBe(false);
  });

  it("reads a GUID without case or braces", () => {
    expect(sameIdentityValue("GUID", "{AAAA0000-0000-0000-0000-000000000001}", "aaaa0000-0000-0000-0000-000000000001")).toBe(true);
  });
});

describe("comparing a record with a file", () => {
  const record: RecordedIdentity = { $TOT: "7378", $DATE: "01-JAN-2024", $BTIM: "10:48:03", $ETIM: "10:50:30", GUID: "aaaa-1" };

  it("confirms by a time or the GUID, and names what agreed", () => {
    const c = compareIdentity(record, { ...record });
    expect(c.verdict).toBe("confirmed");
    expect(c.agree).toEqual(["$TOT", "$DATE", "$BTIM", "$ETIM", "GUID"]);
  });

  it("takes a blank or absent value as not recorded, never as a difference", () => {
    // FlowJo fills $DATE, GUID and $FIL where the FCS holds spaces.
    const file = identityKeywords({ "$TOT": "7378", "$DATE": "   ", "$BTIM": "10:48:03", GUID: "" });
    expect(compareIdentity(record, file).verdict).toBe("confirmed");
    expect(compareIdentity({}, file).verdict).toBe("unconfirmed");
  });

  it("reads keyword names without case", () => {
    expect(identityKeywords({ "$btim": "10:48:03", guid: "aaaa-1", "$fil": "x.fcs" })).toEqual({ $BTIM: "10:48:03", GUID: "aaaa-1" });
  });

  it("never confirms on $TOT alone: fixed-count acquisitions share it", () => {
    // Six contradicted corpus pairings agree on $TOT (runs stopped at 5,000 or 10,000 events).
    expect(compareIdentity({ $TOT: "10000" }, { $TOT: "10000" }).verdict).toBe("weak");
    expect(compareIdentity({ $TOT: "10000", $BTIM: "09:00:00" }, { $TOT: "10000", $BTIM: "09:40:00" }).verdict).toBe("contradicted");
  });

  // A dialog row read "confirmed by $TOT, $DATE" for a verdict that confirms nothing.
  it("does not call an agreement on $TOT and $DATE alone a confirmation", () => {
    expect(describeAgreement(compareIdentity({ $TOT: "3", $DATE: "01-JAN-2024" }, { $TOT: "3", $DATE: "01-JAN-2024" })))
      .toBe("agrees on $TOT, $DATE only, which does not confirm it");
    expect(describeAgreement(compareIdentity(record, { ...record }))).toBe("confirmed by $TOT, $DATE, $BTIM, $ETIM, GUID");
  });

  it("says, by name, what the record holds that the file does not", () => {
    const c = compareIdentity({ $TOT: "36988", $BTIM: "11:02:10" }, { $TOT: "43641", $BTIM: "11:56:55" });
    expect(c.verdict).toBe("contradicted");
    expect(describeContradiction('sample 3 "H1.fcs"', c.differ))
      .toBe('sample 3 "H1.fcs" records $TOT 36,988 and $BTIM 11:02:10; this file has 43,641 and 11:56:55');
  });
});

describe("a file name in either Unicode form", () => {
  it("is the same name composed (NFC) and decomposed (NFD)", () => {
    const composed = "Probe_\u00fc.fcs";
    const decomposed = "Probe_u\u0308.fcs";
    expect(composed).not.toBe(decomposed);
    expect(sameFileName(composed, decomposed)).toBe(true);
    expect(sameFileName(decomposed, "probe_\u00fc")).toBe(true);
    // Pairing by name finds the record either way.
    const pairing = pairFile({ name: decomposed }, [{ id: 1 }], () => [composed], () => ({}));
    expect(pairing.kind).toBe("own");
  });
});

describe("pairing a file with the record that is it", () => {
  interface Rec { index: number; names: string[]; recorded: RecordedIdentity }
  const pair = (file: { name: string; keywords?: Record<string, string> | null }, records: Rec[]) =>
    pairFile(file, records, (r) => r.names, (r) => r.recorded);
  const d1 = { $TOT: "3", $BTIM: "10:00:00", $DATE: "01-JAN-2024" };
  const d2 = { $TOT: "3", $BTIM: "15:30:00", $DATE: "02-FEB-2024" };

  it("takes the one its keywords confirm among several of its name, not the first", () => {
    // Specimen_001_Tube_001.fcs from two experiments in one workspace; the file is the second's.
    const records = [
      { index: 0, names: ["Specimen_001_Tube_001.fcs"], recorded: d1 },
      { index: 1, names: ["Specimen_001_Tube_001.fcs"], recorded: d2 },
    ];
    const p = pair({ name: "Specimen_001_Tube_001.fcs", keywords: d2 }, records);
    expect(p.kind).toBe("own");
    if (p.kind === "own") {
      expect(p.sample.index).toBe(1);
      expect(p.rejected.map((r) => r.sample.index)).toEqual([0]);
    }
  });

  it("asks when one acquisition was added twice and the keywords confirm both", () => {
    const records = [
      { index: 0, names: ["D1.fcs"], recorded: d1 },
      { index: 1, names: ["D1.fcs"], recorded: d1 },
    ];
    const p = pair({ name: "D1.fcs", keywords: d1 }, records);
    expect(p.kind).toBe("ambiguous");
  });

  it("asks when several records of its name record nothing to compare", () => {
    const records = [{ index: 0, names: ["D1.fcs"], recorded: {} }, { index: 1, names: ["D1.fcs"], recorded: {} }];
    expect(pair({ name: "D1.fcs", keywords: null }, records).kind).toBe("ambiguous");
  });

  it("pairs nothing when the only record of its name is another acquisition", () => {
    // A same-named file from another experiment.
    const p = pair({ name: "Specimen_001_Tube_001.fcs", keywords: d2 }, [{ index: 0, names: ["Specimen_001_Tube_001.fcs"], recorded: d1 }]);
    expect(p.kind).toBe("contradicted");
  });

  it("pairs by name alone where nothing is recorded, as before", () => {
    const p = pair({ name: "d1.FCS", keywords: null }, [{ index: 0, names: ["D1.fcs"], recorded: d1 }]);
    expect(p.kind === "own" && p.comparison.verdict).toBe("unconfirmed");
  });

  it("tries the file's $FIL only when no record carries its name", () => {
    const records = [{ index: 0, names: ["19319.fcs"], recorded: d1 }];
    const p = pair({ name: "Specimen_001_B cell presort.fcs", keywords: { ...d1, $FIL: "19319.fcs" } }, records);
    expect(p.kind === "own" && p.matchedOn).toBe("fil");
    expect(pair({ name: "other.fcs", keywords: d1 }, records).kind).toBe("none");
  });

  // Two files of one experiment swapped on disk: D2's acquisition saved as "D1.fcs". The sample
  // named D1.fcs records another acquisition, and the file's $FIL names D2's sample, which its
  // keywords confirm. It used to be "no sample is this file", because a sample of its name existed.
  it("tries the file's $FIL when every record of its name records another acquisition", () => {
    const records = [
      { index: 0, names: ["D1.fcs", "18445.fcs"], recorded: d1 },
      { index: 1, names: ["D2.fcs", "18447.fcs"], recorded: d2 },
    ];
    const p = pair({ name: "D1.fcs", keywords: { ...d2, $FIL: "18447.fcs" } }, records);
    expect(p.kind).toBe("own");
    if (p.kind === "own") {
      expect(p.sample.index).toBe(1);
      expect(p.matchedOn).toBe("fil");
      // The same-named record it is not, with what differs, so the import can say so.
      expect(p.rejected.map((r) => r.sample.index)).toEqual([0]);
    }
    // A $FIL naming a record that also records another acquisition pairs nothing.
    const q = pair({ name: "D1.fcs", keywords: { $BTIM: "08:00:00", $FIL: "18447.fcs" } }, records);
    expect(q.kind).toBe("contradicted");
    if (q.kind === "contradicted") expect(q.candidates.map((c) => c.sample.index)).toEqual([0, 1]);
  });

  // A sample renamed "renamed.fcs" that records no identity keyword, and a loaded renamed.fcs that
  // is another sample's acquisition by its $FIL and every keyword. The same-named sample won
  // because it was the only one of the name, and its tree was imported without a word.
  it("gives a file to the record its $FIL names and its keywords confirm, over a same-named record that confirms nothing", () => {
    const records = [
      { index: 13, names: ["F_022.fcs", "18447.fcs"], recorded: { ...d2, GUID: "g-2" } },
      { index: 16, names: ["renamed.fcs"], recorded: {} },
    ];
    const p = pair({ name: "renamed.fcs", keywords: { ...d2, GUID: "g-2", $FIL: "18447.fcs" } }, records);
    expect(p.kind).toBe("own");
    if (p.kind === "own") {
      expect(p.sample.index).toBe(13);
      expect(p.matchedOn).toBe("fil");
      expect(p.passedOver?.map((c) => c.sample.index)).toEqual([16]);
    }
    // Recording only the $TOT and $DATE the file carries confirms nothing either.
    const weak = [records[0], { index: 16, names: ["renamed.fcs"], recorded: { $TOT: d2.$TOT, $DATE: d2.$DATE } }];
    const q = pair({ name: "renamed.fcs", keywords: { ...d2, GUID: "g-2", $FIL: "18447.fcs" } }, weak);
    expect(q.kind === "own" && q.sample.index).toBe(13);
    // A same-named record the keywords confirm still settles it, whatever the $FIL names.
    const r = pair({ name: "renamed.fcs", keywords: { ...d2, GUID: "g-2", $FIL: "18447.fcs" } },
      [records[0], { index: 16, names: ["renamed.fcs"], recorded: { ...d2 } }]);
    expect(r.kind === "own" && r.sample.index).toBe(16);
    // Where neither is confirmed, the user is asked; the name does not decide.
    const s0 = pair({ name: "renamed.fcs", keywords: { $TOT: "3", $FIL: "18447.fcs" } },
      [{ index: 13, names: ["18447.fcs"], recorded: { $TOT: "3" } }, { index: 16, names: ["renamed.fcs"], recorded: {} }]);
    expect(s0.kind).toBe("ambiguous");
    if (s0.kind === "ambiguous") expect(s0.candidates.map((c) => c.sample.index).sort()).toEqual([13, 16]);
  });
});
