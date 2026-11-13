import { describe, expect, it } from "vitest";
import { defaultBiexParams } from "./biex";
import type { TransformSpec } from "./models";
import { parsePolygonRecord } from "./polygonRecord";
import { parseRectangleRecord } from "./rectangleRecord";
import { transformFromSpec } from "./sample";

describe("a gate record on a biex axis evaluated on cytolib's spline", () => {
  it("is read back on the spline, not on FlowJo's table", () => {
    const spec = { kind: "biex", ...defaultBiexParams(262144)!, spline: true } as TransformSpec;
    const polygon = parsePolygonRecord(JSON.parse(JSON.stringify({ space: "display", transforms: { x: spec, y: spec }, vertices: [[0, 0], [100, 0], [100, 100]], written: [] })))!;
    const rectangle = parseRectangleRecord({ bounds: "closed", space: "display", transforms: { x: spec, y: spec }, x: [0, 1], y: [0, 1] })!;
    expect(polygon.transforms!.x).toEqual(spec);
    expect(rectangle.transforms!.x).toEqual(spec);
    // The two tables differ, so a record read without the flag places an event elsewhere.
    const { spline: _spline, ...onTable } = spec as TransformSpec & { spline?: boolean };
    const written = transformFromSpec(spec).forward(261906);
    expect(transformFromSpec(polygon.transforms!.x).forward(261906)).toBe(written);
    expect(transformFromSpec(onTable as TransformSpec).forward(261906)).not.toBe(written);
  });
});
