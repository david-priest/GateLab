// Plot titles on the Layout tab: templates, placeholders and the automatic choice.
// Synthetic names throughout; nothing here is a real experiment.

import { describe, expect, it } from "vitest";
import { automaticTitleTemplate, plotTitle, plotTitleContext, NO_TITLE } from "./layoutTitle";

const context = {
  population: "CD4_positive",
  file: "D1.fcs",
  sample: "D1",
  x: "CD4",
  y: "CD8",
  count: 12345,
  metadata: { day: "7", donor: "D1" },
  populationMetadata: { lineage: "T", well: "B3" },
};

describe("plotTitle", () => {
  it("fills every placeholder, the plot falling back to the channels", () => {
    expect(plotTitle("{population} · {file}", context)).toBe("CD4_positive · D1.fcs");
    expect(plotTitle("{sample} on {x} vs {y}", context)).toBe("D1 on CD4 vs CD8");
    expect(plotTitle("{plot}", context)).toBe("CD4 vs CD8");
    expect(plotTitle("{plot}", { ...context, plot: "B2M on CD19" })).toBe("B2M on CD19");
    expect(plotTitle("{plot}", { ...context, y: "" })).toBe("CD4");
    expect(plotTitle("{population} ({count})", context)).toBe("CD4_positive (12,345)");
    expect(plotTitle("day {meta:day} · {popmeta:lineage} cells", context)).toBe("day 7 · T cells");
  });

  it("drops an empty part with its separator, leaves an unknown placeholder, and knows no title", () => {
    expect(plotTitle("{population} · {meta:missing}", context)).toBe("CD4_positive");
    expect(plotTitle("{meta:missing} · {population} · {popmeta:none}", context)).toBe("CD4_positive");
    expect(plotTitle("{population} · {stain}", context)).toBe("CD4_positive · {stain}");
    expect(plotTitle(NO_TITLE, context)).toBe("");
    expect(plotTitle("  ", context)).toBe("");
  });
});

describe("automaticTitleTemplate", () => {
  it("names what differs: populations of one file, files of one population, both otherwise", () => {
    expect(automaticTitleTemplate([{ sampleId: "D1", populationId: "p1" }, { sampleId: "D1", populationId: "p2" }])).toBe("{population}");
    expect(automaticTitleTemplate([{ sampleId: "D1", populationId: "p1" }, { sampleId: "D2", populationId: "p1" }])).toBe("{file}");
    expect(automaticTitleTemplate([{ sampleId: "D1", populationId: "p1" }, { sampleId: "D2", populationId: "p2" }])).toBe("{population} · {file}");
    expect(automaticTitleTemplate([{ sampleId: "D1", populationId: "p1" }])).toBe("{population} · {file}");
    expect(automaticTitleTemplate([])).toBe("{population} · {file}");
    // A plot named where it came from keeps its name.
    expect(automaticTitleTemplate([{ sampleId: "D1", populationId: "p1", label: "B2M on CD19" }, { sampleId: "D1", populationId: "p2" }])).toBe("{population} · {plot}");
  });
});

describe("plotTitleContext", () => {
  it("reads the file, its display id and metadata, the population and its metadata, and the plot's own name", () => {
    const ctx = plotTitleContext(
      { xChannel: "CD4", yChannel: "CD8", label: "T cell gate" },
      { name: "D1", fileName: "D1.fcs", metadata: { day: "7" } },
      { id: "p1", name: "CD4_positive" },
      321,
      { p1: { lineage: "T" } },
    );
    expect(ctx).toEqual({ population: "CD4_positive", file: "D1.fcs", sample: "D1", x: "CD4", y: "CD8", plot: "T cell gate", count: 321, metadata: { day: "7" }, populationMetadata: { lineage: "T" } });
    expect(plotTitle("{plot} · {popmeta:lineage} · {count}", ctx)).toBe("T cell gate · T · 321");
    // A histogram has no y, and an unknown file or population reads as empty.
    expect(plotTitleContext({ xChannel: "CD4", yChannel: null }, null, null)).toEqual({ population: "", file: "", sample: "", x: "CD4", y: "" });
  });
});

describe("title builder", () => {
  it("offers the workspace's fields and round-trips a built template", async () => {
    const { titleFields, templateFromFields, fieldsFromTemplate } = await import("./layoutTitle");
    const fields = titleFields(["cell_type", "psi"], ["lineage"]);
    expect(fields.map((f) => f.token)).toEqual(["{population}", "{popmeta:lineage}", "{file}", "{sample}", "{meta:cell_type}", "{meta:psi}", "{plot}", "{x}", "{y}", "{count}"]);
    expect(fields.find((f) => f.token === "{meta:psi}")).toMatchObject({ label: "psi", group: "file" });
    const template = templateFromFields(["{meta:cell_type}", "{meta:psi}"], " · ");
    expect(template).toBe("{meta:cell_type} · {meta:psi}");
    expect(fieldsFromTemplate(template)).toEqual({ tokens: ["{meta:cell_type}", "{meta:psi}"], separator: " · " });
    expect(fieldsFromTemplate("{population}")).toEqual({ tokens: ["{population}"], separator: " · " });
    // A template with words of its own, or mixed separators, is not the builder's to show.
    expect(fieldsFromTemplate("day {meta:day}")).toBeNull();
    expect(fieldsFromTemplate("{a} · {b}, {c}")).toBeNull();
    expect(fieldsFromTemplate("")).toBeNull();
  });
});
