# Large neighborhood routing on large drawings

This experiment tests whether coordinated route reconstruction can save at least five seconds **beyond cheap constrained search**, after paying for planning. The candidate is implemented in [neighborhood-routing.mjs](../tools/neighborhood-routing.mjs) and composed with the existing planner and physical guards in [rollout-routing.mjs](../tools/rollout-routing.mjs). Production routing is unchanged.

**Result:** regret-based ruin/recreate clears that bar on six of 42 fresh drawings in every warm and cold repetition. It is a useful specialized candidate for large separated marks, while dense strokes and clusters often lose time to unsuccessful reconstruction. All tested physical invariants and 1,116 settings combinations pass.

## Measured results

**Six of 42 fresh large drawings have median net savings of 5.9–9.8 seconds beyond cheap constrained search.** Every warm repetition for those six exceeds five seconds. A seventh has a 5.24-second median but one repetition saves only 4.94 seconds, so it is borderline. All six clear wins use A2-sized fields: five dot drawings and one glyph drawing. These are additional gains over the previous candidate, not merely improvements over production's greedy route.

Apple M1 Max, Node v24.13.0. Planning is measured wall time; plotting is modelled. Values below are medians of three repetitions; the net column uses paired total-time differences. Consequently, subtracting marginal medians need not reproduce that column exactly when a deadline changes search output.

| Fresh drawing and seed | Cheap plot seconds | New plot seconds | New planning seconds | Net saved vs cheap | Paired net range |
| --- | ---: | ---: | ---: | ---: | ---: |
| dots-3000-a2-31139 | 1410.085 | 1401.487 | 2.706 | 6.354 s | 6.293–6.357 s |
| dots-6000-a2-31139 | 2591.110 | 2578.022 | 4.754 | 9.780 s | 9.688–10.006 s |
| dots-1500-a2-51047 | 774.697 | 767.023 | 1.900 | 5.925 s | 5.878–5.933 s |
| dots-3000-a2-51047 | 1408.894 | 1399.389 | 2.665 | 7.259 s | 7.168–7.269 s |
| dots-6000-a4-51047 (borderline) | 2189.433 | 2180.938 | 4.632 | 5.239 s | 4.937–5.275 s |
| dots-6000-a2-51047 | 2584.422 | 2572.531 | 4.680 | 8.621 s | 8.511–8.640 s |
| glyphs-4000-a2-51047 | 2670.334 | 2660.756 | 3.680 | 6.632 s | 6.628–6.653 s |

Cheap planning takes 0.14–1.48 seconds on these jobs; its actual cost is included in every net comparison. The six clear winners save **19.6–40.3 seconds versus production routing** after planning. For the remaining fresh drawings, no five-second per-job improvement over cheap search is established. Some improve less, and others lose overall because reconstruction costs time. The largest median loss is **2.005 seconds** on the 6,000-stroke A2 case with seed 31139. Estimated plot duration never regresses versus cheap search in any paired sample.

The two glyph seeds differ: one saves 6.63 seconds, the other only 4.25 seconds. Neither dense cluster drawings nor scattered-stroke drawings reach the bar. The protected contour and hatch controls do not show a meaningful advantage. This supports a specialized candidate for large separated marks, not an automatic choice for every large drawing. No selector was fitted after inspecting validation outcomes.

All **144 strategy/case records** pass the physical audit, covering 42 fresh drawings plus six settings variants and all three strategies. Fine glyph settings retain the result; coarse stroke settings remain below the five-second bar. Disabled sorting returns production's serialized plan exactly. The largest complete warm planning sample is **4.759 seconds**. No global five-second search deadline fires; the earlier reconstruction deadline fires in 10 of 144 candidate samples to preserve time for final refinement.

### Fresh process confirmation

An additional **72 independent Node processes** compare production, cheap search and ruin/recreate on all seven primary median winners and one clustered negative control, with three repetitions and rotated execution order. There is no optimizer warm-up; imports and fixture generation precede the timer. This is first-use planner computation, not end-to-end application startup.

