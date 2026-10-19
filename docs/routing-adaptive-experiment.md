# Adaptive routing with a five second significance threshold

Follow-up: [large-neighborhood reconstruction](routing-neighborhood-experiment.md) changes the search family and finds six robust gains beyond cheap search on 42 fresh large drawings. The results below describe the earlier adaptive beam experiment.

This experiment adds a staged policy to [the constrained rollout optimizer](../tools/rollout-routing.mjs). It starts with the cheaper directed local search and spends more time only when a bounded probe indicates a substantial remaining opportunity. A meaningful improvement means **at least five seconds saved on one completed plot, including planning time**. Smaller differences are recorded but do not count as a reason to change algorithms.

**Result:** seven of 48 fresh drawings save 5.5–15.4 seconds against the current Saxi planner, including planning. All seven are large drawings. The adaptive policy does **not** provide a five-second advantage over the already implemented cheap search on any drawing. Its main conclusion is that further beam search is unnecessary for this suite under the requested significance threshold.

## Results on fresh drawings

Apple M1 Max, Node v24.13.0; five warmed measurements per strategy after one warm-up. Table entries are the seven individual jobs meeting the five-second bar. Every paired sample for each of these jobs exceeded five seconds. Plot time is modelled; planning time is measured.

| Drawing and unseen seed | Current plot seconds | Adaptive plot seconds | Adaptive planning seconds | Net saved for one copy |
| --- | ---: | ---: | ---: | ---: |
| 1,000 scattered strokes, 9109 | 741.614 | 736.027 | 0.084 | 5.508 s |
| 1,000 dots, 9109 | 465.846 | 457.236 | 0.091 | 8.523 s |
| 2,500 scattered strokes, 9109 | 1702.772 | 1696.095 | 0.277 | 6.415 s |
| 2,500 dots, 9109 | 1032.616 | 1016.956 | 0.313 | 15.359 s |
| 1,000 dots, 14249 | 462.732 | 456.462 | 0.092 | 6.182 s |
| 2,500 scattered strokes, 14249 | 1698.900 | 1692.726 | 0.263 | 5.926 s |
| 2,500 dots, 14249 | 1030.797 | 1019.115 | 0.292 | 11.402 s |

These are **seven of the twelve large drawings**. None of the other 36 fresh small/medium drawings meets the significance threshold. The other five large drawings also fall below it. Results are not aggregated across unrelated drawings to manufacture a meaningful win. No candidate increases estimated plot duration; an unsuccessful search still incurs planning overhead.

The cheap-only, probe-only, adaptive and always-on-beam variants all achieve meaningful baseline gains on the **same seven drawings**. The baseline improvements above are mainly attributable to cheap directed local search, not to the new continuation gate. The adaptive experiment has not discovered an additional multi-second improvement over that existing candidate.

The gate's first-sample decisions were stable across all five repetitions:

| Decision on the 48 fresh drawings | Drawings |
| --- | ---: |
| Relaxed remaining travel headroom is below five seconds; no probe | 13 |
| Probe runs, but its evidence does not justify another round | 27 |
| Observed scan cost predicts an over-budget probe | 6 |
| No feasible proposal or no finished descent from which to probe | 2 |
| Continue beam search after the bounded probe | 0 |

This is an adaptive stopping result, not evidence that more beam search is always useless. The strongest unconditional beam improvement over cheap search on the fresh set was **1.791 net seconds** on hatching 300/9109. There were **zero five-second opportunities missed** relative to this tested unconditional beam implementation. That comparison is not an oracle over every possible search method or longer budget.

No global or probe deadline fired on the fresh set. The largest complete adaptive planning sample was 0.328 seconds. All 275 strategy/fixture records, including seven retained regression cases, passed the invariant checks. The separate **1,116-combination settings sweep** also passed; the largest single-sample adaptive planning time there was 0.030 seconds. Those settings timings are compatibility evidence, not repeated latency estimates.

### Fresh process checks

