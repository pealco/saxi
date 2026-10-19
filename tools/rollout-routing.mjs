// Offline LRBS-inspired experiment. Strokes are immutable, directed pen-contact events.
import assert from "node:assert/strict";
import { preparePaths, quiet, replan, tooling } from "./benchmark-routing-settings.mjs";
import { repairWindows, ruinRecreate } from "./neighborhood-routing.mjs";
import { first, last, motionPlan } from "./physical-routing.mjs";

export function bounds(path) {
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of path) {
    assert(Number.isFinite(p.x) && Number.isFinite(p.y));
    box[0] = Math.min(box[0], p.x);
    box[1] = Math.min(box[1], p.y);
    box[2] = Math.max(box[2], p.x);
    box[3] = Math.max(box[3], p.y);
  }
  return box;
}

export function nearby(a, b, clearance) {
  return a[0] <= b[2] + clearance && b[0] <= a[2] + clearance && a[1] <= b[3] + clearance && b[1] <= a[3] + clearance;
}

// Independent final guard, also usable to audit the older, more permissive hybrids.
export function auditOrder(configured, routed, clearance) {
  const ids = new Map();
  configured.forEach((path, i) => {
    const key = JSON.stringify(path);
    if (!ids.has(key)) ids.set(key, []);
    ids.get(key).push(i);
  });
  const order = [];
  for (const path of routed) {
    const candidates = ids.get(JSON.stringify(path));
    if (!candidates?.length) return { valid: false, reason: "directed stroke/contact changed" };
    order.push(candidates.shift());
  }
  if (order.length !== configured.length) return { valid: false, reason: "contact count changed" };
  const boxes = configured.map(bounds);
  const positions = [];
  order.forEach((id, i) => {
    positions[id] = i;
  });
  let protectedPairs = 0;
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      if (!nearby(boxes[i], boxes[j], clearance)) continue;
      protectedPairs++;
      if (positions[i] > positions[j]) return { valid: false, reason: "nearby stroke order changed" };
    }
  return { valid: true, protectedPairs, order };
}

export function context(paths, profile, clearance, expired) {
  const n = paths.length;
  const stride = n + 1;
  const cost = new Float64Array(stride * stride);
  const conflicts = Array.from({ length: n }, () => []);
  const outgoing = Array.from({ length: n }, () => []);
  const incoming = Array.from({ length: n }, () => []);
  const boxes = paths.map(bounds);
  const starts = [...paths.map(first), profile.penHome];
  const ends = [...paths.map(last), profile.penHome];
  const acceleration = profile.penUpProfile.acceleration / profile.stepsPerMm;
  const velocity = profile.penUpProfile.maximumVelocity / profile.stepsPerMm;
  const transitionDistance = (velocity * velocity) / acceleration;
  const edge = (a, b) => cost[a * stride + b];
  const insert = (list, id, value, fixed, incoming) => {
    const metric = (other) => (incoming ? cost[other * stride + fixed] : cost[fixed * stride + other]);
    if (list.length === 12 && value >= metric(list[list.length - 1])) return;
    let k = 0;
    while (k < list.length && metric(list[k]) <= value) k++;
    list.splice(k, 0, id);
    if (list.length > 12) list.pop();
  };
  for (let i = 0; i <= n; i++) {
    if (expired()) return null;
    for (let j = 0; j <= n; j++) {
      const dx = ends[i].x - starts[j].x;
      const dy = ends[i].y - starts[j].y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const value =
        distance <= transitionDistance
          ? 2 * Math.sqrt(distance / acceleration)
          : distance / velocity + velocity / acceleration;
      cost[i * stride + j] = value;
      if (i < n && j < n && i !== j) {
        insert(outgoing[i], j, value, i, false);
        insert(incoming[j], i, value, j, true);
        if (i < j && nearby(boxes[i], boxes[j], clearance)) {
          conflicts[i].push(j);
          conflicts[j].push(i);
        }
      }
    }
  }
  return { n, edge, conflicts, outgoing, incoming };
}

export function applyMove(order, i, length, j) {
  const result = order.slice();
  const block = result.splice(i, length);
  result.splice(j > i ? j - length : j, 0, ...block);
  return result;
}

function execute(order, move) {
  if (move.kind === "reverse")
    return [...order.slice(0, move.i), ...order.slice(move.i, move.j + 1).reverse(), ...order.slice(move.j + 1)];
  return applyMove(order, move.i, move.length, move.j);
}

