import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drawing, rng } from "./benchmark-routing.mjs";
import { base, preparePaths, quiet, replan, tooling, toSVG } from "./benchmark-routing-settings.mjs";
import { exactWindow, regretRepair, repairWindows, ruinRecreate } from "./neighborhood-routing.mjs";
import { measure, movementCost } from "./physical-routing.mjs";
import { applyMove, auditOrder, bounds, improve, nearby, planRollout, worthExpanding } from "./rollout-routing.mjs";

const point = (x, y) => ({ x, y });
const permutations = function* (values) {
  if (!values.length) {
    yield [];
    return;
  }
  for (let i = 0; i < values.length; i++)
    for (const rest of permutations([...values.slice(0, i), ...values.slice(i + 1)])) yield [values[i], ...rest];
};

export function checkRollout() {
  // Compare the exact repair against every feasible permutation, with asymmetric costs and fixed boundaries.
  for (let seed = 1; seed <= 16; seed++) {
    const random = rng(seed);
    const n = 3 + (seed % 5);
    const ids = Array.from({ length: n }, (_, i) => i);
    const costs = Array.from({ length: n + 2 }, () => Array.from({ length: n + 2 }, () => random() * 4));
    const conflicts = ids.map(() => []);
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++)
        if (random() < 0.25) {
          conflicts[i].push(j);
          conflicts[j].push(i);
        }
    const ctx = { n, edge: (a, b) => costs[a][b], conflicts };
    ctx.incoming = ids.map((id) => ids.filter((other) => other !== id));
    ctx.outgoing = ctx.incoming;
    const score = (order) => {
      let total = ctx.edge(n, order[0]) + ctx.edge(order.at(-1), n + 1);
      for (let i = 1; i < n; i++) total += ctx.edge(order[i - 1], order[i]);
      return total;
    };
    let optimum = Infinity;
    for (const order of permutations(ids)) {
      const pos = ids.map((id) => order.indexOf(id));
      if (ids.some((id) => conflicts[id].some((other) => id < other && pos[id] > pos[other]))) continue;
      optimum = Math.min(optimum, score(order));
    }
    const result = exactWindow(ids, n, n + 1, ctx);
    assert(Math.abs(result.score - optimum) < 1e-9);
    assert(Math.abs(score(result.order) - optimum) < 1e-9);
    assert.deepEqual(exactWindow(ids, n, n + 1, ctx), result);
    assert.deepEqual(repairWindows(ids, ctx, () => true).order, ids);
    for (const removed of [ids, ids.filter((id) => id % 2 === 0)]) {
      const repair = regretRepair(ids, removed, ctx);
      if (repair) {
        assert.deepEqual(
          repair.slice().sort((a, b) => a - b),
          ids,
        );
        for (const id of ids)
          for (const other of conflicts[id]) if (id < other) assert(repair.indexOf(id) < repair.indexOf(other));
      }
      assert.equal(
        regretRepair(ids, removed, ctx, () => true),
        null,
      );
    }
    const rebuilt = ruinRecreate(ids, ctx, () => false, { iterations: 20 });
    assert.deepEqual(
      ruinRecreate(ids, ctx, () => false, { iterations: 20 }),
      rebuilt,
    );
    assert.deepEqual(ruinRecreate(ids, ctx, () => true).order, ids);
  }
  assert.equal(
    exactWindow(
      Array.from({ length: 8 }, (_, i) => i),
      8,
      8,
      { edge: () => 1, conflicts: Array.from({ length: 8 }, () => []) },
      () => true,
    ),
    null,
  );
  assert(!worthExpanding(0.5, 0.01), "Milliseconds of compute cannot justify a sub-second gain");
  assert(!worthExpanding(10, 1), "Predicted net gain must reach five seconds");
  assert(worthExpanding(12, 100), "A predicted multi-second improvement can justify search");
  assert(!worthExpanding(20, 6000), "CPU cost and the safety margin still matter");
  const profile = tooling(base);
  const cost = movementCost(profile);
  const paths = drawing("strokes", 7, 919);
  const duration = (ps) => measure(ps, profile).travelSeconds;
  const initial = duration(paths);
  const home = profile.penHome;
  for (let i = 0; i < paths.length; i++)
    for (const length of [1, 2, 3]) {
      if (i + length > paths.length) continue;
      for (let j = 0; j <= paths.length; j++) {
        if (j >= i && j <= i + length) continue;
        const before = paths[i - 1]?.at(-1) ?? home;
        const start = paths[i][0];
        const end = paths[i + length - 1].at(-1);
        const after = paths[i + length]?.[0] ?? home;
        const left = paths[j - 1]?.at(-1) ?? home;
        const right = paths[j]?.[0] ?? home;
        const delta =
          cost(before, after) -
          cost(before, start) -
          cost(end, after) +
          cost(left, start) +
          cost(end, right) -
          cost(left, right);
        const moved = applyMove(paths, i, length, j);
        assert(Math.abs(duration(moved) - initial - delta) < 1e-8, "move delta disagrees with actual motions");
      }
    }
  const crossing = [
    [point(0, 0), point(10, 10)],
    [point(0, 10), point(10, 0)],
  ];
  assert(!auditOrder(crossing, crossing.slice().reverse(), 0).valid);
  assert(!auditOrder(crossing, [crossing[0].slice().reverse(), crossing[1]], 0).valid);
  const repeats = [[point(4, 4)], [point(4, 4)], [point(8, 8)]];
  assert(!auditOrder(repeats, repeats.slice(1), 0).valid);
  assert(auditOrder(repeats, repeats, 0).valid);
  assert(nearby(bounds([point(0, 0)]), bounds([point(0.5, 0)]), 0.5));
  assert(!nearby(bounds([point(0, 0)]), bounds([point(0.5001, 0)]), 0.5));
  for (let seed = 1; seed <= 20; seed++) {
    const tiny = drawing("strokes", 6, seed);
    let optimum = Infinity;
    for (const perm of permutations(tiny))
      if (auditOrder(tiny, perm, 0.5).valid) optimum = Math.min(optimum, duration(perm));
    const result = improve(tiny, profile, { budgetMs: 5000 });
    assert(auditOrder(tiny, result.paths, 0.5).valid);
    assert(duration(result.paths) >= optimum - 1e-8);
    assert(duration(result.paths) <= duration(tiny) + 1e-8);
    assert(Math.abs(duration(tiny) - duration(result.paths) - result.stats.savedTravelSeconds) < 1e-8);
    const again = improve(tiny, profile, { budgetMs: 5000 });
    assert.deepEqual(again.order, result.order, "fixed effort must replay deterministically");
    const bounded = improve(tiny, profile, { mode: "adaptive", probeBudgetMs: 0, budgetMs: 5000 });
    assert(
      bounded.stats.cheapTravelSeconds - bounded.stats.remainingTravelHeadroom <= optimum + 1e-8,
      "Headroom screen must not overestimate the lower bound",
    );
  }
  const random = rng(151);
  for (let trial = 0; trial < 40; trial++) {
    const ps = Array.from({ length: 30 }, () => [
      point(random() * 12, random() * 12),
      point(random() * 12, random() * 12),
    ]);
    for (const mode of ["rollout", "adaptive", "probe", "windows", "ruin"]) {
      const result = improve(ps, profile, { budgetMs: 50, mode });
      assert(auditOrder(ps, result.paths, 0.5).valid);
      assert(duration(result.paths) <= duration(ps) + 1e-8);
    }
  }
  const source = toSVG(drawing("contours", 15, 17));
  const snapshot = JSON.stringify(source);
  for (const mode of ["rollout", "adaptive", "probe", "windows", "ruin"])
    for (const options of [
      base,
      { ...base, pathJoinRadius: 0 },
      { ...base, sortPaths: false },
      { ...base, minimumPathLength: 1000 },
      { ...base, pointJoinRadius: 0.5, pathJoinRadius: 2, minimumPathLength: 2 },
      { ...base, hardware: "brushless", penHome: point(280, 190), penDownCorneringFactor: 0 },
    ]) {
      const expected = quiet(() => replan(source, options));
      const configured = quiet(() => preparePaths(source, options));
      const result = planRollout(source, options, { mode });
      assert(result.plan.duration() <= expected.duration() + 1e-8);
      if (options.sortPaths)
        assert(
          auditOrder(configured, result.paths, Math.max(0.5, options.pathJoinRadius, options.pointJoinRadius)).valid,
        );
      else assert.deepEqual(result.plan.serialize(), expected.serialize());
      const actualMotions = result.plan.serialize();
      const expectedMotions = expected.serialize();
      if (result.audit)
        for (let i = 0; i < result.audit.order.length; i++) {
          const id = result.audit.order[i];
          for (const phase of [1, 2, 3])
            assert.deepEqual(
              actualMotions[4 * i + phase],
              expectedMotions[4 * id + phase],
              "pen contact/drawing motion changed",
            );
        }
    }
  assert.equal(JSON.stringify(source), snapshot);
  const cheap = improve(paths, profile, { mode: "descent", budgetMs: 5000 });
  const disabledProbe = improve(paths, profile, { mode: "adaptive", probeBudgetMs: 0, budgetMs: 5000 });
  assert.deepEqual(disabledProbe.order, cheap.order);
  // Synthetic time scaling tests the positive gate branch; this is not a realistic performance fixture.
  const slow = planRollout(
    toSVG(drawing("dots", 60, 73)),
    { ...base, penUpMaxVelocity: 2, penUpAcceleration: 0.04 },
    { mode: "adaptive", budgetMs: 5000, probeBudgetMs: 500 },
  );
  assert(slow.stats.beamRounds > 0 && slow.stats.beamRounds < 3);
  assert(slow.stats.probeGainSeconds > 10);
  assert(slow.audit.valid);
  assert.deepEqual(improve(paths, profile, { budgetMs: 0 }).paths, paths);
  const tooLarge = Array.from({ length: 3001 }, () => [{ x: 1, y: 1 }]);
  assert.equal(improve(tooLarge, profile).paths, tooLarge);
  assert.equal(planRollout([], base).plan.duration(), quiet(() => replan([], base)).duration());
  assert.throws(() => improve(paths, profile, { clearance: -1 }));
  console.error(
    "Rollout checks passed: deltas vs motion planner, exhaustive tiny routes, proximity precedence, contacts, settings, replay, nonmutation",
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) checkRollout();
