# SIMD routing in Saxi

SIMD Wasm is now the default refinement when **Sort paths** is enabled, in both the browser worker and the CLI. This implements the decision to retain CPU headroom for future search improvements. The earlier [runtime experiment](routing-wasm-experiment.md) did **not** establish a many-second incremental advantage of SIMD over optimized JavaScript or scalar Wasm; that finding is unchanged.

The production algorithm in [routing.ts](../src/routing.ts) is the benchmarked hybrid: directed 2-opt and Or-opt local descent, removal of up to 32 related or contiguous strokes, regret-2 reinsertion, annealing of the working route while retaining the best incumbent, then final local descent. The deterministic search makes at most one reconstruction attempt per configured stroke. It has no learned policy or beam search. [routing-kernel.c](../src/routing-kernel.c) computes the transition matrix and candidate neighbors and runs reconstruction. SIMD uses double-precision pairs for transition arithmetic; fast math, relaxed SIMD, and fused contraction are disabled.

The shared asynchronous [replan](../src/massager.ts) prepares the drawing once and keeps its greedy motion plan as the incumbent. The optimizer:

- Runs after rotation, scaling, layer selection, cropping, point joining, greedy sorting, minimum-length filtering, and path joining. It never reruns those operations on its result.
- Permutes whole directed strokes, preserving every point, seam, contact, join, pen-down motion, and lift/drop cycle. Bounding boxes within `max(0.5 mm, pointJoinRadius, pathJoinRadius)` keep their incumbent relative order. A final independent permutation/order audit checks this again.
- Uses the selected pen-up acceleration, velocity, and home for costs. The final candidate is rebuilt by Saxi's ordinary device-specific motion planner with all selected settings.
- Starts a five-second cooperative deadline before preprocessing, reserves 300 ms for finishing, and leaves 100–1,000 ms within the search for final descent. Preprocessing, final motion construction, and transfer are not hard real-time bounded.
- Accepts a candidate only when its modeled plot savings exceed the measured additional optimization and candidate-planning time **plus five seconds**. An optimistic travel lower bound skips searches that cannot save five seconds. Searching unsuccessfully still costs time; this is not a guarantee of faster total completion on every input.
- Bypasses refinement with sorting disabled, fewer than three or more than 6,000 prepared strokes, all-pair protected order, or an expired budget. Wasm compile/instantiation/allocation failures keep the prepared incumbent and emit a console warning.

The compiled module is embedded in [routing-wasm.ts](../src/routing-wasm.ts); there is no separate download or asset-path requirement. Compiled code is cached within a planner realm; each plan gets a fresh, reclaimable Wasm memory. The UI terminates completed or cancelled workers, so this cache does not persist across UI replans. The dense matrix still needs about 288 MB at 6,000 strokes; worst-case conflict storage adds about 144 MB. A sparse representation is needed before raising that cap.

The browser awaits planning, transfers motion buffers, surfaces planning failures, and terminates superseded work. It clears the previous plan while replanning and records the source drawing only when a result completes, preventing reuse of a stale plan after cancellation. The CLI awaits planning before connecting to hardware.

## Validation and integration timings

The production implementation passes the existing **1,116 drawing/settings combinations** in addition to the **3,348 research-port checks** and **144 exact kernel/reference comparisons**. Production local search is also compared to the reference hybrid on 48 small seeded drawings, allowing only the documented five-second headroom bypass. Tests exercise source/binary freshness, geometry nonmutation, deadline interruption, degenerate jobs, duplicate strokes, all-protected order, unavailable SIMD, the size cap, and actual worker structured cloning and buffer transfer.

Fresh integration timings use seed 321047, two matched repetitions with alternating implementation order, Apple M1 Max / Node 24.13.0, and the actual browser worker bundle hosted in fresh Node workers. Timing starts before worker construction and ends after transfer and plan reconstruction. All returned pen-down and servo motions and protected stroke orders pass independent audits. These are smoke benchmarks of integration, not a replacement for the larger runtime study.

| Drawing / settings | Prepared strokes | Greedy planning | SIMD planning | Net saving, median |
| --- | ---: | ---: | ---: | ---: |
| 3,000 dots, A2 | 2,979 | 0.139 s | 1.428 s | **36.21 s** |
| 6,000 strokes, A2 | 5,790 | 0.398 s | 3.037 s | **7.33 s** |
| 3,000 strokes, A2; point radius 0.5, join radius 2, minimum length 2 mm | 2,330 | 0.106 s | 0.693 s | **7.28 s** |
| 3,000 contours, A2 | 2,975 | 0.187 s | 0.958 s | **5.77 s** |

All four exceed five net seconds in both repetitions **against the greedy incumbent**. These numbers do not measure an incremental SIMD benefit over the cheap-search or optimized-JS hybrids. A 3,000-line hatch drawing joined into two strokes and a 3,000-stroke sorting-disabled control both retained exactly the same modeled plotting time, with only millisecond timing noise.

The desktop's real in-app browser also passed the built-worker smoke test: SIMD compilation and execution, selected-layer Sets, unchanged physical motions, unsupported-SIMD fallback, asynchronous failure reporting, and cancellation followed by a replacement plan. Its 1,500-mark example planned in 0.584 s and saved 27.04 modeled plot seconds. This is a functional browser check, not a repeated browser performance study.

No physical plot or ink-quality trial was performed. Preserving contacts and nearby order does not model drying time, paper deformation, or communication overhead. The isolated routing snapshot passes its unit/server/worker tests (one existing skip) and the server and browser builds. The broader workspace also passed both TypeScript project checks with its separate UI/dependency fixes.

## Reproduction

Normal `npm run build` uses the checked-in embedded module and needs no C toolchain. After changing the C kernel, run `npm run build:routing`, then tests. The generator requires LLVM Clang with a wasm32 target and `wasm-ld` (or Rust's `rust-lld`); set `WASM_CLANG` and `WASM_LD` for custom paths. A unit test detects an embedded module whose source hash is stale.

```sh
npm run build:routing
npm test
npm run build:server
npm run build:ui
npx tsc --project tsconfig.ui.json --noEmit
npm run eval:routing:wasm:build
npm run eval:routing:wasm:check
```

Integration evidence: [raw timings](/Users/pealco/.codex/visualizations/2026/10/18/01a150cd-a826-7100-bcdf-40e061f860d5/routing-simd-integration.jsonl), [controls](/Users/pealco/.codex/visualizations/2026/10/18/01a150cd-a826-7100-bcdf-40e061f860d5/routing-simd-integration-controls.jsonl), [analysis](/Users/pealco/.codex/visualizations/2026/10/18/01a150cd-a826-7100-bcdf-40e061f860d5/routing-simd-integration-analysis.json), and [harness](/Users/pealco/.codex/visualizations/2026/10/18/01a150cd-a826-7100-bcdf-40e061f860d5/routing-simd-integration-benchmark.mjs).
