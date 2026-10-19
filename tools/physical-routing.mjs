// Experimental algorithms; exact joins never introduce connectors or remove ink.
import assert from "node:assert/strict";
import { AxidrawFast, plan } from "./benchmark-routing.mjs";

export const first = (p) => p[0];
export const last = (p) => p[p.length - 1];
export const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const key = (p) => `${p.x},${p.y}`;
const origin = { x: 0, y: 0 };
export function movementCost(profile = AxidrawFast) {
  const stepsPerMm = profile.stepsPerMm ?? 5;
  const a = profile.penUpProfile.acceleration / stepsPerMm;
  const v = profile.penUpProfile.maximumVelocity / stepsPerMm;
  return (p, q) => {
    const d = distance(p, q);
    return d <= (v * v) / a ? 2 * Math.sqrt(d / a) : d / v + v / a;
  };
}
export function motionPlan(paths, profile = AxidrawFast) {
  const stepsPerMm = profile.stepsPerMm ?? 5;
  const home = profile.penHome ?? origin;
  return plan(
    paths.map((p) => p.map(({ x, y }) => ({ x: x * stepsPerMm, y: y * stepsPerMm }))),
    profile,
    { x: home.x * stepsPerMm, y: home.y * stepsPerMm },
  );
}
export function measure(paths, profile = AxidrawFast) {
  const motions = motionPlan(paths, profile).motions;
  const sum = (mod) => motions.filter((_, i) => i % 4 === mod).reduce((s, m) => s + m.duration(), 0);
  let travelMm = 0;
  const home = profile.penHome ?? origin;
  let p = home;
  let sharpTurns = 0;
  for (const path of paths) {
    travelMm += distance(p, first(path));
    p = last(path);
    for (let i = 1; i + 1 < path.length; i++) {
      const a = path[i - 1];
      const b = path[i];
      const c = path[i + 1];
      const length = distance(a, b) * distance(b, c);
      if (length && ((b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y)) / length < -0.5) sharpTurns++;
    }
  }
  travelMm += distance(p, home);
  const travelSeconds = sum(0);
  const drawingSeconds = sum(2);
  const servoSeconds = sum(1) + sum(3);
  return {
    strokes: paths.length,
    travelMm,
    travelSeconds,
    drawingSeconds,
    servoSeconds,
    totalSeconds: travelSeconds + drawingSeconds + servoSeconds,
    sharpTurns,
  };
}

export function joinExactAdjacent(paths) {
  const result = [];
  for (const path of paths) {
    const prev = result.at(-1);
    // Dots and all-zero strokes may encode dwell/repeated marks; leave them separate.
    if (
      prev?.some((p) => distance(p, first(prev))) &&
      path.some((p) => distance(p, first(path))) &&
      key(last(prev)) === key(first(path))
    ) {
      result[result.length - 1] = prev.concat(path.slice(1));
    } else result.push(path);
  }
  return result;
}

