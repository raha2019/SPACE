# MOSA Design Note
**File:** v1/js/sim_mosa.js  
**Validation harness:** tools/mosa_validate.mjs  
**Test suite:** tests/tests_mosa.js (runner: tests/run_mosa_tests.mjs)

---

## Objective Vector

The optimizer minimizes a three-component objective vector:

```
vec = { ada, egress, noise }  each in [0, 1]
```

All three components come from `evaluateLayout()` in `sim_eval.js`, which evaluates the current `state.zones` configuration using the existing simulation modules:

| Component | What it measures | Lower is better |
|-----------|-----------------|-----------------|
| `ada`     | Fraction of ADA corridor cells failing the 36-inch minimum width | Yes |
| `egress`  | Normalized composite egress score (travel distance + dead-end + occupant load) | Yes |
| `noise`   | Fraction of Monte Carlo samples where mean dBA across the floor exceeds OSHA action level | Yes |

The three components are not aggregated into a single scalar during search. Instead, the optimizer searches for the Pareto-optimal front: the set of zone arrangements where no other arrangement is at least as good on all three and strictly better on one.

---

## Randomized-Weight SA Acceptance Rule

Each iteration:

1. Sample a weight vector `w = (w_0, w_1, w_2)` uniformly on the 3-simplex using the exponential normalization method: `w_i = -log(U_i) / sum(-log(U_j))` for `U_i ~ Uniform(0,1)`.

2. Compute the scalar `s = w_0 * ada + w_1 * egress + w_2 * noise` for both the current and proposed layouts.

3. Accept if the proposed scalar is lower, or with probability `exp(-delta / T)` if it is higher (standard SA Metropolis criterion).

Varying `w` each iteration is why this approach spreads the search across the full Pareto front rather than converging to one weighting. On any given iteration, the optimizer behaves like a single-objective SA with some weighting of the three components. Over many iterations, different weight vectors cover different directions in objective space, and the archive accumulates all non-dominated candidates encountered along the way.

---

## Archive and Crowding Prune

The archive stores every feasible non-dominated candidate encountered during the search. Insertion follows two steps:

1. **Reject** the candidate if any existing archive member dominates it.
2. **Evict** all archive members that the candidate dominates, then insert.

If the archive exceeds `ARCHIVE_CAP = 40` entries, the most crowded member is dropped. Crowding is measured as the minimum Euclidean distance in objective space to any other archive member. Dropping the closest-neighbor point preserves spread across the front.

On return, `mosaOptimize` restores `state.zones` to the seed layout via a snapshot/restore pattern and returns `{ front, seedVec, stats }`.

---

## Constraint Model

Constraints are the same two hard checks as `optimize.js`:

- **footInside**: rotation-aware AABB of the proposed zone must have all four corners and the centroid within the analysis scope. With no active room scope, this reduces to checking that the footprint is inside the stage bounding box.

- **collides**: the proposed AABB must not overlap any fixed obstacle or other movable zone by more than `0.3 %^2`. Computed via `overlapArea(rotAABB(a), rotAABB(b))`.

Infeasible moves (footInside fails or collides returns true) are immediately rejected and counted in `stats.infeasible`. The SA temperature is not updated for infeasible moves.

---

## Assumptions That Must Be Replaced Before Publishing

### [A1] Stage scale: placeholder 100 ft x 75 ft

`mosa_validate.mjs` sets `state.scale = { pxPerUnit: 10, unit: 'ft', stageWidthPx: 1000, stageHeightPx: 750 }`, giving a 100 ft x 75 ft floor.

This is a round-number placeholder. The real Invention Studio dimensions must come from a calibrated floor plan (Matterport point cloud, architectural drawings, or on-site measurement). Absolute ADA corridor widths and egress travel distances both scale linearly with this assumption. The reported percent improvements (optimized vs. baseline) are dimensionless ratios and are robust to it, but the underlying physical distances are not.

**Action:** Replace with Matterport-derived px-per-foot scale before citing any absolute distance or width figures.

> **T1.1 UPDATE (from GT MRDC drawing):** Real room 2323 is L-shaped, 6235 sf.
> Outer dims: 96.6 ft E-W x 88.6 ft N-S. Main body 96.6 x 48.6 ft, west L-jog 39.6 x 40 ft.
> The 100 x 75 ft rectangle in `mosa_validate.mjs` is a placeholder (7500 sf, 17% too large).
> Do NOT update `mosa_validate.mjs` until T1.2 (real station positions) and T1.3 (real dBA specs) are complete.
> NFPA 101 occupant load classification: industrial (50 sf/person, Table 7.3.1.2). Makerspace
> classification decision -- not assembly/educational -- documented here. Revisit if occupancy
> type changes. Max occupant load at 6235 sf = 124 persons.

### [A2] dBA proxy: 70 + 5 * risk for risk >= 1

`mosa_validate.mjs` sets `def.dba_active = 70 + 5 * def.risk` for each element with `risk >= 1`. This maps the existing 1-to-5 risk scores to: risk 1 = 75 dBA, 2 = 80, 3 = 85, 4 = 90, 5 = 95 dBA (at 1 m from source).

These are plausible order-of-magnitude estimates for workshop tools but have no direct empirical backing for the specific tools in the Invention Studio.

**Action:** Replace with measured operating dBA per tool (from manufacturer spec sheets or on-site sound level measurement), re-run `mosa_validate.mjs`, and verify the noise objective changes meaningfully.

---

## How sim_mosa.js Is Loaded

`sim_mosa.js` is not yet wired to `v1/index.html` (Rahul's file; no new `<script>` tags are allowed there). The intended browser loading path mirrors `sim_optimizer.js`: call `mosaOptimizeUI()` from inside `sim_ui.js`, which is already loaded by `index.html`. Add one call in `sim_ui.js` without touching `index.html`.

For headless validation, `tools/mosa_validate.mjs` loads all modules via a single vm context and runs the full SA search against the real `testcase/hub/` layout data.

---

## Next Step

Replace [A1] and [A2] with real values, re-run:

```
node tools/mosa_validate.mjs --iters 4000
```

Compare the new front to the placeholder run. If the noise objective changes substantially, re-examine the front shape and update any improvement percentages cited in the paper or presentation.
