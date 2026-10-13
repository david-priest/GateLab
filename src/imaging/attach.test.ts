import { describe, expect, it } from "vitest";
import { attachCellImages, ImageAttachError } from "./attach";
import { buildSyntheticCvw } from "./cvwFixture";
import { imageRecordOf } from "./imageSource";
import { imageHandleKey } from "../engine/sidecarNames";
import { memoryFile } from "../testDirectory";

const bytes = buildSyntheticCvw([{ samples: 256 }, { noWaveform: true }, { samples: 256 }], { recordingId: "rec-1" });

describe("attachCellImages", () => {
  it("describes the file for a sample with the same event count", async () => {
    const keywords = {
      BD_IMAGEWALL_SETTINGS: JSON.stringify({ ChannelSettings: [{ ChannelNumber: 3, Enabled: false, Color: 255 }] }),
      BDFIRESETTINGS: JSON.stringify({ ImagingMaskSettings: { MaskConfiguration: [{ Threshold: 8192, InputChannelId: 4, MaskId: "A" }] } }),
    };
    const source = await attachCellImages(memoryFile("tube A.cvw", bytes), null, { nEvents: 3, keywords }, "Tubes/tube A.cvw");
    expect(source.kind).toBe("cvw");
    expect(source.fileName).toBe("tube A.cvw");
    expect(source.eventCount).toBe(3);
    expect(source.recordingId).toBe("rec-1");
    expect(source.channelNames.get(3)).toBe("FSC");
    expect(source.pixelAspectRatio).toBe(0.3);
    expect(source.display.find((d) => d.slot === 3)).toMatchObject({ enabled: false, colour: "#ff0000" });
    expect(source.mask).toEqual({ slot: 4, fraction: 8192 / 65535 });
    expect(source.sourcePath).toBe("Tubes/tube A.cvw");
    expect(imageRecordOf(source)).toEqual({ kind: "cvw", fileName: "tube A.cvw", eventCount: 3, recordingId: "rec-1" });
    expect(imageHandleKey("cvw", "tube A.fcs")).toBe("cvw:tube A.fcs");
  });

  it("refuses a file whose event count is not the sample's", async () => {
    await expect(attachCellImages(memoryFile("tube A.cvw", bytes), null, { nEvents: 4, keywords: {} }))
      .rejects.toThrow(/holds 3 events but the FCS has 4/);
  });

  it("refuses a file that is not a waveform file, naming it", async () => {
    const error = await attachCellImages(memoryFile("notes.cvw", new TextEncoder().encode("hello")), null, { nEvents: 3, keywords: {} })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ImageAttachError);
    expect((error as Error).message).toMatch(/^notes\.cvw: /);
  });
});
