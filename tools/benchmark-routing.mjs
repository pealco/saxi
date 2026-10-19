// Research harness only; never connects to hardware or changes the production planner.
// Run: node tools/benchmark-routing.mjs [drawing.svg ...] > /tmp/routing-results.json
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { cpus } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { flattenSVG } from "flatten-svg";
import { merge, reorder } from "optimize-paths";
import { createSVGWindow } from "svgdom";

// Load current source, so the experiment cannot accidentally use an old dist build.
const compiled = await build({
  entryPoints: [fileURLToPath(new URL("../src/planning.ts", import.meta.url))],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
});
const { plan, AxidrawFast } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`
);
const home = { x: 0, y: 0 };
const start = (p) => p[0];
const end = (p) => p[p.length - 1];
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const travelTime = (a, b) => {
  const d = distance(a, b);
  const accel = AxidrawFast.penUpProfile.acceleration / 5;
  const speed = AxidrawFast.penUpProfile.maximumVelocity / 5;
  return d <= (speed * speed) / accel ? 2 * Math.sqrt(d / accel) : d / speed + speed / accel;
};
function cost(paths, edgeCost) {
  let total = 0;
  let previous = home;
  for (const path of paths) {
    total += edgeCost(previous, start(path));
    previous = end(path);
  }
  return total + edgeCost(previous, home);
}

function twoOpt(input, edgeCost, penHome = home) {
  const paths = input.slice();
  // shortcut: quadratic full scans capped at 20 passes, use spatial candidates for production-scale jobs.
  let passes = 0;
  let changed = true;
  let moves = 0;
  for (; passes < 20 && changed; passes++) {
    changed = false;
    for (let i = 0; i < paths.length; i++) {
      for (let j = i; j < paths.length; j++) {
        const before = i ? end(paths[i - 1]) : penHome;
        const after = j + 1 < paths.length ? start(paths[j + 1]) : penHome;
        const oldCost = edgeCost(before, start(paths[i])) + edgeCost(end(paths[j]), after);
        const newCost = edgeCost(before, end(paths[j])) + edgeCost(start(paths[i]), after);
        if (newCost < oldCost - 1e-9) {
          const reversed = paths
            .slice(i, j + 1)
            .reverse()
            .map((p) => p.slice().reverse());
          paths.splice(i, j - i + 1, ...reversed);
          changed = true;
          moves++;
        }
      }
    }
  }
  return { paths, passes, moves, converged: !changed };
}

function relocate(input, edgeCost, penHome = home) {
  const paths = input.slice();
  let passes = 0;
  let changed = true;
  let moves = 0;
  for (; passes < 8 && changed; passes++) {
    changed = false;
    for (let i = 0; i < paths.length; i++) {
      const p = paths[i];
      const before = i ? end(paths[i - 1]) : penHome;
      const after = i + 1 < paths.length ? start(paths[i + 1]) : penHome;
      const removal = edgeCost(before, after) - edgeCost(before, start(p)) - edgeCost(end(p), after);
      let bestDelta = -1e-9;
      let bestJ = -1;
      let bestFlip = false;
      for (let j = 0; j <= paths.length; j++) {
        if (j === i || j === i + 1) continue;
        const a = j ? end(paths[j - 1]) : penHome;
        const b = j < paths.length ? start(paths[j]) : penHome;
        for (const flip of [false, true]) {
          const delta =
            removal - edgeCost(a, b) + edgeCost(a, flip ? end(p) : start(p)) + edgeCost(flip ? start(p) : end(p), b);
          if (delta < bestDelta) {
            bestDelta = delta;
            bestJ = j;
            bestFlip = flip;
          }
        }
      }
      if (bestJ >= 0) {
        paths.splice(i, 1);
        paths.splice(bestJ > i ? bestJ - 1 : bestJ, 0, bestFlip ? p.slice().reverse() : p);
        changed = true;
        moves++;
      }
    }
  }
  return { paths, passes, moves, converged: !changed };
}

function improveSeams(input) {
  const paths = input.slice();
  let passes = 0;
  let changed = true;
  let moves = 0;
  for (; passes < 4 && changed; passes++) {
    changed = false;
    for (let i = 0; i < paths.length; i++) {
      const p = paths[i];
      if (p.length < 4 || distance(start(p), end(p)) !== 0) continue;
      const a = i ? end(paths[i - 1]) : home;
      const b = i + 1 < paths.length ? start(paths[i + 1]) : home;
      let best = travelTime(a, start(p)) + travelTime(start(p), b);
      let bestK = 0;
      for (let k = 1; k < p.length - 1; k++) {
        const candidate = travelTime(a, p[k]) + travelTime(p[k], b);
        if (candidate < best - 1e-9) {
          best = candidate;
          bestK = k;
        }
      }
      if (bestK) {
        paths[i] = [...p.slice(bestK, -1), ...p.slice(0, bestK), p[bestK]];
        changed = true;
        moves++;
      }
    }
  }
  return { paths, passes, moves, converged: !changed };
}

function validate(paths) {
  assert(
    Array.isArray(paths) &&
      paths.every(
        (p) => Array.isArray(p) && p.length && p.every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y)),
      ),
    "Expected finite, nonempty strokes (an empty drawing is allowed)",
  );
}
function readPaths(svg) {
  const window = createSVGWindow();
  window.document.documentElement.innerHTML = svg;
  const paths = flattenSVG(window.document.documentElement).map((p) => p.points.map(({ x, y }) => ({ x, y })));
  validate(paths);
  return paths;
}
function signature(paths) {
  return paths.map((p) => [JSON.stringify(p), JSON.stringify(p.slice().reverse())].sort()[0]).sort();
}
function segmentSignature(paths) {
  return paths
    .flatMap((p) =>
      p.length === 1
        ? [`dot:${JSON.stringify(p[0])}`]
        : p.slice(1).map((b, i) => [JSON.stringify(p[i]), JSON.stringify(b)].sort().join("|")),
    )
    .sort();
}
function metrics(paths) {
  const p = plan(
    paths.map((line) => line.map(({ x, y }) => ({ x: x * 5, y: y * 5 }))),
    AxidrawFast,
  );
  const seconds = p.duration();
  const travelSeconds = p.motions.filter((_, i) => i % 4 === 0).reduce((s, m) => s + m.duration(), 0);
  assert(Math.abs(travelSeconds - cost(paths, travelTime)) < 1e-6, "Cost model must match saxi motion planning");
  return { strokes: paths.length, travelMm: cost(paths, distance), travelSeconds, totalSeconds: seconds };
}
function rng(seed) {
  let state = seed;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}
function drawing(kind, n, seed) {
  const random = rng(seed);
  const paths = [];
  for (let i = 0; i < n; i++) {
    if (kind === "fragments") {
      const chain = Math.floor(i / 10);
      const k = i % 10;
      const point = (j) => ({ x: 20 + j * 25, y: 20 + chain * 3.3 + Math.sin(j * 0.6) });
      paths.push([point(k), point(k + 1)]);
    } else if (kind === "dots") {
      paths.push([{ x: 20 + random() * 250, y: 20 + random() * 170 }]);
    } else if (kind === "hatching") {
      const y = 20 + (170 * i) / n;
      paths.push([
        { x: 20, y },
        { x: 270, y },
      ]);
    } else if (kind === "contours") {
      const x = 25 + random() * 240;
      const y = 25 + random() * 160;
      const r = 1 + random() * 6;
      const phase = random() * 2 * Math.PI;
      const loop = Array.from({ length: 24 }, (_, j) => ({
        x: x + r * Math.cos(phase + (j * Math.PI) / 12),
        y: y + r * Math.sin(phase + (j * Math.PI) / 12),
      }));
      paths.push([...loop, { ...loop[0] }]);
    } else {
      const clustered = kind === "clusters";
      const x = clustered ? 35 + (i % 4) * 65 + random() * 20 : 20 + random() * 250;
      const y = clustered ? 35 + (i % 3) * 60 + random() * 15 : 20 + random() * 170;
      const angle = random() * 2 * Math.PI;
      const length = 1 + random() * 8;
      paths.push([
        { x, y },
        { x: x + length * Math.cos(angle), y: y + length * Math.sin(angle) },
      ]);
    }
  }
  for (let i = paths.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [paths[i], paths[j]] = [paths[j], paths[i]];
  }
  return paths;
}

// Exact subset dynamic programming, used only to measure small-instance optimality gaps.
function exactCost(paths, edgeCost) {
  const n = paths.length;
  if (!n) return 0;
  const dp = new Float64Array((1 << n) * n * 2).fill(Infinity);
  const idx = (mask, i, flip) => (mask * n + i) * 2 + flip;
  const entry = (i, flip) => (flip ? end(paths[i]) : start(paths[i]));
  const exit = (i, flip) => (flip ? start(paths[i]) : end(paths[i]));
  for (let i = 0; i < n; i++)
    for (let flip = 0; flip < 2; flip++) dp[idx(1 << i, i, flip)] = edgeCost(home, entry(i, flip));
  for (let mask = 1; mask < 1 << n; mask++) {
    for (let i = 0; i < n; i++)
      if (mask & (1 << i)) {
        for (let flip = 0; flip < 2; flip++) {
          for (let j = 0; j < n; j++)
            if (!(mask & (1 << j))) {
              for (let nextFlip = 0; nextFlip < 2; nextFlip++) {
                const k = idx(mask | (1 << j), j, nextFlip);
                dp[k] = Math.min(dp[k], dp[idx(mask, i, flip)] + edgeCost(exit(i, flip), entry(j, nextFlip)));
              }
            }
        }
      }
  }
  return Math.min(
    ...paths.flatMap((_, i) => [0, 1].map((flip) => dp[idx((1 << n) - 1, i, flip)] + edgeCost(exit(i, flip), home))),
  );
}

function selfCheck() {
  assert.deepEqual(readPaths('<svg xmlns="http://www.w3.org/2000/svg"><path d="M1 2L3 4"/></svg>'), [
    [
      { x: 1, y: 2 },
      { x: 3, y: 4 },
    ],
  ]);
  assert.equal(cost([], travelTime), 0);
  assert.deepEqual(twoOpt([], travelTime).paths, []);
  const points = [[{ x: 3, y: 0 }], [{ x: 1, y: 0 }]];
  assert.equal(exactCost(points, distance), 6);
  metrics([]);
  for (const d of [0, 1e-6, 1, 99.999, 100, 100.001, 300]) metrics([[{ x: d, y: 0 }]]);
  assert.throws(() => validate([[]]));
  assert.throws(() => validate([[{ x: NaN, y: 0 }]]));
  assert.throws(() => validate([[{ x: 0, y: Infinity }]]));
  for (const paths of [[], [[home]], [[home, home]], [home, home].map((p) => [p])]) {
    validate(paths);
    assert.deepEqual(signature(twoOpt(paths, travelTime).paths), signature(paths));
    metrics(paths);
  }
  for (const edgeCost of [distance, travelTime]) {
    const input = drawing("strokes", 6, 123);
    const saved = JSON.stringify(input);
    let brute = Infinity;
    function enumerate(prefix, rest) {
      if (!rest.length) {
        brute = Math.min(brute, cost(prefix, edgeCost));
        return;
      }
      for (let i = 0; i < rest.length; i++) {
        const remaining = rest.filter((_, j) => j !== i);
        for (const p of [rest[i], rest[i].slice().reverse()]) enumerate([...prefix, p], remaining);
      }
    }
    enumerate([], input);
    assert(Math.abs(exactCost(input, edgeCost) - brute) < 1e-7);
    const result = twoOpt(input, edgeCost);
    assert(cost(result.paths, edgeCost) <= cost(input, edgeCost) + 1e-7);
    assert(cost(result.paths, edgeCost) >= brute - 1e-7);
    assert.deepEqual(signature(input), signature(result.paths));
    assert.equal(JSON.stringify(input), saved);
    metrics(result.paths);
    const moved = relocate(result.paths, edgeCost);
    assert(cost(moved.paths, edgeCost) <= cost(result.paths, edgeCost) + 1e-7);
    assert(cost(moved.paths, edgeCost) >= brute - 1e-7);
    assert.deepEqual(signature(input), signature(moved.paths));
  }
  const loops = drawing("contours", 20, 17);
  const saved = JSON.stringify(loops);
  const seams = improveSeams(loops).paths;
  assert.deepEqual(segmentSignature(loops), segmentSignature(seams));
  assert(cost(seams, travelTime) <= cost(loops, travelTime) + 1e-7);
  assert.equal(JSON.stringify(loops), saved);
}

function benchmark(name, input) {
  validate(input);
  const saved = JSON.stringify(input);
  const original = signature(input);
  const variants = [];
  const routes = {};
  const run = (algorithm, operation, parent = null, seams = false) => {
    const t = performance.now();
    const result = operation();
    const stageMs = performance.now() - t;
    const routingMs = stageMs + (variants.find((v) => v.algorithm === parent)?.routingMs ?? 0);
    const { paths, ...search } = result;
    validate(paths);
    if (seams)
      assert.deepEqual(segmentSignature(paths), segmentSignature(input), "Seam changes must preserve every segment");
    else assert.deepEqual(signature(paths), original, "Every stroke must survive unchanged, possibly reversed");
    assert.equal(JSON.stringify(input), saved, "Input must not be mutated");
    routes[algorithm] = paths;
    variants.push({
      algorithm,
      routingMs,
      stageMs,
      parent,
      ...search,
      ...metrics(paths),
      mergedAt05mm: metrics(merge(paths, 0.5)),
    });
    return paths;
  };
  const greedy = run("current", () => ({ paths: reorder(input) }));
  const fromHome = run("home-greedy", () => ({ paths: reorder([[home], ...input]).slice(1) }));
  const dist = run("distance-2opt", () => twoOpt(greedy, distance), "current");
  const timed = run("time-2opt", () => twoOpt(greedy, travelTime), "current");
  run("home-time-2opt", () => twoOpt(fromHome, travelTime), "home-greedy");
  run("distance-then-time-2opt", () => twoOpt(dist, travelTime), "distance-2opt");
  const moved = run(
    "time-2opt-relocate",
    () => {
      const relocation = relocate(timed, travelTime);
      const polish = twoOpt(relocation.paths, travelTime);
      return {
        ...polish,
        relocationPasses: relocation.passes,
        relocationMoves: relocation.moves,
        relocationConverged: relocation.converged,
      };
    },
    "time-2opt",
  );
  if (input.some((p) => p.length >= 4 && distance(start(p), end(p)) === 0)) {
    run("time-2opt-seams", () => improveSeams(timed), "time-2opt", true);
  }
  assert(cost(dist, distance) <= cost(greedy, distance) + 1e-6);
  assert(cost(timed, travelTime) <= cost(greedy, travelTime) + 1e-6);
  assert(cost(moved, travelTime) <= cost(timed, travelTime) + 1e-6);
  const result = { name, sourceOrder: metrics(input), variants };
  if (input.length <= 12) {
    result.exactTravelSeconds = exactCost(input, travelTime);
    for (const v of variants.filter((v) => v.algorithm !== "time-2opt-seams"))
      assert(v.travelSeconds >= result.exactTravelSeconds - 1e-6);
  }
  if (["strokes-500-seed-17", "contours-500-seed-17", "fragments-500-seed-17", "trap-two-rows"].includes(name)) {
    result.exampleRoutes = Object.fromEntries(
      ["current", "time-2opt", "time-2opt-seams"].filter((key) => routes[key]).map((key) => [key, routes[key]]),
    );
  }
  return result;
}

export { AxidrawFast, drawing, plan, relocate, rng, segmentSignature, selfCheck, travelTime, twoOpt, validate };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  selfCheck();
  const results = [];
  const files = process.argv.slice(2);
  if (files.length) {
    for (const file of files) {
      const paths = readPaths(readFileSync(file, "utf8"));
      assert(paths.length, "SVG must contain strokes");
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const p of paths)
        for (const { x, y } of p) {
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
      const scale = Math.min(257 / (maxX - minX || 1), 170 / (maxY - minY || 1));
      results.push(
        benchmark(
          file,
          paths.map((p) => p.map(({ x, y }) => ({ x: 20 + (x - minX) * scale, y: 20 + (y - minY) * scale }))),
        ),
      );
    }
  } else {
    for (const kind of ["strokes", "clusters", "hatching", "contours", "fragments", "dots"]) {
      for (const seed of [17, 42, 101, 2026, 8675309])
        results.push(benchmark(`${kind}-500-seed-${seed}`, drawing(kind, 500, seed)));
    }
    for (let seed = 1; seed <= 10; seed++)
      results.push(benchmark(`exact-strokes-10-seed-${seed}`, drawing("strokes", 10, seed)));
    const point = (x, y) => ({ x, y });
    const cases = {
      empty: [],
      "single-dot-at-home": [[home]],
      "single-stroke-backward": [[point(100, 100), point(1, 1)]],
      "duplicate-dots": Array.from({ length: 8 }, () => [point(10, 10)]),
      "zero-length-strokes": Array.from({ length: 8 }, (_, i) => [point(i, i), point(i, i)]),
      "duplicate-strokes": Array.from({ length: 8 }, () => [point(10, 10), point(20, 20)]),
      "negative-coordinates": drawing("strokes", 10, 17).map((p) => p.map(({ x, y }) => point(x - 200, y - 100))),
      "near-tied-distances": Array.from({ length: 10 }, (_, i) => [
        point(100 + Math.cos((i * Math.PI) / 5), 100 + Math.sin((i * Math.PI) / 5) + i * 1e-8),
      ]),
      "far-home": drawing("strokes", 10, 17).map((p) => p.map(({ x, y }) => point(x + 1000, y + 1000))),
      "tiny-segments": Array.from({ length: 10 }, (_, i) => [point(i, i), point(i + 1e-5, i)]),
      "join-threshold": [0, 0.499999, 0.5, 0.500001].map((gap, i) => [point(10 + i, 10), point(11 + i - gap, 10)]),
      "branching-star": Array.from({ length: 10 }, (_, i) => [
        point(100, 100),
        point(100 + 50 * Math.cos((i * Math.PI) / 5), 100 + 50 * Math.sin((i * Math.PI) / 5)),
      ]),
      "nested-loops": Array.from({ length: 10 }, (_, i) => {
        const r = (i + 1) * 5;
        return [
          point(100 - r, 100 - r),
          point(100 + r, 100 - r),
          point(100 + r, 100 + r),
          point(100 - r, 100 + r),
          point(100 - r, 100 - r),
        ];
      }),
      "trap-two-rows": [1, 2, 4, 8, 16, 32].flatMap((x) => [[point(x * 5, 20)], [point(x * 5, 30)]]),
    };
    for (const [name, paths] of Object.entries(cases)) results.push(benchmark(name, paths));
    results.push(benchmark("strokes-2000-seed-17", drawing("strokes", 2000, 17)));
  }
  console.log(
    JSON.stringify(
      {
        sourceSha256: Object.fromEntries(
          ["../src/planning.ts", "../node_modules/optimize-paths/dist/index.js", "./benchmark-routing.mjs"].map(
            (file) => [
              file,
              createHash("sha256")
                .update(readFileSync(new URL(file, import.meta.url)))
                .digest("hex"),
            ],
          ),
        ),
        environment: { node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model },
        selfChecks:
          "Passed: validation, empty/degenerate cases, travel-time formula vs saxi at acceleration transition, exact DP vs exhaustive permutations/directions, nonmutation, stroke/segment preservation, monotonic search, exact lower bound.",
        methodology:
          "All coordinates in mm; home (0,0); AxidrawFast defaults. Route-only metrics disable path joining. mergedAt05mm separately applies saxi's default adjacent-path merge. Total seconds from current src/planning.ts, including return home and lift/drop. routingMs includes parent stages; stageMs does not. CPU timings are single runs, not repeated benchmarks. SVGs, if supplied, are fit to a 257 x 170 mm box with a 20 mm offset, all strokes together; not the user's saved UI settings. No physical plotting. Two-opt caps at 20 passes; relocation at 8, seams at 4. Seams optimize travel only and can change drawing acceleration time; all totals are evaluated afterward. Exact optima hold stroke endpoints fixed, so do not bound the seams variant. Synthetic stress/negative/far-home cases are numerical evaluations, not hardware-safe drawings.",
        results,
      },
      null,
      2,
    ),
  );
}