All six clear warm wins remain above five seconds in **every cold paired sample**. The borderline A4 case also passes cold, but its warm near-miss still prevents treating it as a robust five-second result across the complete experiment. Cold runs were faster here; these targeted confirmations do not replace the primary distribution or establish performance on another machine.

| Drawing | Cold median net saved vs cheap | Cold paired range | Cold median planning |
| --- | ---: | ---: | ---: |
| dots-3000-a2-31139 | 6.788 s | 6.774–6.799 s | 2.301 s |
| dots-6000-a2-31139 | 10.591 s | 10.524–10.764 s | 4.116 s |
| dots-1500-a2-51047 | 6.196 s | 6.187–6.196 s | 1.684 s |
| dots-3000-a2-51047 | 7.560 s | 7.519–7.663 s | 2.422 s |
| dots-6000-a4-51047 | 5.785 s | 5.685–5.825 s | 4.014 s |
| dots-6000-a2-51047 | 9.240 s | 9.132–9.320 s | 4.121 s |
| glyphs-4000-a2-51047 | 7.175 s | 7.075–7.192 s | 3.256 s |
| clusters-6000-a2-31139 | -1.429 s | -1.483–-1.273 s | 2.835 s |

The clustered control still loses about 1.43 seconds, and none of the cold search deadlines fires. Fresh-process checks cover these eight selected drawings, not all 42 fresh drawings. All timings use the same frozen implementation hashes.

## Implemented algorithm

The selected hybrid is cheap directed local search → bounded ruin/recreate with regret insertion → cheap local refinement. It changes many transitions together; the earlier beam only explored a small number of local-move proposals.

Each reconstruction removes 32 whole configured strokes from their route positions. Every fourth attempt removes a contiguous route section, wrapping at home if needed; other attempts choose strokes related to a seeded random anchor by the sum of directed travel times, with small deterministic random noise. Removing a stroke here means removing its position from a temporary search state, never deleting a mark from the drawing.

The repair repeatedly compares each eligible removed stroke's best and second-best legal insertion positions. It inserts the stroke with the greatest regret—the extra cost of losing its best position—at that best position. Candidate positions come from incoming/outgoing nearest-neighbor lists, the holes left by removal, already reinserted strokes, and the feasible interval boundaries. This is candidate-limited regret-2 insertion, not exhaustive insertion at every gap. Ties prefer the lower insertion cost.

Baseline stroke IDs encode the protected precedence relation. A stroke cannot be reinserted before a removed predecessor has returned, and each placement respects all predecessors and successors already present. A placement can still block a later precedence chain; the entire incomplete repair is discarded. No intermediate incomplete route reaches the plotter.

Search may accept a slightly slower complete feasible route to escape a local optimum, using a simulated-annealing acceptance probability and a linearly decreasing temperature starting at 0.05 travel seconds. The best complete incumbent is retained independently. The final cheap refinement and complete motion-plan guard determine the returned route.

The frozen candidate attempts at most `min(900, configured stroke count)` repairs, with a fixed internal random seed. A cooperative five-second search ceiling includes cache construction and both local searches. Reconstruction stops early to reserve twice the measured initial descent duration, clamped to 0.1–1.0 seconds, for the final refinement. Preparation, final auditing, motion generation and transferable packing are additional measured costs. The reserve is a heuristic, not a hard real-time guarantee. A deadline can change the number of attempts and the resulting route; fixed effort without a deadline interruption replays deterministically.

