import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Path } from "flatten-svg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { preparePaths, replan, replanGreedy } from "../massager.js";
import { defaultPlanOptions, type PlanOptions } from "../planning.js";
import { optimizePaths } from "../routing.js";
import { kernelBase64, kernelSourceHash } from "../routing-wasm.js";
import type { Vec2 } from "../vec.js";

const options: PlanOptions = { ...defaultPlanOptions, fitPage: false, cropToMargins: false, layerMode: "all" };
const marks: Vec2[][] = Array.from({ length: 120 }, (_, i) => {
  const x = 10 + ((i * 97) % 241);
  const y = 10 + ((i * 53) % 173);
  return [
    { x, y },
    { x: x + 0.2, y },
    { x: x + 1, y: y + 1 },
  ];
});
const input: Path[] = [...marks, ...marks.slice(0, 2)].map((points, i) => ({
  points: points.map(({ x, y }) => ({ x: (x * 96) / 25.4, y: (y * 96) / 25.4 })),
  groupId: i % 2 ? "odd" : "even",
  stroke: i % 2 ? "red" : "black",
}));

// Independent geometry and contact check; includes duplicate strokes.
function audit(configured: Vec2[][], routed: Vec2[][], clearance: number) {
  const remaining = configured.map((path, id) => ({ path, id }));
  const order = routed.map((path) => {
    const index = remaining.findIndex((candidate) => candidate.path === path);
    expect(index).toBeGreaterThanOrEqual(0);
    return remaining.splice(index, 1)[0].id;
  });
  expect(remaining).toHaveLength(0);
  const boxes = configured.map((path) => [
    Math.min(...path.map((p) => p.x)),
    Math.min(...path.map((p) => p.y)),
    Math.max(...path.map((p) => p.x)),
    Math.max(...path.map((p) => p.y)),
  ]);
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      if (a[0] <= b[2] + clearance && b[0] <= a[2] + clearance && a[1] <= b[3] + clearance && b[1] <= a[3] + clearance)
        expect(order.indexOf(i)).toBeLessThan(order.indexOf(j));
    }
}

beforeEach(() => {
  vi.spyOn(console, "time").mockImplementation(() => {});
  vi.spyOn(console, "timeEnd").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("production SIMD routing", () => {
  it("ships a valid kernel matching its C source", () => {
    const source = readFileSync(new URL("../routing-kernel.c", import.meta.url));
    expect(createHash("sha256").update(source).digest("hex")).toBe(kernelSourceHash);
    expect(WebAssembly.validate(Buffer.from(kernelBase64, "base64"))).toBe(true);
  });

  it("improves the route without changing or mutating directed strokes", async () => {
    const snapshot = structuredClone(marks);
    const result = await optimizePaths(marks, options, performance.now() + 5000);
    expect(result).not.toEqual(marks);
    audit(marks, result, 0.5);
    expect(marks).toEqual(snapshot);
  });

  it("bypasses disabled sorting, expired budgets, tiny jobs, and oversized jobs", async () => {
    const compile = vi.spyOn(WebAssembly, "compile");
    for (const paths of [[], marks.slice(0, 2), Array.from({ length: 6001 }, () => marks[0])])
      expect(await optimizePaths(paths, options, Infinity)).toBe(paths);
    expect(await optimizePaths(marks, { ...options, sortPaths: false }, Infinity)).toBe(marks);
    expect(await optimizePaths(marks, options, performance.now() - 1)).toBe(marks);
    expect(compile).not.toHaveBeenCalled();
    const unsorted = { ...options, sortPaths: false };
    expect((await replan(input, unsorted)).serialize()).toEqual(replanGreedy(input, unsorted).serialize());
  });

  it("preserves every contact when all strokes overlap", async () => {
    const paths = Array.from({ length: 40 }, () => marks[0].map((p) => ({ ...p })));
    expect(await optimizePaths(paths, options, Infinity)).toBe(paths);
  });

  it.each([0.01, 1, 10])("returns a valid incumbent when the deadline expires mid-search (%s)", async (step) => {
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => (clock += step));
    const result = await optimizePaths(marks, options, 50);
    audit(marks, result, 0.5);
    expect(clock).toBeLessThan(100);
  });

  it("rejects nonfinite coordinates and invalid motion profiles before entering Wasm", async () => {
    await expect(optimizePaths([[{ x: NaN, y: 0 }], ...marks], options, Infinity)).rejects.toThrow("coordinate");
    await expect(optimizePaths(marks, { ...options, penUpAcceleration: 0 }, Infinity)).rejects.toThrow("profile");
    await expect(optimizePaths(marks, { ...options, penHome: { x: Infinity, y: 0 } }, Infinity)).rejects.toThrow(
      "home",
    );
  });

  it.each([
    {},
    { pointJoinRadius: 0.5, pathJoinRadius: 2, minimumPathLength: 0.5 },
    { pointJoinRadius: 0, pathJoinRadius: 0, minimumPathLength: 0 },
    { minimumPathLength: 1000 },
    { fitPage: true, rotateDrawing: 90, marginMm: 10 },
    { cropToMargins: true, layerMode: "group", selectedGroupLayers: new Set(["even"]), marginMm: 25 },
    { fitPage: true, layerMode: "stroke", selectedStrokeLayers: new Set(["red"]) },
    { layerMode: "stroke", selectedStrokeLayers: new Set(["missing"]) },
    { hardware: "nextdraw-2234", penHome: { x: 100, y: 120 }, penUpMaxVelocity: 80, penUpAcceleration: 150 },
    { hardware: "idraw-h-se", penDropDuration: 0.3, penLiftDuration: 0.25, penDownCorneringFactor: 0 },
  ] as Partial<PlanOptions>[])("keeps settings and physical motions intact: %j", async (settings) => {
    const selected = { ...options, ...settings };
    const snapshot = structuredClone(input);
    const configured = preparePaths(input, selected);
    const routed = await optimizePaths(configured, selected, performance.now() + 5000);
    audit(configured, routed, Math.max(0.5, selected.pointJoinRadius, selected.pathJoinRadius));
    const baseline = replanGreedy(input, selected);
    const result = await replan(input, selected);
    const expected = baseline.serialize();
    const actual = result.serialize();
    expect(actual).toHaveLength(expected.length);
    const contacts = (motions: typeof actual) =>
      Array.from({ length: (motions.length - 1) / 4 }, (_, i) =>
        JSON.stringify(motions.slice(4 * i + 1, 4 * i + 4)),
      ).sort();
    expect(contacts(actual)).toEqual(contacts(expected));
    expect(result.duration()).toBeLessThanOrEqual(baseline.duration());
    if (result.duration() !== baseline.duration()) expect(baseline.duration() - result.duration()).toBeGreaterThan(5);
    expect(input).toEqual(snapshot);
  });

  it("caches compiled code and falls back to the identical incumbent if SIMD cannot load", async () => {
    vi.resetModules();
    const fresh = await import("../routing.js");
    const compile = vi.spyOn(WebAssembly, "compile");
    await fresh.optimizePaths(marks, options, Infinity);
    await fresh.optimizePaths(marks, options, Infinity);
    expect(compile).toHaveBeenCalledTimes(1);
    vi.resetModules();
    compile.mockRejectedValue(new WebAssembly.CompileError("SIMD disabled"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fallback = await import("../massager.js");
    expect((await fallback.replan(input, options)).serialize()).toEqual(
      fallback.replanGreedy(input, options).serialize(),
    );
    expect(warn).toHaveBeenCalledOnce();
  });
});
