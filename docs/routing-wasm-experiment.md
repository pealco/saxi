# Optimized JavaScript, scalar Wasm and SIMD Wasm routing

Subsequent implementation decision: [SIMD routing is now integrated into production](routing-simd-production.md) to retain headroom for future search. The measurements and recommendation below describe the earlier runtime experiment; its use of “production” refers to the greedy baseline at that time.

**Optimized JavaScript earns the next implementation step. Wasm is faster, but its additional gain over optimized JS does not reach five seconds in the primary five-second-budget experiment. SIMD's incremental benefit is much smaller still.** This follow-up ports the existing constrained ruin/recreate hybrid. It does not introduce a new route heuristic or change production routing.

## Primary results

Apple M1 Max, Node v24.13.0. There are 420 fresh-worker timings across 14 cases, including three repetitions of each comparison. Plotting durations are Saxi motion-model estimates. All independent physical audits pass. Fixed-effort runs produce identical final routes across reference JS, optimized JS, scalar Wasm and SIMD Wasm. No five-second-budget run overruns its allowance; the maximum observed elapsed time is 4.791 seconds.

For the 6,000-dot A2 input with seed 73061 (5,912 configured strokes), medians are:

| Implementation | Planning at 900 attempts | Plot at 900 attempts | Planning with 5 s allowance | Plot with 5 s allowance | Attempts with 5 s allowance |
| --- | ---: | ---: | ---: | ---: | ---: |
| Reference JS | 4.479 s | 2579.889 s | 4.668 s | 2578.332 s | 928 |
| Optimized JS | 2.270 s | 2579.889 s | 4.654 s | 2568.255 s | 4,098 |
| Scalar Wasm | 2.031 s | 2579.889 s | 4.337 s | 2567.181 s | 5,912 |
| SIMD Wasm | 1.980 s | 2579.889 s | 4.296 s | 2567.181 s | 5,912 |

The cheap baseline takes 1.799 seconds to plan and 2592.022 modeled seconds to plot this input. The optimized JS budget run saves **20.924 net seconds** versus cheap search; scalar Wasm saves **22.300 seconds**. Only **1.419 seconds** of the scalar result is additional to optimized JS. Paired net medians are computed from each repetition, so subtracting marginal medians in this table can differ slightly.

Across all 14 cases:

- Fixed-effort maximum per-case median planning savings versus reference are **2.209 seconds for JS**, **2.482 for scalar Wasm**, and **2.544 for SIMD**. No fixed-effort comparison saves five seconds.
- With a five-second allowance, optimized JS beats the equally budgeted reference by at least five net seconds in every repetition on **2 cases**; scalar and SIMD do so on **7 cases** each. The maximum scalar gain versus reference is **11.488 seconds**.
- Against **optimized JS**, scalar Wasm has **zero five-second wins**. Its per-case median incremental gain ranges from approximately zero to **2.277 seconds**.
- Against **scalar Wasm**, SIMD has **zero five-second wins**. Its best per-case median improvement is **0.110 seconds**; one case is **0.040 seconds slower**.
- Optimized JS and scalar Wasm each have **nine robust five-second wins versus the prior cheap search**, all dots/glyphs (including the fine-settings variant). The scalar gains on these cases range from **6.932 to 22.300 seconds**. Its largest median loss versus cheap search is **0.272 seconds** on clusters.
- Against current production routing, scalar's budget run has **11 robust five-second total-time wins**, with a maximum median saving of **54.409 seconds**. Its worst median total-time regression is **0.456 seconds**. The motion guard prevents increased modeled plotting duration, but cannot make the planning overhead worthwhile on every input.

SIMD technically crosses the five-second threshold on one additional scattered-stroke case because scalar's median net gain is 4.994 seconds and SIMD trims a little more planning time. This is a borderline threshold crossing, not evidence of a meaningful additional SIMD benefit. It does not change the recommendation.

All-case net savings with the five-second allowance, in seconds; positive values favor the candidate:

