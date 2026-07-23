# Objective Plumbing (v2 Phase O1)

Makes the MOSA objective set **configurable and arbitrary in count** without editing any
engine file — the prerequisite for every planned objective (tool adjacency, safety zones,
workflow distance, supervision sightlines, active-users, amenity linkages). The generalized
driver reproduces the frozen WSC pin **bit-for-bit** when configured with exactly the current
three objectives.

Files: `v2/objectives.mjs` (registry), `v2/mosa-driver.mjs` (generalized SA driver),
`v2/frontier.mjs` (n-D presentation). Tests: `v2/test-mosa-driver-equivalence.mjs` (3-obj
bit-for-bit), `v2/test-mosa-driver-4obj.mjs` (4-obj generality), `v2/test-frontier.mjs`.

---

## Task 0 finding — what the engine's MOSA functions assume

**Determination: (b).** `sim_mosa.js`'s machinery genuinely hardcodes exactly three objectives;
none of its functions iterate keys. So the v2 driver **reimplements** them generically and proves
numerical identity on the three-objective case (it does not call into `sim_mosa`'s three-objective
functions).

Hardcoded sites (all literal, none key-iterating):

| Concern | Location | Hardcoding |
|---|---|---|
| Weight sampler | `sim_mosa.js:48-56` | draws exactly 3 (`e0,e1,e2`), returns `[e0/s,e1/s,e2/s]` |
| Scalarization | `sim_mosa.js:264,295` | `wa*ada + we*egress + wn*noise` |
| `curVec` init | `sim_mosa.js:254` | `{ada, egress, noise}` |
| Archive push | `sim_mosa.js:70` | `vec:{ada, egress, noise}` |
| Crowding prune | `sim_mosa.js:82` | `Math.hypot(vi.ada-vj.ada, vi.egress-vj.egress, vi.noise-vj.noise)` |
| Dominance | `sim_eval.js:139-146` | `A.ada<=B.ada && A.egress<=B.egress && A.noise<=B.noise && (…)` |

The **reused-unchanged** engine surface (not objective-count dependent): `evaluateLayout` (the
objective math itself), `allZoneDefs`, `overlapArea`, `clamp`, `stageDimsUnits`, the move set, the
feasibility gate (`footInside`/`collides`), the SA schedule, and `ARCHIVE_CAP = 40`. The driver
calls these verbatim through the V0 seam vm; it never edits them.

---

## The registry contract — how to add a new objective

An objective is a declared object in `v2/objectives.mjs`:

```js
export const MY_OBJECTIVE = {
  id: 'toolAdjacency',                 // stable key; also the vec-order key
  name: 'Tool-group adjacency penalty',// human label
  direction: 'minimize',               // ONLY 'minimize' this phase (lower = better)
  needsEngine: false,                  // true iff evaluate() reads the shared engine result
  provenance: 'design assumption (…)', // a source clause OR "design assumption"
  evaluate: function (ctx) { /* return a value in [0,1] */ },
};
// then add it to REGISTRY (or call registerObjective(MY_OBJECTIVE)).
```

Select and order objectives per run: `runGeneralizedMosa(project, ['ada','egress','noise','toolAdjacency'], opts)`.

### Requirements (enforced by `getObjectives` / `registerObjective`)

1. **Direction.** Every objective **minimizes** (lower is better). The driver's dominance,
   scalarization, and knee all assume this. A "maximize" metric must be pre-negated/pre-inverted
   into a minimize form before registering (a first-class `maximize` direction is deferred).
2. **Normalization.** `evaluate` must return a value in **[0, 1]**. This keeps the SA temperature
   schedule (`startT=0.15 → endT=0.005`) and the scalarization meaningful across objectives, and
   makes the crowding distance commensurate across axes. The three engine objectives are already
   normalized fractions; new objectives must normalize themselves (e.g. divide by a max).
3. **Provenance.** Every objective carries a `provenance` string — a **source clause** (a code/law
   citation, e.g. "OSHA 1910.95 action level 85 dBA") or the literal **"design assumption"** — the
   same defensibility discipline used across this project. No unattributed metrics.
4. **Self-contained `evaluate`.** `evaluate(ctx)` may reference only its `ctx` argument, `Math`, and
   vm globals (`state`, …). It is injected into the engine vm via `.toString()`, so it must not close
   over module-scope variables. **It must NOT call `evaluateLayout` itself** — see determinism below.

### `ctx` (built by the driver per candidate)

`{ engine, movableIds, dims, state, stageW, stageH }` — `engine` is the shared `evaluateLayout`
result (or `null` if no registered objective needs it); `movableIds` are the ids being optimized;
`state.zones[id].{x,y,w,h,rotation}` are the current positions.

---

## How the driver preserves determinism (RNG draw order)

SA determinism depends on the exact **sequence and count** of `Math.random()` calls. `sim_mosa`'s
per-iteration draw sequence is:

