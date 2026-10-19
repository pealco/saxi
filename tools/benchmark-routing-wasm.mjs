import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { drawing, rng } from "./benchmark-routing.mjs";
import { base, preparePaths, quiet, replan, toSVG } from "./benchmark-routing-settings.mjs";
import { auditOrder } from "./rollout-routing.mjs";

const Plan = quiet(() => replan([], base)).constructor;
export async function runWorker(input, options, strategy, regime = "effort") {
  const started = performance.now();
  const worker = new Worker(new URL("../dist/routing-wasm/worker.mjs", import.meta.url), {
    workerData: {
      input,
      options,
      strategy,
      regime,
      startedEpochMs: performance.timeOrigin + started,
      wasmDirectory: resolve("dist/routing-wasm"),
    },
  });
  try {
    const message = await new Promise((accept, reject) => {
      worker.once("message", accept);
      worker.once("error", reject);
      worker.once("exit", (code) => {
        if (code) reject(new Error(`Worker exited ${code}`));
      });
    });
    const plan = Plan.fromTransferable(message.transfer);
    const planningMs = performance.now() - started;
    return {
      plan,
      planningMs,
      plotSeconds: plan.duration(),
      totalSeconds: planningMs / 1000 + plan.duration(),
      order: message.order,
      stats: message.stats,
      timing: message.timing,
    };
  } finally {
    await worker.terminate();
  }
}

