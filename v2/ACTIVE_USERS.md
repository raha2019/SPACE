# Active-Users (Usable Capacity) Metric — v2 Phase A1

The metric Dr. Jariwala requested: **as machines move, report how many people can actually use the
space.** It becomes a first-class MOSA objective (`activeUsers`) via the O1 registry. There is no
external ground truth, so the design decisions below *are* the correctness definition. No
implementation was written until this document was complete and internally consistent.

**Inertness bar.** The frozen WSC pin (`0.13827363048035732 / 0.4275 / 0.40589569160997735`, front
18, 18/18) reproduces bit-for-bit, and V0/G1/G2/G3/O1/E1 all still pass. No engine file is modified;
active-users **reuses** the engine's own grid via the V0 seam (see (d)).

---

## (a) Definition — formal

Work on the engine's walkable grid (1 ft cells, `EGRESS_GRID_RES_FT`). Let a machine `m` have an
operator standing region `Op(m)` (see (b)). A **candidate person-cell** is a grid cell `k` whose
centre lies in some `Op(m)`. Cell `k` is **usable for m** iff all hold:

1. **inside** — `centre(k) ∈ Op(m)` (an operator standing region, or a designated usable open area);
2. **clear** — `grid[k] ≠ 1` (not overlapped by a machine footprint, a structural blocker, or a
   wall) **and** `centre(k) ∉ Hard(any machine)`, where `Hard(·)` is the union of that machine's
   clearance zones with `severity: "hard"`;
3. **reachable** — `dist[k] ≥ 0`, where `dist` is the engine's multi-source egress BFS from every
   `cat:"exit"` cell (a cell the BFS never reaches has `dist < 0`).

Let `U(m)` = set of cells usable for `m`. With overlap accounting (c), each usable cell contributes a
fractional area `share_m(k)·cellArea` to `m` (cellArea = 1 ft²). Then

```
usableArea(m)  = Σ_{k∈U(m)} share_m(k) · cellArea
usableUsers(m) = usableArea(m) / personSpace(m)
zoneUsers(Z)   = Σ_{m∈Z} usableUsers(m)            (0 if Z is unreachable — see (f))
buildingUsers  = Σ_Z zoneUsers(Z)
```

A person counts **only** if their standing area is inside an operator region, is not overlapped by a
machine/hard-clearance/wall, **and** is connected to an exit by a walkable path. Clear-but-unreachable
space counts **zero** — that is the heart of the metric (fixture c).

## (b) Person-space & the operator standing region

- **Person-space** = `occupancy.personSpaceAreaUnits` (E1), **default 15 ft²**. This is a **design
  assumption**: it is the *net* standing+reach workspace for one operator (roughly a 3–4 ft square),
  denser than NFPA 101's **50 ft²/person gross** occupant-load factor (which includes aisles and
  equipment and is used only as the *reference capacity* in (e)). Anthropometric anchors: a person's
  static standing footprint is ≈2.3 ft² (ANSI/HFES 100 / Humanscale ~18×18 in), and a working
  operator envelope with reach and clearance is commonly 10–20 ft²; 15 ft² sits in that band. Flagged
  as a design assumption — no standard fixes an operator person-space for makerspaces.
- **Person model = AREA**, measured as a cluster of 1 ft grid cells: `usableUsers = usableArea /
  personSpace`. Justification: (1) it matches the sf/person convention the occupant-load reference
  already uses; (2) it is **smooth/continuous**, which a MOSA objective needs (discrete headcount is a
  step function that starves SA of gradient); (3) the grid resolution *is* the egress grid, so
  "usable" and "walkable" share one discretization. **Alternative:** discrete circle/disc packing —
  rejected as primary because it is orientation- and shape-dependent and no more correct for a
  capacity estimate; a floored integer **headcount** is still reported alongside the fractional value.
- **Operator standing region resolution** (per machine, first that applies):
  1. explicit `operatorZonesFt: [{offsetX, offsetY, w, h}]` — local ft rectangles relative to the
     machine centre, rotated by `principalAxis.angle + rotation` (the A1 hand-checkable form);
  2. an E1 `clearanceZones` entry of `type:"operatorEnvelope"` (its rect/polygon geometry);
  3. **synthesised from occupancy** — a rectangle in front of the machine (front = the operator side,
     `principalAxis + 180°`), width = machine width, depth = `operatorCount·personSpace / width`, so
     its area is exactly `operatorCount·personSpace`. This is a design assumption; it makes a fully
     clear, reachable machine yield exactly `operatorCount` users.

## (c) Overlap accounting

