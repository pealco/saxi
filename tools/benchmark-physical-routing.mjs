// Run: npm run --silent eval:routing:physical > /tmp/physical-routing.json
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { cpus } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { merge, reorder } from "optimize-paths";
import { AxidrawFast, drawing, rng, segmentSignature, twoOpt, validate } from "./benchmark-routing.mjs";
import { eulerTrails, joinExactAdjacent, measure, movementCost, optimizeStates } from "./physical-routing.mjs";

const origin = { x: 0, y: 0 };
const point = (x, y) => ({ x, y });
function shuffle(paths, seed) {
  const random = rng(seed);
  const result = paths.slice();
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
function route(paths, profile, states = false, allowJoin = true) {
  const cost = movementCost(profile);
  let result = twoOpt(reorder(paths), cost, profile.penHome).paths;
  if (states) {
    result = optimizeStates(result, profile);
    const alternative = optimizeStates(twoOpt(result, cost, profile.penHome).paths, profile);
    if (measure(alternative, profile).totalSeconds < measure(result, profile).totalSeconds) result = alternative;
  }
  return allowJoin ? joinExactAdjacent(result) : result;
}
function multiStart(paths, profile, allowJoin = true) {
  let best = route(paths, profile, true, allowJoin);
  let bestSeconds = measure(best, profile).totalSeconds;
  // Deterministic kicks preserve continuous trails. Accept only a better full motion plan.
  for (let trial = 0; trial < 4; trial++) {
    const random = rng(17 + trial);
    const cuts = [...new Set(Array.from({ length: 4 }, () => Math.floor(random() * best.length)))].sort(
      (a, b) => a - b,
    );
    if (cuts.length < 4) continue;
    const [a, b, c, d] = cuts;
    const kicked = [
      ...best.slice(0, a),
      ...best.slice(c, d),
      ...best.slice(b, c),
      ...best.slice(a, b),
      ...best.slice(d),
    ];
    const oriented = optimizeStates(twoOpt(kicked, movementCost(profile), profile.penHome).paths, profile);
    const candidate = allowJoin ? joinExactAdjacent(oriented) : oriented;
    const seconds = measure(candidate, profile).totalSeconds;
    if (seconds < bestSeconds - 1e-9) {
      best = candidate;
      bestSeconds = seconds;
    }
  }
  return best;
}
function traversalPortfolio(paths, profile) {
  let best;
  let seconds = Infinity;
  // Circuit splicing can undo a locally smooth decision; judge complete motion plans.
  for (const [seed, smooth] of [
    [null, false],
    [null, true],
    [73, true],
    [211, true],
  ]) {
    const graph = eulerTrails(seed === null ? paths : shuffle(paths, seed), smooth);
    const candidate = route(graph.paths, profile, true);
    const score = measure(candidate, profile).totalSeconds;
    if (score < seconds) {
      best = candidate;
      seconds = score;
    }
  }
  return best;
}
function difference(input, output) {
  const original = segmentSignature(input);
  const actual = segmentSignature(output);
  const counts = new Map();
  for (const s of original) counts.set(s, (counts.get(s) ?? 0) + 1);
  for (const s of actual) counts.set(s, (counts.get(s) ?? 0) - 1);
  let removedSegments = 0;
  let introducedSegments = 0;
  for (const n of counts.values()) {
    if (n > 0) removedSegments += n;
    else introducedSegments -= n;
  }
  return { exactSegmentCoverage: !removedSegments && !introducedSegments, removedSegments, introducedSegments };
}
function selfCheck() {
  const fixtures = [
    [],
    [[origin]],
    [[origin, origin]],
    [
      [point(0, 0), point(1, 0)],
      [point(1, 0), point(2, 0)],
    ],
    [
      [point(0, 0), point(1, 0)],
      [point(0, 0), point(1, 0)],
    ],
  ];
  for (let seed = 1; seed <= 50; seed++) {
    const random = rng(seed);
    const vertices = Array.from({ length: 10 }, (_, i) => point(i % 4, Math.floor(i / 4)));
    fixtures.push(
      Array.from({ length: 30 }, () => [vertices[Math.floor(random() * 10)], vertices[Math.floor(random() * 10)]]),
    );
  }
  for (const input of fixtures) {
    const original = JSON.stringify(input);
    for (const smooth of [false, true]) {
      const result = eulerTrails(input, smooth);
      assert.deepEqual(segmentSignature(result.paths), segmentSignature(input));
      assert.equal(JSON.stringify(input), original);
      validate(result.paths);
      assert(Number.isFinite(measure(result.paths).totalSeconds));
    }
  }
  const square = [
    [point(0, 0), point(10, 0)],
    [point(10, 0), point(10, 10)],
    [point(10, 10), point(0, 10)],
    [point(0, 10), point(0, 0)],
  ];
  assert.equal(eulerTrails(square).minimumStrokes, 1);
  const spokes = Array.from({ length: 6 }, (_, i) => [origin, point(Math.cos(i), Math.sin(i))]);
  assert.equal(eulerTrails(spokes).minimumStrokes, 3);
  const near = [
    [point(0, 0), point(1, 0)],
    [point(1 + 1e-10, 0), point(2, 0)],
  ];
  assert.equal(eulerTrails(near).paths.length, 2, "Never silently snap endpoints");
  const micro = [
    [point(0, 0), point(10, 0)],
    [point(10, 0), point(10.1, 0.2), point(10.2, 0), point(11, 0)],
  ];
  assert(difference(micro, joinExactAdjacent(micro)).exactSegmentCoverage);
  assert(
    !difference(micro, merge(micro, 0.5)).exactSegmentCoverage,
    "Regression fixture must catch the current joiner's geometry changes",
  );
  // Protected groups are optimized independently; fixed-direction/seam states remain identical.
  assert.equal([square, square].flatMap((group) => eulerTrails(group).paths).length, 2);
  const fixed = drawing("strokes", 6, 17);
  assert.deepEqual(optimizeStates(fixed, AxidrawFast, false, false), fixed);
  const states = fixed.map((p) => [p, p.slice().reverse()]);
  let brute = Infinity;
  for (let mask = 0; mask < 1 << fixed.length; mask++)
    brute = Math.min(brute, measure(states.map((s, i) => s[(mask >> i) & 1])).totalSeconds);
  assert(Math.abs(measure(optimizeStates(fixed)).totalSeconds - brute) < 1e-6);
  // Exhaustively check coupled seam and direction states on an asymmetric miniature.
  const triangle = [point(20, 20), point(60, 20), point(25, 40), point(20, 20)];
  const loopStates = [0, 1, 2].map((i) => [...triangle.slice(i, -1), ...triangle.slice(0, i), triangle[i]]);
  const couple = [fixed[0], triangle, fixed[1]];
  brute = Infinity;
  for (const a of [fixed[0], fixed[0].slice().reverse()])
    for (const b of loopStates)
      for (const c of [fixed[1], fixed[1].slice().reverse()]) brute = Math.min(brute, measure([a, b, c]).totalSeconds);
  assert(Math.abs(measure(optimizeStates(couple)).totalSeconds - brute) < 1e-6);
}

function necklace(n) {
  const paths = [];
  for (let i = 0; i < n; i++) {
    const x = 20 + i * 8;
    const y = 40;
    const p = [point(x, y), point(x + 5, y), point(x + 5, y + 5), point(x, y + 5), point(x, y)];
    for (let j = 0; j < 4; j++) paths.push([p[j], p[j + 1]]);
    if (i + 1 < n) paths.push([p[0], point(x + 4, y - 5), point(x + 8, y)]);
  }
  return paths;
}
function grid(nx, ny) {
  const result = [];
  for (let y = 0; y < ny; y++)
    for (let x = 0; x < nx; x++) {
      const a = point(20 + x * 6, 20 + y * 6);
      if (x + 1 < nx) result.push([a, point(a.x + 6, a.y)]);
      if (y + 1 < ny) result.push([a, point(a.x, a.y + 6)]);
    }
  return result;
}
function straightGrid(nx, ny) {
  const result = [];
  for (let y = 0; y < ny; y++) {
    const row = Array.from({ length: nx }, (_, x) => point(20 + x * 6, 20 + y * 6));
    if (y % 2) row.reverse();
    for (let i = 1; i < row.length; i++) result.push([row[i - 1], row[i]]);
  }
  for (let x = 0; x < nx; x++) {
    const column = Array.from({ length: ny }, (_, y) => point(20 + x * 6, 20 + y * 6));
    if (x % 2) column.reverse();
    for (let i = 1; i < column.length; i++) result.push([column[i - 1], column[i]]);
  }
  return result;
}
const cases = [];
cases.push({ name: "already-straight-grid", paths: straightGrid(20, 12) });
for (const kind of ["strokes", "clusters", "hatching", "contours", "fragments", "dots"])
  for (const seed of [17, 42, 101]) cases.push({ name: `${kind}-300-${seed}`, paths: drawing(kind, 300, seed) });
for (const seed of [17, 42, 101]) {
  cases.push({ name: `necklace-${seed}`, paths: shuffle(necklace(30), seed) });
  cases.push({ name: `grid-${seed}`, paths: shuffle(grid(20, 12), seed) });
  cases.push({
    name: `junctions-${seed}`,
    paths: shuffle(
      Array.from({ length: 24 }, (_, i) => [
        point(120, 90),
        point(120 + 60 * Math.cos((i * Math.PI) / 12), 90 + 60 * Math.sin((i * Math.PI) / 12)),
      ]),
      seed,
    ),
  });
}
cases.push({
  name: "microdetails",
  paths: Array.from({ length: 30 }, (_, i) => [
    [point(20, 20 + i * 3), point(100, 20 + i * 3)],
    [point(100, 20 + i * 3), point(100.1, 20.2 + i * 3), point(100.2, 20 + i * 3), point(101, 20 + i * 3)],
  ]).flat(),
});
cases.push({
  name: "deliberate-gaps",
  paths: Array.from({ length: 100 }, (_, i) => [point(20 + i * 2, 20), point(21.7 + i * 2, 20)]),
});
cases.push({ name: "repeated-dots", paths: Array.from({ length: 20 }, () => [point(20, 20)]) });
cases.push({
  name: "stress-connected-5000",
  paths: shuffle(
    Array.from({ length: 5000 }, (_, i) => [
      point(20 + i * 0.04, 30 + Math.sin(i * 0.002)),
      point(20 + (i + 1) * 0.04, 30 + Math.sin((i + 1) * 0.002)),
    ]),
    17,
  ),
});

const profiles = {
  default: AxidrawFast,
  "fast-lift": { ...AxidrawFast, penLiftDuration: 0.08, penDropDuration: 0.08 },
  "slow-ink-assumption": {
    ...AxidrawFast,
    penLiftDuration: 0.3,
    penDropDuration: 0.3,
    penDownProfile: { ...AxidrawFast.penDownProfile, maximumVelocity: 25 * 5, acceleration: 100 * 5 },
  },
};

export { cases, difference, multiStart, route, traversalPortfolio };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  selfCheck();
  const results = [];
  for (const fixture of cases) {
    validate(fixture.paths);
    const original = JSON.stringify(fixture.paths);
    const started = performance.now();
    const graph = eulerTrails(fixture.paths);
    const smooth = eulerTrails(fixture.paths, true);
    const topologyMs = performance.now() - started;
    for (const [profileName, profile] of Object.entries(profiles)) {
      if (fixture.paths.length > 1000 && profileName !== "default") continue;
      const variants = [];
      const candidates = new Map();
      const run = (name, operation, strict = true, extraMs = 0) => {
        const t = performance.now();
        const paths = operation();
        const computeMs = performance.now() - t + extraMs;
        const ink = difference(fixture.paths, paths);
        if (strict) assert(ink.exactSegmentCoverage, `${fixture.name}/${name} changed ink`);
        assert.equal(JSON.stringify(fixture.paths), original);
        variants.push({ name, computeMs, ...ink, ...measure(paths, profile) });
        candidates.set(name, paths);
        return paths;
      };
      run("source-exact-join", () => joinExactAdjacent(fixture.paths));
      run("current-default-join", () => merge(reorder(fixture.paths), 0.5), false);
      run("current-exact-join", () => joinExactAdjacent(reorder(fixture.paths)));
      if (fixture.paths.length <= 1000) run("previous-time-2opt-exact", () => route(fixture.paths, profile));
      run("euler-time-2opt", () => route(graph.paths, profile), true, topologyMs);
      run("smooth-euler-time-2opt", () => route(smooth.paths, profile), true, topologyMs);
      if (fixture.paths.length <= 1000) {
        run("joint-states", () => route(fixture.paths, profile, true));
        run("euler-joint-states", () => route(smooth.paths, profile, true), true, topologyMs);
        run("euler-iterated-search", () => multiStart(smooth.paths, profile), true, topologyMs);
        if (graph.paths.length < fixture.paths.length)
          run("traversal-portfolio", () => traversalPortfolio(fixture.paths, profile));
      }
      const safe = variants.filter((v) => v.exactSegmentCoverage);
      const fastest = Math.min(...safe.map((v) => v.totalSeconds));
      const frontier = safe.filter(
        (v) =>
          !safe.some(
            (w) =>
              w.totalSeconds <= v.totalSeconds + 1e-8 &&
              w.strokes <= v.strokes &&
              (w.totalSeconds < v.totalSeconds - 1e-8 || w.strokes < v.strokes),
          ),
      );
      const similarTime = safe
        .filter((v) => v.totalSeconds <= fastest * 1.01 + 1e-8)
        .sort((a, b) => a.strokes - b.strokes || a.totalSeconds - b.totalSeconds)[0];
      const row = {
        name: fixture.name,
        profile: profileName,
        inputStrokes: fixture.paths.length,
        minimumStrokes: graph.minimumStrokes,
        variants,
        pareto: frontier.map((v) => v.name),
        fewestLiftsWithinOnePercent: similarTime.name,
      };
      if (
        profileName === "default" &&
        ["necklace-17", "grid-17", "contours-300-17", "microdetails"].includes(fixture.name)
      )
        row.example = {
          input: fixture.paths,
          current: candidates.get("current-exact-join"),
          optimized: candidates.get(similarTime.name),
          optimizedName: similarTime.name,
        };
      results.push(row);
    }
  }
  console.log(
    JSON.stringify(
      {
        environment: {
          node: process.version,
          platform: process.platform,
          architecture: process.arch,
          cpu: cpus()[0]?.model,
        },
        profiles,
        sourceSha256: Object.fromEntries(
          [
            "benchmark-routing.mjs",
            "physical-routing.mjs",
            "benchmark-physical-routing.mjs",
            "../src/planning.ts",
            "../node_modules/optimize-paths/dist/index.js",
          ].map((file) => [
            file,
            createHash("sha256")
              .update(readFileSync(new URL(file, import.meta.url)))
              .digest("hex"),
          ]),
        ),
        checks:
          "50 generated multigraphs plus degenerate inputs: exact segment multiplicity, no phantom joins, all edges used once, minimum trail count, no input mutation, finite motion estimates. State DP checked against exhaustive orientation and joint seam/direction combinations. Separate-call group boundaries and locked state DP checked; full routing pipeline is unconstrained.",
        methodology:
          "32 synthetic drawings, default/fast-lift/illustrative slow-ink profiles (large stress case default only). Strict candidates preserve every original segment/dot, join only exactly equal coordinate values, add no connectors or extra retracing, and score with current saxi motion planning. Geometry preservation does not guarantee identical physical ink deposition. Benchmarked routes permit stroke reversal and reordering; state DP alone preserves the winding of its input loops. Direction/order/layer constraints require excluding corresponding transformations, not implemented in the benchmark pipeline. Graph minimum applies to supplied stroke endpoints, not unmodeled interior crossings. Search caps inherited from two-opt; seams sample up to 24 existing vertices. Physical timing/ink finish not calibrated. 1% is an illustrative near-tie policy, not a measured perceptual threshold. Sharp turns are pen-down deflections greater than 120 degrees, not a calibrated quality score. CPU times are single runs; graph timings conservatively include construction of both traversal variants. Traversal portfolio tries four graph decompositions and evaluates their complete motion plans. Default 0.5 mm merge is reported separately and may change ink. No hardware commands.",
        results,
      },
      null,
      2,
    ),
  );
}