| Drawing | Optimized JS vs cheap | Scalar Wasm vs cheap | Scalar Wasm vs optimized JS |
| --- | ---: | ---: | ---: |
| dots-3000-a2-73061 | 12.100 | 12.935 | 0.827 |
| dots-6000-a2-73061 | 20.924 | 22.300 | 1.419 |
| dots-6000-a4-73061 | 12.415 | 13.995 | 1.575 |
| glyphs-4000-a2-73061 | 8.250 | 9.248 | 1.008 |
| glyphs-4000-a2-73061/fine | 8.266 | 9.270 | 1.003 |
| strokes-6000-a2-73061 | 4.367 | 4.994 | 0.606 |
| clusters-6000-a2-73061 | -0.418 | -0.272 | 0.145 |
| strokes-3000-a2-73061/coarse | 1.006 | 1.222 | 0.216 |
| contours-3000-a4-73061 | -0.039 | 0.127 | 0.159 |
| hatching-3000-a4-73061 | -0.001 | -0.002 | -0.002 |
| dots-3000-a2-99181 | 10.749 | 11.746 | 0.997 |
| dots-6000-a2-99181 | 11.383 | 13.705 | 2.277 |
| dots-6000-a4-99181 | 10.225 | 11.530 | 1.297 |
| glyphs-4000-a2-99181 | 5.907 | 6.932 | 1.004 |

The hatching fixture joins into two configured strokes and correctly bypasses optimization. The fine glyph case shares geometry with its default-settings counterpart; cases are not all statistically independent, and three repetitions measure timing variability rather than drawing-population uncertainty.

Startup is included. Median worker/input/module readiness is approximately **25–26 ms** for each implementation; maxima range up to 63 ms. Scalar Wasm's measured file-load/compile/instantiate component has median **0.357 ms**, maximum **1.357 ms**; SIMD's median is **0.368 ms**, maximum **1.561 ms**. These are fresh isolates reading small local modules (about 6.7/7.7 KiB), with normal filesystem caching. They do not measure network fetch latency or browser startup.

On the example above, fixed-effort reconstruction alone falls from 2.574 seconds to 0.741 seconds in optimized JS and 0.430 seconds in scalar Wasm. Context construction falls from 1.023 seconds to 0.608 seconds in JS; scalar Wasm takes 0.662 seconds and SIMD 0.617 seconds. The irregular search and data-structure changes explain most of the benefit; vector arithmetic is not the dominant bottleneck.

## Two-second allowance

A secondary run uses the same frozen implementation on six cases: both large A2 dot inputs, both default glyph inputs, the 6,000-stroke input and the clustered input. It adds **108 fresh-worker timings**, again with three repetitions and all physical audits passing. No two-second candidate overruns its allowance. The cheap comparator remains the complete cheap search; its actual planning cost is included.

| Drawing | Optimized JS vs cheap | Scalar Wasm vs cheap | Scalar Wasm vs optimized JS |
| --- | ---: | ---: | ---: |
| dots-6000-a2-73061 | 1.924 s | 3.809 s | 1.884 s |
| glyphs-4000-a2-73061 | 5.986 s | 7.472 s | 1.502 s |
| strokes-6000-a2-73061 | 4.987 s | 5.521 s | 0.524 s |
| clusters-6000-a2-73061 | 0.192 s | 0.181 s | -0.011 s |
| dots-6000-a2-99181 | 1.584 s | 1.953 s | 0.612 s |
| glyphs-4000-a2-99181 | 3.996 s | 5.630 s | 1.621 s |

Scalar Wasm has two robust five-second wins against cheap search here; optimized JS has one. **Neither scalar versus optimized JS nor SIMD versus scalar reaches five seconds in any paired repetition.** Scalar's maximum per-case median incremental gain over JS is 1.884 seconds. SIMD's incremental medians range from a 0.886-second loss to a 2.054-second gain, reflecting the different search endpoints reached under a tight clock. The maximum candidate planning time is 1.826 seconds.

Short-budget quality is less repeatable: for the scattered-stroke case, scalar's net advantage over optimized JS ranges from -0.008 to 4.625 seconds across repetitions. Clock cutoffs and final local descent can reach different local optima. Faster execution does not guarantee a better final route on every timed run; fixed-effort route equality is the check that isolates numeric/algorithmic fidelity.

On the first large A2 dot case, increasing the allowance from two to five seconds raises optimized JS's net saving versus cheap search from 1.924 to 20.924 seconds. Minimizing planning latency alone would miss this substantial improvement in overall completion time.

## Recommendation

Carry forward **optimized JS plus bounded reconstruction for large separated marks**. It satisfies the many-seconds criterion without introducing a second language/toolchain. Keep scalar and SIMD as working research variants: scalar reduces fixed-effort planning cost, but neither port has established an additional five-second net gain over the simpler preceding implementation under the tested allowances. SIMD is especially difficult to justify on these results.