Two operator regions may overlap; the shared area must **not** be double-counted. Both modes are
implemented and reported.

- **even-split (primary):** a cell shared by `n` machines contributes `1/n` of its area to each.
  `usableArea(m) = exclusiveArea(m) + Σ shared-cell shares`. Total counted area = union area (each
  cell once).
- **layer-priority (alternative):** the **topmost** machine claims the full overlap; a shared cell
  contributes its whole area to the highest-index machine in `project.machines` (later in the array =
  drawn on top) and `0` to the others. Avoids fractional attribution across machines. Total counted
  area is still the union (each cell once).

Both modes yield the **same building total** (union area); they differ only in the **per-machine
split**, which fixture (b) asserts.

- **Fractional capacity:** `usableUsers(m)` and the objective use the **fractional** value (smooth
  for MOSA). A human-readable **headcount** is reported as `floor(Σ usableUsers)` **at the zone and
  building level** — flooring the aggregate, not per machine, so capacity is not lost to per-machine
  rounding (three machines at 0.7 users each are 2 people, not 0). Justification: floor is the honest
  "how many whole people fit" and never over-claims; the fractional value is kept for gradient and for
  sensitivity.

## (d) Reachability — reuse of the engine's grid (no engine edit)

**The engine does not expose a reachable-cell set.** `evaluateLayout` returns only the scalar
`{ada, egress, noise}`; the walkable grid + BFS live in `runEgressCheck` (sim_egress.js:196), a
DOM-bound UI function that paints a canvas and is never on the headless path. Reading reachability out
of `evaluateLayout` would require an **engine edit** (adding a return value) — which is forbidden.

