import { describe, expect, it } from "vitest";
import {
  parsePanelImport,
  serializePanelTemplate,
  type PanelTableChannel,
} from "./panelTable";

const channels: PanelTableChannel[] = [
  { key: "FSC-A", pnn: "FSC-A", marker: null, label: "FSC-A", renamable: false },
  { key: "CD3 (Blue 1-A)", pnn: "Blue 1-A", marker: "CD3", label: "CD3 (Blue 1-A)", renamable: true },
  { key: "CD19", pnn: "Red 2-A", marker: "CD19", label: "B cell, marker", renamable: true },
];

describe("panel CSV/TSV bulk editing", () => {
  it("exports an Excel-friendly template with immutable identifiers and current labels", () => {
    const text = serializePanelTemplate(channels);
    expect(text.startsWith("\uFEFFchannel_pnn,marker_pns,display_name,channel_key,editable\r\n")).toBe(true);
    expect(text).toContain('Red 2-A,CD19,"B cell, marker",CD19,yes');
    expect(text).toContain("FSC-A,,FSC-A,FSC-A,no");
  });

  it("previews changed, reset, locked, unknown, and omitted rows without mutating channels", () => {
    const text = [
      "channel_pnn\tdisplay_name\tchannel_key",
      "FSC-A\tForward scatter\tFSC-A",
      "Blue 1-A\tT cells\tCD3 (Blue 1-A)",
      "Red 2-A\t\tCD19",
      "Missing-A\tUnknown\tMissing",
    ].join("\n");
    const preview = parsePanelImport(text, [...channels, {
      key: "CD4", pnn: "Violet 1-A", marker: "CD4", label: "CD4", renamable: true,
    }]);

    expect(preview.changes).toEqual([
      { key: "CD3 (Blue 1-A)", label: "T cells", previousLabel: "CD3 (Blue 1-A)" },
      { key: "CD19", label: "", previousLabel: "B cell, marker" },
    ]);
    expect(preview.lockedIgnoredCount).toBe(1);
    expect(preview.unknownIdentifiers).toEqual(["Missing"]);
    expect(preview.omittedCount).toBe(1);
    expect(channels[2].label).toBe("B cell, marker");
  });

  it("falls back to a unique $PnN when the optional GateLab key is absent", () => {
    const preview = parsePanelImport(
      "Channel ($PnN),Display name\r\nBlue 1-A,CD3 T cells\r\n",
      channels,
    );
    expect(preview.changes).toEqual([
      { key: "CD3 (Blue 1-A)", label: "CD3 T cells", previousLabel: "CD3 (Blue 1-A)" },
    ]);
  });

  it("rejects ambiguous or malformed uploads before any change can be applied", () => {
    expect(() => parsePanelImport("channel_key,marker\nCD19,B cells\n", channels))
      .toThrow("display_name");
    expect(() => parsePanelImport(
      "channel_key,display_name\nCD19,B cells\nCD19,B lymphocytes\n",
      channels,
    )).toThrow("duplicate rows");
    expect(() => parsePanelImport("channel_key,display_name\n\"CD19,B cells\n", channels))
      .toThrow("unterminated quoted field");
  });
});