Do not enable expensive reconstruction for every drawing. Clustered strokes, contours and hatching provide no meaningful improvement over cheap search in the five-second experiment. A production decision still needs a suitable selection rule, lower-memory transition storage, browser/deployment-device measurements and physical plot trials. The present experiment leaves production routing unchanged.

## Implementations

- **Reference:** the existing JavaScript context builder and ruin/recreate search in `rollout-routing.mjs` and `neighborhood-routing.mjs`.
- **Optimized JS:** structure-of-arrays endpoint storage, flat double-precision transition storage and neighbor lists, a stable bounded top-32 selection instead of sorting every stroke, reusable repair buffers, indexed pending membership, stamped gap deduplication, and incremental position updates. The algorithm, candidate order, random stream, annealing schedule, constraints and tie rules remain unchanged.
- **Scalar Wasm:** the same transition/neighbor construction and reconstruction loops in `routing-kernel.c`, compiled with LLVM. Conflict detection, initial/final local descent, preprocessing and final physical checks remain shared JavaScript. One Wasm call builds the numeric context and another runs the reconstruction stage; there is no JS callback per edge. Deadline checks and annealing's `exp` call use host imports.
- **SIMD Wasm:** the same C source, with explicit `f64x2` distance/travel-time evaluation plus LLVM autovectorization. Double precision is retained. Fast math, fused contraction and relaxed SIMD are disabled. Disassembly confirms vector instructions in this build and their absence from the scalar build. See the [official SIMD documentation](https://emscripten.org/docs/porting/simd.html) for the instruction model and compiler switches.

The shared local descent still moves directed, intact strokes. It never reverses a stroke's drawn points. The same baseline-defined precedence constraints apply to all variants.

## Experimental protocol

The initial development pilot uses seed 431. The held-out suite uses previously unused seeds 73061 and 99181: 3,000/6,000 dots on A2, 6,000 dots on A4, 4,000 glyphs on A2, and difficult/control cases with 6,000 scattered strokes, 6,000 clustered strokes, 3,000 contours and 3,000 hatches. Fine glyph and coarse stroke settings add two large settings cases. There are 14 cases in total. This deliberately includes plausible winners and negative controls; it is not a representative sample of users' drawings.

Every case has three repetitions, with strategy order rotated by case and repetition. Only one timing workload runs at a time. Each sample creates a fresh Node worker, using a prebuilt bundle of the current Saxi source. Research fixture generation, source compilation and unrelated SVG/parser dependencies are excluded from that bundle.

The primary data combines completed cases from two recorded batches. The first harness incorrectly required repair attempts on the two-stroke hatching bypass; only that untimed assertion was corrected. Incomplete hatch samples were discarded and the case rerun. Assembly validates complete strategy/repetition coverage, identical timed source/binary hashes, and both harness versions. Raw batches and assembly provenance are retained.

The timer begins **before worker creation**, then includes input cloning, worker/module startup, local Wasm file loading, compilation and instantiation, settings preprocessing, search, final route audit, motion generation, transfer packing, actual transfer and parent-side plan reconstruction. Drawing generation and the independent post-run audit are outside the timer. Wasm's build from C is an installation/build step, not a per-plot step. The measurements use local files, not a network download; operating-system disk caches are not flushed. Each sample is a new worker/isolate, not a warmed-up planner invocation.

Two regimes answer different questions:

1. **Equal effort:** 900 removal/reinsertion attempts, capped at the configured stroke count, with the same initial and final local-descent limits. A generous 60-second safety ceiling prevents the ordinary five-second deadline from changing the workload. The harness requires exactly identical final routes across reference JS, optimized JS, scalar Wasm and SIMD Wasm, and asserts that no effort run was truncated.
2. **Equal elapsed-time allowance:** five seconds beginning at parent-side worker creation. After startup and preparation, 300 ms is reserved for final audit/motion/transfer work. The search also reserves time for final descent using the existing measured-descent rule. All four variants use the same attempt ceiling of `min(6000, configured strokes)` and the same annealing schedule. A variant may finish below the allowance when it exhausts the attempt ceiling. Deadlines are cooperative; full elapsed times and any overruns are reported rather than hidden.

Production routing and cheap constrained descent are additional baselines, measured with the same fresh-worker transport. Net gain for one copy is calculated per matched repetition as `(reference planning + reference modeled plot) - (candidate planning + candidate modeled plot)`. A robust meaningful win requires **at least five seconds in every repetition** on that drawing. Small gains across different drawings are not added together to manufacture a meaningful win.

The equal-effort experiment isolates execution speed. The budget experiment also changes attainable search effort. Its annealing horizon is the common attempt ceiling, whereas the fixed-effort horizon is 900; these schedules can follow different trajectories. Consequently, a truncated five-second reference run need not beat its own 900-attempt run. Results compare the accelerated budget run against both reference controls, as well as cheap search and production.

## Physical and settings checks

Saxi's `preparePaths` applies the user's point-joining radius, path-joining radius, minimum path length, layer selection, crop, fitting and rotation before optimization. Those configured strokes become immutable directed contacts. Optimizers cannot create connectors, omit strokes, change contact counts, move closed-loop seams or reverse pen-down direction. Nearby bounding-box pairs retain their original precedence, using clearance `max(0.5 mm, pointJoinRadius, pathJoinRadius)`.

The independent audit checks every stroke and protected pair. Every returned pen-down motion and servo motion is compared against the corresponding production motion, including on the large timing cases. The final motion-plan guard rejects candidates that increase modeled plotting time relative to production.

The settings sweep covers 1,116 fixture/settings combinations and all three new variants: **3,348 checks pass**. It includes point radii 0–0.5 mm, path radii 0–2 mm, minimum lengths 0–2 mm, alternate acceleration/velocity and hardware profiles, home/pen heights, layers, fitting, rotation, cropping and disabled sorting. Another 144 comparisons require exact agreement of transition costs, neighbors, repair statistics and final routes with the reference on small cases. Interruption checks require a complete feasible incumbent. The relevant 17 unit tests pass, with one pre-existing skip; the prior rollout assertions and TypeScript server check also pass.

These checks establish software invariants and modeled timings. They do not establish identical wet-ink behavior on physical hardware. The existing conservative proximity-order rule is retained, but it is not an ink-drying model.

## Reproduce

Requires LLVM Clang with a Wasm target and `wasm-ld` (or Rust's bundled LLD). `WASM_CLANG` and `WASM_LD` select explicit tool paths. The local build used LLVM 23.1.2; the build script also recognizes the installed macOS LLVM/Rust tool locations.

```sh
npm run eval:routing:wasm:build
npm run eval:routing:wasm:check
npm run eval:routing:wasm -- held-out /tmp/saxi-wasm-held-out.jsonl
node tools/analyze-routing-wasm.mjs /tmp/saxi-wasm-held-out.jsonl > /tmp/saxi-wasm-analysis.json

WASM_REGIMES=2000 WASM_FILTER='^(dots-6000-a2|glyphs-4000-a2-[0-9]+$|strokes-6000-a2|clusters-6000-a2)' npm run eval:routing:wasm -- held-out /tmp/saxi-wasm-two-second.jsonl
node tools/analyze-routing-wasm.mjs /tmp/saxi-wasm-two-second.jsonl > /tmp/saxi-wasm-two-second-analysis.json
```

`WASM_FILTER`, `WASM_STRATEGIES`, `WASM_REGIMES` and `WASM_REPEATS` select focused development runs. The recorded primary run uses the defaults. The JSONL output records individual samples, stage timings, route hashes, source/binary hashes, settings-case names and a completion record. The analysis refuses incomplete runs.

The dense transition matrix still uses about 288 MB at 6,000 configured strokes, before conflict lists, motion plans and scratch space. Wasm is not a solution to this quadratic memory limit. The experiment retains the 6,000-stroke cap and does not install a production selector or change the UI.

Saved evidence: [primary raw samples](/Users/pealco/.codex/visualizations/2026/10/18/01a150cd-a826-7100-bcdf-40e061f860d5/routing-wasm-primary.jsonl), [primary analysis](/Users/pealco/.codex/visualizations/2026/10/18/01a150cd-a826-7100-bcdf-40e061f860d5/routing-wasm-primary-analysis.json), [two-second raw samples](/Users/pealco/.codex/visualizations/2026/10/18/01a150cd-a826-7100-bcdf-40e061f860d5/routing-wasm-two-second.jsonl), [two-second analysis](/Users/pealco/.codex/visualizations/2026/10/18/01a150cd-a826-7100-bcdf-40e061f860d5/routing-wasm-two-second-analysis.json), and [source/binary snapshot](/Users/pealco/.codex/visualizations/2026/10/18/01a150cd-a826-7100-bcdf-40e061f860d5/routing-wasm-source.tar.gz). Both original primary batches, the earlier harness, the validation/assembly script and artifact hashes are saved alongside these files.
