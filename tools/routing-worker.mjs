import { readFileSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import { quiet, replan } from "./benchmark-routing-settings.mjs";
import { ruinRecreate } from "./neighborhood-routing.mjs";
import { context, planRollout } from "./rollout-routing.mjs";
import { fastContext, fastRepair, loadWasm } from "./routing-kernel.mjs";

const { input, options, strategy, regime, startedEpochMs, wasmDirectory } = workerData;
const timing = {};
let runtime;
if (strategy === "scalar" || strategy === "simd") {
  const start = performance.now();
  runtime = await loadWasm(readFileSync(`${wasmDirectory}/${strategy}.wasm`));
  timing.wasmLoadCompileInstantiateMs = performance.now() - start;
}
timing.readyMs = performance.timeOrigin + performance.now() - startedEpochMs;
const start = performance.now();
let result;
if (strategy === "current") result = { plan: quiet(() => replan(input, options)), stats: {} };
else {
  const search = {
    mode: strategy === "cheap" ? "descent" : "ruin",
    maxStrokes: 6000,
    budgetMs: 60000,
    iterations: regime === "effort" ? 900 : 6000,
    removalSize: 32,
  };
  if (regime !== "effort" && strategy !== "cheap") search.deadlineEpochMs = startedEpochMs + Number(regime);
  const optimized = ["js", "scalar", "simd"].includes(strategy);
  search.contextFactory = (paths, profile, clearance, expired) => {
    const start = performance.now();
    const result = optimized
      ? fastContext(paths, profile, clearance, expired, runtime)
      : context(paths, profile, clearance, expired);
    timing.contextMs = performance.now() - start;
    return result;
  };
  search.repair = (...args) => {
    const start = performance.now();
    const result = (optimized ? fastRepair : ruinRecreate)(...args);
    timing.repairMs = performance.now() - start;
    return result;
  };
  result = planRollout(input, options, search);
}
timing.planMs = performance.now() - start;
const transfer = result.plan.toTransferable();
const buffers = transfer.filter((m) => m.type === "xy").flatMap((m) => [m.cols, m.ts, m.ss]);
parentPort.postMessage({ transfer, stats: result.stats, order: result.audit?.order, timing }, buffers);