```
_mosaSampleWeights()   -> 3 draws (e0,e1,e2)              [sim_mosa.js:51-53]
movable pick           -> 1 draw                           [sim_mosa.js:267]
move type              -> 1 draw                           [sim_mosa.js:271]
move params            -> 1..4 draws (branch-dependent)    [sim_mosa.js:274-283]
(if feasible) evaluateLayout -> N draws (noise MC)         [sim_mosa.js:294]
(if delta>0) acceptance      -> 1 draw                     [sim_mosa.js:299]
```

**The only draw whose count depends on the objective count is the weight sampler.** The driver's
n-simplex sampler draws exactly `n` in a `for i in 0..n-1` loop; for `n=3` that is the **same three
`-log(random())` draws, in the same order, with the same `e[i]/s` normalization** as
`_mosaSampleWeights`. Every other part of the loop body is copied verbatim (same `0.25/0.55`
thresholds, same `±12%` nudge, same bounding-box jump, same `ROTS`, same feasibility gate, same
acceptance short-circuit), so it draws identically. Two further guards:

- **One engine eval per candidate.** `evaluateLayout` is called **at most once** per candidate and
  its result is shared across all engine objectives via `ctx.engine`. If each of ada/egress/noise
  called `evaluateLayout` separately, the noise-MC would draw 3× per candidate and determinism would
  break. Objective `evaluate` functions never draw randomness themselves.
- **Same seeding point.** The seed is applied globally (`Math.random = _harnessLCG(seed)`) before the
  driver runs — exactly as the frozen harness seeds `mosaOptimize` — and the driver's first
  draw-bearing call is the seed-layout `evaluateLayout`, matching `sim_mosa.js:227`.

Numerically-identical generalizations (proven bit-for-bit on 3 objectives):

- **Scalarization** `Σ w[i]·vec[i]` accumulated left-to-right from `0` equals `wa*v0+we*v1+wn*v2`
  (`0 + w0·v0 == w0·v0` exactly), same associativity.
- **Dominance** — booleans over comparisons; order-independent; identical to `evalDominates` on 3.
- **Crowding** — `Math.hypot.apply(Math, diffs)` over the n diffs equals the literal 3-arg
  `Math.hypot` for n=3.

**Result (`v2/test-mosa-driver-equivalence.mjs`, seed 0x4D524443, 4000 iters):** baseline vector ==
pin, front size 18, dominating 18/18, **full front membership order-identical AND set-identical** to
the unmodified `sim_mosa`, deterministic across 3 runs.

---

## Frontier presentation for n objectives (`v2/frontier.mjs`)

The live scatterplot is 2-D (ADA vs noise, egress as opacity) and does not generalize.
`presentFront(front, objIds)` is the **presentation-data** layer (no UI) for any `n`:

- `knee` — **min-max normalized** distance to the per-objective ideal (each axis rescaled to
  `[0,1]` by its front min/max), generalized to n dimensions.
- `kneeOrigin` — **raw** `Math.hypot` distance to the origin, **bit-for-bit the metric
  `sim_mosa.js` `mosaOptimizeUI` uses** (first-wins ties). Kept so the existing poster's highlighted
  knee does not move. `v2/test-frontier.mjs` asserts `kneeOrigin` equals the sim_ui knee on the real
  frozen MRDC front.
- `perObjectiveBest` — the member minimizing each objective.
- `parallelCoords` — axes (with min/max) + one polyline per member (raw + normalized values): the
  n-D replacement for the 2-D scatter.

`kneeAgrees` reports whether the two knee metrics pick the same member; they can differ (min-max
rescales each axis), which is why both are returned — the poster uses `kneeOrigin`, and `knee`
(min-max) is offered as the generalized n-D knee.

---

## What remains coupled (and a deliberate non-change)

- **`objectiveWeights` is dead input — preserved deliberately.** `translateProject` forwards
  `optimization.objectiveWeights` as `t.weights`, but `sim_mosa`'s randomized-weight approach never
  reads it — it samples fresh simplex weights every iteration (`_mosaSampleWeights`). The generalized
  driver **preserves this exactly**: it also samples fresh n-simplex weights per iteration and does
  **not** read `objectiveWeights`. This is required for bit-for-bit reproduction — honoring a fixed
  or preference weight vector would change the scalarization and the search trajectory. A
  fixed-weight / preference-weighted scalarization would be a separate **opt-in mode** in a later
  phase (and would not reproduce the pin, by design), not a change to this driver.
- **Nothing in the live app calls the generalized driver yet.** It is a tested library. Wiring it
  into `sim_ui.js` (replacing the `mosaOptimize` call and the 2-D frontier with `presentFront`) is a
  later, UI-touching phase. No engine file, the V0 seam, the frozen project, or the pin was modified.
- **Direction is minimize-only; maximize and true preference weighting are deferred** (see the
  registry contract).
