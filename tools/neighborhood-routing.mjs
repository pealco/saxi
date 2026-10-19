// Directed large-neighborhood repairs. No stroke geometry or pen-contact event is changed.
import assert from "node:assert/strict";

// Ruin/recreate uses baseline IDs as the precedence order, even after many accepted rearrangements.
export function regretRepair(order, removedIds, ctx, expired = () => false) {
  const pending = new Set(removedIds);
  const kept = order.filter((id) => !pending.has(id));
  const anchors = new Set([ctx.n]);
  for (let i = 0; i < order.length; i++)
    if (pending.has(order[i])) {
      if (i && !pending.has(order[i - 1])) anchors.add(order[i - 1]);
      if (i + 1 < order.length && !pending.has(order[i + 1])) anchors.add(order[i + 1]);
    }
  const positions = new Int32Array(ctx.n);
  while (pending.size) {
    if (expired()) return null;
    positions.fill(-1);
    kept.forEach((id, i) => {
      positions[id] = i;
    });
    let choice = null;
    for (const id of pending) {
      let lo = 0;
      let hi = kept.length;
      let eligible = true;
      for (const other of ctx.conflicts[id]) {
        if (pending.has(other)) {
          if (other < id) {
            eligible = false;
            break;
          }
        } else if (other < id) lo = Math.max(lo, positions[other] + 1);
        else hi = Math.min(hi, positions[other]);
      }
      if (!eligible || lo > hi) continue;
      const gaps = new Set([lo, hi]);
      for (const other of [...ctx.incoming[id], ...ctx.outgoing[id], ...anchors]) {
        if (other === ctx.n || positions[other] < 0) continue;
        gaps.add(positions[other]);
        gaps.add(positions[other] + 1);
      }
      let best = Infinity;
      let second = Infinity;
      let gap = -1;
      for (const j of gaps) {
        if (j < lo || j > hi) continue;
        const a = kept[j - 1] ?? ctx.n;
        const b = kept[j] ?? ctx.n;
        const delta = ctx.edge(a, id) + ctx.edge(id, b) - ctx.edge(a, b);
        if (delta < best) {
          second = best;
          best = delta;
          gap = j;
        } else if (delta < second) second = delta;
      }
      const regret = second - best;
      if (!choice || regret > choice.regret || (regret === choice.regret && best < choice.best))
        choice = { id, gap, regret, best };
    }
    // A greedy placement may block a later precedence chain; discard the entire incomplete repair.
    if (!choice) return null;
    kept.splice(choice.gap, 0, choice.id);
    pending.delete(choice.id);
    anchors.add(choice.id);
  }
  return kept;
}

export function ruinRecreate(initial, ctx, expired, { iterations = 300, removalSize = 32 } = {}) {
  assert(Number.isInteger(iterations) && iterations >= 0);
  assert(Number.isInteger(removalSize) && removalSize > 0 && removalSize <= 64);
  iterations = Math.min(iterations, initial.length);
  let state = 8675309;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const cost = (order) => {
    let total = ctx.edge(ctx.n, order[0]) + ctx.edge(order.at(-1), ctx.n);
    for (let i = 1; i < order.length; i++) total += ctx.edge(order[i - 1], order[i]);
    return total;
  };
  let current = initial.slice();
  let currentCost = cost(current);
  let best = current;
  let bestCost = currentCost;
  const stats = { repairs: 0, failedRepairs: 0, improvedRepairs: 0 };
  const count = Math.min(removalSize, initial.length);
  for (let iteration = 0; iteration < iterations && !expired(); iteration++) {
    let selected;
    const seedIndex = Math.floor(random() * current.length);
    const seed = current[seedIndex];
    if (iteration % 4 === 0)
      selected = Array.from({ length: count }, (_, i) => current[(seedIndex + i) % current.length]);
    else {
      const related = current.map((id) => ({ id, rank: ctx.edge(seed, id) + ctx.edge(id, seed) + random() * 0.1 }));
      related.sort((a, b) => a.rank - b.rank);
      selected = related.slice(0, count).map((v) => v.id);
    }
    const repaired = regretRepair(current, selected, ctx, expired);
    stats.repairs++;
    if (!repaired) {
      stats.failedRepairs++;
      continue;
    }
    const score = cost(repaired);
    if (score < bestCost - 1e-9) {
      best = repaired;
      bestCost = score;
      stats.improvedRepairs++;
    }
    const temperature = 0.05 * (1 - iteration / iterations);
    if (score < currentCost || random() < Math.exp((currentCost - score) / temperature)) {
      current = repaired;
      currentCost = score;
    }
  }
  stats.repairGainSeconds = cost(initial) - bestCost;
  return { order: best, stats };
}

