// @vitest-environment jsdom
// The embed entry point, which GateLabR bundles, offers the Gating-ML importer the app runs, so a
// host can import a file through it. Driven here on the public BCR-XL example's standard Gating-ML
// export: the populations it builds gate a public file to the example's published counts.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as embed from "./embed";
import { parseFcs } from "./engine/fcs";
import { Sample } from "./engine/sample";
import { recomputeGating, type CoreState } from "./store";
import { BCRXL_GATINGML, bcrxlAvailable, fcsPath } from "./host/bcrxlSceFixture";

describe("embed entry point", () => {
  it("exports the Gating-ML importer", () => {
    expect(typeof embed.importGatingML).toBe("function");
  });

  it.runIf(bcrxlAvailable())("imports the public BCR-XL Gating-ML to the published counts", () => {
    const bytes = readFileSync(fcsPath("PBMC8_30min_patient1_BCR-XL"));
    const sample = new Sample(parseFcs(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer));
    const pnn: Record<string, string> = {};
    for (const channel of sample.channels) pnn[channel.pnn] = channel.key;

    const imported = embed.importGatingML(
      readFileSync(BCRXL_GATINGML, "utf8"), sample.channels.map((c) => c.key), pnn, sample.instrument);
    expect(imported.n_gates_skipped).toBe(0);
    const gating = recomputeGating(sample, {
      gates: imported.gates, gate_order: imported.gate_order, populations: imported.populations,
      root_population_id: imported.root_population_id,
    } as unknown as CoreState);
    const counts = Object.fromEntries(Object.entries(imported.populations)
      .map(([id, population]) => [population.name, gating.stats.event_count[id]]));
    // PUBLIC - Screenshot Safe/manifest-and-validation.json, cytof, PBMC8_30min_patient1_BCR-XL.fcs.
    expect(counts).toEqual({
      "All Events": 2838, "B cells": 130, "T cells": 1995, "NK cells": 400, "Monocytes": 108,
      "Dendritic cells": 8, "IgM+ B cells": 97, "IgM- B cells": 33, "pS6+ B cells": 115,
      "CD4 T cells": 737, "CD8 T cells": 1258,
    });
  });
});