The removal/reinsertion framework, related removal, regret insertion and annealing acceptance are adaptations of established large-neighborhood-search techniques. [Røpke and Pisinger](https://orbit.dtu.dk/en/publications/an-adaptive-large-neighborhood-search-heuristic-for-the-pickup-an/) use these ideas for pickup-and-delivery routing. Their regret comparison is between vehicle routes; this implementation compares gaps within one plotter route. Their adaptive operator weights and multi-vehicle constraints are **not** implemented. The fixed removal schedule, directed plot-time objective, candidate gaps, precedence safeguards and time reserve are this experiment's choices. This is a new candidate for Saxi, not a claim to have invented the algorithm family.

## Alternative tested during development

An exact-window candidate uses Bellman–Held–Karp subset dynamic programming to find the minimum-cost feasible order of each 10-, 12- or 14-stroke window with fixed entry and exit strokes. Two offset sweeps permit coordinated changes across the first sweep's boundaries. It preserves protected precedence inside each window; membership in the contiguous window preserves all external precedence. It is exact only within an individual window.

This follows the dynamic-programming approach to sequencing in [Held and Karp](https://epubs.siam.org/doi/abs/10.1137/0110015). It is a simpler bounded subproblem than the exponential neighborhoods studied in [Pacheco et al.](https://arxiv.org/abs/2107.05189); it does not implement their Balas–Simonetti or nested 2k-opt algorithms.

On two 3,000-stroke A2 development cases, the best exact-window variant saved less than 0.8 additional plotting seconds before its extra planning charge. It failed the five-second bar and was excluded from the frozen validation comparison. Its implementation and checks remain available as an experimental control.

## Physical and settings contract

All strategies run Saxi's existing preparation pipeline with the selected layer, fitting, rotation, cropping, point joining, minimum length and path joining settings. They optimize the **configured output**. They do not reinterpret or disable tolerance joins to gain freedom.

Every configured stroke retains its ordered point sequence, direction, winding, seam and pen-contact count. No added connector, merge, split or retracing is allowed. For every pair of stroke bounds within `max(0.5 mm, pointJoinRadius, pathJoinRadius)`, the configured baseline order is preserved. This deliberately conservative bounds test also protects some pairs whose ink does not actually intersect. Pen-down and servo motions are compared against the corresponding baseline contact events. Sorting off produces the serialized production plan exactly.

Complete plot duration cannot regress against the production baseline; the inner optimizer also retains the cheap-search incumbent. Extra computation is still charged when no better route is found. These guards preserve the existing geometric and motion contract, not identical ink deposition: route order changes drying intervals and lifted travel. Nib, paper, lift clearance and firmware behavior require physical trials.

## Evaluation protocol

Development used seeds 431 and 983. Search policy and parameters were frozen before evaluating seeds 31139 and 51047. The development cases compare removal sizes 16, 32 and 64, and shorter and longer search runs. Validation uses the selected 32-stroke, 900-attempt policy throughout; a winning preset is not selected separately for each validation drawing.

The fresh set contains 42 drawings: scattered dots, strokes and clusters at 1,500, 3,000 and 6,000 source strokes on A4-sized and A2-sized fields, plus 4,000-glyph fields and 3,000-source-stroke contour and hatch controls, for each of two unseen seeds. Six additional cases apply fine settings, coarse settings or disabled sorting to those larger drawings. A2-sized drawings use Saxi’s supported [NextDraw 22×34 hardware profile](https://bantamtools.com/products/bantam-tools-nextdraw-2234) and fit within the manufacturer’s drawing envelope. Coordinates are real millimetres, and motion settings retain normal Saxi values. Configured stroke counts may be smaller because the selected preprocessing joins or filters paths.

The primary comparison is current production routing, cheap constrained search, and the ruin/recreate hybrid. **Both** experimental methods allow up to 6,000 configured strokes and a five-second search ceiling. Their shared transition cache, local moves and guards are identical; the cheap control does not hit the previous 3,000-stroke bypass. Legacy experiment defaults retain their old capacity. The dense cache alone requires about 288 MB at 6,000 strokes, plus paths, motion plans and precedence lists; this is a research scalability limit, not a production memory target.

Each validation strategy receives one warm-up and three measured repetitions, with execution order rotated between rounds. No other benchmark or test suite runs concurrently. Net improvement is paired by round: `(cheap planning + cheap plot) − (candidate planning + candidate plot)`. A meaningful result requires at least five seconds per job; the report also checks whether every paired sample meets that bar. Many small gains across unrelated jobs are not combined into a meaningful win.

Timers include synchronous preparation, search, failed repairs, selection, required guards, complete motion generation, transfer packing and local reconstruction. They exclude module loading, fixture generation, SVG parsing, actual worker startup/transit, UI rendering and device communication. Independent redundant harness audits occur after each timer. Planning times are measured on this machine; plot durations remain Saxi's motion-model estimates. Repeated-copy economics assume the already computed plan is reused.

## Reproduction

```sh
node tools/check-rollout-routing.mjs
ROLLOUT_REPEATS=3 node tools/benchmark-rollout-routing.mjs neighborhood-test > /tmp/saxi-neighborhood-held-out.json
ROLLOUT_STRATEGIES=current,ruin-32-900 node tools/benchmark-rollout-routing.mjs settings > /tmp/saxi-neighborhood-settings.json
```

The JSON records source hashes, every timing sample, configured counts, protected-pair counts, failed and completed repair attempts, deadline behavior, and paired net improvements against cheap search as well as production routing.

## Verification and saved evidence

The separate **1,116-combination settings sweep passes all cases**, including point-joining radii 0–0.5 mm, path-joining radii 0–2 mm, minimum lengths 0–2 mm, alternate motion/device profiles, layer selection, fitting, rotation, cropping and disabled sorting. It reuses the established small/edge-case suite; the six additional large settings cases are included in the primary benchmark. The settings sweep uses one timing per strategy/case for compatibility, not a repeated latency estimate; its maximum candidate planning sample was 0.168 seconds.

Independent checks cover all feasible permutations on tiny asymmetric precedence problems, interrupted exact repairs, discarded partial reconstructions, deterministic fixed-effort replay, nonmutation, the previous move-delta checks, protected order and serialized pen-down/servo motions. All optimizer assertions, 17 relevant unit tests (one existing skip), the server TypeScript check and Biome checks for the five changed experimental scripts pass. No production UI integration or physical plot trial was performed. The 288 MB dense cache and measured CPU costs need evaluation on the actual deployment machine before making this a production option.

Saved evidence:

- [Fresh validation](/Users/pealco/.codex/visualizations/2026/10/18/01a150cd-a826-7100-bcdf-40e061f860d5/routing-neighborhood-held-out.json), [settings sweep](/Users/pealco/.codex/visualizations/2026/10/18/01a150cd-a826-7100-bcdf-40e061f860d5/routing-neighborhood-settings.json), and [72 cold processes](/Users/pealco/.codex/visualizations/2026/10/18/01a150cd-a826-7100-bcdf-40e061f860d5/routing-neighborhood-cold.json) use identical implementation hashes, verified against the saved workspace source.
- Development evidence: [exact windows](/Users/pealco/.codex/visualizations/2026/10/18/01a150cd-a826-7100-bcdf-40e061f860d5/routing-neighborhood-dev-windows.json), [removal sizes](/Users/pealco/.codex/visualizations/2026/10/18/01a150cd-a826-7100-bcdf-40e061f860d5/routing-neighborhood-dev-removal-sizes.json), [large cases](/Users/pealco/.codex/visualizations/2026/10/18/01a150cd-a826-7100-bcdf-40e061f860d5/routing-neighborhood-dev-large.json), and [search effort](/Users/pealco/.codex/visualizations/2026/10/18/01a150cd-a826-7100-bcdf-40e061f860d5/routing-neighborhood-dev-effort.json). These are tuning results from earlier source revisions, not fresh validation. One early removal-size pilot briefly overlapped a self-check; it is not used for final latency claims.
- [Source snapshot](/Users/pealco/.codex/visualizations/2026/10/18/01a150cd-a826-7100-bcdf-40e061f860d5/routing-neighborhood-source.tar.gz), [cold-process driver](/Users/pealco/.codex/visualizations/2026/10/18/01a150cd-a826-7100-bcdf-40e061f860d5/routing-neighborhood-cold.py), and [independent arithmetic check](/Users/pealco/.codex/visualizations/2026/10/18/01a150cd-a826-7100-bcdf-40e061f860d5/routing-neighborhood-analyze.py). The two Python helpers use the `/tmp/saxi-neighborhood-*.json` reproduction paths above.
