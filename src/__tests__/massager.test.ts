import type { Path } from "flatten-svg";
import { describe, expect, it } from "vitest";
import { preparePaths, replan } from "../massager.js";
import { PaperSize } from "../paper-size.js";
import { defaultPlanOptions, type PlanOptions } from "../planning.js";

const options: PlanOptions = {
  ...defaultPlanOptions,
  paperSize: new PaperSize({ x: 100, y: 100 }),
  marginMm: 5,
  fitPage: false,
  sortPaths: false,
  pathJoinRadius: 0,
  layerMode: "all",
};
const path = (points: number[][], groupId = "keep", stroke = "black"): Path => ({
  points: points.map(([x, y]) => ({ x: (x * 96) / 25.4, y: (y * 96) / 25.4 })),
  groupId,
  stroke,
});

describe("drawing settings", () => {
  it.each(["group", "stroke"] as const)("keeps %s selection attached when clipping splits paths", (layerMode) => {
    const input = [
      path(
        [
          [200, 10],
          [210, 10],
        ],
        "drop",
        "red",
      ),
      path([
        [20, 20],
        [200, 20],
        [20, 40],
      ]),
    ];
    const result = preparePaths(input, {
      ...options,
      layerMode,
      selectedGroupLayers: new Set(["keep"]),
      selectedStrokeLayers: new Set(["black"]),
    });
    expect(result).toHaveLength(2);
    expect(result[0][0].x).toBeCloseTo(20);
    expect(result[0].at(-1)?.x).toBeCloseTo(95);
    expect(result[1].at(-1)?.y).toBeCloseTo(40);
  });

  it("fits a drawing consisting of a single location without NaN coordinates", async () => {
    const input = [path([[20, 30]])];
    const fitted = preparePaths(input, { ...options, fitPage: true });
    expect(fitted).toEqual([[{ x: 50, y: 50 }]]);
    expect(Number.isFinite((await replan(input, { ...options, fitPage: true })).duration())).toBe(true);
  });

  it("applies minimum length after point simplification and before path joining", () => {
    const input = [
      path([
        [20, 20],
        [20.2, 20],
      ]),
      path([
        [20.2, 20],
        [20.4, 20],
      ]),
    ];
    expect(
      preparePaths(input, { ...options, cropToMargins: false, pathJoinRadius: 0.5, minimumPathLength: 0.3 }),
    ).toEqual([]);
    expect(
      preparePaths(input, { ...options, cropToMargins: false, pointJoinRadius: 0.5, minimumPathLength: 0.01 }),
    ).toEqual([]);
  });

  it("keeps coincident paths separate when joining is disabled", () => {
    const input = [
      path([
        [10, 10],
        [20, 10],
      ]),
      path([
        [20, 10],
        [30, 10],
      ]),
    ];
    expect(preparePaths(input, options)).toHaveLength(2);
    expect(preparePaths(input, { ...options, pathJoinRadius: 0.1 })).toHaveLength(1);
  });

  it("fits using all layers before selecting one", () => {
    const input = [
      path([
        [0, 0],
        [10, 10],
      ]),
      path(
        [
          [90, 90],
          [100, 100],
        ],
        "drop",
      ),
    ];
    const fitted = preparePaths(input, {
      ...options,
      fitPage: true,
      layerMode: "group",
      selectedGroupLayers: new Set(["keep"]),
    });
    expect(fitted).toHaveLength(1);
    expect(fitted[0][0].x).toBeCloseTo(5);
    expect(fitted[0][1].x).toBeCloseTo(14);
  });
});
