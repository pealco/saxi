# Bounded rollout routing experiment

Follow-up: [the adaptive experiment](routing-adaptive-experiment.md) applies the user's later requirement that an algorithm change save at least five seconds per completed job. The sub-second differences discussed below are historical measurements, not meaningful wins under that newer criterion.

This is an implemented offline candidate, not a change to Saxi's production planner. [rollout-routing.mjs](../tools/rollout-routing.mjs) contains the optimizer, [benchmark-rollout-routing.mjs](../tools/benchmark-rollout-routing.mjs) compares complete planning-plus-plotting costs, and [check-rollout-routing.mjs](../tools/check-rollout-routing.mjs) checks the algorithm independently of the timing runs.

**Result:** the constrained optimizer improves planning-plus-estimated-plotting time on 18 of 24 unseen small/medium drawings. However, the paper-inspired beam adds less value than expected: across those 24 jobs, its extra 0.191 seconds of plotting savings costs 0.291 seconds of planning. The simpler constrained descent wins that one-copy aggregate by about 0.100 seconds. Beam search does help particular local optima, including the retained grid fixture, but the evidence does not justify making it a universal production default. Neither version dominates the older, physically more permissive hybrids.

## Measured results

Apple M1 Max, Node v24.13.0. Primary timings below are medians of five warmed measurements. Net savings include the measured difference in **complete planning** costs versus the current planner. Plot seconds remain Saxi motion-model estimates.

| Fixture | Current plot seconds | New plot seconds | New planning ms | Net seconds saved, one copy | Ten reused copies | 100 reused copies |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 300 scattered strokes, unseen seed 707 | 246.901 | 243.984 | 37.3 | 2.882 | 29.138 | 291.700 |
| 300 closed contours, unseen seed 707 | 388.124 | 385.509 | 44.1 | 2.574 | 26.106 | 261.424 |
| 300 dots, unseen seed 2027 | 164.037 | 159.973 | 28.1 | 4.037 | 40.610 | 406.344 |
| 300 hatch lines, unseen seed 2027 | 1671.555 | 1671.492 | 32.6 | 0.031 | 0.596 | 6.238 |
| 2,000 scattered strokes, unseen seed 2027 | 1388.689 | 1383.822 | 395.3 | 4.482 | 48.289 | 486.354 |
| Connected grid, retained seed 17 | 126.008 | 125.517 | 5.6 | 0.486 | 4.902 | 49.056 |

Across the 24 unseen 60/300-stroke cases, one copy of each saves 29.459 seconds overall. Eighteen improve; six retain baseline plot duration and lose 0.26–28.28 ms to search. Those six are hatching 60/707, hatching 300/707, hatching 60/2027, fragments 60/707, fragments 60/2027, and fragments 300/2027. There are no plot-time regressions. Do not count tiny CPU differences on bypassed/unchanged jobs as routing gains. The largest primary planning sample was 405.0 ms; no 500 ms search watchdog fired in the final primary or settings runs.

All **1,116 settings combinations passed**, with exact serialized pen-down/servo-motion preservation and protected-order checks. The new route was selected in 487; the remainder retained the baseline. Single-sample planning peaked at 71.4 ms in that sweep. This establishes compatibility over the tested settings, not a statistical timing bound or physical ink certification.

### Does the beam earn its cost?

The descent ablation uses the same directed moves, proximity constraints, neighbor lists, setup, incumbent guard, and 500 ms ceiling, but omits beam expansion and rollouts.

| Comparison against constrained descent | Result |
| --- | --- |
| 24 unseen small/medium jobs, one copy of each | Beam loses approximately 0.100 s overall; its improvement exceeds 1 ms on 3 jobs, it loses more than 1 ms on 18, and 3 differ by under 1 ms. |
| Ten copies of each job, reusing each plan | Beam saves an additional 1.620 s overall. |
| 100 copies of each job, reusing each plan | Beam saves an additional 18.814 s overall. |
| Retained grid seed 17 | Descent leaves the baseline; beam saves approximately 0.487 s net against descent. |
| Unseen 2,000-stroke seed 2027 | Both find the same plot duration; descent plans in 198.8 ms versus beam's 395.3 ms. |
| Development 2,000-stroke seed 17 | Beam reduces plot time another 0.403 s, paying for its roughly 0.179 s of extra warmed planning on the first copy. This is calibration evidence, not held-out evidence. |

The repeated-copy aggregate charges planning once per distinct drawing. Replanning for every copy preserves the one-copy disadvantage where the beam loses. These aggregates depend on the fixture mix; they do not imply every individual drawing pays back at the same copy count.