export function routeCost(order, ctx) {
  let total = 0;
  let previous = ctx.n;
  for (const id of order) {
    total += ctx.edge(previous, id);
    previous = id;
  }
  return total + ctx.edge(previous, ctx.n);
}

function moves(order, ctx, expired, visit, lengths, reverseOrder) {
  const { n, edge, conflicts, outgoing, incoming } = ctx;
  const positions = new Int32Array(n);
  const reversePrefix = new Float64Array(n);
  const reverseLimit = new Int32Array(n);
  const update = () => {
    order.forEach((id, i) => {
      positions[id] = i;
    });
    if (!reverseOrder) return;
    reverseLimit.fill(n);
    for (let i = 0; i < n; i++) {
      if (i) reversePrefix[i] = reversePrefix[i - 1] + edge(order[i], order[i - 1]) - edge(order[i - 1], order[i]);
      for (const other of conflicts[order[i]])
        if (positions[other] > i) reverseLimit[i] = Math.min(reverseLimit[i], positions[other]);
    }
    for (let i = n - 2; i >= 0; i--) reverseLimit[i] = Math.min(reverseLimit[i], reverseLimit[i + 1]);
  };
  update();
  for (let i = 0; i < n; i++) {
    if (expired()) return;
    if (reverseOrder) {
      const before = i ? order[i - 1] : n;
      const endpoints = before === n ? order.slice(i + 1, i + 13) : outgoing[before];
      for (const id of endpoints) {
        const j = positions[id];
        if (j <= i || j >= reverseLimit[i]) continue;
        const after = order[j + 1] ?? n;
        const delta =
          edge(before, order[j]) +
          edge(order[i], after) -
          edge(before, order[i]) -
          edge(order[j], after) +
          reversePrefix[j] -
          reversePrefix[i];
        if (delta <= 0.2 && visit({ kind: "reverse", i, j, delta })) {
          update();
          break;
        }
      }
    }
    for (const length of lengths) {
      if (i + length > n) continue;
      const a = i ? order[i - 1] : n;
      const b = order[i];
      const c = order[i + length - 1];
      const d = order[i + length] ?? n;
      const removal = edge(a, d) - edge(a, b) - edge(c, d);
      const gaps = new Set([
        0,
        n,
        ...outgoing[c].map((id) => positions[id]),
        ...incoming[b].map((id) => positions[id] + 1),
      ]);
      for (const j of gaps) {
        if (j >= i && j <= i + length) continue;
        const left = j ? order[j - 1] : n;
        const right = order[j] ?? n;
        const delta = removal + edge(left, b) + edge(c, right) - edge(left, right);
        if (delta > 0.2) continue;
        const lo = Math.min(i, j);
        const hi = Math.max(i + length, j);
        let allowed = true;
        for (let k = i; k < i + length && allowed; k++)
          for (const other of conflicts[order[k]]) {
            const p = positions[other];
            if (p >= lo && p < hi && (p < i || p >= i + length)) {
              allowed = false;
              break;
            }
          }
        if (allowed && visit({ i, length, j, delta })) {
          update();
          break;
        }
      }
    }
  }
}

export const meaningfulSavingsSeconds = 5;

// Forecast half the last gain, requiring five net seconds and a 2x margin over predicted CPU cost.
export function worthExpanding(gainSeconds, estimatedMs) {
  return gainSeconds / 2 - estimatedMs / 1000 >= meaningfulSavingsSeconds && gainSeconds * 1000 > 4 * estimatedMs;
}

function travelLowerBound(ctx) {
  const { n, edge, outgoing, incoming } = ctx;
  let out = 0;
  let into = 0;
  let homeOut = Infinity;
  let homeIn = Infinity;
  for (let i = 0; i < n; i++) {
    out += Math.min(edge(i, outgoing[i][0]), edge(i, n));
    into += Math.min(edge(incoming[i][0], i), edge(n, i));
    homeOut = Math.min(homeOut, edge(n, i));
    homeIn = Math.min(homeIn, edge(i, n));
  }
  return Math.max(out + homeOut, into + homeIn);
}

function keepBranch(branches, move, limit) {
  if (branches.length === limit && move.delta >= branches.at(-1).delta) return;
  branches.push(move);
  branches.sort((a, b) => a.delta - b.delta);
  if (branches.length > limit) branches.pop();
}

