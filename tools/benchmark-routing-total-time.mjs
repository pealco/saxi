// Offline elapsed-time economics. No plotter connection or production routing changes.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { cpus } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { merge } from "optimize-paths";
import { cases, difference, multiStart, route, traversalPortfolio } from "./benchmark-physical-routing.mjs";
import { drawing, relocate, segmentSignature } from "./benchmark-routing.mjs";
import { base, preparePaths, quiet, replan, tooling, toSVG } from "./benchmark-routing-settings.mjs";
import { eulerTrails, joinExactAdjacent, motionPlan, movementCost } from "./physical-routing.mjs";

const methods = ["2opt", "relocate", "joint-states", "iterated-search", "euler", "smooth-euler", "traversals"];
const strategies = [
  "current",
  "2opt/after",
  "relocate/after",
  "joint-states/after",
  "iterated-search/after",
  "euler/before",
  "smooth-euler/before",
  "traversals/before",
  "search-all",
];
const epsilon = 1e-8;

// Strictly faster, so exact ties at integer copy counts require one more copy.
export function economics(extraPlanningSeconds, savedPlotSeconds, copies) {
  assert(Number.isFinite(extraPlanningSeconds) && Number.isFinite(savedPlotSeconds));
  assert(savedPlotSeconds >= 0, "This comparison requires a non-regressing plot plan");
  assert(Number.isInteger(copies) && copies > 0);
  let firstWinningCopy = null;
  if (savedPlotSeconds > epsilon) {
    firstWinningCopy = Math.max(1, Math.floor(extraPlanningSeconds / savedPlotSeconds) + 1);
  } else if (Math.abs(savedPlotSeconds) <= epsilon && extraPlanningSeconds < 0) {
    firstWinningCopy = 1;
  }
  return {
    firstWinningCopy,
    reusedPlanSavedSeconds: copies * savedPlotSeconds - extraPlanningSeconds,
    replannedEveryCopySavedSeconds: copies * (savedPlotSeconds - extraPlanningSeconds),
  };
}

function select(candidates) {
  const baseline = candidates[0];
  const fastest = Math.min(...candidates.map((c) => c.plan.duration()));
  // Same physical preference as the earlier suites; computation is sunk by this point.
  return candidates
    .filter(
      (c) => c.plan.duration() <= fastest * 1.01 + epsilon && c.plan.duration() <= baseline.plan.duration() + epsilon,
    )
    .sort((a, b) => a.paths.length - b.paths.length || a.plan.duration() - b.plan.duration())[0];
}

function pack(result) {
  const transferable = result.plan.toTransferable();
  const buffers = transferable.filter((m) => m.type === "xy").flatMap((m) => [m.cols, m.ts, m.ss]);
  const restored = result.plan.constructor.fromTransferable(transferable);
  return { ...result, plan: restored, transferBufferCount: buffers.length };
}

export function planWithStrategy(input, options, strategy) {
  assert(strategies.includes(strategy));
  return quiet(() => {
    if (strategy === "current" || !options.sortPaths) {
      return pack({ plan: replan(input, options), selected: "current", attempted: 0, rejectedGeometry: 0 });
    }
    const profile = tooling(options);
    const join = options.pathJoinRadius > 0;
    const needsBefore = strategy === "search-all" || strategy.endsWith("/before");
    const prepared = preparePaths(input, needsBefore ? { ...options, pathJoinRadius: 0 } : options);
    const configured = needsBefore && join ? merge(prepared, options.pathJoinRadius) : prepared;
    const candidates = [{ name: "current", paths: configured, plan: motionPlan(configured, profile) }];
    let attempted = 0;
    let rejectedGeometry = 0;
    const placements = strategy === "search-all" ? ["after", "before"] : [strategy.split("/")[1]];
    for (const placement of placements) {
      const paths = placement === "after" ? configured : prepared;
      const ink = segmentSignature(paths);
      const enabled = strategy === "search-all" ? methods : [strategy.split("/")[0]];
      let twoOpt;
      for (const method of enabled) {
        if (!join && ["euler", "smooth-euler", "traversals"].includes(method)) continue;
        attempted++;
        let routed;
        switch (method) {
          case "2opt":
            routed = twoOpt = route(paths, profile, false, join);
            break;
          case "relocate":
            routed = relocate(
              twoOpt ?? route(paths, profile, false, join),
              movementCost(profile),
              profile.penHome,
            ).paths;
            if (join) routed = joinExactAdjacent(routed);
            break;
          case "joint-states":
            routed = route(paths, profile, true, join);
            break;
          case "iterated-search":
            routed = multiStart(paths, profile, join);
            break;
          case "euler":
          case "smooth-euler":
            routed = route(
              eulerTrails(paths, method === "smooth-euler").paths,
              profile,
              method === "smooth-euler",
              join,
            );
            break;
          case "traversals":
            routed = traversalPortfolio(paths, profile);
            break;
          default:
            throw new Error(`Unknown method ${method}`);
        }
        // These are required guards, so their cost is inside the planning timer.
        assert.deepEqual(segmentSignature(routed), ink, `${method}: changed raw geometry`);
        const finalPaths = placement === "before" && join ? merge(routed, options.pathJoinRadius) : routed;
        if (!difference(configured, finalPaths).exactSegmentCoverage) {
          rejectedGeometry++;
          continue;
        }
        const plan = motionPlan(finalPaths, profile);
        assert(Number.isFinite(plan.duration()));
        candidates.push({ name: `${method}/${placement}`, paths: finalPaths, plan });
      }
    }
    const best = select(candidates);
    return pack({ ...best, selected: best.name, attempted, rejectedGeometry });
  });
}