An additional **96 fresh Node processes** tested all seven meaningful winners and one clustered negative control: four strategies, three measurements each, with rotated execution order and no optimizer warm-up. Imports and fixture generation still precede the timer; this is a cold planner invocation, not complete application startup.

All seven wins remained above five seconds in every cold adaptive sample. Median net savings were 5.461, 8.480, 6.347, 15.330, 6.137, 5.865 and 11.387 seconds, in the table's order. The largest cold adaptive planning sample was 0.382 seconds. The negative control remained below the significance threshold. Gate decisions were consistent across its repetitions; no probe/global deadline fired and no post-probe beam round was authorized.

These cold checks target the seven claimed wins, plus one negative control. They do not establish cold-start win rates for all 48 fresh drawings.

**Decision:** the cheap constrained search is the useful candidate for these larger jobs. The adaptive experiment successfully avoids spending more effort on gains below the requested bar, but its additional machinery has not earned a production change over cheap search. Keep the gate and beam variants as research tools until a new drawing class supplies a meaningful advantage. The production planner remains unchanged.

## Decision rule

The first stage is unchanged: nearest-neighbor candidate lists, directed subsequence order reversal, and relocation of one to three intact strokes, with up to 20 improvement passes. All stages share the transition cache, physical constraints and incumbent. The adaptive strategy does not rerun preparation or start the cheap search again.

After the cheap stage:

1. Compute a lower bound on remaining travel by independently minimizing each vertex's incoming and outgoing transition cost, including home, and taking the larger sum. This relaxes route connectivity and precedence, so it is optimistic. If even that bound leaves less than five seconds of possible improvement, stop without probing.
2. Reuse the top feasible proposals collected in the final unchanged descent pass. If descent did not finish, no proposals exist, or measured scan speed predicts that the probe will exceed its 50 ms allowance, stop.
3. Probe up to three distinct children, each with at most two local-search passes, under one cooperative 50 ms deadline. This is one bounded lookahead round and its entire cost counts as planning. It is not a free classification step.
4. Forecast the next round's gain as half the improvement observed in the probe or preceding round. Estimate its cost from measured scan time, beam width and expected scan count. Continue only if the predicted **net** improvement is at least five seconds and predicted gross improvement exceeds twice the estimated computation cost. A truncated probe cannot authorize continuation.
5. Retain the best feasible incumbent and reapply the decision after every round. There are at most two further rounds after the probe, matching the previous three-round search horizon.

The half-gain forecast and safety factor are explicit heuristics, not a calibrated probability or a guarantee that another round will pay. The lower-bound rejection is stronger: under the unchanged motion objective, the omitted search cannot find five seconds of additional plot-time improvement if the relaxed headroom is already smaller than that.

The experiment allows a 1.5-second search ceiling for every competing non-baseline strategy, giving the 2,500-stroke cases room to complete. Preparation, required auditing, final motion generation and transfer packing are additional measured work. The earlier experiment used 500 ms; the new comparisons all use the same larger allowance. The dense-cache limit remains 3,000 configured strokes. Production routing is unchanged.

## Constraints and checks

