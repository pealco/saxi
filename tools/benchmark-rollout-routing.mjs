// CPU benchmark and settings/physical audit. No serial connection or production changes.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { cpus } from "node:os";
import { adaptiveFixtures } from "./adaptive-routing-fixtures.mjs";
import { cases } from "./benchmark-physical-routing.mjs";
import { drawing } from "./benchmark-routing.mjs";
import { base, preparePaths, quiet, replan, toSVG } from "./benchmark-routing-settings.mjs";
import { planWithStrategy } from "./benchmark-routing-total-time.mjs";
import { checkRollout } from "./check-rollout-routing.mjs";
import { neighborhoodFixtures } from "./neighborhood-routing-fixtures.mjs";
import { auditOrder, meaningfulSavingsSeconds, planRollout } from "./rollout-routing.mjs";

const median = (values) => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)];
const searchVariants = {
  "rollout-50": { budgetMs: 50 },
  "rollout-200": { budgetMs: 200 },
  "rollout-500": { budgetMs: 500 },
  "descent-200": { mode: "descent", budgetMs: 200 },
  "descent-500": { mode: "descent", budgetMs: 500 },
  "single-200": { mode: "descent", budgetMs: 200, lengths: [1], reverseOrder: false },
  "beam-one-200": { budgetMs: 200, beamWidth: 1 },
  "adaptive-1500": { mode: "adaptive", budgetMs: 1500 },
  "probe-1500": { mode: "probe", budgetMs: 1500 },
  "descent-1500": { mode: "descent", budgetMs: 1500 },
  "rollout-1500": { budgetMs: 1500 },
  "cheap-large": { mode: "descent", budgetMs: 5000, maxStrokes: 6000 },
  "windows-10": { mode: "windows", budgetMs: 3000, maxStrokes: 6000, windowSize: 10 },
  "windows-12": { mode: "windows", budgetMs: 3000, maxStrokes: 6000, windowSize: 12 },
  "windows-14": { mode: "windows", budgetMs: 3000, maxStrokes: 6000, windowSize: 14 },
  "ruin-32": { mode: "ruin", budgetMs: 5000, maxStrokes: 6000, removalSize: 32 },
  "ruin-16": { mode: "ruin", budgetMs: 5000, maxStrokes: 6000, removalSize: 16, iterations: 600 },
  "ruin-64": { mode: "ruin", budgetMs: 5000, maxStrokes: 6000, removalSize: 64, iterations: 150 },
  "ruin-32-long": { mode: "ruin", budgetMs: 5000, maxStrokes: 6000, removalSize: 32, iterations: 1200 },
  "ruin-32-900": { mode: "ruin", budgetMs: 5000, maxStrokes: 6000, removalSize: 32, iterations: 900 },
};
const primary = [
  "current",
  "rollout-500",
  "descent-500",
  "relocate/after",
  "joint-states/after",
  "iterated-search/after",
];
const phase = process.argv[2] ?? "held-out";
const fixtures = [];
const kinds = ["strokes", "clusters", "hatching", "contours", "fragments", "dots"];
for (const seed of phase === "pilot" ? [17] : [707, 2027])
  for (const n of [60, 300])
    for (const kind of kinds) fixtures.push({ name: `${kind}-${n}-${seed}`, paths: drawing(kind, n, seed) });