export function fixtures(phase) {
  const inputs = [];
  const seeds = phase === "pilot" ? [431] : [73061, 99181];
  for (const seed of seeds) {
    for (const n of [3000, 6000])
      inputs.push({
        name: `dots-${n}-a2-${seed}`,
        paths: drawing("dots", n, seed).map((p) => p.map(({ x, y }) => ({ x: x * 2, y: y * 2 }))),
        settings: { hardware: "nextdraw-2234" },
      });
    inputs.push({ name: `dots-6000-a4-${seed}`, paths: drawing("dots", 6000, seed) });
    const random = rng(seed);
    const glyphs = Array.from({ length: 4000 }, (_, i) => {
      const x = 20 + (i % 80) * 6 + random();
      const y = 20 + Math.floor(i / 80) * 6 + random();
      return [
        { x, y },
        { x: x + 0.8, y: y + 0.2 },
        { x: x + 1.2, y: y + 1.1 },
      ];
    });
    for (let i = glyphs.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [glyphs[i], glyphs[j]] = [glyphs[j], glyphs[i]];
    }
    inputs.push({ name: `glyphs-4000-a2-${seed}`, paths: glyphs, settings: { hardware: "nextdraw-2234" } });
    if (seed === seeds[0]) {
      inputs.push({
        name: `glyphs-4000-a2-${seed}/fine`,
        paths: glyphs,
        settings: { hardware: "nextdraw-2234", pointJoinRadius: 0.1, pathJoinRadius: 0.1, minimumPathLength: 0.5 },
      });
      for (const kind of ["strokes", "clusters"])
        inputs.push({
          name: `${kind}-6000-a2-${seed}`,
          paths: drawing(kind, 6000, seed).map((p) => p.map(({ x, y }) => ({ x: x * 2, y: y * 2 }))),
          settings: { hardware: "nextdraw-2234" },
        });
      inputs.push({
        name: `strokes-3000-a2-${seed}/coarse`,
        paths: drawing("strokes", 3000, seed).map((p) => p.map(({ x, y }) => ({ x: x * 2, y: y * 2 }))),
        settings: { hardware: "nextdraw-2234", pointJoinRadius: 0.5, pathJoinRadius: 2, minimumPathLength: 2 },
      });
      for (const kind of ["contours", "hatching"])
        inputs.push({ name: `${kind}-3000-a4-${seed}`, paths: drawing(kind, 3000, seed) });
    }
  }
  return inputs;
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const phase = process.argv[2] ?? "held-out";
  const file = process.argv[3] ?? `/tmp/saxi-wasm-${phase}.jsonl`;
  const repeats = Number(process.env.WASM_REPEATS ?? 3);
  assert(Number.isInteger(repeats) && repeats > 0);
  const selected = fixtures(phase).filter(
    (f) => !process.env.WASM_FILTER || new RegExp(process.env.WASM_FILTER).test(f.name),
  );
  const strategies = process.env.WASM_STRATEGIES?.split(",") ?? [
    "current",
    "cheap",
    "reference",
    "js",
    "scalar",
    "simd",
  ];
  const regimes = process.env.WASM_REGIMES?.split(",") ?? ["effort", "5000"];
  const sourceFiles = [
    "tools/routing-kernel.mjs",
    "src/routing-kernel.c",
    "tools/rollout-routing.mjs",
    "tools/neighborhood-routing.mjs",
    "tools/routing-worker.mjs",
    "tools/build-routing-wasm.mjs",
    "tools/benchmark-routing-wasm.mjs",
    "src/massager.ts",
    "src/planning.ts",
    "src/util.ts",
    "dist/routing-wasm/scalar.wasm",
    "dist/routing-wasm/simd.wasm",
    "dist/routing-wasm/worker.mjs",
  ];
  const hashes = () =>
    Object.fromEntries(sourceFiles.map((f) => [f, createHash("sha256").update(readFileSync(f)).digest("hex")]));
  const initialHashes = hashes();
  writeFileSync(
    file,
    `${JSON.stringify({
      type: "metadata",
      phase,
      repeats,
      regimes,
      strategies,
      node: process.version,
      cpu: cpus()[0].model,
      createdAt: new Date().toISOString(),
      hashes: initialHashes,
      timing:
        "Fresh worker per sample, parent start through reconstructed plan; includes input clone, module loading, Wasm read/compile/instantiate, all preprocessing, search, guard, motion generation, transfer and reconstruction. Local filesystem, no network fetch. 300ms reserved for finishing in time-budget runs; cooperative deadline. Plot seconds are Saxi simulation.",
    })}\n`,
  );
  for (let fi = 0; fi < selected.length; fi++) {
    const fixture = selected[fi];
    const input = toSVG(fixture.paths);
    const options = { ...base, ...fixture.settings };
    const snapshot = JSON.stringify(input);
    const configured = quiet(() => preparePaths(input, options));
    const expected = quiet(() => replan(input, options));
    const serialized = expected.serialize();
    const clearance = Math.max(0.5, options.pointJoinRadius, options.pathJoinRadius);
    const jobs = regimes.flatMap((regime) =>
      strategies
        .filter((s) => regime === regimes[0] || !["current", "cheap"].includes(s))
        .map((strategy) => ({ strategy, regime })),
    );
    let effortOrder;
    for (let round = 0; round < repeats; round++) {
      const offset = (round + fi) % jobs.length;
      for (const job of [...jobs.slice(offset), ...jobs.slice(0, offset)]) {
        const result = await runWorker(input, options, job.strategy, job.regime);
        assert(result.plotSeconds <= expected.duration() + 1e-8);
        const order = result.order ?? configured.map((_, i) => i);
        const audit = auditOrder(
          configured,
          order.map((i) => configured[i]),
          clearance,
        );
        assert(audit.valid, `${fixture.name}/${job.strategy}: ${audit.reason}`);
        const actual = result.plan.serialize();
        for (let i = 0; i < order.length; i++)
          for (const phase of [1, 2, 3]) assert.deepEqual(actual[4 * i + phase], serialized[4 * order[i] + phase]);
        if (job.regime === "effort" && !["current", "cheap"].includes(job.strategy)) {
          if (effortOrder) assert.deepEqual(order, effortOrder, "Fixed-effort route changed");
          else effortOrder = order;
          assert.equal(result.stats.repairs ?? 0, configured.length < 3 ? 0 : Math.min(900, configured.length));
          assert(!result.stats.repairTruncated && !result.stats.timedOut);
        }
        const { plan, ...record } = result;
        appendFileSync(
          file,
          `${JSON.stringify({
            type: "sample",
            name: fixture.name,
            strokes: configured.length,
            round,
            ...job,
            ...record,
            physicalAudit: true,
            orderHash: createHash("sha256").update(JSON.stringify(order)).digest("hex"),
          })}\n`,
        );
        console.error(
          `${fi + 1}/${selected.length} r${round} ${fixture.name} ${job.strategy}/${job.regime}: ${(result.planningMs / 1000).toFixed(3)}s planning, ${result.plotSeconds.toFixed(3)}s plot, ${result.stats.repairs ?? 0} repairs`,
        );
      }
    }
    assert.equal(JSON.stringify(input), snapshot);
  }
  assert.deepEqual(hashes(), initialHashes, "Source changed during benchmark");
  appendFileSync(file, `${JSON.stringify({ type: "complete", cases: selected.length, repeats })}\n`);
}
