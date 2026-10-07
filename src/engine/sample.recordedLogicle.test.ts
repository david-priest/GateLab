// A FACSDiscover S8 file records Chorus's biexponential for every parameter — $PnR (T), PnM (M),
// PnMS (R) — and the sample's default logicle is that display; a file without the keywords keeps
// the estimate. A synthetic FCS 3.1 file with the keywords stands in for an S8 export.
import { describe, expect, it } from "vitest";
import { parseFcs } from "./fcs";
import { Sample } from "./sample";

function buildFcs(channels: string[], events: number[][], extra: (p: number, name: string) => string[]): ArrayBuffer {
  const par = channels.length, tot = events.length;
  const kv: string[] = ["$PAR", String(par), "$TOT", String(tot), "$DATATYPE", "F", "$BYTEORD", "1,2,3,4", "$MODE", "L", "$CYT", "FACSDiscover S8"];
  channels.forEach((nm, i) => { const p = i + 1; kv.push(`$P${p}N`, nm, `$P${p}B`, "32", `$P${p}R`, "2147483648", `$P${p}E`, "0,0", ...extra(p, nm)); });
  const delim = "/";
  const textBody = delim + kv.map((t) => t.replaceAll(delim, delim + delim)).join(delim) + delim;
  const textStart = 256, textEnd = textStart + textBody.length - 1, dataStart = textEnd + 1, dataEnd = dataStart + tot * par * 4 - 1;
  const buf = new ArrayBuffer(dataEnd + 1); const u8 = new Uint8Array(buf);
  const put = (s: string, off: number) => { for (let i = 0; i < s.length; i++) u8[off + i] = s.charCodeAt(i) & 0xff; };
  const pad8 = (n: number) => String(n).padStart(8, " ");
  put("FCS3.1    ", 0); put(pad8(textStart), 10); put(pad8(textEnd), 18); put(pad8(dataStart), 26); put(pad8(dataEnd), 34); put(pad8(0), 42); put(pad8(0), 50);
  put(textBody, textStart);
  const view = new DataView(buf);
  events.forEach((row, e) => row.forEach((v, c) => view.setFloat32(dataStart + (e * par + c) * 4, v, true)));
  return buf;
}

const events = Array.from({ length: 200 }, (_, i) => [1000 + i * 500, -40000 + i * 2000, 500 + i * 100]);

describe("the logicle an S8 file records", () => {
  it("is the channel's default: T from $PnR, M from PnM, W from PnMS", () => {
    const buf = buildFcs(["FSC-A", "BV421-A", "PE-A"], events, (p, nm) => (nm === "FSC-A" ? [] : [`P${p}M`, "7", `P${p}MS`, nm === "BV421-A" ? "54006" : "42898", `P${p}MDMin`, "-341140.7", `P${p}MDMax`, "1955091.9"]));
    const sample = new Sample(parseFcs(buf));
    const ch = sample.channels.find((c) => c.pnn === "BV421-A")!;
    const idx = sample.channels.indexOf(ch);
    const spec = sample.transformSpec(ch.key);
    expect(spec.kind).toBe("logicle");
    if (spec.kind === "logicle") {
      expect(spec.T).toBe(2147483648);
      expect(spec.M).toBe(7);
      expect(spec.W).toBeCloseTo((7 - Math.log10(2147483648 / 54006)) / 2, 9);
    }
    expect(sample.logicleM(idx)).toBe(7);
    // The PE channel has its own R, so its own W.
    const pe = sample.channels.find((c) => c.pnn === "PE-A")!;
    const peSpec = sample.transformSpec(pe.key);
    if (peSpec.kind === "logicle") expect(peSpec.W).toBeCloseTo((7 - Math.log10(2147483648 / 42898)) / 2, 9);
    // And the display is the one Chorus showed: the window's lower end (PnMDMin) sits at the
    // bottom of the axis, T at its top (display space runs 0 to 1).
    expect(Math.abs(sample.rawToDisplay(ch.key, -341140.7))).toBeLessThan(0.2);
    expect(sample.rawToDisplay(ch.key, 2147483648)).toBeCloseTo(1, 6);
  });

  it("falls back to the estimate, with 4.5 decades, when the file records no display", () => {
    const buf = buildFcs(["FSC-A", "BV421-A"], events.map((r) => r.slice(0, 2)), () => []);
    const sample = new Sample(parseFcs(buf));
    const ch = sample.channels.find((c) => c.pnn === "BV421-A")!;
    const spec = sample.transformSpec(ch.key);
    expect(spec.kind).toBe("logicle");
    if (spec.kind === "logicle") expect(spec.M).toBe(4.5);
    expect(sample.logicleM(sample.channels.indexOf(ch))).toBe(4.5);
  });
});
