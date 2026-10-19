// Research kernels: preserve the reference search's candidate order, RNG and double precision.
import assert from "node:assert/strict";
import { bounds, nearby } from "./rollout-routing.mjs";

export async function loadWasm(bytes) {
  const runtime = { expired: () => false };
  const { instance } = await WebAssembly.instantiate(bytes, {
    env: { expired: () => Number(runtime.expired()), exp: Math.exp },
  });
  runtime.exports = instance.exports;
  return runtime;
}

export function fastContext(paths, profile, clearance, expired, wasm) {
  const n = paths.length;
  const stride = n + 1;
  const k = Math.min(12, n - 1);
  const boxes = paths.map(bounds);
  const conflicts = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) {
    if (expired()) return null;
    for (let j = i + 1; j < n; j++)
      if (nearby(boxes[i], boxes[j], clearance)) {
        conflicts[i].push(j);
        conflicts[j].push(i);
      }
  }
  const offsets = new Int32Array(stride);
  for (let i = 0; i < n; i++) offsets[i + 1] = offsets[i] + conflicts[i].length;
  let cursor = wasm ? Number(wasm.exports.__heap_base.value) : 0;
  const locations = {};
  const reserve = (name, Type, length) => {
    cursor = Math.ceil(cursor / 8) * 8;
    locations[name] = { Type, length, offset: cursor };
    cursor += Type.BYTES_PER_ELEMENT * length;
  };
  for (const name of ["sx", "sy", "ex", "ey"]) reserve(name, Float64Array, stride);
  reserve("cost", Float64Array, stride * stride);
  for (const name of ["out", "into"]) reserve(name, Int32Array, n * k);
  reserve("offsets", Int32Array, stride);
  reserve("conflictIds", Int32Array, offsets[n]);
  reserve("order", Int32Array, n);
  reserve("scratch", Int32Array, 9 * stride);
  reserve("stats", Float64Array, 4);
  if (wasm) {
    const extra = Math.ceil((cursor - wasm.exports.memory.buffer.byteLength) / 65536);
    if (extra > 0) wasm.exports.memory.grow(extra);
  }
  const data = Object.fromEntries(
    Object.entries(locations).map(([name, { Type, length, offset }]) => [
      name,
      wasm ? new Type(wasm.exports.memory.buffer, offset, length) : new Type(length),
    ]),
  );
  for (let i = 0; i <= n; i++) {
    const first = i === n ? profile.penHome : paths[i][0];
    const last = i === n ? profile.penHome : paths[i].at(-1);
    data.sx[i] = first.x;
    data.sy[i] = first.y;
    data.ex[i] = last.x;
    data.ey[i] = last.y;
  }
  data.offsets.set(offsets);
  for (let i = 0; i < n; i++) data.conflictIds.set(conflicts[i], offsets[i]);
  const a = profile.penUpProfile.acceleration / profile.stepsPerMm;
  const v = profile.penUpProfile.maximumVelocity / profile.stepsPerMm;
  const ptr = (name) => locations[name].offset;
  if (wasm) {
    wasm.expired = expired;
    if (!wasm.exports.build(n, ptr("sx"), ptr("sy"), ptr("ex"), ptr("ey"), a, v, ptr("cost"), ptr("out"), ptr("into")))
      return null;
  } else {
    const { sx, sy, ex, ey, cost, out, into } = data;
    const threshold = (v * v) / a;
    for (let i = 0; i <= n; i++) {
      if (expired()) return null;
      for (let j = 0; j <= n; j++) {
        const dx = ex[i] - sx[j];
        const dy = ey[i] - sy[j];
        const d = Math.sqrt(dx * dx + dy * dy);
        cost[i * stride + j] = d <= threshold ? 2 * Math.sqrt(d / a) : d / v + v / a;
      }
    }
    const insert = (list, base, id, fixed, incoming, count) => {
      const metric = (other) => (incoming ? cost[other * stride + fixed] : cost[fixed * stride + other]);
      const value = metric(id);
      if (count === k && value >= metric(list[base + k - 1])) return;
      let at = 0;
      while (at < count && metric(list[base + at]) <= value) at++;
      for (let j = Math.min(count, k - 1); j > at; j--) list[base + j] = list[base + j - 1];
      list[base + at] = id;
    };
    for (let i = 0; i < n; i++) {
      if (expired()) return null;
      let count = 0;
      for (let j = 0; j < n; j++)
        if (i !== j) {
          insert(out, i * k, j, i, false, count);
          insert(into, i * k, j, i, true, count);
          count = Math.min(k, count + 1);
        }
    }
  }
  return {
    n,
    k,
    ...data,
    ptr,
    wasm,
    conflicts,
    edge: (a, b) => data.cost[a * stride + b],
    outgoing: Array.from({ length: n }, (_, i) => data.out.subarray(i * k, (i + 1) * k)),
    incoming: Array.from({ length: n }, (_, i) => data.into.subarray(i * k, (i + 1) * k)),
  };
}

