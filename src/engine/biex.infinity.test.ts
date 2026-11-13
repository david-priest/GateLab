// A biex axis holds a value beyond its table on the table's end, an infinite value included.
import { describe, expect, it } from "vitest";
import { biexTransform, FLOWJO_BIEX_TABLE_CHANNELS } from "./biex";
import { flowJoGridScale } from "./flowjoGrid";
import { transformFromSpec } from "./sample";

describe("biex: +Infinity is above the table and must sit on the last channel", () => {
  const p = { maxValue: 262144, pos: 4.418539922, neg: 0, widthBasis: -100, channelRange: 256, tableChannels: FLOWJO_BIEX_TABLE_CHANNELS };
  it("the continuous biex pins +Infinity at channelRange, as it pins every value above the table", () => {
    const t = biexTransform(p);
    expect(t.forward(1e30)).toBe(256);
    expect(t.forward(Infinity)).toBe(256);
    expect(t.forward(-Infinity)).toBe(0);
  });
  it("and agrees with FlowJo's grid on the same axis, which puts +Infinity on the top channel", () => {
    const g = flowJoGridScale({ kind: "flowjoChannels", channels: 256, axis: { kind: "biex", maxValue: 262144, pos: 4.418539922, neg: 0, widthBasis: -100, channelRange: 256 } });
    expect(g.eventCell(Infinity)).toBe(256);
    expect(transformFromSpec({ kind: "biex", ...p }).forward(Infinity)).toBe(256);
  });
});