export function exactWindow(ids, before, after, ctx, expired = () => false) {
  const k = ids.length;
  assert(k > 0 && k <= 16);
  const full = (1 << k) - 1;
  const dp = new Float64Array((full + 1) * k).fill(Infinity);
  const parent = new Int8Array(dp.length).fill(-1);
  const predecessors = new Int32Array(k);
  const costs = ids.map((a) => ids.map((b) => ctx.edge(a, b)));
  const local = new Map(ids.map((id, i) => [id, i]));
  for (let j = 0; j < k; j++) {
    for (const id of ctx.conflicts[ids[j]]) if (id < ids[j] && local.has(id)) predecessors[j] |= 1 << local.get(id);
    if (!predecessors[j]) dp[(1 << j) * k + j] = ctx.edge(before, ids[j]);
  }
  for (let mask = 1; mask <= full; mask++) {
    if ((mask & 127) === 0 && expired()) return null;
    let eligible = 0;
    for (let j = 0; j < k; j++)
      if (!(mask & (1 << j)) && (mask & predecessors[j]) === predecessors[j]) eligible |= 1 << j;
    for (let bits = mask; bits; bits &= bits - 1) {
      const i = 31 - Math.clz32(bits & -bits);
      const value = dp[mask * k + i];
      if (!Number.isFinite(value)) continue;
      for (let next = eligible; next; next &= next - 1) {
        const j = 31 - Math.clz32(next & -next);
        const index = (mask | (1 << j)) * k + j;
        const candidate = value + costs[i][j];
        if (candidate < dp[index]) {
          dp[index] = candidate;
          parent[index] = i;
        }
      }
    }
  }
  let last = -1;
  let score = Infinity;
  for (let i = 0; i < k; i++) {
    const candidate = dp[full * k + i] + ctx.edge(ids[i], after);
    if (candidate < score) {
      score = candidate;
      last = i;
    }
  }
  assert(last >= 0, "A feasible incumbent window must have a feasible repair");
  const order = [];
  let mask = full;
  while (last >= 0) {
    order.push(ids[last]);
    const previous = parent[mask * k + last];
    mask ^= 1 << last;
    last = previous;
  }
  return { order: order.reverse(), score };
}

export function repairWindows(initial, ctx, expired, { windowSize = 12, windowPasses = 2 } = {}) {
  assert(Number.isInteger(windowSize) && windowSize >= 3 && windowSize <= 16);
  const order = initial.slice();
  const stats = { windows: 0, repaired: 0, repairGainSeconds: 0 };
  for (let pass = 0; pass < windowPasses && !expired(); pass++) {
    const offset = pass % 2 ? Math.floor(windowSize / 2) : 0;
    for (let start = offset; start < order.length && !expired(); start += windowSize) {
      const ids = order.slice(start, start + windowSize);
      if (ids.length < 3) continue;
      const before = order[start - 1] ?? ctx.n;
      const after = order[start + ids.length] ?? ctx.n;
      let old = ctx.edge(before, ids[0]) + ctx.edge(ids.at(-1), after);
      for (let i = 1; i < ids.length; i++) old += ctx.edge(ids[i - 1], ids[i]);
      const result = exactWindow(ids, before, after, ctx, expired);
      if (!result) break;
      stats.windows++;
      if (result.score < old - 1e-9) {
        order.splice(start, ids.length, ...result.order);
        stats.repaired++;
        stats.repairGainSeconds += old - result.score;
      }
    }
  }
  return { order, stats };
}