// Deterministic heuristic policy replaces LRBS's trained stochastic policy.
export function improve(
  paths,
  profile,
  {
    clearance = 0.5,
    budgetMs = 500,
    beamWidth = 3,
    rolloutPasses = 2,
    rounds = 3,
    mode = "rollout",
    lengths = [1, 2, 3],
    reverseOrder = true,
    probeBudgetMs = 50,
    maxStrokes = 3000,
    windowSize = 12,
    windowPasses = 2,
    iterations = 300,
    removalSize = 32,
    contextFactory = context,
    repair = ruinRecreate,
  } = {},
) {
  assert(clearance >= 0 && Number.isFinite(clearance));
  assert(budgetMs >= 0 && Number.isFinite(budgetMs));
  assert(["rollout", "descent", "adaptive", "probe", "windows", "ruin"].includes(mode));
  assert(Number.isInteger(maxStrokes) && maxStrokes >= 3 && maxStrokes <= 6000);
  assert(Number.isFinite(probeBudgetMs) && probeBudgetMs >= 0);
  const started = performance.now();
  let timedOut = false;
  let phaseDeadline = Infinity;
  const expired = () => {
    const now = performance.now();
    timedOut ||= now - started >= budgetMs;
    return timedOut || now >= phaseDeadline;
  };
  const original = paths.map((_, i) => i);
  const stats = { scans: 0, expansions: 0, accepted: 0, timedOut: false, beamRounds: 0 };
  // shortcut: dense transitions use 72 MB at 3,000 strokes; large-job experiments allow 6,000 (288 MB).
  if (paths.length < 3 || paths.length > maxStrokes || !budgetMs) return { paths, order: original, stats };
  const ctx = contextFactory(paths, profile, clearance, expired);
  if (!ctx) return { paths, order: original, stats: { ...stats, timedOut } };
  const initialCost = routeCost(original, ctx);
  let best = { order: original, score: initialCost };
  let lastScanMs = 0;
  let terminalBranches = null;
  const gated = mode === "adaptive" || mode === "probe";
  const descend = (initial, passes, collect = false) => {
    const order = initial.slice();
    for (let pass = 0; pass < passes && !expired(); pass++) {
      const scanStarted = performance.now();
      const branches = [];
      let changed = false;
      stats.scans++;
      moves(
        order,
        ctx,
        expired,
        (move) => {
          if (move.delta >= -1e-9) {
            if (collect) keepBranch(branches, move, beamWidth * 4);
            return false;
          }
          order.splice(0, order.length, ...execute(order, move));
          changed = true;
          stats.accepted++;
          return true;
        },
        lengths,
        reverseOrder,
      );
      lastScanMs = performance.now() - scanStarted;
      if (collect && !changed && !expired()) terminalBranches = branches;
      if (!changed) break;
    }
    const node = { order, score: routeCost(order, ctx) };
    if (node.score < best.score - 1e-9) best = node;
    return node;
  };
  const descentStarted = performance.now();
  const cheap = descend(original, 20, gated);
  stats.descentMs = performance.now() - descentStarted;
  stats.cheapTravelSeconds = cheap.score;
  if (mode === "windows") {
    const repaired = repairWindows(cheap.order, ctx, expired, { windowSize, windowPasses });
    Object.assign(stats, repaired.stats);
    const score = routeCost(repaired.order, ctx);
    if (score < best.score - 1e-9) best = { order: repaired.order, score };
  }
  if (mode === "ruin") {
    phaseDeadline = started + budgetMs - Math.min(1000, Math.max(100, stats.descentMs * 2));
    const repaired = repair(cheap.order, ctx, expired, { iterations, removalSize });
    Object.assign(stats, repaired.stats);
    stats.repairTruncated = performance.now() >= phaseDeadline;
    phaseDeadline = Infinity;
    descend(repaired.order, 20);
  }
  let beam = [cheap];
  const seen = new Set([beam[0].order.join(",")]);
  let marginalGain = 0;
  let runBeam = mode === "rollout";
  if (gated) {
    stats.probeEstimateMs = (1 + beamWidth * rolloutPasses) * lastScanMs;
    stats.remainingTravelHeadroom = Math.max(0, cheap.score - travelLowerBound(ctx));
    stats.decision = "probe-too-expensive";
    if (stats.remainingTravelHeadroom < meaningfulSavingsSeconds) stats.decision = "headroom-below-five-seconds";
    else if (!terminalBranches?.length) stats.decision = "no-proposal-or-unfinished-descent";
    else if (probeBudgetMs > 0 && stats.probeEstimateMs <= probeBudgetMs && !expired()) {
      const probeStarted = performance.now();
      phaseDeadline = Math.min(started + budgetMs, probeStarted + probeBudgetMs);
      const probes = [];
      for (const move of terminalBranches) {
        if (expired() || probes.length >= beamWidth) break;
        const child = execute(cheap.order, move);
        const key = child.join(",");
        if (seen.has(key)) continue;
        seen.add(key);
        probes.push(descend(child, rolloutPasses));
      }
      stats.probeMs = performance.now() - probeStarted;
      stats.probeBranches = probes.length;
      stats.probeTruncated = performance.now() >= phaseDeadline;
      phaseDeadline = Infinity;
      marginalGain = cheap.score - best.score;
      stats.probeGainSeconds = marginalGain;
      beam = [...new Map([best, ...probes].map((node) => [node.order.join(","), node])).values()]
        .sort((a, b) => a.score - b.score)
        .slice(0, beamWidth);
      stats.nextRoundEstimateMs = beam.length * (1 + beamWidth * rolloutPasses) * lastScanMs;
      runBeam = mode === "adaptive" && !stats.probeTruncated && worthExpanding(marginalGain, stats.nextRoundEstimateMs);
      stats.decision = runBeam ? "expand" : "stop-after-probe";
    }
  }
  if (runBeam)
    for (let round = 0; round < rounds - (gated ? 1 : 0) && !expired(); round++) {
      if (gated && !worthExpanding(marginalGain, beam.length * (1 + beamWidth * rolloutPasses) * lastScanMs)) break;
      const previousBest = best.score;
      stats.beamRounds++;
      const candidates = [best];
      for (const node of beam) {
        const branches = [];
        stats.scans++;
        moves(
          node.order,
          ctx,
          expired,
          (move) => {
            keepBranch(branches, move, beamWidth * 4);
            return false;
          },
          lengths,
          reverseOrder,
        );
        let expanded = 0;
        for (const move of branches) {
          if (expired() || expanded >= beamWidth) break;
          const child = execute(node.order, move);
          const key = child.join(",");
          if (seen.has(key)) continue;
          seen.add(key);
          expanded++;
          stats.expansions++;
          // Retain reached rollout states as the next beam, as in LRBS Algorithm 1.
          candidates.push(descend(child, rolloutPasses));
        }
      }
      const unique = new Map(candidates.map((node) => [node.order.join(","), node]));
      beam = [...unique.values()].sort((a, b) => a.score - b.score).slice(0, beamWidth);
      marginalGain = previousBest - best.score;
    }
  stats.timedOut = timedOut;
  stats.savedTravelSeconds = initialCost - best.score;
  return { paths: best.order.map((i) => paths[i]), order: best.order, stats };
}

