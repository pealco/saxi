import type { PlanOptions } from "./planning.js";
import { kernelBase64 } from "./routing-wasm.js";
import type { Vec2 } from "./vec.js";

type Box = [number, number, number, number];
type Kernel = WebAssembly.Exports & {
  memory: WebAssembly.Memory;
  __heap_base: WebAssembly.Global;
  build: (...args: number[]) => number;
  search: (...args: number[]) => void;
};
type Context = {
  n: number;
  edge: (a: number, b: number) => number;
  conflicts: Int32Array[];
  outgoing: Int32Array[];
  incoming: Int32Array[];
};
type Move = { i: number; j: number; delta: number } & ({ kind: "reverse" } | { kind?: undefined; length: number });

let compiledKernel: Promise<WebAssembly.Module> | undefined;

function bounds(path: Vec2[]): Box {
  if (!path.length) throw new Error("Cannot route an empty stroke");
  const box: Box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of path) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) throw new Error("Nonfinite routing coordinate");
    box[0] = Math.min(box[0], p.x);
    box[1] = Math.min(box[1], p.y);
    box[2] = Math.max(box[2], p.x);
    box[3] = Math.max(box[3], p.y);
  }
  return box;
}

function nearby(a: Box, b: Box, clearance: number) {
  return a[0] <= b[2] + clearance && b[0] <= a[2] + clearance && a[1] <= b[3] + clearance && b[1] <= a[3] + clearance;
}

function routeCost(order: number[], ctx: Context) {
  let total = 0;
  let previous = ctx.n;
  for (const id of order) {
    total += ctx.edge(previous, id);
    previous = id;
  }
  return total + ctx.edge(previous, ctx.n);
}