### Comparison with the existing hybrids

The new optimizer preserves configured directions, seams, contacts, and nearby-stroke order. The older recipes intentionally have more freedom. Their larger gains remain real under their old geometry contract; many are infeasible under the new one.

| Fixture and method | Planning ms | Plot seconds | Meets the new physical invariants? |
| --- | ---: | ---: | --- |
| Contours 300/707: new rollout | 44.1 | 385.509 | Yes |
| Contours 300/707: older iterated hybrid | 588.9 | 362.909 | No: directed strokes/contacts differ |
| Strokes 2,000/2027: new rollout | 395.3 | 1383.822 | Yes |
| Strokes 2,000/2027: older relocation hybrid | 2938.5 | 1356.173 | No: directed strokes/contacts differ |
| Grid 17: new rollout, supplementary run | 6.2 | 125.517 | Yes |
| Grid 17: older traversal portfolio | 10.5 | 78.436 | No: directed strokes/contacts differ |
| Dots 60/707: new rollout, supplementary run | 4.0 | 41.083 | Yes |
| Dots 60/707: older full search | 30.8 | 41.027 | Yes; it is about 0.029 s faster including planning |

Across the 24 unseen small/medium fixtures, the original relocation, direction/seam, and iterated recipes meet the stricter invariants on only 3, 4, and 2 cases respectively. A failure can reflect changed point ordering within a configured joined stroke even when the source drawing was called “dots.” It is not evidence of added/removed ink segments; that is a separate, weaker check.

The supplementary three-repeat portfolio run also measures all-method search on contours 300/707: 3.742 seconds planning for a 362.909-second plot, versus the new search's 0.052 seconds planning and 385.509-second plot. The full portfolio still wins elapsed time there if its changed drawing behavior is allowed. This new experiment has not beaten that result under the old permissive rules.

### Fresh-process planning changes borderline decisions

Thirty-six additional fresh Node processes measured three strategies on four fixtures, three times each, with rotated execution order and no self-check warm-up. Module/fixture setup remains outside the timer, matching the primary harness boundary.

| Fixture | Current planning ms | New rollout planning ms | Constrained descent planning ms |
| --- | ---: | ---: | ---: |
| Strokes 60/707 | 3.75 | 19.23 | 11.59 |
| Contours 300/707 | 19.85 | 95.68 | 56.65 |
| Hatching 300/2027 | 9.86 | 77.38 | 29.57 |
| Strokes 2,000/2027 | 28.75 | 498.63 | 260.66 |

The hatch fixture's 62.6 ms plotting gain becomes an approximately **5 ms first-copy loss** for cold rollout planning; the descent variant still pays back. The large scattered-stroke fixture retains about **4.40 seconds** of first-copy savings for rollout. Cold plot durations match warmed runs, and none of these searches timed out. The maximum cold rollout planning sample was 499.8 ms. These are observations on this machine, not a universal latency guarantee.

**Decision from this experiment:** retain both candidates as offline research tools. Under the strict contract, the simpler directed descent is the better general first-copy starting point in this evaluation; small-beam lookahead is useful on some trapped routes or reused plans. The subsequent [adaptive evaluation](routing-adaptive-experiment.md) now tests an economic stopping rule on fresh drawings with a five-second significance threshold. No production cutover is warranted from these synthetic results, and physical equivalence remains unverified.

## What comes from the research

