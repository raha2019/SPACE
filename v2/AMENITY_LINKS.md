# Amenity-Linkage Objective — v2 Phase L1

Dr. Jariwala's design: **typed links from a machine to a required amenity**, each with a maximum
distance or travel requirement — a laser near ventilation, a resin printer near a flammables cabinet,
every hazardous tool within reach of a fire extinguisher and an eyewash. It becomes a first-class
MOSA objective (`amenityLinks`) via the O1 registry and deliberately **reuses N1's distance/penalty
machinery** and **A1's engine-grid reachability**. No external ground truth for the weights → the
decisions below are the definition; each is justified. No code was written until this was complete.

**Correctness bar.** The frozen WSC pin reproduces bit-for-bit and every prior suite passes. No engine
file is modified; path-based travel **reuses** the engine's own grid + BFS.

---

## (a) The link model

A **linkage** is a **typed, directed** relationship *from a machine to a required amenity type*,
carrying: `amenityType`, a requirement (`maxDistanceUnits` in ft **or** `maxTravelSeconds`), a `mode`
(`strict` | `advisory`), and `provenance`. Directed because "machine requires amenity" is not
symmetric (the amenity does not require the machine).

- **A machine may have multiple links** — required, since a laser needs **both** ventilation (fume
  hood) **and** a fire extinguisher, and a welder needs an extinguisher **and** a flammables cabinet.
  Each link is scored independently.
- **Satisfaction when several amenity instances exist: the NEAREST instance satisfies.** A link asks
  "is *an* eyewash within reach?", not "are *all* of them". So the link's actual distance/travel is
  the **minimum** over all placed instances of that type; the objective uses a **multi-source BFS**
  (path-based) or a **nearest-of** minimum (straight-line), which yields the nearest instance in one
  pass. Justified: this is exactly how a person behaves (walk to the closest eyewash) and how the
  standards read (Z358.1/NFPA 10 require *an* accessible unit within the distance).

## (b) Distance vs travel path — the central L1 decision

N1 used **straight-line** edge-to-edge distance because hazard *separation* is about physical
proximity. An amenity requirement is about **reachability** — an eyewash 10 ft away *through a wall*
is useless; ANSI Z358.1 specifies a **10-second travel**, not a straight line. So L1 splits link types:

| amenity type | mode of distance | standard | requirement |
|---|---|---|---|
| `eyewash` | **path-based (travel)** | ANSI/ISEA **Z358.1-2014** §4.5.2 | ≤ 10 s ≈ **55 ft** travel, unobstructed |
| `fireExtinguisher` | **path-based (travel)** | **NFPA 10** §6.2/§6.3 | ≤ **75 ft** (Class A) / 30–50 ft (Class B) travel |
| `firstAid` | **path-based (travel)** | OSHA 1910.151(b) | "near vicinity" (no numeric → design assumption) |
| `flammablesCabinet` | **straight-line** | NFPA 30 / OSHA 1910.106 | proximity; you carry a small quantity a short way |
| `fumeHood` | **straight-line** | OSHA 1910.94 / ACGIH | *at-process* (3–5 ft) exhaust; duct is local |
| `dustCollection` | **straight-line** | NFPA 664 | duct **run** length, not a walking path |
| `sink` | **straight-line** | design assumption | post-processing proximity |

**Path-based travel — reuse of the engine grid (no reimplementation).** Exactly as A1 read
reachability from the engine, L1 calls the engine's own `_egressBuildGrid` + `_egressBFS`
(sim_egress.js) through the V0 seam, changing only the **seed set** (data, not code): it takes the
wall grid, resets the real exit seeds to free space (a doorway is walkable but not a target here), and
**seeds the BFS from the cells of the amenity instances of the required type**. The resulting `dist`
field is the **walking distance to the nearest such amenity**, in the *same* 4-connected 1-ft taxicab
grid the egress sim uses. A machine's travel is the minimum reachable `dist` over the walkable cells
bordering its footprint. `maxTravelSeconds` converts to feet at **5.5 ft/s** (so 10 s ⇒ 55 ft, the
Z358.1 convention; a design assumption) when `maxDistanceUnits` is absent.

**Straight-line links reuse N1** — the same `rectGap` edge-to-edge distance (feet, via `room.scale`),
because a duct run / short material carry is a proximity requirement, not a walking evacuation.