export function fastRepair(initial, ctx, expired, { iterations = 300, removalSize = 32 } = {}) {
  assert(Number.isInteger(iterations) && iterations >= 0);
  assert(Number.isInteger(removalSize) && removalSize > 0 && removalSize <= 64);
  const { n, k, cost, out, into, offsets, conflictIds } = ctx;
  const stride = n + 1;
  const count = Math.min(removalSize, n);
  iterations = Math.min(iterations, n);
  if (ctx.wasm) {
    ctx.order.set(initial);
    ctx.wasm.expired = expired;
    ctx.wasm.exports.search(
      n,
      ctx.ptr("cost"),
      ctx.ptr("out"),
      ctx.ptr("into"),
      ctx.ptr("offsets"),
      ctx.ptr("conflictIds"),
      ctx.ptr("order"),
      iterations,
      count,
      ctx.ptr("scratch"),
      ctx.ptr("stats"),
    );
    return {
      order: Array.from(ctx.order),
      stats: {
        repairs: ctx.stats[0],
        failedRepairs: ctx.stats[1],
        improvedRepairs: ctx.stats[2],
        repairGainSeconds: ctx.stats[3],
      },
    };
  }
  const current = Int32Array.from(initial);
  const best = Int32Array.from(initial);
  const kept = new Int32Array(n);
  const positions = new Int32Array(n);
  const pending = new Uint8Array(n);
  const anchors = new Int32Array(stride);
  const anchorMark = new Uint8Array(stride);
  const gapMark = new Int32Array(stride);
  const gaps = new Int32Array(stride);
  const selected = new Int32Array(count);
  const ranks = new Float64Array(count);
  let state = 8675309;
  let generation = 0;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const edge = (a, b) => cost[a * stride + b];
  const score = (order) => {
    let total = edge(n, order[0]) + edge(order[n - 1], n);
    for (let i = 1; i < n; i++) total += edge(order[i - 1], order[i]);
    return total;
  };
  let currentCost = score(current);
  let bestCost = currentCost;
  const initialCost = currentCost;
  const stats = { repairs: 0, failedRepairs: 0, improvedRepairs: 0 };
  for (let iteration = 0; iteration < iterations && !expired(); iteration++) {
    const seedIndex = Math.floor(random() * n);
    const seed = current[seedIndex];
    if (iteration % 4 === 0) for (let i = 0; i < count; i++) selected[i] = current[(seedIndex + i) % n];
    else {
      let length = 0;
      for (let i = 0; i < n; i++) {
        const id = current[i];
        const rank = edge(seed, id) + edge(id, seed) + random() * 0.1;
        if (length === count && rank >= ranks[count - 1]) continue;
        let at = 0;
        while (at < length && ranks[at] <= rank) at++;
        for (let j = Math.min(length, count - 1); j > at; j--) {
          ranks[j] = ranks[j - 1];
          selected[j] = selected[j - 1];
        }
        ranks[at] = rank;
        selected[at] = id;
        length = Math.min(count, length + 1);
      }
    }
    pending.fill(0);
    anchorMark.fill(0);
    positions.fill(-1);
    for (const id of selected) pending[id] = 1;
    let keptLength = 0;
    let anchorLength = 0;
    const anchor = (id) => {
      if (!anchorMark[id]) {
        anchorMark[id] = 1;
        anchors[anchorLength++] = id;
      }
    };
    anchor(n);
    for (let i = 0; i < n; i++) {
      const id = current[i];
      if (pending[id]) {
        if (i && !pending[current[i - 1]]) anchor(current[i - 1]);
        if (i + 1 < n && !pending[current[i + 1]]) anchor(current[i + 1]);
      } else {
        positions[id] = keptLength;
        kept[keptLength++] = id;
      }
    }
    let failed = false;
    for (let remaining = count; remaining > 0; remaining--) {
      if (expired()) {
        failed = true;
        break;
      }
      let chosen = -1;
      let chosenGap = -1;
      let chosenRegret = -Infinity;
      let chosenBest = Infinity;
      for (const id of selected) {
        if (!pending[id]) continue;
        let lo = 0;
        let hi = keptLength;
        let eligible = true;
        for (let c = offsets[id]; c < offsets[id + 1]; c++) {
          const other = conflictIds[c];
          if (pending[other]) {
            if (other < id) {
              eligible = false;
              break;
            }
          } else if (other < id) lo = Math.max(lo, positions[other] + 1);
          else hi = Math.min(hi, positions[other]);
        }
        if (!eligible || lo > hi) continue;
        generation++;
        let gapLength = 0;
        const gap = (j) => {
          if (gapMark[j] !== generation) {
            gapMark[j] = generation;
            gaps[gapLength++] = j;
          }
        };
        gap(lo);
        gap(hi);
        const neighbor = (other) => {
          if (other !== n && positions[other] >= 0) {
            gap(positions[other]);
            gap(positions[other] + 1);
          }
        };
        for (let j = 0; j < k; j++) neighbor(into[id * k + j]);
        for (let j = 0; j < k; j++) neighbor(out[id * k + j]);
        for (let j = 0; j < anchorLength; j++) neighbor(anchors[j]);
        let first = Infinity;
        let second = Infinity;
        let at = -1;
        for (let g = 0; g < gapLength; g++) {
          const j = gaps[g];
          if (j < lo || j > hi) continue;
          const a = j ? kept[j - 1] : n;
          const b = j < keptLength ? kept[j] : n;
          const delta = edge(a, id) + edge(id, b) - edge(a, b);
          if (delta < first) {
            second = first;
            first = delta;
            at = j;
          } else if (delta < second) second = delta;
        }
        const regret = second - first;
        if (chosen < 0 || regret > chosenRegret || (regret === chosenRegret && first < chosenBest)) {
          chosen = id;
          chosenGap = at;
          chosenRegret = regret;
          chosenBest = first;
        }
      }
      if (chosen < 0) {
        failed = true;
        break;
      }
      for (let j = keptLength; j > chosenGap; j--) {
        kept[j] = kept[j - 1];
        positions[kept[j]] = j;
      }
      kept[chosenGap] = chosen;
      positions[chosen] = chosenGap;
      keptLength++;
      pending[chosen] = 0;
      anchor(chosen);
    }
    stats.repairs++;
    if (failed) {
      stats.failedRepairs++;
      continue;
    }
    const value = score(kept);
    if (value < bestCost - 1e-9) {
      best.set(kept);
      bestCost = value;
      stats.improvedRepairs++;
    }
    const temperature = 0.05 * (1 - iteration / iterations);
    if (value < currentCost || random() < Math.exp((currentCost - value) / temperature)) {
      current.set(kept);
      currentCost = value;
    }
  }
  stats.repairGainSeconds = initialCost - bestCost;
  return { order: Array.from(best), stats };
}
