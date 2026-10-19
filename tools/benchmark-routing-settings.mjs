// Offline settings compatibility evaluation; never connects to a plotter.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { cpus } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { merge } from "optimize-paths";
import { cases, difference, multiStart, route, traversalPortfolio } from "./benchmark-physical-routing.mjs";
import { drawing, relocate, segmentSignature, validate } from "./benchmark-routing.mjs";
import {
  eulerTrails,
  joinExactAdjacent,
  measure,
  motionPlan,
  movementCost,
  optimizeStates,
} from "./physical-routing.mjs";

const compiled = await build({
  stdin: {
    contents:
      'export {preparePaths,replanGreedy as replan} from "./massager.ts"; export {defaultPlanOptions,Device} from "./planning.ts"; export {PaperSize} from "./paper-size.ts"; export {dedupPoints} from "./util.ts";',
    resolveDir: fileURLToPath(new URL("../src/", import.meta.url)),
    loader: "ts",
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
});
const { preparePaths, replan, defaultPlanOptions, Device, PaperSize, dedupPoints } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`
);

function quiet(operation) {
  const time = console.time;
  const timeEnd = console.timeEnd;
  console.time = console.timeEnd = () => {};
  try {
    return operation();
  } finally {
    console.time = time;
    console.timeEnd = timeEnd;
  }
}

// Coordinates remain in mm; the profile carries Saxi's device units and chosen home.
function tooling(options) {
  const device = Device(options.hardware);
  const s = device.stepsPerMm;
  for (const name of ["penUpAcceleration", "penUpMaxVelocity", "penDownAcceleration", "penDownMaxVelocity"])
    assert(Number.isFinite(options[name]) && options[name] > 0, `${name} must be finite and positive`);
  for (const name of [
    "pointJoinRadius",
    "pathJoinRadius",
    "minimumPathLength",
    "penDownCorneringFactor",
    "penDropDuration",
    "penLiftDuration",
  ])
    assert(Number.isFinite(options[name]) && options[name] >= 0, `${name} must be finite and nonnegative`);
  assert(Number.isFinite(options.penHome.x) && Number.isFinite(options.penHome.y));
  return {
    stepsPerMm: s,
    penHome: options.penHome,
    penUpPos: device.penPctToPos(options.penUpHeight),
    penDownPos: device.penPctToPos(options.penDownHeight),
    penUpProfile: {
      acceleration: options.penUpAcceleration * s,
      maximumVelocity: options.penUpMaxVelocity * s,
      corneringFactor: 0,
    },
    penDownProfile: {
      acceleration: options.penDownAcceleration * s,
      maximumVelocity: options.penDownMaxVelocity * s,
      corneringFactor: options.penDownCorneringFactor * s,
    },
    penDropDuration: options.penDropDuration,
    penLiftDuration: options.penLiftDuration,
  };
}

export function evaluateSettings(input, options, placement = "after-join") {
  assert(["after-join", "before-join"].includes(placement));
  const before = JSON.stringify(input);
  const profile = tooling(options);
  // Before-join candidates receive the same point/length filtering; apply their
  // configured tolerance join once, after routing. After-join candidates keep it fixed.
  const configured = quiet(() => preparePaths(input, options));
  const prepared =
    placement === "after-join" ? configured : quiet(() => preparePaths(input, { ...options, pathJoinRadius: 0 }));
  validate(prepared);
  const production = quiet(() => replan(input, options));
  assert.deepEqual(motionPlan(configured, profile).serialize(), production.serialize(), "Profile/home/unit mismatch");
  const ink = segmentSignature(prepared);
  const join = options.pathJoinRadius > 0;
  const finish = (paths) => (join ? joinExactAdjacent(paths) : paths);
  const variants = [];
  const pathsByName = new Map();
  const run = (name, operation, enabled = true) => {
    const start = performance.now();
    const routed = enabled && options.sortPaths ? operation() : prepared;
    assert.deepEqual(segmentSignature(routed), ink, `${name}: changed geometry before tolerance joining`);
    const paths = placement === "before-join" && join ? merge(routed, options.pathJoinRadius) : routed;
    const computeMs = performance.now() - start;
    validate(paths);
    const change = difference(configured, paths);
    if (placement === "after-join") assert(change.exactSegmentCoverage, `${name}: changed configured geometry`);
    if (name === "current" || !options.sortPaths) assert.deepEqual(paths, configured);
    if (!join) assert.equal(paths.length, prepared.length, `${name}: joined despite zero radius`);
    const metrics = measure(paths, profile);
    assert(Object.values(metrics).every(Number.isFinite));
    const plan = motionPlan(paths, profile);
    assert(Math.abs(metrics.totalSeconds - plan.duration()) < 1e-7);
    const homeSteps = { x: profile.penHome.x * profile.stepsPerMm, y: profile.penHome.y * profile.stepsPerMm };
    assert.deepEqual(plan.motions[0].p1, homeSteps);
    assert.deepEqual(plan.motions.at(-1).p2, homeSteps);
    variants.push({
      name,
      enabled: name === "current" || (enabled && options.sortPaths),
      computeMs,
      ...change,
      ...metrics,
    });
    pathsByName.set(name, paths);
    return routed;
  };
  run("current", () => prepared);
  const twoOpt = run("2opt", () => route(prepared, profile, false, join));
  run("relocate", () => finish(relocate(twoOpt, movementCost(profile), profile.penHome).paths));
  run("joint-states", () => route(prepared, profile, true, join));
  run("iterated-search", () => multiStart(prepared, profile, join));
  run("euler", () => route(eulerTrails(prepared).paths, profile, false, join), join);
  run("smooth-euler", () => route(eulerTrails(prepared, true).paths, profile, true, join), join);
  run("traversal-portfolio", () => traversalPortfolio(prepared, profile), join);
  const fastest = Math.min(...variants.filter((v) => v.enabled && v.exactSegmentCoverage).map((v) => v.totalSeconds));
  // Spend up to 1% versus the fastest on fewer lifts, but never exceed the baseline.
  const selected = variants
    .filter(
      (v) =>
        v.enabled &&
        v.exactSegmentCoverage &&
        v.totalSeconds <= fastest * 1.01 + 1e-8 &&
        v.totalSeconds <= variants[0].totalSeconds + 1e-8,
    )
    .sort((a, b) => a.strokes - b.strokes || a.totalSeconds - b.totalSeconds)[0];
  assert.equal(JSON.stringify(input), before, "Mutated source paths");
  return { prepared, paths: pathsByName.get(selected.name), selected: selected.name, variants };
}

const point = (x, y) => ({ x, y });
const toSVG = (paths) =>
  paths.map((p, i) => ({
    points: p.map(({ x, y }) => ({ x: x / (25.4 / 96), y: y / (25.4 / 96) })),
    stroke: i % 2 ? "red" : "black",
    groupId: i % 2 ? "odd" : "even",
  }));
const base = { ...defaultPlanOptions, layerMode: "all", fitPage: false, cropToMargins: false };

export { base, preparePaths, quiet, replan, tooling, toSVG };

function selfCheck() {
  const touching = toSVG([
    [point(10, 10), point(20, 10)],
    [point(20, 10), point(30, 10)],
  ]);
  const disabled = evaluateSettings(touching, { ...base, pathJoinRadius: 0 });
  assert(disabled.variants.every((v) => v.strokes === 2));
  assert(
    disabled.variants
      .filter((v) => v.name.includes("euler") || v.name === "traversal-portfolio")
      .every((v) => !v.enabled),
  );
  const tiny = toSVG([
    [point(10, 10), point(10.2, 10)],
    [point(10.2, 10), point(10.4, 10)],
  ]);
  assert.equal(evaluateSettings(tiny, { ...base, minimumPathLength: 0.3 }).prepared.length, 0);
  assert.equal(evaluateSettings(tiny, { ...base, pointJoinRadius: 0.5, minimumPathLength: 0.01 }).prepared.length, 0);
  const input = toSVG(drawing("strokes", 8, 17));
  const locked = evaluateSettings(input, { ...base, sortPaths: false, pathJoinRadius: 2, pointJoinRadius: 0.25 });
  assert(locked.variants.every((v) => v.totalSeconds === locked.variants[0].totalSeconds));
  for (const radius of [0.1, 0.5, 2]) {
    for (const delta of [-1e-7, 0, 1e-7]) {
      const paths = [
        [point(0, 0), point(10, 0)],
        [point(10 + radius + delta, 0), point(20, 0)],
      ];
      // Check the inclusive mathematical boundary directly in the installed joiner.
      const gap = paths[1][0].x - paths[0][1].x;
      assert.equal(merge(paths, radius).length, gap * gap <= radius * radius ? 1 : 2);
      const result = evaluateSettings(toSVG(paths), { ...base, sortPaths: false, pathJoinRadius: radius });
      const actual = toSVG(paths).map((p) => p.points.map((p) => point(p.x * (25.4 / 96), p.y * (25.4 / 96))));
      assert.deepEqual(result.prepared, merge(actual, radius));
    }
  }
  for (const epsilon of [0.125, 0.5]) {
    const result = dedupPoints([point(0, 0), point(epsilon, 0), point(2 * epsilon, 0)], epsilon);
    assert.deepEqual(result, [point(0, 0), point(2 * epsilon, 0)]);
  }
  const oneLine = toSVG([[point(10, 10), point(12, 10)]]);
  const line = quiet(() => preparePaths(oneLine, { ...base, pathJoinRadius: 0 }))[0];
  const length = Math.hypot(line[1].x - line[0].x, line[1].y - line[0].y);
  assert.equal(evaluateSettings(oneLine, { ...base, minimumPathLength: length }).prepared.length, 1);
  assert.equal(evaluateSettings(oneLine, { ...base, minimumPathLength: length + 1e-7 }).prepared.length, 0);
  for (const home of [point(0, 0), point(280, 190)]) {
    const profile = tooling({
      ...base,
      penHome: home,
      penDownMaxVelocity: 20,
      penUpMaxVelocity: 70,
      penUpAcceleration: 150,
    });
    const paths = drawing("strokes", 6, 42);
    let exact = Infinity;
    for (let mask = 0; mask < 64; mask++)
      exact = Math.min(
        exact,
        measure(
          paths.map((p, i) => ((mask >> i) & 1 ? p.slice().reverse() : p)),
          profile,
        ).totalSeconds,
      );
    assert(Math.abs(measure(optimizeStates(paths, profile), profile).totalSeconds - exact) < 1e-7);
  }
  assert.throws(() => evaluateSettings(input, { ...base, penUpMaxVelocity: 0 }), /positive/);
  assert.throws(() => evaluateSettings(input, { ...base, pathJoinRadius: -1 }), /nonnegative/);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  selfCheck();
  const fixtures = ["strokes", "clusters", "hatching", "contours", "fragments", "dots"].map((kind) => ({
    name: `${kind}-60`,
    paths: drawing(kind, 60, 17),
  }));
  fixtures.push(
    ...cases.filter((c) =>
      ["necklace-17", "grid-17", "microdetails", "deliberate-gaps", "repeated-dots", "already-straight-grid"].includes(
        c.name,
      ),
    ),
  );
  fixtures.push(
    { name: "empty", paths: [] },
    { name: "collapsed-loop", paths: [[point(20, 20), point(20.1, 20), point(20.1, 20.1), point(20, 20)]] },
  );
  const matrix = [];
  for (const pointJoinRadius of [0, 0.1, 0.25, 0.5])
    for (const pathJoinRadius of [0, 0.1, 0.5, 1, 2])
      for (const minimumPathLength of [0, 0.1, 0.5, 2])
        matrix.push({ name: "radius-matrix", values: { pointJoinRadius, pathJoinRadius, minimumPathLength } });
  const scenarios = [
    {
      name: "sorting-off",
      values: { sortPaths: false, pointJoinRadius: 0.25, pathJoinRadius: 1, minimumPathLength: 0.1 },
    },
    {
      name: "precision",
      values: {
        penDownMaxVelocity: 15,
        penDownAcceleration: 75,
        penDownCorneringFactor: 0.02,
        penUpMaxVelocity: 80,
        penUpAcceleration: 150,
        penLiftDuration: 0.3,
        penDropDuration: 0.25,
        pointJoinRadius: 0.1,
        pathJoinRadius: 0.1,
        minimumPathLength: 0.1,
      },
    },
    {
      name: "fast",
      values: {
        penDownMaxVelocity: 100,
        penDownAcceleration: 400,
        penDownCorneringFactor: 0.5,
        penUpMaxVelocity: 250,
        penUpAcceleration: 800,
        penLiftDuration: 0.06,
        penDropDuration: 0.06,
        pointJoinRadius: 0.25,
        pathJoinRadius: 1,
        minimumPathLength: 0.5,
      },
    },
    { name: "stop-at-corners", values: { penDownCorneringFactor: 0, penHome: point(280, 190) } },
    {
      name: "brushless-home",
      values: {
        hardware: "brushless",
        penUpHeight: 40,
        penDownHeight: 70,
        penHome: point(140, 100),
        penLiftDuration: 0.08,
        penDropDuration: 0.08,
      },
    },
    {
      name: "nextdraw-home",
      values: {
        hardware: "nextdraw-2234",
        penUpHeight: 35,
        penDownHeight: 65,
        penHome: point(280, 190),
        pointJoinRadius: 0.1,
        pathJoinRadius: 0,
        minimumPathLength: 0.1,
      },
    },
    { name: "idraw", values: { hardware: "idraw-h-se", penUpHeight: 45, penDownHeight: 55 } },
    {
      name: "fit-rotated-A4",
      values: {
        fitPage: true,
        rotateDrawing: 90,
        paperSize: PaperSize.standard.A4.portrait,
        marginMm: 12,
        pointJoinRadius: 0.1,
        pathJoinRadius: 0.5,
        minimumPathLength: 0.1,
      },
    },
    {
      name: "crop-selected-group",
      values: {
        cropToMargins: true,
        paperSize: PaperSize.standard.A6.landscape,
        marginMm: 8,
        layerMode: "group",
        selectedGroupLayers: new Set(["even"]),
        pointJoinRadius: 0.1,
        minimumPathLength: 0.1,
      },
    },
    {
      name: "fit-selected-stroke",
      values: {
        fitPage: true,
        layerMode: "stroke",
        selectedStrokeLayers: new Set(["red"]),
        pointJoinRadius: 0.25,
        pathJoinRadius: 1,
        minimumPathLength: 0.5,
      },
    },
    { name: "empty-layer", values: { layerMode: "group", selectedGroupLayers: new Set() } },
  ];
  const results = [];
  for (const fixture of fixtures) {
    for (const settings of [...matrix, ...scenarios]) {
      const options = { ...base, ...settings.values };
      for (const placement of ["after-join", "before-join"]) {
        const evaluation = evaluateSettings(toSVG(fixture.paths), options, placement);
        results.push({
          drawing: fixture.name,
          scenario: settings.name,
          settings: settings.values,
          placement,
          preparedStrokes: evaluation.prepared.length,
          selected: evaluation.selected,
          variants: evaluation.variants,
        });
      }
    }
    console.error(`Settings checked: ${fixture.name} (${results.length} combinations)`);
  }
  console.log(
    JSON.stringify(
      {
        environment: { node: process.version, cpu: cpus()[0]?.model, platform: process.platform, arch: process.arch },
        sourceSha256: Object.fromEntries(
          [
            "benchmark-routing-settings.mjs",
            "benchmark-routing.mjs",
            "benchmark-physical-routing.mjs",
            "physical-routing.mjs",
            "../src/massager.ts",
            "../src/util.ts",
            "../src/planning.ts",
            "../node_modules/optimize-paths/dist/index.js",
          ].map((file) => [
            file,
            createHash("sha256")
              .update(readFileSync(new URL(file, import.meta.url)))
              .digest("hex"),
          ]),
        ),
        baseOptions: base,
        methodology:
          "Two placements: AFTER current Saxi preprocessing (including greedy sort and tolerance merge), or BEFORE its final tolerance merge (retaining current point simplification, initial greedy sort, and minimum-length filter). Before-join candidates preserve the filtered geometry then apply the configured tolerance merge exactly once; resulting geometry differences versus the current output are reported and excluded from selection. After-join candidates preserve the configured result exactly and only add exact endpoint joins. Zero join radius disables all joining in both placements. Sorting off disables every optimizer including seam/direction changes. Minimum-length filtering and point simplification are never rerun after routing. Candidates may reverse/reorder paths when sorting is on, as today's sorter does; no new inter-layer barrier semantics. Full serialized baseline plan must match replan, including device units, home, speeds, accelerations, corner factor, servo positions and durations. Selection prefers fewer cycles within 1% of the fastest same-geometry candidate, constrained to no time regression versus current. Single-run CPU timings. No hardware commands or ink-quality claims. Nonpositive motion speeds/accelerations are rejected by this research harness.",
        checks:
          "Inclusive radius/length boundaries, point simplification before minimum length, minimum length before graph joining, no joins at radius zero, no optimization when sorting is off, source nonmutation, exact configured-geometry preservation, finite estimates, real replan serialization equality, start/end at selected home, direction DP vs exhaustive search at two home positions.",
        results,
      },
      (_key, value) => (value instanceof Set ? [...value] : value),
      2,
    ),
  );
}