The selected paper is [Camerota Verdù, Castelli, and Bortolussi, Limited Rollout Beam Search, AAAI 2025](https://ojs.aaai.org/index.php/AAAI/article/view/34921). Its [Algorithm 1](https://ojs.aaai.org/index.php/AAAI/article/view/34921/37076) expands several moves from each beam state, rolls each child forward for a limited number of improvement steps, then keeps the best reached states. Retaining those reached states, rather than only using their scores to select the original children, is the mechanism implemented here.

This is a heuristic-policy adaptation, **not a reproduction of the trained neural solver**. The paper uses a pretrained stochastic policy; this implementation ranks feasible moves using exact analytic pen-up motion time. No training, model weights, GPU, or online policy adaptation are involved. NICO-TSP's learned trajectories are not implemented. This is a new combination in this repository; it is not a claim of a scientifically novel algorithm or of beating published solvers.

## The concrete algorithm

1. Run Saxi's existing `preparePaths` once, including rotation, fitting, selected layers, crop, point simplification, greedy sorting, minimum-length filtering, and configured path joining. Construct the current motion plan as a feasible incumbent.
2. Treat every resulting stroke as an immutable, directed pen-contact event. Build a graph of pairs whose axis-aligned bounds overlap or approach within the clearance. Each pair must retain its baseline order.
3. Cache accelerated travel costs between stroke ends and starts, including home. Keep the 12 closest incoming and outgoing neighbors per stroke to limit candidate search. Because drawing motions and contacts are fixed, reducing this travel objective reduces the complete modelled plot duration by the same amount.
4. Refine the current order with up to 20 passes over two move families: relocate blocks of one, two, or three strokes without reversing them; or reverse a subsequence's **order**, preserving every stroke's own point sequence. Reject every move that reverses a protected pair. A prefix sum accounts for the asymmetric internal travel costs of order reversal.
5. Expand up to three distinct moves from each of up to three beam states. A move may initially cost up to 0.2 extra travel seconds. Follow each child with up to two local-improvement passes, retain the best reached states, and repeat for at most three beam rounds. Keep the best feasible incumbent throughout. The initial local optimum remains available.
6. Stop search cooperatively after 500 ms, including transition/constraint setup. Independently audit the chosen order, construct its complete Saxi motion plan, reject any plot-time regression, and pack/reconstruct the transferable result just as in the earlier timing harness.

The beam/rollout structure is the recent-paper contribution. Directed Or-opt-style relocation, order reversal, nearest-neighbor candidate lists, precedence constraints, incumbent retention, and motion-time scoring are classical or application-specific components. The beam is deliberately small. This is neither an optimal solver nor an exhaustive search of the move neighborhoods.

Search checks the clock once per setup row and search position; a small operation can overrun the deadline. Preprocessing, final auditing, motion generation, and transfer packing are additional, measured costs. Jobs with fewer than three configured strokes or more than 3,000 use the current result directly. The dense transition cache alone reaches about 72 MB at 3,000 strokes; conflict lists and other data add memory. This is a bounded research implementation, not a large-scale spatial-index solver.

## Physical and settings contract

The contract is relative to Saxi's **configured output**, not the original SVG. In particular, existing radius joining can already remove small details or collapse repeated contacts. This experiment preserves that configured result; it does not silently fix or undo those semantics.

- Every configured stroke appears exactly once, with its full ordered point sequence unchanged. Directions, loop winding and seams, point multiplicity, pen-down corners, joins, lift/drop count, and servo settings stay fixed. No stroke splitting, extra joining, retracing, snapping, or inserted connector is allowed.
- For each nearby pair, the earlier configured stroke stays earlier. Clearance defaults to the maximum of 0.5 mm, point-join radius, and path-join radius. Whole-stroke bounding boxes intentionally overprotect some disjoint geometry. The 0.5 mm floor is an explicit experimental assumption, not a calibrated pen width.
- Point joining, minimum length, layer selection, crop and fitting run once in their existing order. Path joining runs once before the new optimization. A zero path-join radius stays disabled. Sorting off bypasses the experiment and must return the serialized production plan exactly.
- The benchmark compares every new result's serialized pen-down movement and lift/drop motions with its corresponding baseline contact. It independently checks the directed-stroke multiset and protected order, finite/non-increasing plot duration, and input nonmutation. Guards needed by the candidate itself are inside its planning timer; redundant benchmark audits are outside all strategies' timers.

This preserves substantially more physical behavior than the older segment-multiset guard. It still **cannot prove identical ink on paper**. Reordering changes elapsed drying intervals; lifted travel trajectories also change. Pen width, lift clearance, nib orientation, paper deformation, drying, slipping, and firmware timing need measurements on the actual setup. The proximity rule preserves precedence, not drying duration. No algorithmic simulation can certify the user's absolute “no physical consequences” requirement without that material/device model or a physical test.

## Evaluation protocol

Development used seed 17, existing graph/edge fixtures, and a 2,000-stroke seed-17 scaling case. The first version used block relocation only. Adding directed order reversal improved hatching and dots. A setup optimization reduced transition-cache cost. Budgets of 50, 200 and 500 ms, a single-relocation ablation, and beam width one were explored on development inputs. The 500 ms ceiling, beam width three, three rounds, two rollout passes, 12 neighbors, and physical rules were frozen before the final unseen-seed run. No candidate was retuned on those results.

The primary run has 37 fixtures: 24 new drawings from six families × two sizes (60 and 300) × two unseen seeds (707 and 2027); two additional unseen large drawings; and 11 calibration, regression, empty/singleton, and capacity fixtures. These are held-out seeds from existing generators, not unseen drawing distributions or real customer artwork. Do not call all 37 independent held-out drawings.

Each primary fixture has one unmeasured warm-up per strategy, then five measured rounds with rotated strategy order. The 5,000-disconnected-stroke capacity fixture compares the current planner and new variants only; the expensive older solvers are omitted there. The older relocation, direction/seam DP, and iterated hybrids are measured as originally implemented, then audited against the stricter contract. An invalid audit means they are outside this experiment's feasible set, not that their historical segment-coverage result was wrong. The new descent-only variant shares the same moves, constraints, candidate lists, budget and 20-pass initial search, isolating the additional beam/rollout work.

The settings run covers 12 drawing/edge fixtures × (80 radius/length combinations + 13 scenarios) = 1,116 combinations. Radii and minimum lengths use the same grid as the earlier suite: point radius 0/0.1/0.25/0.5 mm; path radius 0/0.1/0.5/1/2 mm; minimum length 0/0.1/0.5/2 mm. Scenarios cover sorting/joining off, slow/fast motion, four hardware profiles, changed home/heights, zero cornering, fit/rotate, crop/group selection, stroke selection, and empty selection. These single timing samples are compatibility checks, not timing confidence estimates.

Timing begins after module loading, source bundling and fixture generation. It includes production preparation, all search including rejected or interrupted work, required guards, complete motion generation, transfer-buffer collection and local reconstruction. It excludes SVG parsing, worker startup/scheduling, actual message transit, rendering, HTTP/device transport, and hardware effects absent from Saxi's model. Benchmarks run sequentially on one machine. Plot duration is simulated; planning duration is measured wall time.

For a plan reused over N copies, compare `planning + N × estimated_plot_time`. Replanning every copy instead costs `N × (planning + estimated_plot_time)`. Report lost planning time even when search returns the baseline. Empty drawings and unchanged routes cannot acquire an algorithmic benefit from timing noise. A plot-time guard does not guarantee a planning-plus-plotting win.

## Reproduce

```sh
npm run --silent eval:routing:rollout:check
npm run --silent eval:routing:rollout -- held-out > /tmp/saxi-rollout-held-out.json
npm run --silent eval:routing:rollout -- settings > /tmp/saxi-rollout-settings.json
```

`ROLLOUT_FILTER`, `ROLLOUT_STRATEGIES`, and `ROLLOUT_REPEATS` allow targeted reruns. The JSON records include individual samples, one/ten/hundred-copy economics, range of paired one-copy savings, physical audit results, search work/timeouts, CPU/Node versions and source hashes. A fresh process can use `--cold` with one selected fixture and `ROLLOUT_STRATEGIES=current,rollout-500`; fixture/module setup is still outside that timer. Hard deadline interruptions can change the returned incumbent across machines or CPU load, so the recorded route duration and timeout status matter alongside the timing.

Additional self-checks compare all block-relocation deltas against actual Saxi motions, examine 20 six-stroke instances against exhaustive feasible permutations, verify deterministic replay when the watchdog does not truncate work, and exercise 40 generated overlapping cases, threshold proximity, crossing order, repeated dots, zero budget, input nonmutation and the capacity bypass. The exhaustive solver is a test reference; the heuristic is not required to find every tiny optimum.

The six preprocessing regression tests and server TypeScript check also pass. Biome checks pass for all three new scripts. No hardware was connected or commanded; the full server/UI suite was not rerun for these offline-only additions.

Saved evidence: [primary results](/Users/pealco/.codex/visualizations/2026/10/18/01a150cd-a826-7100-bcdf-40e061f860d5/routing-rollout-held-out.json), [settings checks](/Users/pealco/.codex/visualizations/2026/10/18/01a150cd-a826-7100-bcdf-40e061f860d5/routing-rollout-settings.json), [portfolio comparison](/Users/pealco/.codex/visualizations/2026/10/18/01a150cd-a826-7100-bcdf-40e061f860d5/routing-rollout-portfolio.json), [fresh-process samples](/Users/pealco/.codex/visualizations/2026/10/18/01a150cd-a826-7100-bcdf-40e061f860d5/routing-rollout-cold.json), and [final source snapshot](/Users/pealco/.codex/visualizations/2026/10/18/01a150cd-a826-7100-bcdf-40e061f860d5/routing-rollout-source.tar.gz). The four final result sets have identical source hashes. Pilot JSON files in the same artifact folder document earlier configurations; the source snapshot reproduces the final implementation, not the discarded pilot versions.
