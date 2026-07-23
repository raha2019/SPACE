# Per-Zone Simulation Semantics (v2 Phase G3)

There is **no external ground truth** for "the ADA/egress/noise of one zone in a multi-zone
building." The engine only knows how to score a whole-stage grid. So before writing any code we
must *define* what per-zone evaluation MEANS, and the definitions must be internally consistent and
must preserve the frozen regression anchor (single-zone MRDC reproduces the pin bit-for-bit).

The only no-engine-edit mechanism available is **G2's region-as-wall translation**: to scope a sim
to zone `Z`, fill the stage complement of `Z` (everything outside `Z`) with structural wall blockers
(`v2/zone-to-blocker.mjs`), assemble the project through the V0 seam, and call the **unmodified**
`evaluateLayout`. Every decision below is constrained by what that mechanism can and cannot do.

---

## (a) ADA — denominator is `Z`'s cells only

**Decision:** when evaluating zone `Z`, the ADA walkable denominator is the walkable cells **of `Z`
only**.

**Why this is what the engine already gives us (no override needed):** `sim_eval` computes
`vec.ada = fail / free` where `free = corr.free` counts only cells with `dist > 0` (walkable, not
blocked) — `sim_ada.js:149-155`. With `Z`'s complement filled by wall blockers (`blocksMovement:true`),
every non-`Z` cell is blocked → `dist = 0` → excluded from `free`. So `free` = `Z`'s walkable cells and
`fail` = `Z`'s failing cells, and `vec.ada` is already the `Z`-scoped fraction. This is *cleanly*
zone-partitioned (unlike noise, below), and it is exactly why single-zone MRDC reproduces the frozen
ADA `0.13827…` bit-for-bit.

**Corridor / circulation spanning two zones:** a corridor element that crosses the `Z`↔neighbour
boundary is **split at the boundary**. The portion inside `Z` is walkable within `Z` (corridors are
in `ADA_PASSABLE_IDS`, `sim_ada.js:46`, so they stay traversable); the portion outside `Z` sits under
the complement wall blockers and is excluded from `Z`'s grid. Each zone thus sees only the length of
the corridor that lies within it — the intended per-zone behaviour.

---

## (b) Egress — per-zone LOCAL egress: travel to the nearest egress door ON `Z`'s boundary

This is the most consequential decision. For a zone whose only door is an **interior-bridge**
(no exit-to-outside), egress could mean either:

- **(i) travel to the bridge door** (occupants "escape the zone" by leaving through the bridge), or
- **(ii) travel through the adjacent zone to a true exterior exit** (whole-building egress).

**Decision: (i).** Per-zone egress = travel distance to the **nearest egress door on `Z`'s
boundary**, where an egress door is any door zone-detection put on the boundary — **exit-to-outside
OR interior-bridge**. The evaluator seeds the egress BFS (via `cat:"exit"` elements at those door
openings) from every boundary door of `Z`. A bridge-only zone is therefore evaluated as travel to the
bridge doorway (leaving `Z` into the neighbour), not as unreachable.

**Justification:**
1. **It is what the region-as-wall mechanism can do without an engine edit.** Option (ii) requires a
   BFS that walks *through* one zone's doorway into a *different* zone and on to that zone's exterior
   exit — i.e. a cross-zone people-flow path. There is no way to run that while simultaneously walling
   the rest of the building to keep `Z`'s ADA/noise denominators clean. `evaluateLayout` gives one
   whole-stage result; cross-zone path composition is a different computation.
2. **It composes.** Local egress ("cost to leave each zone") is the natural building block: a future
   people-flow phase can chain per-zone local egress along a zone graph to get whole-building egress.
3. **It is conservative and interpretable per zone.** "How far to the nearest way out of this room"
   is a real, defensible per-zone safety quantity.

**Documented alternative (ii):** whole-building egress = travel through adjacent zones to a true
exterior exit. This is **explicitly deferred to the later people-flow / congestion phase** (it needs a
zone-adjacency graph and multi-hop path cost, not per-zone isolation). Reported in §Limits.

`travelNorm = maxTrav / NFPA_MAX_TRAVEL_DISTANCE_FT` (200 ft, `sim_egress.js:28`);
`egress = (travelNorm + capNorm) / 2` (`sim_eval.js:85`).

---

## (c) Noise — action cells within `Z` over the FULL-GRID denominator, complement walled

Sound crosses walls with attenuation, so noise is **not** cleanly zone-partitioned like ADA.

**Decision:** per-zone noise = **fraction of stage grid cells at/above the OSHA action level, with
`Z`'s complement filled by noise walls (STC 35) so those cells are quiet**. The **denominator is the
FULL stage grid** (`nCols × nRows`), exactly as the engine computes it (`sim_eval.js:106-111`,
`vec.noise = actionCells / total`, `total = nCols*nRows`).