// Only permute whole, directed strokes after all drawing settings have been applied.
export async function optimizePaths(paths: Vec2[][], options: PlanOptions, deadline: number): Promise<Vec2[][]> {
  const n = paths.length;
  // shortcut: dense transitions need up to 288 MB; use a sparse search before lifting the 6,000-stroke cap.
  if (!options.sortPaths || n < 3 || n > 6000 || performance.now() >= deadline) return paths;
  const clearance = Math.max(0.5, options.pointJoinRadius, options.pathJoinRadius);
  const a = options.penUpAcceleration;
  const v = options.penUpMaxVelocity;
  if (![a, v].every((value) => Number.isFinite(value) && value > 0) || !Number.isFinite(clearance))
    throw new Error("Invalid routing motion profile");
  if (![options.penHome.x, options.penHome.y].every(Number.isFinite)) throw new Error("Invalid routing home");
  const boxes = paths.map(bounds);
  let phaseDeadline = deadline;
  const expired = () => performance.now() >= phaseDeadline;
  const stride = n + 1;
  const k = Math.min(12, n - 1);
  const offsets = new Int32Array(stride);
  // Count first, then fill CSR directly: dense conflicts must not also live in JS arrays.
  for (let i = 0; i < n; i++) {
    if (expired()) return paths;
    for (let j = i + 1; j < n; j++) {
      if (!nearby(boxes[i], boxes[j], clearance)) continue;
      offsets[i + 1]++;
      offsets[j + 1]++;
    }
  }
  for (let i = 0; i < n; i++) offsets[i + 1] += offsets[i];
  if (offsets[n] === n * (n - 1)) return paths;
  compiledKernel ??= WebAssembly.compile(Uint8Array.from(atob(kernelBase64), (c) => c.charCodeAt(0)));
  const module = await compiledKernel;
  if (expired()) return paths;
  // Cache code, not the large linear memory: every plan gets a reclaimable instance.
  const kernel = new WebAssembly.Instance(module, {
    env: { expired: () => Number(expired()), exp: Math.exp },
  }).exports as Kernel;
  let cursor = Number(kernel.__heap_base.value);
  const reserve = (bytes: number) => {
    const offset = Math.ceil(cursor / 8) * 8;
    cursor = offset + bytes;
    return offset;
  };
  const sx = reserve(stride * 8);
  const sy = reserve(stride * 8);
  const ex = reserve(stride * 8);
  const ey = reserve(stride * 8);
  const cost = reserve(stride * stride * 8);
  const out = reserve(n * k * 4);
  const into = reserve(n * k * 4);
  const conflictOffsets = reserve(stride * 4);
  const conflictIds = reserve(offsets[n] * 4);
  const orderPtr = reserve(n * 4);
  const scratch = reserve(9 * stride * 4);
  const stats = reserve(4 * 8);
  const extra = Math.ceil((cursor - kernel.memory.buffer.byteLength) / 65536);
  if (extra > 0) kernel.memory.grow(extra);
  const floats = (offset: number, length: number) => new Float64Array(kernel.memory.buffer, offset, length);
  const ints = (offset: number, length: number) => new Int32Array(kernel.memory.buffer, offset, length);
  const startsX = floats(sx, stride);
  const startsY = floats(sy, stride);
  const endsX = floats(ex, stride);
  const endsY = floats(ey, stride);
  for (let i = 0; i <= n; i++) {
    const first = i === n ? options.penHome : paths[i][0];
    const last = i === n ? options.penHome : paths[i][paths[i].length - 1];
    startsX[i] = first.x;
    startsY[i] = first.y;
    endsX[i] = last.x;
    endsY[i] = last.y;
  }
  ints(conflictOffsets, stride).set(offsets);
  const ids = ints(conflictIds, offsets[n]);
  const next = offsets.slice();
  for (let i = 0; i < n; i++) {
    if (expired()) return paths;
    for (let j = i + 1; j < n; j++) {
      if (!nearby(boxes[i], boxes[j], clearance)) continue;
      ids[next[i]++] = j;
      ids[next[j]++] = i;
    }
  }
  if (!kernel.build(n, sx, sy, ex, ey, a, v, cost, out, into)) return paths;
  const costs = floats(cost, stride * stride);
  for (let i = 0; i <= n; i++) {
    if (expired()) return paths;
    for (let j = 0; j <= n; j++) if (!Number.isFinite(costs[i * stride + j])) throw new Error("Nonfinite routing cost");
  }
  const ctx: Context = {
    n,
    edge: (a, b) => costs[a * stride + b],
    conflicts: Array.from({ length: n }, (_, i) => ids.subarray(offsets[i], offsets[i + 1])),
    outgoing: Array.from({ length: n }, (_, i) => ints(out + i * k * 4, k)),
    incoming: Array.from({ length: n }, (_, i) => ints(into + i * k * 4, k)),
  };
  const original = paths.map((_, i) => i);
  let best = original;
  let bestCost = routeCost(original, ctx);
  // Independent incoming/outgoing minima are optimistic; skip work that cannot save five seconds.
  let lowerOut = 0;
  let lowerIn = 0;
  let homeOut = Infinity;
  let homeIn = Infinity;
  for (let i = 0; i < n; i++) {
    lowerOut += Math.min(ctx.edge(i, ctx.outgoing[i][0]), ctx.edge(i, n));
    lowerIn += Math.min(ctx.edge(ctx.incoming[i][0], i), ctx.edge(n, i));
    homeOut = Math.min(homeOut, ctx.edge(n, i));
    homeIn = Math.min(homeIn, ctx.edge(i, n));
  }
  if (bestCost - Math.max(lowerOut + homeOut, lowerIn + homeIn) < 5) return paths;
  const descend = (initial: number[]) => {
    const order = initial.slice();
    for (let pass = 0; pass < 20 && !expired(); pass++) {
      let changed = false;
      moves(order, ctx, expired, (move) => {
        if (move.delta >= -1e-9) return false;
        if (move.kind === "reverse") {
          const block = order.slice(move.i, move.j + 1).reverse();
          order.splice(move.i, block.length, ...block);
        } else {
          const block = order.splice(move.i, move.length);
          order.splice(move.j > move.i ? move.j - move.length : move.j, 0, ...block);
        }
        changed = true;
        return true;
      });
      if (!changed) break;
    }
    const score = routeCost(order, ctx);
    if (score < bestCost - 1e-9) {
      best = order;
      bestCost = score;
    }
    return order;
  };
  const descentStarted = performance.now();
  const cheap = descend(original);
  phaseDeadline = deadline - Math.min(1000, Math.max(100, (performance.now() - descentStarted) * 2));
  const order = ints(orderPtr, n);
  order.set(cheap);
  kernel.search(n, cost, out, into, conflictOffsets, conflictIds, orderPtr, n, Math.min(32, n), scratch, stats);
  phaseDeadline = deadline;
  descend(Array.from(order));
  if (best === original) return paths;
  // Audit independently of the kernel's conflict buffers before accepting its permutation.
  const positions = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const id = best[i];
    if (!Number.isInteger(id) || id < 0 || id >= n || positions[id] !== -1)
      throw new Error("Invalid route permutation");
    positions[id] = i;
  }
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++)
      if (positions[i] > positions[j] && nearby(boxes[i], boxes[j], clearance))
        throw new Error("Route changed nearby stroke order");
  return best.map((id) => paths[id]);
}

// The same directed 2-opt / Or-opt descent used in the benchmarked hybrid.
function moves(order: number[], ctx: Context, expired: () => boolean, visit: (move: Move) => boolean) {
  const { n, edge, conflicts, outgoing, incoming } = ctx;
  const positions = new Int32Array(n);
  const reversePrefix = new Float64Array(n);
  const reverseLimit = new Int32Array(n);
  const update = () => {
    order.forEach((id, i) => {
      positions[id] = i;
    });
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
      if (delta < -1e-9 && visit({ kind: "reverse", i, j, delta })) {
        update();
        break;
      }
    }
    for (const length of [1, 2, 3]) {
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
        if (delta >= -1e-9) continue;
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
