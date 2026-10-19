import { flattenSVG } from "flatten-svg";
import { createSVGWindow } from "svgdom";
import { describe, expect, it } from "vitest";
import { parsePaperSize, parseSvg } from "../cli.js";
import { preparePaths, replan } from "../massager.js";
import { AxidrawBrushlessFast, defaultPlanOptions, PenMotion, Plan, plan, XYMotion } from "../planning.js";
import { sanitizeSvg } from "../svg.js";
import { cropToMargins, dedupPoints } from "../util.js";
import { PaperSize } from "../paper-size.js";

const line = [
  {
    points: [
      { x: 10, y: 10 },
      { x: 20, y: 20 },
    ],
    stroke: "black",
    groupId: "layer",
  },
];
const options = { ...defaultPlanOptions, layerMode: "all" as const, sortPaths: false };

describe("SVG and CLI input", () => {
  it("removes active SVG/HTML, event handlers, links, CSS, and external resources", () => {
    const window = createSVGWindow();
    const svg = parseSvg(`<svg xmlns="http://www.w3.org/2000/svg" onload="attack()" viewBox="0 0 100 100">
      <script>attack()</script><foreignObject><img src="https://example.invalid" onerror="attack()" /></foreignObject>
      <style>body{display:none}</style><image href="https://example.invalid"/>
      <g id="layer" transform="translate(1,2)"><path d="M0 0 L10 10" style="stroke:red;background:url(https://example.invalid)" onclick="attack()"/>
      <a href="javascript:attack()"><circle r="2"/></a></g></svg>`);
    const clean = sanitizeSvg(svg, window.document);
    expect(clean.querySelector("script,foreignObject,style,image")).toBeNull();
    expect(clean.getAttribute("onload")).toBeNull();
    expect(clean.getAttribute("viewBox")).toBe("0 0 100 100");
    expect(clean.querySelector("path")?.getAttribute("stroke")).toBe("red");
    expect(clean.querySelector("path")?.getAttribute("style")).toBeNull();
    expect(clean.querySelector("path")?.getAttribute("onclick")).toBeNull();
    expect(clean.querySelector("a")?.getAttribute("href")).toBeNull();
    expect(clean.querySelector("g")?.getAttribute("transform")).toBe("translate(1,2)");
  });

  it("parses an SVG into a usable motion plan", async () => {
    const paths = flattenSVG(
      parseSvg('<svg xmlns="http://www.w3.org/2000/svg"><path d="M10 10 L20 20" stroke="black"/></svg>'),
    );
    expect(paths).toHaveLength(1);
    expect(Number.isFinite((await replan(paths, options)).duration())).toBe(true);
    expect(() => parseSvg("not an SVG")).toThrow();
  });

  it.each(["url(https://example.invalid)", String.raw`u\72l(https://example.invalid)`, "var(--remote-paint)"])(
    "drops resource-bearing paint %s",
    (paint) => {
      const window = createSVGWindow();
      const svg = parseSvg(
        `<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L1 1" stroke="${paint}" fill="${paint}"/></svg>`,
      );
      const clean = sanitizeSvg(svg, window.document).querySelector("path");
      expect(clean?.getAttribute("stroke")).toBeNull();
      expect(clean?.getAttribute("fill")).toBeNull();
    },
  );

  it.each([
    ["16x10in", 406.4, 254],
    ["20x30cm", 200, 300],
    ["100x100MM", 100, 100],
  ])("converts %s to millimetres", (input, x, y) => {
    const size = parsePaperSize(String(input)).size;
    expect(size.x).toBeCloseTo(Number(x));
    expect(size.y).toBeCloseTo(Number(y));
  });
  it.each(["0x1mm", "x10mm", "-1x2cm", "10x20px"])("rejects invalid paper size %s", (size) => {
    expect(() => parsePaperSize(size)).toThrow();
  });
});

describe("plan validation and geometry", () => {
  it.each(["penUpAcceleration", "penDownAcceleration", "penUpMaxVelocity", "penDownMaxVelocity"])(
    "rejects zero %s before planning",
    (field) => {
      expect(() => preparePaths(line, { ...options, [field]: 0 })).toThrow("positive");
    },
  );

  it("preserves in-bounds dots and empty deduplication", () => {
    expect(cropToMargins([[{ x: 50, y: 50 }], [{ x: 101, y: 50 }]], new PaperSize({ x: 100, y: 100 }), 5)).toEqual([
      [{ x: 50, y: 50 }],
    ]);
    expect(dedupPoints([], 0.1)).toEqual([]);
    expect(
      dedupPoints(
        [
          { x: 0, y: 0 },
          { x: 0, y: 0 },
          { x: 2, y: 0 },
        ],
        0.1,
      ),
    ).toHaveLength(2);
  });

  it.each([
    {},
    [null],
    [{ type: "unknown" }],
    [{ type: "pen", initialPos: 9000, finalPos: 8000, duration: -1 }],
    [{ type: "pen", initialPos: NaN, finalPos: 8000, duration: 1 }],
    [{ type: "xy", length: 20, cols: [], ts: [], ss: [] }],
  ])("rejects malformed motion data %#", (input) => {
    expect(() => Plan.deserialize(input)).toThrow();
  });

  it("round-trips a plan over JSON without losing buffers or pen motions", () => {
    const original = plan([line[0].points], AxidrawBrushlessFast);
    const restored = Plan.deserialize(JSON.parse(JSON.stringify(original.serialize())));
    expect(restored.duration()).toBeCloseTo(original.duration(), 10);
    expect(restored.serialize()).toEqual(original.serialize());
    expect(restored.motions[0]).toBeInstanceOf(XYMotion);
    expect(restored.motions[1]).toBeInstanceOf(PenMotion);
    expect(Plan.deserialize([]).duration()).toBe(0);
  });
});