function pack(result) {
  const transfer = result.plan.toTransferable();
  const buffers = transfer.filter((m) => m.type === "xy").flatMap((m) => [m.cols, m.ts, m.ss]);
  return { ...result, plan: result.plan.constructor.fromTransferable(transfer), transferBufferCount: buffers.length };
}

export function planRollout(input, options, search = {}) {
  return quiet(() => {
    if (!options.sortPaths) return pack({ plan: replan(input, options), selected: "current", stats: {} });
    const configured = preparePaths(input, options);
    const profile = tooling(options);
    const baseline = motionPlan(configured, profile);
    if (configured.length < 3 || configured.length > (search.maxStrokes ?? 3000))
      return pack({ plan: baseline, paths: configured, selected: "current", stats: { bypass: true } });
    const clearance = search.clearance ?? Math.max(0.5, options.pointJoinRadius, options.pathJoinRadius);
    const budgetMs =
      search.deadlineEpochMs === undefined
        ? search.budgetMs
        : Math.max(0, search.deadlineEpochMs - (performance.timeOrigin + performance.now()) - 300);
    const result = improve(configured, profile, { ...search, budgetMs, clearance });
    const candidate = result.order.every((id, i) => id === i) ? baseline : motionPlan(result.paths, profile);
    assert(Number.isFinite(candidate.duration()));
    const useCandidate = candidate.duration() < baseline.duration() - 1e-9;
    const finalPaths = useCandidate ? result.paths : configured;
    const audit = auditOrder(configured, finalPaths, clearance);
    assert(audit.valid, audit.reason);
    return pack({
      plan: useCandidate ? candidate : baseline,
      paths: finalPaths,
      selected: useCandidate ? (search.mode ?? "rollout") : "current",
      stats: result.stats,
      clearance,
      audit,
    });
  });
}