**Why the full-grid denominator (not `Z`-cell count):** the frozen baseline noise `0.40589…` **is**
the full-grid fraction with the notch walled. The regression anchor (3a) requires single-zone MRDC to
reproduce it bit-for-bit, which is only possible if per-zone noise = what `evaluateLayout` returns
with a **noise-wall** complement. So per-zone noise inherits the engine's full-grid denominator by
construction. Values are directly comparable across zones (same denominator); a small zone's fraction
is proportionally "diluted" by its walled complement — the same convention as the pin.

**Honest consequence (over-attenuation of cross-zone sources):** because the complement is *filled*
with wall (not just the single inter-zone wall), a source in a neighbouring zone is attenuated by the
entire walled complement, not by the one wall physically between the zones. So per-zone noise is
**dominated by in-zone sources**; cross-zone acoustic contribution is **under-counted**. Getting
correct single-wall cross-zone coupling *and* a `Z`-scoped action count would require the engine to
expose the per-cell dB field or accept a zone mask — an engine edit, out of scope. This is stated as
a limitation, not silently accepted as exact. (For the symmetric two-zone fixture it does not break
the *symmetry* assertion; see §Limits and test 3b.)

---

## (d) Occupant load — per-zone area / NFPA factor

**Decision:** per-zone occupant load = `ceil(area_sf(Z) / 50)`, using
`NFPA_OCCUPANT_LOAD_FACTOR_MAKERSPACE = 50` sf/person (`sim_egress.js:21`).

**How it is computed:** the evaluator sets the project's analysis floor to `Z`'s polygon, so
`sim_egress._egressOccupantLoad` reads `analysisScopeAreaUnits()` = `Z`'s area (`sim_egress.js:117-121`)
and computes the load internally (feeding the egress `capNorm`). The evaluator also reports
`area_sf(Z)` (shoelace via the scale) and the derived occupant load for transparency. For single-zone
MRDC, `Z` = the L-room, area 6278.76 sf → load `ceil(6278.76/50) = 126`, identical to the frozen path.

---

## (e) The building result — per-zone vectors PLUS an area-weighted aggregate

**Decision:** report **both** a `{ada, egress, noise}` vector **per zone** and a single **building-level
aggregate**. The aggregate = the **area-weighted mean** of the per-zone vectors (weight = `area_sf(Z)`),
computed component-wise.

**Why area-weighted mean (primary):**
- **MOSA optimizes exactly one objective vector**, so an aggregation rule is *required*. A smooth,
  continuous aggregate (mean) is friendlier to simulated annealing than a max.
- Area-weighting matches whole-building experience (a large hall dominates a closet) and, for ADA,
  approximates the true whole-building `total_fail / total_free`.
- **It reduces EXACTLY to the single-zone vector** when there is one zone, so it preserves the frozen
  regression anchor with no distortion.

**Documented alternative:** **worst-zone (component-wise max)** for a safety-conservative objective —
"the building is only as good as its worst zone." Provided as `aggregateWorst` alongside the mean, not
used as the default.

**Unreachable zones:** a zone with **no egress door** (no exit-to-outside and no interior-bridge on its
boundary) is flagged `reachable:false` and **excluded from the aggregate**, with a building-level flag
recording how many zones were dropped. Its raw engine vector is still reported for transparency (note:
the engine returns egress ≈ 0.5 for a no-seed zone — `travelNorm=0` from an empty BFS plus `capNorm=1`
from zero exit capacity — which is an artifact, not a meaningful egress; the `reachable:false` flag is
the truth). See test 3d.

---

## Invariants this design must satisfy (checked by the tests)

1. **Single-zone MRDC reproduces the pin bit-for-bit** (3a): area-weighted aggregate of one zone = that
   zone's vector = `0.13827363048035732 / 0.4275 / 0.40589569160997735`.
2. **Symmetric two-zone** (3b): equal machine sets placed symmetrically ⇒ equal per-zone ADA and egress;
   noise symmetric.
3. **Doorway-only-in-A** (3c): zone B (interior-bridge only) is **reachable** — egress = travel to the
   bridge door — not flagged unreachable.