const median = (values) => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)];
const stats = (values) => ({
  medianMs: median(values),
  minMs: Math.min(...values),
  maxMs: Math.max(...values),
  samplesMs: values,
});

function selfCheck() {
  assert.equal(economics(2, 1, 1).firstWinningCopy, 3);
  assert.equal(economics(0.5, 1, 1).firstWinningCopy, 1);
  assert.equal(economics(1, 0, 100).firstWinningCopy, null);
  assert.equal(economics(0, 0, 100).firstWinningCopy, null);
  assert.equal(economics(1, 0.1, 100).reusedPlanSavedSeconds, 9);
  assert.equal(economics(1, 0.1, 100).replannedEveryCopySavedSeconds, -90);
  assert.equal(economics(-1, 0, 1).firstWinningCopy, 1);
  assert.throws(() => economics(1, -1, 1), /non-regressing/);
  const input = toSVG(drawing("strokes", 8, 17));
  const before = JSON.stringify(input);
  for (const options of [
    base,
    { ...base, pathJoinRadius: 0 },
    { ...base, sortPaths: false },
    { ...base, minimumPathLength: 1000 },
    { ...base, pointJoinRadius: 0.25, minimumPathLength: 0.1, pathJoinRadius: 1, penHome: { x: 240, y: 140 } },
  ]) {
    const configured = quiet(() => preparePaths(input, options));
    const expected = quiet(() => replan(input, options));
    assert.deepEqual(planWithStrategy(input, options, "current").plan.serialize(), expected.serialize());
    assert.deepEqual(motionPlan(configured, tooling(options)).serialize(), expected.serialize());
    for (const strategy of strategies.slice(1)) {
      const result = planWithStrategy(input, options, strategy);
      assert(result.plan.duration() <= expected.duration() + epsilon);
      if (result.paths) {
        assert(difference(configured, result.paths).exactSegmentCoverage);
        if (options.pathJoinRadius === 0) assert.equal(result.paths.length, configured.length);
      }
      if (!options.sortPaths) assert.deepEqual(result.plan.serialize(), expected.serialize());
    }
  }
  assert.equal(JSON.stringify(input), before);
}