## (c) Defaults from hazard flags + precedence

Rule-derived defaults (so a user-invented machine gets sensible links), shipped as data in
`v2/amenity-link-defaults.json` with provenance on every entry:

| rule | predicate | required link | requirement | provenance |
|---|---|---|---|---|
| A1 | `sparkSource` ∨ `hotWork` | `fireExtinguisher` (path) | ≤ 75 ft travel | NFPA 10 §6.2.1.1 (Class A) |
| A2 | `wetProcess` | `eyewash` (path) | ≤ 55 ft / 10 s travel | ANSI/ISEA Z358.1-2014 §4.5.2 |
| A3 | `flammable` | `flammablesCabinet` (straight) | ≤ 35 ft | NFPA 30 / OSHA 1910.106; distance = design assumption |
| A4 | `ventilation.localExhaustRequired` | `fumeHood` (straight) | ≤ 10 ft | OSHA 1910.94 / ACGIH; distance = design assumption |
| A5 | `dustProducing` | `dustCollection` (straight) | ≤ 30 ft | NFPA 664; duct length = design assumption |

**Precedence (identical structure to N1):** user override (`project.amenityLinks` / per-instance) >
explicit link (on the machine type in the library) > rule-derived (A1–A5) > **none**. The library
already carries explicit `amenityLinks`; those win over the rule-derived layer for those types.

## (d) The penalty function (reuses N1's bounded-linear form)

Per link, let `d` = actual distance/travel (ft), `D` = required, `mm` = mode multiplier
(**strict → 5, advisory → 1**, mirroring N1):

```
satisfied  (d ≤ D)            -> penalty 0
violated   (D < d < ∞, reach) -> penalty = mm · min(1, (d − D) / D)          // bounded-linear, capped at mm
UNREACHABLE (no walkable path) -> penalty = mm   (the maximum)               // as A1 treats unreachable space as 0 users
```

`UNREACHABLE` is the path-based case where the BFS never reaches the machine (walls seal it off) —
scored as the **maximum**, mirroring A1's "unreachable ⇒ worst". A link whose amenity type is **not
placed at all** (`UNSATISFIABLE`) is, by default, **excluded from the objective and reported
separately** (it is a provisioning gap, not a placement quality — no machine move can fix it; opt in
with `includeUnsatisfiable`). **Scores only** — a strict violation raises the objective but never
rejects a layout; hard rejection is **Phase R1** (the `mode` field is designed so R1 changes only the
feasibility gate).

## (e) Normalization + composition + amenity placement

```
amenityLinks_objective = clamp( Σ_links penalty(link) / referenceTotal , 0, 1 )
referenceTotal         = Σ_scored-links  mm                       // every link at max violation
```

**0 when every link is satisfied**, rising as links are violated, ≤ 1. If there are no scored links,
the objective is 0. **Composition is building-wide** over all (machine, required-amenity) links —
consistent with N1 (a link is a machine↔amenity relationship, not a per-zone quantity); a machine and
its required amenity in different zones is a real reachability question the path-based BFS answers
correctly (it walks through the doorway). This mirrors N1's building-wide rule and differs from A1's
per-zone occupancy sum for the same reason.

**Amenity placement.** The penalty depends on machine↔amenity distance, so the objective **drives
whichever endpoint is movable**. In the diagnostic (and L1's fixtures) amenities are **fixed** (not in
`movableIds`), so it drives **machine** placement toward the amenities. The model does not preclude
movable amenities — adding them to `movableIds` would let MOSA also place the amenities optimally
(cheaper to relocate a fire extinguisher than a CNC in reality). Kept fixed here for consistency with
the diagnostic and to isolate the machine-placement signal; noted as an option.

---

# LIMITS (Task 5)

## Provenance tally

Of the **5 rule-derived defaults** (`v2/amenity-link-defaults.json`):

| class | count | which |
|---|---|---|
| **standards-cited** | **2** (~40%) | A1 `fireExtinguisher` (**NFPA 10** §6.2.1.1, 75 ft travel), A2 `eyewash` (**ANSI/ISEA Z358.1-2014** §4.5.2, 10 s / 55 ft) |
| **design-assumption** | **3** (~60%) | A3 `flammablesCabinet` (35 ft), A4 `fumeHood` (10 ft), A5 `dustCollection` (30 ft duct) |