4. **No-door zone** (3d): flagged `reachable:false`, no crash, excluded from the aggregate.
5. **Clean state**: the evaluator never persistently mutates engine state; each zone is a fresh V0-seam
   vm run (the seam's discipline), so zones cannot leak into each other's denominators.

---

# Limits — what G3 does and does NOT do (Task 5)

## What per-zone simulation now does

`v2/zone-sim.mjs` evaluates each detected zone independently through the **unmodified** engine: it
isolates the zone with G2 region-as-wall blockers, sets the analysis floor to the zone (occupant
load), seeds egress from the zone's boundary doors and any in-zone `cat:"exit"` machine, calls
`evaluateLayout`, and collects `{ada, egress, noise}` + area + occupant load. It then reports a
per-zone vector for every zone plus an **area-weighted-mean** building aggregate (and a worst-zone
alternative). It is proven on five fixtures, anchored by the MRDC single-zone case reproducing the
frozen pin **bit-for-bit** (`0.13827363048035732 / 0.4275 / 0.40589569160997735`).

## What it explicitly does NOT do

- **No people-flow / congestion / cross-zone egress path simulation.** Per §(b), egress is *local*
  (travel to the nearest boundary door of the zone). Whole-building egress — travel *through*
  adjacent zones to a true exterior exit — needs a zone-adjacency graph and multi-hop path cost and
  is a **later phase**. The alternative semantic is documented but not implemented.
- **No fumes or fire in the objective vector.** Per the audit, `sim_fumes`/`sim_fire` are display-only
  (radius-based, not in `evaluateLayout`), so per-zone results are `{ada, egress, noise}` only — the
  same three objectives the engine and MOSA use. Fumes/fire per-zone is out of scope.
- **Rectilinear zones only** (inherited from G2). A zone with a diagonal edge cannot be isolated
  exactly by axis-aligned wall blockers; `evaluateZone` returns `exact:false`, a warning, and skips it
  (it is excluded from the aggregate) rather than silently approximating. The engine wall model cannot
  represent a non-axis-aligned blocker; rectify such zones upstream.
- **No correct cross-zone acoustic coupling.** Per §(c), the walled complement over-attenuates sources
  in other zones, so per-zone noise is dominated by in-zone sources. True single-wall coupling would
  need the engine to expose the per-cell dB field or a zone-masked count — an engine edit.

## Data workarounds and the open bugs they mask

These are **data-shaped workarounds**, not fixes; the underlying engine bugs remain open (per the
audit and BUGS.md):

- **`cat:"exit"` egress seeding (BUG #4).** `sim_egress` seeds its BFS only from `cat==="exit"`
  elements, and there is no builder/draw path to create one from a `subtype:"door"` door. G3 emits
  `cat:"exit"` seed elements at each zone's boundary doors so egress actually seeds. This masks BUG #4;
  it does not fix it (a subtype-aware `isExit(def)` helper would, but that is an engine edit).
- **Passable-id coupling.** `ADA_PASSABLE_IDS`/`EGRESS_PASSABLE_IDS = {corridor, connector, rightOpen,
  entrance}` are checked before `blocksMovement`. G2's blockers never use those ids; a non-MRDC project
  whose circulation uses different ids must pass them via `opts.passableIds`. Unchanged open coupling.
- **ADA door-width check (BUG #3).** `_adaCheckDoorWidths` keys off `def.cat`, so builder/drawn doors
  (`subtype:"door"`, no `cat`) get no width check. G3 does not exercise or fix this; per-zone ADA is a
  corridor-width fraction, not a door-width check. BUG #3 remains open.

## Fixtures that were defensible-but-surprising (reported, not hidden)

- **No-door zone raw egress = 0.5 (fixture d).** The engine returns egress ≈ 0.5 for a zone with no
  exit seed: `travelNorm = 0` (empty BFS ⇒ `maxTrav = 0`) plus `capNorm = 1` (zero exit capacity),
  averaged. This is an **artifact**, not a meaningful egress. The evaluator flags the zone
  `reachable:false` and **excludes it from the aggregate**; the raw 0.5 is reported only for
  transparency.
- **A ~constant noise "floor" across zones (fixture e).** With one loud source in the right band, the
  left/middle bands each report `noise ≈ 0.02`, not 0, even though the source is walled off in their
  evaluations. This is the **full-grid-denominator** convention (§c): the source's own cells (near the
  emitter, in the walled complement) are still above the action level and are counted in every zone's
  full-grid noise. The source's own zone shows the full propagated value (0.19). This correctly
  distinguishes the source zone (no leak into others' *walkable* denominators — ADA/egress are cleanly
  isolated), but it means per-zone noise carries a small constant contribution from every loud source
  in the building. Defensible under the stated semantic; flagged so no one reads the 0.02 as a leak.

## Can MOSA optimize a multi-zone plan now?

**Partly.** The frozen `sim_mosa` optimizes by calling the engine's `evaluateLayout` (whole-stage), so:

- **Single active zone: YES, already.** Region-as-wall makes the whole-stage objective *equal* that
  zone's objective, so the existing MOSA optimizes a single zone correctly — that is exactly what the
  frozen MRDC run does (it optimizes the single L-zone with the notch walled).
- **True multi-zone (optimize the area-weighted aggregate): NO, not yet.** `sim_mosa` calls
  `evaluateLayout`, not `evaluateProjectPerZone`, and it is frozen (no engine edit). Optimizing a
  multi-zone plan by its aggregate requires a **new v2-side MOSA driver** whose objective is
  `evaluateProjectPerZone(...).aggregate` — new code that does not touch `sim_mosa`. That driver is the
  next phase. G3 delivers the tested per-zone *objective function* it will consume; it does not wire it
  into an optimizer, and **nothing in the live app calls `zone-sim.mjs` yet.**
