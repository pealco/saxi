import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { cases } from "./benchmark-physical-routing.mjs";
import { drawing } from "./benchmark-routing.mjs";
import { base, preparePaths, quiet, replan, tooling, toSVG } from "./benchmark-routing-settings.mjs";
import { ruinRecreate } from "./neighborhood-routing.mjs";
import { auditOrder, context, improve, planRollout } from "./rollout-routing.mjs";
import { fastContext, fastRepair, loadWasm } from "./routing-kernel.mjs";

const compiled = await build({
  stdin: { contents: 'export {replan} from "./src/massager.ts"; export {optimizePaths} from "./src/routing.ts";', resolveDir: process.cwd(), loader: "ts" },
  bundle: true, write: false, platform: "node", format: "esm",
});
const production = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`);
console.time = console.timeEnd = () => {};

const runtimes = [
  undefined,
  await loadWasm(readFileSync("dist/routing-wasm/scalar.wasm")),
  await loadWasm(readFileSync("dist/routing-wasm/simd.wasm")),
];
let comparisons = 0;
for (let seed = 1; seed <= 12; seed++)
  for (const kind of ["dots", "strokes", "contours", "hatching"]) {
    const paths = drawing(kind, 3 + seed * 3, seed);
    const reference = context(paths, tooling(base), 0.5, () => false);
    const initial = paths.map((_, i) => i);
    const expected = ruinRecreate(initial, reference, () => false, { iterations: 20 });
    for (const wasm of runtimes) {
      const ctx = fastContext(paths, tooling(base), 0.5, () => false, wasm);
      assert.deepEqual(ctx.conflicts, reference.conflicts);
      assert.deepEqual(
        ctx.outgoing.map((row) => Array.from(row)),
        reference.outgoing,
      );
      assert.deepEqual(
        ctx.incoming.map((row) => Array.from(row)),
        reference.incoming,
      );
      for (let i = 0; i <= paths.length; i++)
        for (let j = 0; j <= paths.length; j++) assert.equal(ctx.edge(i, j), reference.edge(i, j));
      assert.deepEqual(
        fastRepair(initial, ctx, () => false, { iterations: 20 }),
        expected,
      );
      assert.deepEqual(fastRepair(initial, ctx, () => true).order, initial);
      let calls = 0;
      const interrupted = fastRepair(initial, ctx, () => ++calls > 8);
      assert(
        auditOrder(
          paths,
          interrupted.order.map((i) => paths[i]),
          0.5,
        ).valid,
      );
      comparisons++;
    }
    const referenceRoute = improve(paths, tooling(base), {
      mode: "ruin", budgetMs: 60000, iterations: paths.length,
      contextFactory: fastContext, repair: fastRepair,
    });
    const routed = await production.optimizePaths(paths, base, performance.now() + 60000);
    assert(auditOrder(paths, routed, 0.5).valid);
    // Production skips jobs whose optimistic headroom is below five seconds.
    if (referenceRoute.stats.savedTravelSeconds >= 5) assert.deepEqual(routed, referenceRoute.paths);
  }
for (const wasm of runtimes) {
  for (const paths of [[], [[{ x: 2, y: 3 }]], drawing("dots", 20, 91)])
    for (const settings of [
      {},
      { sortPaths: false },
      { minimumPathLength: 1000 },
      { pointJoinRadius: 0.5, pathJoinRadius: 2, minimumPathLength: 2 },
      { hardware: "brushless", penHome: { x: 100, y: 120 }, penDownCorneringFactor: 0 },
    ]) {
      const options = { ...base, ...settings };
      const input = toSVG(paths);
      const snapshot = JSON.stringify(input);
      const expected = quiet(() => replan(input, options));
      const result = planRollout(input, options, {
        mode: "ruin",
        budgetMs: 5000,
        contextFactory: (p, profile, c, e) => fastContext(p, profile, c, e, wasm),
        repair: fastRepair,
      });
      assert(result.plan.duration() <= expected.duration() + 1e-8);
      if (!options.sortPaths) assert.deepEqual(result.plan.serialize(), expected.serialize());
      else {
        const configured = quiet(() => preparePaths(input, options));
        const audit = auditOrder(
          configured,
          result.paths,
          Math.max(0.5, options.pointJoinRadius, options.pathJoinRadius),
        );
        assert(audit.valid);
        for (let i = 0; i < audit.order.length; i++)
          for (const phase of [1, 2, 3])
            assert.deepEqual(result.plan.serialize()[4 * i + phase], expected.serialize()[4 * audit.order[i] + phase]);
      }
      assert.equal(JSON.stringify(input), snapshot);
    }
}
console.log(
  `Kernel checks passed: ${comparisons} exact reference comparisons across JS/scalar/SIMD, interruption, settings, nonmutation and physical motions`,
);

if (process.argv.includes("--settings")) {
  const inputs = [
    ...["strokes", "clusters", "hatching", "contours", "fragments", "dots"].map((kind) => ({
      name: kind,
      paths: drawing(kind, 30, 101),
    })),
    ...cases.filter((f) =>
      ["grid-17", "necklace-17", "microdetails", "deliberate-gaps", "repeated-dots"].includes(f.name),
    ),
    {
      name: "collapsed",
      paths: [
        [
          { x: 20, y: 20 },
          { x: 20.1, y: 20 },
        ],
      ],
    },
  ];
  const scenarios = [
    { sortPaths: false },
    { pathJoinRadius: 0 },
    { pointJoinRadius: 0.1, pathJoinRadius: 0.1, minimumPathLength: 0.1 },
    { pointJoinRadius: 0.5, pathJoinRadius: 2, minimumPathLength: 2 },
    {
      penUpMaxVelocity: 80,
      penUpAcceleration: 150,
      penDownMaxVelocity: 15,
      penDownAcceleration: 75,
      penDownCorneringFactor: 0.02,
      penLiftDuration: 0.3,
      penDropDuration: 0.25,
    },
    {
      penUpMaxVelocity: 250,
      penUpAcceleration: 800,
      penDownMaxVelocity: 100,
      penDownAcceleration: 400,
      penLiftDuration: 0.06,
      penDropDuration: 0.06,
    },
    {
      hardware: "brushless",
      penHome: { x: 280, y: 190 },
      penDownCorneringFactor: 0,
      penUpHeight: 40,
      penDownHeight: 70,
    },
    { hardware: "nextdraw-2234" },
    { hardware: "idraw-h-se" },
    { fitPage: true, rotateDrawing: 90, marginMm: 10 },
    { cropToMargins: true, layerMode: "group", selectedGroupLayers: new Set(["even"]), marginMm: 25 },
    { fitPage: true, layerMode: "stroke", selectedStrokeLayers: new Set(["red"]) },
    { layerMode: "stroke", selectedStrokeLayers: new Set(["missing"]) },
  ];
  for (const pointJoinRadius of [0, 0.1, 0.25, 0.5])
    for (const pathJoinRadius of [0, 0.1, 0.5, 1, 2])
      for (const minimumPathLength of [0, 0.1, 0.5, 2])
        scenarios.push({ pointJoinRadius, pathJoinRadius, minimumPathLength });
  let count = 0;
  for (const fixture of inputs)
    for (const setting of scenarios) {
      const options = { ...base, ...setting };
      const input = toSVG(fixture.paths);
      const snapshot = JSON.stringify(input);
      const expected = quiet(() => replan(input, options));
      const motions = expected.serialize();
      const configured = quiet(() => preparePaths(input, options));
      let route;
      for (const wasm of runtimes) {
        const result = planRollout(input, options, {
          mode: "ruin",
          budgetMs: 60000,
          maxStrokes: 6000,
          iterations: 900,
          contextFactory: (p, profile, c, e) => fastContext(p, profile, c, e, wasm),
          repair: fastRepair,
        });
        assert(result.plan.duration() <= expected.duration() + 1e-8);
        if (!options.sortPaths) assert.deepEqual(result.plan.serialize(), motions);
        else {
          const audit = auditOrder(
            configured,
            result.paths,
            Math.max(0.5, options.pointJoinRadius, options.pathJoinRadius),
          );
          assert(audit.valid);
          if (route) assert.deepEqual(audit.order, route);
          route = audit.order;
          const actual = result.plan.serialize();
          for (let i = 0; i < route.length; i++)
            for (const phase of [1, 2, 3]) assert.deepEqual(actual[4 * i + phase], motions[4 * route[i] + phase]);
        }
        count++;
      }
      const result = await production.replan(input, options);
      const actual = result.serialize();
      assert.equal(actual.length, motions.length);
      assert(result.duration() <= expected.duration() + 1e-8);
      if (!options.sortPaths) assert.deepEqual(actual, motions);
      const remaining = configured.map((path, i) => ({ path, key: JSON.stringify(motions.slice(4 * i + 1, 4 * i + 4)) }));
      const routed = configured.map((_, i) => {
        const key = JSON.stringify(actual.slice(4 * i + 1, 4 * i + 4));
        const at = remaining.findIndex((entry) => entry.key === key);
        assert(at >= 0, "production changed a pen contact or pen-down motion");
        return remaining.splice(at, 1)[0].path;
      });
      assert(auditOrder(configured, routed, Math.max(0.5, options.pointJoinRadius, options.pathJoinRadius)).valid);
      if (result.duration() < expected.duration() - 1e-8) assert(expected.duration() - result.duration() >= 5);
      assert.equal(JSON.stringify(input), snapshot);
    }
  console.log(`Settings sweep passed: ${inputs.length * scenarios.length} combinations, ${count} research checks plus ${inputs.length * scenarios.length} production checks`);
}