The physical contract is the same as in [the preceding experiment](routing-rollout-experiment.md#physical-and-settings-contract): preserve every configured stroke's ordered points, direction, winding, seam, joins, contact count and pen-down/servo motions. Preserve baseline order for pairs of stroke bounds separated by at most the maximum of 0.5 mm and the two joining radii. No connectors, extra joins or retracing are introduced. Sorting off returns the serialized production result exactly. Layer selection, fitting, cropping, point joining, minimum length and path joining run once through Saxi's existing preparation pipeline.

All variants retain the non-regressing complete plot-plan guard. Required guards are timed; the harness's redundant independent audits are outside every strategy's timer. A fallback still costs computation, and a sub-five-second improvement remains below the significance threshold even if it is statistically consistent.

The added self-checks cover the five-second and cost-margin boundaries; disabling probes reproducing cheap search; the relaxed bound against exhaustive tiny feasible routes; adaptive/probe preservation of directions, contacts and precedence; and a positive continuation followed by stopping. That last branch uses an intentionally time-scaled synthetic motion profile to make a known opportunity large enough. It is a logic test, **not evidence of realistic plotting performance**.

Changing route order still changes drying intervals and lifted travel. The geometric and motion checks cannot prove identical ink deposition or account for nib, paper, lift-clearance and firmware effects. No hardware was commanded.

## Frozen evaluation protocol

Development uses seeds 313 and 811. Validation uses previously unevaluated seeds 9109 and 14249. The policy, significance threshold, generators and budgets were frozen before running validation. The initial development policy probed only one child; that often examined an unproductive equivalent arrangement. The final policy tests up to three distinct children within one shared allowance. No rule is fitted to the validation outcomes.

Each phase contains 48 fresh drawings and seven retained regression/empty/singleton cases:

- Six existing families at 60 and 300 strokes, two seeds: 24 drawings.
- Three additional families—clustered L-shaped marks, sinusoidal ribbons, and nested contours—at 72 and 240 strokes, two seeds: 12 drawings.
- Scattered strokes, clusters and dots at 1,000 and 2,500 strokes, two seeds: 12 drawings.

These are new seeds and additional synthetic generators, not real customer SVGs. The additional families are present in development as well as validation; they are not a claim of unseen-distribution generalization.

The five strategies are current Saxi, cheap descent, probe-only, adaptive continuation, and always-on beam. All use the same preparation and physical contract. Validation uses one warm-up and five measured rounds per strategy, with rotated execution order. Development uses three measured rounds. The probe-only control separates the value of the short trial from any later beam search. Always-on beam supplies the counterfactual for opportunities the gate declined.

Timers include preparation, search and selection overhead, required guards, full motion generation and transfer packing/reconstruction. They exclude source/module loading, SVG parsing, fixture generation, actual worker/message transit, UI rendering and device communication. Planning is measured wall time; plot time is Saxi's estimate. No concurrent benchmark is run on this machine.

The gate targets **one copy**. Stored results also calculate ten and 100 copies with plan reuse; those totals do not change this policy's decision. Replanning every copy repeats the one-copy economics.

## Reproduction

```sh
npm run --silent eval:routing:rollout:check
npm run --silent eval:routing:rollout -- adaptive-test > /tmp/saxi-adaptive-held-out.json
ROLLOUT_STRATEGIES=current,adaptive-1500 npm run --silent eval:routing:rollout -- settings > /tmp/saxi-adaptive-settings.json
```

JSON retains all samples, phase/source hashes, gate decisions, measured probe work, estimated headroom/costs, plotting duration, one/ten/hundred-copy economics and whether the five-second threshold was reached. Timing-dependent gate choices may vary with machine load; the physical invariants do not.

The optimizer self-checks, 17 relevant unit tests (one existing skip), server TypeScript check and Biome checks for the four experimental scripts pass. No production routing/UI integration or physical plotting trial was performed.

Saved evidence: [final development run](/Users/pealco/.codex/visualizations/2026/10/18/01a150cd-a826-7100-bcdf-40e061f860d5/routing-adaptive-dev-final.json), [fresh validation](/Users/pealco/.codex/visualizations/2026/10/18/01a150cd-a826-7100-bcdf-40e061f860d5/routing-adaptive-held-out.json), [settings sweep](/Users/pealco/.codex/visualizations/2026/10/18/01a150cd-a826-7100-bcdf-40e061f860d5/routing-adaptive-settings.json), [cold samples](/Users/pealco/.codex/visualizations/2026/10/18/01a150cd-a826-7100-bcdf-40e061f860d5/routing-adaptive-cold.json), and [source snapshot](/Users/pealco/.codex/visualizations/2026/10/18/01a150cd-a826-7100-bcdf-40e061f860d5/routing-adaptive-source.tar.gz). The final development, validation, settings and cold data use identical implementation hashes. An earlier development JSON is retained separately; its one-child probe policy was superseded before validation.
