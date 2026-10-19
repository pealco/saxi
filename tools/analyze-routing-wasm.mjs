import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const lines = readFileSync(process.argv[2] ?? "/tmp/saxi-wasm-held-out.jsonl", "utf8")
  .trim()
  .split("\n")
  .map(JSON.parse);
assert.equal(lines.at(-1).type, "complete", "Only analyze a complete run");
const metadata = lines[0];
const samples = lines.filter((r) => r.type === "sample");
const median = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const summarize = (xs) => ({ median: median(xs), min: Math.min(...xs), max: Math.max(...xs) });
const cases = [...new Set(samples.map((r) => r.name))];
const results = [];
const budget = metadata.regimes.find((r) => r !== "effort");
const baselineRegime = metadata.regimes[0];
for (const name of cases) {
  const rows = samples.filter((r) => r.name === name);
  const get = (strategy, regime) =>
    rows.filter((r) => r.strategy === strategy && r.regime === regime).sort((a, b) => a.round - b.round);
  const comparisons = [
    ["fixed-js-v-reference", "js", "effort", "reference", "effort"],
    ["fixed-scalar-v-reference", "scalar", "effort", "reference", "effort"],
    ["fixed-simd-v-reference", "simd", "effort", "reference", "effort"],
    ["budget-js-v-reference", "js", budget, "reference", budget],
    ["budget-scalar-v-reference", "scalar", budget, "reference", budget],
    ["budget-simd-v-reference", "simd", budget, "reference", budget],
    ["budget-scalar-v-js", "scalar", budget, "js", budget],
    ["budget-simd-v-scalar", "simd", budget, "scalar", budget],
    ["budget-js-v-cheap", "js", budget, "cheap", baselineRegime],
    ["budget-scalar-v-cheap", "scalar", budget, "cheap", baselineRegime],
    ["budget-simd-v-cheap", "simd", budget, "cheap", baselineRegime],
    ["budget-scalar-v-current", "scalar", budget, "current", baselineRegime],
    ["budget-scalar-v-old900", "scalar", budget, "reference", "effort"],
  ].filter(
    ([, , regime, , referenceRegime]) =>
      metadata.regimes.includes(regime) && metadata.regimes.includes(referenceRegime),
  );
  for (const [comparison, strategy, regime, reference, referenceRegime] of comparisons) {
    const a = get(strategy, regime);
    const b = get(reference, referenceRegime);
    assert.equal(a.length, metadata.repeats);
    assert.equal(b.length, metadata.repeats);
    const net = a.map((r, i) => b[i].totalSeconds - r.totalSeconds);
    results.push({
      name,
      comparison,
      netSeconds: summarize(net),
      robustFiveSecondWin: net.every((v) => v >= 5),
      planningSeconds: summarize(a.map((r) => r.planningMs / 1000)),
      referencePlanningSeconds: summarize(b.map((r) => r.planningMs / 1000)),
      plotSeconds: summarize(a.map((r) => r.plotSeconds)),
      plotSavedSeconds: summarize(a.map((r, i) => b[i].plotSeconds - r.plotSeconds)),
      repairs: summarize(a.map((r) => r.stats.repairs ?? 0)),
    });
  }
}
const byComparison = Object.fromEntries(
  [...new Set(results.map((r) => r.comparison))].map((name) => {
    const rows = results.filter((r) => r.comparison === name);
    return [
      name,
      {
        medianCaseNetSeconds: median(rows.map((r) => r.netSeconds.median)),
        robustWins: rows.filter((r) => r.robustFiveSecondWin).map((r) => r.name),
        medianWins: rows.filter((r) => r.netSeconds.median >= 5).map((r) => r.name),
        worstCaseMedian: Math.min(...rows.map((r) => r.netSeconds.median)),
        bestCaseMedian: Math.max(...rows.map((r) => r.netSeconds.median)),
      },
    ];
  }),
);
const startup = Object.fromEntries(
  metadata.strategies.map((strategy) => {
    const rows = samples.filter((r) => r.strategy === strategy);
    return [
      strategy,
      {
        readyMs: summarize(rows.map((r) => r.timing.readyMs)),
        wasmLoadCompileInstantiateMs: summarize(rows.map((r) => r.timing.wasmLoadCompileInstantiateMs ?? 0)),
      },
    ];
  }),
);
console.log(
  JSON.stringify(
    {
      metadata,
      count: samples.length,
      cases: cases.length,
      allPhysicalAuditsPass: samples.every((r) => r.physicalAudit),
      budgetOverruns: samples
        .filter(
          (r) => r.regime !== "effort" && !["current", "cheap"].includes(r.strategy) && r.planningMs > Number(r.regime),
        )
        .map((r) => ({ name: r.name, strategy: r.strategy, planningMs: r.planningMs })),
      startup,
      byComparison,
      results,
    },
    null,
    2,
  ),
);