// Minimum number of trails in each undirected endpoint graph: max(1, odd-degree vertices / 2).
// Virtual edges are bookkeeping only: remove them before constructing any drawable path.
export function eulerTrails(paths, smooth = false) {
  const vertices = new Map();
  const edges = [];
  const dots = [];
  const get = (p) => {
    const k = key(p);
    if (!vertices.has(k)) vertices.set(k, { p, edges: [] });
    return vertices.get(k);
  };
  function add(a, b, path) {
    const edge = { a, b, path, used: false };
    edges.push(edge);
    a.edges.push(edge);
    b.edges.push(edge);
    return edge;
  }
  for (const path of paths) {
    if (!path.some((p) => distance(p, first(path)))) {
      dots.push(path);
      continue;
    }
    add(get(first(path)), get(last(path)), path);
  }
  const seen = new Set();
  const result = [...dots];
  let minimumStrokes = dots.length;
  for (const root of vertices.values()) {
    if (seen.has(root)) continue;
    const component = [];
    const pending = [root];
    seen.add(root);
    while (pending.length) {
      const v = pending.pop();
      component.push(v);
      for (const edge of v.edges) {
        const other = edge.a === v ? edge.b : edge.a;
        if (!seen.has(other)) {
          seen.add(other);
          pending.push(other);
        }
      }
    }
    const odd = component.filter((v) => v.edges.length % 2);
    minimumStrokes += Math.max(1, odd.length / 2);
    // Pairing influences trail endpoints, but not the optimal number of trails.
    while (odd.length) {
      const a = odd.pop();
      let best = 0;
      for (let j = 1; j < odd.length; j++) if (distance(a.p, odd[j].p) < distance(a.p, odd[best].p)) best = j;
      add(a, odd.splice(best, 1)[0], null);
    }
    const stack = [{ vertex: root, via: null }];
    const circuit = [];
    while (stack.length) {
      const top = stack.at(-1);
      const v = top.vertex;
      let available = v.edges.filter((edge) => !edge.used);
      if (!available.length) {
        const item = stack.pop();
        if (item.via) circuit.push(item.via);
        continue;
      }
      if (smooth && top.via?.path) {
        const incoming = top.via.path;
        const prev = incoming[incoming.length - 2];
        const vx = v.p.x - prev.x;
        const vy = v.p.y - prev.y;
        const score = (edge) => {
          if (!edge.path) return -2;
          const next = edge.a === v ? edge.path[1] : edge.path[edge.path.length - 2];
          const wx = next.x - v.p.x;
          const wy = next.y - v.p.y;
          return (vx * wx + vy * wy) / (Math.hypot(vx, vy) * Math.hypot(wx, wy) || 1);
        };
        available = available.sort((a, b) => score(b) - score(a));
      }
      const edge = available[0];
      edge.used = true;
      const path = edge.path && (edge.a === v ? edge.path : edge.path.slice().reverse());
      stack.push({ vertex: edge.a === v ? edge.b : edge.a, via: { path } });
    }
    circuit.reverse();
    const cut = circuit.findIndex((edge) => !edge.path);
    const ordered = cut < 0 ? circuit : [...circuit.slice(cut + 1), ...circuit.slice(0, cut)];
    let trail = [];
    for (const edge of ordered) {
      if (!edge.path) {
        if (trail.length) result.push(trail);
        trail = [];
      } else if (!trail.length) trail = edge.path.slice();
      else {
        assert.equal(key(last(trail)), key(first(edge.path)));
        trail.push(...edge.path.slice(1));
      }
    }
    if (trail.length) result.push(trail);
  }
  assert(edges.every((edge) => edge.used));
  assert.equal(result.length, minimumStrokes);
  return { paths: result, minimumStrokes };
}

// Exact dynamic program over permitted direction/seam states for a fixed stroke order.
export function optimizeStates(paths, profile = AxidrawFast, allowReverse = true, moveSeams = true) {
  if (!paths.length) return [];
  const cost = movementCost(profile);
  const home = profile.penHome ?? origin;
  const states = paths.map((path) => {
    let choices = [path];
    if (moveSeams && path.length >= 4 && key(first(path)) === key(last(path))) {
      // shortcut: at most 24 sampled existing vertices, increase only if seam quality justifies the cost.
      const n = path.length - 1;
      const indices = [
        ...new Set(Array.from({ length: Math.min(24, n) }, (_, i) => Math.floor((i * n) / Math.min(24, n)))),
      ];
      choices = indices.map((i) => [...path.slice(i, -1), ...path.slice(0, i), path[i]]);
    } else if (allowReverse && path.length > 1) choices.push(path.slice().reverse());
    return choices.map((p) => ({ path: p, draw: motionPlan([p], profile).motions[2].duration() }));
  });
  const predecessors = [];
  let previous = [];
  for (let i = 0; i < states.length; i++) {
    const row = [];
    const back = [];
    for (const state of states[i]) {
      let best = i ? Infinity : cost(home, first(state.path));
      let index = -1;
      if (i)
        for (let j = 0; j < previous.length; j++) {
          const candidate = previous[j] + cost(last(states[i - 1][j].path), first(state.path));
          if (candidate < best) {
            best = candidate;
            index = j;
          }
        }
      row.push(best + state.draw);
      back.push(index);
    }
    previous = row;
    predecessors.push(back);
  }
  let index = 0;
  for (let j = 1; j < previous.length; j++)
    if (
      previous[j] + cost(last(states.at(-1)[j].path), home) <
      previous[index] + cost(last(states.at(-1)[index].path), home)
    )
      index = j;
  const result = new Array(paths.length);
  for (let i = paths.length - 1; i >= 0; i--) {
    result[i] = states[i][index].path;
    index = predecessors[i][index];
  }
  return result;
}