The library's **explicit** `amenityLinks` are a mix on the same pattern: fire-extinguisher and
eyewash links cite **NFPA 10 / ANSI Z358.1**; fume-hood, flammables-cabinet, and dust-collection
distances carry **design-assumption** notes. Running tally across the phases: **E1 ~11.5%**, **N1
~31%**, **L1 ~40%** standards-cited — the highest, because the two most safety-critical amenities (the
fire extinguisher and the eyewash) have **code-backed travel requirements**.

**In front of a fire marshal / EHS reviewer:** the **fire-extinguisher and eyewash travel
requirements are code-backed** (NFPA 10, ANSI Z358.1) and are the ones L1 evaluates as *walking
travel through the actual layout* — defensible as written. The **flammables-cabinet, fume-hood, and
dust-collection distances are engineering judgment** (design assumptions), and are evaluated as
straight-line proximity. Present them accordingly.

## What this phase does NOT do

- **Scores, does not hard-reject.** A strict unmet/unreachable link raises the objective but never
  makes a layout infeasible — enforcement is **Phase R1** (the `mode` field is R1-ready).
- **Path-based travel is the egress sim's taxicab grid, and inherits its approximations.** "Walking
  distance" reuses the engine's own `_egressBuildGrid` + `_egressBFS`: a **4-connected, 1-ft
  Manhattan (taxicab)** flood. So (i) diagonal travel is **overestimated by up to √2**; (ii)
  resolution is 1 ft; (iii) it does **not** model door swing, stairs, or crowding — exactly the egress
  sim's documented limits. A grid travel of 55 ft therefore approximates, but is not identical to, the
  ANSI Z358.1 10-second walk (which assumes an unobstructed ~5.5 ft/s path). This is deliberate: L1
  reuses the engine's walkability so "reachable" means exactly what egress means, at the cost of the
  taxicab approximation.
- **Straight-line links** (`flammablesCabinet`/`fumeHood`/`dustCollection`/`sink`) reuse N1's
  edge-to-edge distance and do **not** model walls at all — appropriate for a duct run or short
  material carry, but a wall between a machine and its fume hood is not penalized.
- **Amenity placement is not optimized here.** Amenities are **fixed** (not in `movableIds`) in the
  fixtures and the diagnostic, so the objective drives **machine** placement toward the amenities.
  Adding an amenity to `movableIds` would let MOSA place it (a real facility relocates a fire
  extinguisher more easily than a CNC); left as an option, not exercised.
- **Unsatisfiable links (amenity type not placed at all) are excluded by default** and reported as a
  separate provisioning list — no machine move can fix a missing amenity, so it is a provisioning
  decision, not a placement score. Opt in with `includeUnsatisfiable`.

## Defensible-but-surprising results

- **The two safety objectives pull opposite ways (r ≈ −0.55).** `adjacency` pushes hazardous machines
  **apart**; `amenityLinks` pulls machines **toward** shared amenities (extinguisher, eyewash) —
  clustering. The six-objective front's best-amenity member has adjacency **0.38 → 0.62 (worse)**. A
  facility cannot simultaneously maximally separate hazards and maximally cluster tools around shared
  safety amenities; the Pareto front is where that trade is made. This is the L1 scientific payload,
  extending A1's capacity-vs-ADA (r ≈ −0.90) and N1's safety-vs-capacity.
- **A link can be satisfied on a ruler but violated on foot without any wall.** Because travel is
  taxicab, a machine 40 ft straight-line from an eyewash can be ~56 ft on the grid and thus violate
  the 55 ft requirement — correct (people walk in aisles, not through equipment), but surprising to a
  user measuring with a straightedge.
- **The diagnostic objective is small (0.0576)** because only **grind→eyewash** violates among the
  *placed*-amenity links (travel 74 ft > 55); the many required fume-hood / flammables-cabinet /
  dust-collection links are **UNSATISFIABLE** (those amenities were never placed in the fixture) and
  excluded by default. The diagnostic answer key already documented these as informational amenity
  gaps, so **no key update was needed** — L1's placed-amenity conclusions (weld→fireExt satisfied,
  grind→eyewash violated) match the key; only the *distances* differ (path-based travel vs the key's
  straight-line), which is the intended L1↔N1 distinction.