function fixtures() {
  const result = [];
  for (const kind of ["strokes", "clusters", "hatching", "contours", "fragments", "dots"]) {
    result.push({ name: `${kind}-60-17`, paths: drawing(kind, 60, 17) });
    result.push(...cases.filter((c) => c.name.startsWith(`${kind}-300-`)));
  }
  result.push(
    ...cases.filter((c) =>
      /^(grid-|necklace-|microdetails|deliberate-gaps|repeated-dots|already-straight-grid)/.test(c.name),
    ),
  );
  result.push(
    { name: "empty", paths: [] },
    {
      name: "single-line",
      paths: [
        [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
        ],
      ],
    },
  );
  result.push({ name: "strokes-2000-17", paths: drawing("strokes", 2000, 17) });
  result.push({ name: "hatching-2000-17", paths: drawing("hatching", 2000, 17) });
  // The 5,000-edge tiny-segment chain is already radically altered by default tolerance joining;
  // retain it to expose guards and fallback cost, not to claim an ink-changing speedup.
  result.push(cases.find((c) => c.name === "stress-connected-5000"));
  for (const name of ["grid-17", "contours-300-17", "microdetails"]) {
    const fixture = cases.find((c) => c.name === name);
    for (const [label, settings] of [
      ["join-off", { pathJoinRadius: 0 }],
      ["fine", { pointJoinRadius: 0.1, pathJoinRadius: 0.1, minimumPathLength: 0.1 }],
      ["coarse", { pointJoinRadius: 0.5, pathJoinRadius: 2, minimumPathLength: 2 }],
      ["fast", { penLiftDuration: 0.08, penDropDuration: 0.08, penDownMaxVelocity: 100, penUpMaxVelocity: 250 }],
    ])
      result.push({ ...fixture, name: `${name}/${label}`, settings });
  }
  result.push({
    ...cases.find((c) => c.name === "grid-17"),
    name: "grid-17/sorting-off",
    settings: { sortPaths: false },
  });
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "--cold-once") {
    // Run in a fresh process; source bundling/imports finish before this timer, with no self-check warm-up.
    const fixture = fixtures().find((f) => f.name === process.argv[3]);
    assert(fixture, "Unknown fixture");
    const input = toSVG(fixture.paths);
    const options = { ...base, ...fixture.settings };
    const started = performance.now();
    const output = planWithStrategy(input, options, process.argv[4]);
    console.log(
      JSON.stringify({
        drawing: fixture.name,
        strategy: process.argv[4],
        planningMs: performance.now() - started,
        plotSeconds: output.plan.duration(),
        selected: output.selected,
      }),
    );
  } else if (process.argv.includes("--check")) {
    selfCheck();
    console.log("Total-time self-checks passed");
  } else {
    selfCheck();
    const repeats = Number(process.env.ROUTING_REPEATS ?? 7);
    assert(Number.isInteger(repeats) && repeats >= 3);
    const filter = process.env.ROUTING_FILTER;
    const requested = process.env.ROUTING_STRATEGIES?.split(",") ?? strategies;
    assert(requested.includes("current") && requested.every((s) => strategies.includes(s)));
    const results = [];
    for (const fixture of fixtures().filter((f) => !filter || new RegExp(filter).test(f.name))) {
      const input = toSVG(fixture.paths);
      const original = JSON.stringify(input);
      const options = { ...base, ...fixture.settings };
      // Avoid quadratic search over 5,000 unmerged tiny edges; graph-first is the applicable experiment.
      const enabled = requested.filter(
        (s) =>
          fixture.paths.length <= 3000 ||
          ["current", "euler/before", "smooth-euler/before", "traversals/before"].includes(s),
      );
      const samples = Object.fromEntries(enabled.map((s) => [s, []]));
      const outputs = {};
      const firstMs = {};
      const baselinePlan = quiet(() => replan(input, options));
      const configured = quiet(() => preparePaths(input, options));
      for (let round = -1; round < repeats; round++) {
        // Rotate ordering to reduce fixed-order warm-up/GC bias. One untimed warm-up per strategy/case.
        const shift = (round + 1) % enabled.length;
        const order = [...enabled.slice(shift), ...enabled.slice(0, shift)];
        for (const strategy of order) {
          const started = performance.now();
          const output = planWithStrategy(input, options, strategy);
          const ms = performance.now() - started;
          if (round < 0) firstMs[strategy] = ms;
          else samples[strategy].push(ms);
          // Audit assertions outside the timer; algorithm acceptance guards remain inside it.
          assert(output.plan.duration() <= baselinePlan.duration() + epsilon);
          if (output.paths) assert(difference(configured, output.paths).exactSegmentCoverage);
          if (strategy === "current" || !options.sortPaths)
            assert.deepEqual(output.plan.serialize(), baselinePlan.serialize());
          if (outputs[strategy]) {
            assert.equal(output.selected, outputs[strategy].selected);
            assert.equal(output.plan.duration(), outputs[strategy].plan.duration());
          }
          outputs[strategy] = output;
        }
        if (input.length > 1000)
          console.error(`${fixture.name}: ${round < 0 ? "warm-up" : `sample ${round + 1}/${repeats}`} complete`);
      }
      assert.equal(JSON.stringify(input), original);
      const baseline = outputs.current;
      const baselineMs = median(samples.current);
      const variants = enabled.map((strategy) => {
        const output = outputs[strategy];
        const planning = stats(samples[strategy]);
        const extraPlanningSeconds = (planning.medianMs - baselineMs) / 1000;
        const savedPlotSeconds =
          Math.abs(baseline.plan.duration() - output.plan.duration()) < epsilon
            ? 0
            : baseline.plan.duration() - output.plan.duration();
        const conservativeExtra = Math.max(0, (planning.maxMs - Math.min(...samples.current)) / 1000);
        return {
          strategy,
          selected: output.selected,
          attempted: output.attempted,
          rejectedGeometry: output.rejectedGeometry,
          planning: { ...planning, firstInCaseMs: firstMs[strategy] },
          plotSeconds: output.plan.duration(),
          cycles: (output.plan.motions.length - 1) / 4,
          extraPlanningSeconds,
          savedPlotSeconds,
          firstWinningCopy: economics(extraPlanningSeconds, savedPlotSeconds, 1).firstWinningCopy,
          conservativeFirstWinningCopy: economics(conservativeExtra, savedPlotSeconds, 1).firstWinningCopy,
          copies: Object.fromEntries(
            [1, 10, 100].map((n) => [
              n,
              {
                currentTotalSeconds: baselineMs / 1000 + n * baseline.plan.duration(),
                candidateTotalSeconds: planning.medianMs / 1000 + n * output.plan.duration(),
                ...economics(extraPlanningSeconds, savedPlotSeconds, n),
              },
            ]),
          ),
          planningSlowdown: Object.fromEntries(
            [5, 20].map((factor) => [factor, economics(extraPlanningSeconds * factor, savedPlotSeconds, 1)]),
          ),
        };
      });
      results.push({
        drawing: fixture.name,
        inputStrokes: input.length,
        configuredStrokes: configured.length,
        settings: fixture.settings ?? {},
        variants,
      });
      const all = variants.find((v) => v.strategy === "search-all") ?? variants.at(-1);
      console.error(
        `${fixture.name}: ${all.planning.medianMs.toFixed(1)} ms, saves ${all.savedPlotSeconds.toFixed(3)} s/copy, break-even ${all.firstWinningCopy ?? "never"}`,
      );
    }
    console.log(
      JSON.stringify(
        {
          environment: {
            timestamp: new Date().toISOString(),
            node: process.version,
            cpu: cpus()[0]?.model,
            platform: process.platform,
            arch: process.arch,
          },
          sourceSha256: Object.fromEntries(
            [
              "benchmark-routing-total-time.mjs",
              "benchmark-routing-settings.mjs",
              "benchmark-routing.mjs",
              "benchmark-physical-routing.mjs",
              "physical-routing.mjs",
              "../src/massager.ts",
              "../src/planning.ts",
              "../src/util.ts",
              "../node_modules/optimize-paths/dist/index.js",
            ].map((file) => [
              file,
              createHash("sha256")
                .update(readFileSync(new URL(file, import.meta.url)))
                .digest("hex"),
            ]),
          ),
          baseOptions: base,
          methodology: {
            repeats,
            statistic: "median of repeated wall-clock CPU runs; raw samples and min/max retained",
            included:
              "Current production preprocessing; candidate search; all attempted/rejected alternatives in search-all; exact geometry guards; baseline and candidate motion planning; selection; transferable construction/buffer enumeration and local Plan reconstruction.",
            excluded:
              "Source bundling/imports, SVG parsing, worker startup/message transit, UI drawing, HTTP encoding/network, plotter communication and unmodelled physical effects. Source bundling is benchmark setup, not production planning. No forced GC. Audit assertions outside timer. Acceptance guards inside timer.",
            warmup:
              "One initial run per strategy/case excluded from median. First-in-case values retained but are not cold-start measurements. Strategy order rotates each repeat. Sequential execution on this machine; no browser or slower-device timing claims.",
            portfolio:
              "search-all evaluates seven methods at both placements, shares preprocessing and the 2opt parent of relocation, charges all search and rejection costs. Fixed strategies include current-plan fallback; they are alternatives selected in advance, not free hindsight selection.",
            physicalSelection:
              "Same-segment/dot multiset; no joins with zero radius; sorting off bypasses every optimizer. Minimum length and point filtering use production preparation once. Prefer fewer cycles within 1% of fastest plot duration, never exceed baseline plot duration. This does not guarantee lower planning-plus-plotting time.",
            economics:
              "Reuse: P + N*T. Replan each copy: N*(P+T). First winning integer N strictly exceeds extra planning / per-copy plot saving. Null means no winning count for nonnegative overhead and zero savings. Ignore plot differences below 1e-8 s. Planning slowdown factors 5 and 20 are sensitivity assumptions, not measured hardware.",
            conservative:
              "Use candidate maximum observed planning minus baseline minimum for a conservative observed-range break-even; this is not a confidence bound.",
          },
          results,
        },
        (_key, value) => (value instanceof Set ? [...value] : value),
        2,
      ),
    );
  }
}