**What I did instead — call the engine's own functions via the V0 seam.** `_egressBuildGrid(stageW,
stageH)` (sim_egress.js:61) and `_egressBFS(grid, cols, rows)` (sim_egress.js:93) are vm-global
`function` declarations. Exactly as the O1 driver calls `evaluateLayout`/`allZoneDefs` inside the vm,
active-users injects code that calls **these same functions** and returns their `grid` + `dist`
arrays. This is **reuse of the actual engine code**, not a reimplementation: "walkable" is byte-for-
byte what egress means (same `EGRESS_GRID_RES_FT`, same `_egressIsBlocking` rules — passable ids,
`blocksMovement`, structural-floor, `cat`, wall — same 4-connected multi-source BFS from `cat:"exit"`
cells). `state.activeUse` is left `false` (applyTranslated sets it so), so operator footprints are
**not** rasterised as obstacles — people may stand in them.

**Blocker translation reuse.** The grid inputs are produced by the same translation the rest of v2
uses: interior walls are materialised into structural wall blockers and `exit-to-outside` doors into
`cat:"exit"` elements (a wall→blocker translation in the spirit of G2), and per-zone isolation reuses
G3's complement-blocker + `cat:"exit"` door-seed construction. A cell is reachable iff the engine's
BFS reaches it; a sealed zone (no exit door) yields all `dist < 0`, so every candidate there is
unreachable — consistent with G3 marking that zone `reachable:false`.

## (e) Normalization — minimized shortfall in [0,1]

MOSA objectives minimize and live in [0,1]. Active-users is a **maximise** quantity, so the objective
is a **normalized shortfall**:

```
activeUsers_objective = clamp( 1 − buildingUsers / referenceCapacity , 0, 1 )
referenceCapacity     = Σ_Z  zoneArea(Z) / 50        (NFPA 101 occupant load, 50 ft²/person)
```

Reference capacity is the **NFPA occupant load** the egress sim already uses
(`NFPA_OCCUPANT_LOAD_FACTOR_MAKERSPACE = 50`, sim_egress.js:21), so the objective reads as **"the
fraction of code-permitted occupancy that this layout fails to deliver."** 0 = the layout delivers (or
exceeds) full code occupancy; 1 = it delivers none. Justification: the reference is a real,
already-computed code quantity, giving the number an interpretable meaning rather than an arbitrary
denominator. **Alternative:** a fixed nominal reference (e.g. sum of `operatorCount`) — rejected
because it makes the objective insensitive to room size and unmoored from code. The clamp guards the
rare case where dense operator packing (`personSpace < 50`) would exceed the reference.

## (f) Per-zone vs building

- **Compose by summation.** `zoneUsers(Z) = Σ machines assigned to Z`; a machine is assigned to the
  zone whose polygon contains its footprint centre. `buildingUsers = Σ_Z zoneUsers(Z)`.
- **Unreachable zones contribute zero.** A zone with no exit door seeds no BFS cells, so every
  candidate cell in it has `dist < 0` and is rejected by (a)(3) — the zone contributes 0, exactly as
  G3 excludes an unreachable zone from its aggregate. This falls out of the reachability rule; it is
  not a special case.

---

# LIMITS (Task 5)

## Every design assumption (so the number is never mistaken for ground truth)

- **Person-space size = 15 ft²/operator** (`occupancy.personSpaceAreaUnits` default). A design
  assumption (net operator workspace); no makerspace standard fixes it. Halving it roughly doubles the
  count — the metric is linear in this number, so it is the single most load-bearing assumption.
- **Overlap rule.** Two modes, both implemented and reported: **even-split** (primary — shared area
  divided equally) and **layer-priority** (topmost = later in `project.machines` claims the overlap).
  Both give the same building total; they differ only in per-machine attribution.
- **Reference capacity = NFPA occupant load at 50 ft²/person** (the code figure the egress sim
  already uses). The shortfall is "fraction of code-permitted occupancy not delivered." A different
  reference rescales the objective but not the ranking of layouts.
- **People stand ONLY in operator standing regions**, not in open circulation. This is deliberate:
  counting everyone who could stand in a corridor would conflate usable capacity with egress area and
  double-count circulation. A "designated usable open area" can be added explicitly (as an operator
  region) but open space is not auto-counted. Design decision, not an oversight.
- **Operator standing region** resolves as explicit `operatorZonesFt` → E1 `operatorEnvelope` →
  occupancy synthesis (a front rectangle of area `operatorCount·personSpace`). The synthesis
  direction (machine-local +y) and the envelope sizes are design assumptions.
- **Wall materialisation thickness = 1.5 ft**; walls are rasterised as 1-cell-thick barriers on the
  1 ft egress grid. Thin enough not to eat zone area, thick enough to block the 4-connected BFS.

## What this is NOT

- **A static packing-plus-reachability metric, not a people-flow or congestion simulation.** It
  answers "how many operators fit in usable, reachable space at one instant," not how they move.
- **No queueing, no tours, no time-varying occupancy.** All three were raised on the project call and
  are explicitly out of scope. The metric has no notion of time; it is a single-snapshot capacity.
- **No inter-person spacing/packing geometry.** People are modelled as *area* (usableArea /
  personSpace), on the 1 ft grid — not as discs with a minimum separation. Two operators sharing a
  region are counted if the *area* supports them, regardless of whether two disc-people would
  physically fit in that exact shape.

## Reachability reuse — the one honest caveat

Reachability calls the engine's **own** `_egressBuildGrid` / `_egressBFS` via the V0 seam, so
"walkable" is byte-identical to egress — **but** the engine does not *expose* a reachable-cell set
from `evaluateLayout` (only the scalar objective; the grid lives in the DOM-bound `runEgressCheck`).
Reading it out would need an engine edit, which is forbidden, so this module **calls the functions
directly** instead. That is reuse, not reimplementation; the only thing not reused is a return value
the engine never offered.

## Defensible-but-surprising results (reported, not hidden)

- **Grid quantisation inflates area slightly.** A synthesised 20 ft² rectangle can cover 24 whole 1 ft
  cells (a cell counts if its centre is inside), so `waterjet` reads 1.2 users, not 1.0. This is the
  documented grid-cell-cluster model (b); it is consistent, not a bug, but it means fractional counts
  are grid-rounded upward at the region edges.
- **Tiny operator envelopes yield tiny counts.** `printer3d`'s E1 `operatorEnvelope` is 4 ft², so it
  contributes ~0.2–0.4 users regardless of its `personSpace`. Defensible (a small printer needs little
  operator space), but the count is governed by the envelope, not by `operatorCount`.
- **A machine can read 0 users in an otherwise open room.** In MRDC, `xr` reads 0.00: its synthesised
  operator strip falls on blocked/other-machine cells or a pocket the BFS does not reach. Correct per
  the definition (clear + reachable), but surprising if one expects every machine to seat someone.
- **The MOSA trade-off is real and counter-intuitively strong.** Across the 4-objective front,
  active-users-shortfall correlates with ADA at **r ≈ −0.90**: layouts that pack more usable capacity
  systematically worsen ADA corridor compliance (more people-space ⇒ tighter corridors). Egress and
  noise are largely decoupled from capacity on this fixture. This tension — usable capacity vs
  accessible circulation — is the scientifically interesting output and is exactly the kind of
  argument (more space needed, or accept fewer users) Dr. Jariwala asked the tool to surface.