fixtures.push(
  ...cases.filter((f) =>
    /^(grid-17$|necklace-17$|microdetails|deliberate-gaps|repeated-dots|already-straight-grid|stress-connected-5000)/.test(
      f.name,
    ),
  ),
);
if (phase !== "pilot") {
  for (const seed of [17, 2027]) fixtures.push({ name: `strokes-2000-${seed}`, paths: drawing("strokes", 2000, seed) });
  fixtures.push({ name: "hatching-2000-2027", paths: drawing("hatching", 2000, 2027) });
  fixtures.push({ name: "disconnected-5000-cap", paths: drawing("dots", 5000, 2027), settings: { pathJoinRadius: 0 } });
}
fixtures.push({ name: "empty", paths: [] }, { name: "singleton", paths: [[{ x: 20, y: 20 }]] });
const scenarios = [
  ["off", { sortPaths: false }],
  ["join-off", { pathJoinRadius: 0 }],
  ["fine", { pointJoinRadius: 0.1, pathJoinRadius: 0.1, minimumPathLength: 0.1 }],
  ["coarse", { pointJoinRadius: 0.5, pathJoinRadius: 2, minimumPathLength: 2 }],
  [
    "precision",
    {
      penUpMaxVelocity: 80,
      penUpAcceleration: 150,
      penDownMaxVelocity: 15,
      penDownAcceleration: 75,
      penDownCorneringFactor: 0.02,
      penLiftDuration: 0.3,
      penDropDuration: 0.25,
    },
  ],
  [
    "fast",
    {
      penUpMaxVelocity: 250,
      penUpAcceleration: 800,
      penDownMaxVelocity: 100,
      penDownAcceleration: 400,
      penLiftDuration: 0.06,
      penDropDuration: 0.06,
    },
  ],
  [
    "brushless",
    {
      hardware: "brushless",
      penHome: { x: 280, y: 190 },
      penDownCorneringFactor: 0,
      penUpHeight: 40,
      penDownHeight: 70,
    },
  ],
  ["nextdraw", { hardware: "nextdraw-2234" }],
  ["idraw", { hardware: "idraw-h-se" }],
  ["fit-rotate", { fitPage: true, rotateDrawing: 90, marginMm: 10 }],
  ["crop-group", { cropToMargins: true, layerMode: "group", selectedGroupLayers: new Set(["even"]), marginMm: 25 }],
  ["fit-stroke", { fitPage: true, layerMode: "stroke", selectedStrokeLayers: new Set(["red"]) }],
  ["empty-layer", { layerMode: "stroke", selectedStrokeLayers: new Set(["missing"]) }],
];
if (phase === "settings") {
  fixtures.length = 0;
  const inputs = [
    ...kinds.map((kind) => ({ name: `${kind}-30`, paths: drawing(kind, 30, 101) })),
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
  for (const fixture of inputs) {
    for (const pointJoinRadius of [0, 0.1, 0.25, 0.5])
      for (const pathJoinRadius of [0, 0.1, 0.5, 1, 2])
        for (const minimumPathLength of [0, 0.1, 0.5, 2])
          fixtures.push({
            ...fixture,
            name: `${fixture.name}/${pointJoinRadius}/${pathJoinRadius}/${minimumPathLength}`,
            settings: { pointJoinRadius, pathJoinRadius, minimumPathLength },
          });
    for (const [name, settings] of scenarios) fixtures.push({ ...fixture, name: `${fixture.name}/${name}`, settings });
  }
}
if (phase.startsWith("adaptive-")) fixtures.splice(0, fixtures.length, ...adaptiveFixtures(phase));
if (phase.startsWith("neighborhood-")) fixtures.splice(0, fixtures.length, ...neighborhoodFixtures(phase));
const input = (fixture) => toSVG(fixture.paths);
const run = (paths, options, strategy) =>
  searchVariants[strategy]
    ? planRollout(paths, options, searchVariants[strategy])
    : planWithStrategy(paths, options, strategy);
const requested =
  process.env.ROLLOUT_STRATEGIES?.split(",") ??
  (phase.startsWith("neighborhood-")
    ? ["current", "cheap-large", "ruin-32-900"]
    : phase.startsWith("adaptive-")
      ? ["current", "descent-1500", "probe-1500", "adaptive-1500", "rollout-1500"]
      : phase === "pilot"
        ? ["current", ...Object.keys(searchVariants), "relocate/after", "joint-states/after", "iterated-search/after"]
        : phase === "settings"
          ? ["current", "rollout-500"]
          : primary);
assert(requested.includes("current"));
const selectedFixtures = fixtures.filter(
  (f) => !process.env.ROLLOUT_FILTER || new RegExp(process.env.ROLLOUT_FILTER).test(f.name),
);
if (process.argv.includes("--cold")) {
  assert(selectedFixtures.length === 1 && requested.length === 2);
  const fixture = selectedFixtures[0];
  const paths = input(fixture);
  const options = { ...base, ...fixture.settings };
  const start = performance.now();
  const result = run(paths, options, requested[1]);
  console.log(
    JSON.stringify({
      name: fixture.name,
      strategy: requested[1],
      planningMs: performance.now() - start,
      plotSeconds: result.plan.duration(),
      stats: result.stats,
    }),
  );
} else {
  checkRollout();
  const repeats = Number(process.env.ROLLOUT_REPEATS ?? (phase === "settings" ? 1 : 5));
  assert(Number.isInteger(repeats) && repeats >= 1);
  const records = [];
  const sourceFiles = [
    "tools/rollout-routing.mjs",
    "tools/adaptive-routing-fixtures.mjs",
    "tools/neighborhood-routing-fixtures.mjs",
    "tools/neighborhood-routing.mjs",
    "tools/check-rollout-routing.mjs",
    "tools/benchmark-rollout-routing.mjs",
    "tools/benchmark-routing-total-time.mjs",
    "tools/benchmark-routing.mjs",
    "tools/physical-routing.mjs",
    "tools/benchmark-physical-routing.mjs",
    "tools/benchmark-routing-settings.mjs",
    "src/massager.ts",
    "src/planning.ts",
    "src/util.ts",
  ];
  const hashes = Object.fromEntries(
    sourceFiles.map((path) => [path, createHash("sha256").update(readFileSync(path)).digest("hex")]),
  );
  for (let fi = 0; fi < selectedFixtures.length; fi++) {
    const fixture = selectedFixtures[fi];
    const paths = input(fixture);
    const untouched = JSON.stringify(paths);
    const options = { ...base, ...fixture.settings };
    const configured = quiet(() => preparePaths(paths, options));
    const expected = quiet(() => replan(paths, options));
    const clearance = Math.max(0.5, options.pathJoinRadius, options.pointJoinRadius);
    // Connected stress input is for bounded new search, not the old quadratic raw-graph portfolio.
    const strategies =
      fixture.name === "disconnected-5000-cap"
        ? requested.filter((s) => s === "current" || searchVariants[s])
        : requested;
    const samples = new Map(strategies.map((s) => [s, []]));
    for (let round = phase === "settings" ? 0 : -1; round < repeats; round++) {
      const offset = (((round + fi) % strategies.length) + strategies.length) % strategies.length;
      for (const strategy of [...strategies.slice(offset), ...strategies.slice(0, offset)]) {
        const started = performance.now();
        const result = run(paths, options, strategy);
        const planningMs = performance.now() - started;
        assert(result.plan.duration() <= expected.duration() + 1e-8);
        if (strategy === "current" || !options.sortPaths)
          assert.deepEqual(result.plan.serialize(), expected.serialize());
        const audit = auditOrder(configured, result.paths ?? configured, clearance);
        if (searchVariants[strategy]) {
          assert(audit.valid, `${fixture.name}: ${audit.reason}`);
          const actual = result.plan.serialize();
          const reference = expected.serialize();
          for (let i = 0; i < audit.order.length; i++)
            for (const phase of [1, 2, 3])
              assert.deepEqual(actual[4 * i + phase], reference[4 * audit.order[i] + phase]);
        }
        if (round >= 0)
          samples.get(strategy).push({
            planningMs,
            plotSeconds: result.plan.duration(),
            totalSeconds: planningMs / 1000 + result.plan.duration(),
            selected: result.selected,
            audit: { valid: audit.valid, reason: audit.reason, protectedPairs: audit.protectedPairs },
            stats: result.stats,
          });
      }
    }
    const baseline = samples.get("current");
    for (const [strategy, values] of samples) {
      const versusCheap = samples.get("cheap-large")?.map((v, i) => v.totalSeconds - values[i].totalSeconds);
      const saved = values.map((v, i) => baseline[i].totalSeconds - v.totalSeconds);
      const plotSaved = values.map((v, i) => baseline[i].plotSeconds - v.plotSeconds);
      const extraPlanning = values.map((v, i) => (v.planningMs - baseline[i].planningMs) / 1000);
      records.push({
        name: fixture.name,
        group: fixture.group,
        strategy,
        strokes: configured.length,
        planningMs: median(values.map((v) => v.planningMs)),
        plotSeconds: median(values.map((v) => v.plotSeconds)),
        savedOneCopySeconds: median(saved),
        meaningfulOneCopyWin: median(saved) >= meaningfulSavingsSeconds,
        savedOneCopyRange: [Math.min(...saved), Math.max(...saved)],
        savedVsCheapSeconds: versusCheap && median(versusCheap),
        savedVsCheapRange: versusCheap && [Math.min(...versusCheap), Math.max(...versusCheap)],
        savedTenCopiesSeconds: median(plotSaved.map((v, i) => 10 * v - extraPlanning[i])),
        savedHundredCopiesSeconds: median(plotSaved.map((v, i) => 100 * v - extraPlanning[i])),
        constraintPass: values.every((v) => v.audit.valid),
        samples: values,
      });
    }
    assert.equal(JSON.stringify(paths), untouched);
    if (phase !== "settings" || fi % 40 === 0)
      console.error(`${phase} ${fi + 1}/${selectedFixtures.length}: ${fixture.name}`);
    if (phase.startsWith("neighborhood-"))
      for (const record of records.slice(-strategies.length))
        if (record.strategy.startsWith("ruin"))
          console.error(
            `  ${record.strategy}: ${record.savedVsCheapSeconds.toFixed(3)} s net vs cheap, ${(record.planningMs / 1000).toFixed(3)} s planning`,
          );
  }
  assert.deepEqual(
    hashes,
    Object.fromEntries(
      sourceFiles.map((path) => [path, createHash("sha256").update(readFileSync(path)).digest("hex")]),
    ),
    "source changed during timing",
  );
  console.log(
    JSON.stringify(
      {
        phase,
        createdAt: new Date().toISOString(),
        node: process.version,
        cpu: cpus()[0].model,
        repeats,
        meaningfulSavingsSeconds,
        searchVariants,
        hashes,
        notes:
          "Full synchronous preparation, search, guard, motion generation and transfer packing; excludes common module loading, worker startup and actual hardware. Paired/rotated samples; no concurrent benchmark. Plot time is Saxi simulation. No physical ink test.",
        records,
      },
      null,
      2,
    ),
  );
}
