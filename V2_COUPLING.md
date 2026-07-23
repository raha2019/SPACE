# V2_COUPLING — remaining hardcoded coupling (V1-phase backlog)

Catalog of every place the engine (or the inputs it requires) still depends on **named MRDC
ids or fixed values that the v2 schema cannot yet express**. V0 built the seam only; nothing
here is fixed yet. Each entry lists the location, what is hardcoded, whether the current
schema can already express it, and the proposed schema-driven replacement.

**Constraint reminder:** every fix below edits a *trusted* engine file
(`sim_*`, `scoring.js`). None may be done without re-proving the frozen pin
(`v2/equivalence-test.mjs`) bit-for-bit afterward. That is the whole point of freezing the
pin first.

Status legend: **BLOCKS-GENERALITY** (a different room/machine set gives wrong results) ·
**DEAD-INPUT** (schema field exists but engine ignores it) · **CONSTANT** (regulatory/engine
constant, arguably not layout data).

---

## A. Already resolved by V0 (was hardcoded in v1, now pure data)

These moved out of the harness/data files into the v2 schema and are proven equivalent:

| v1 hardcoding | v2 replacement |
|---|---|
| Stage `96.6 × 88.6 ft`, `pxPerUnit 9`, `stageWidthPx/HeightPx` (harness + `mrdc2323-scale.json`) | `room.scale` + `room.stage` |
| L-polygon vertices (`mrdc2323-scale.json` floorDef) | `room.polygonPct` (+ `room.shape`) |
| The 21 element defs incl. `dba_active` (`default-elements.json`) | `machineTypes` |
| Zone positions (`default-configuration.json`) | `machines[].{x,y,w,h,rotation}` |
| The explicit 14-id movable list (harness `MOVABLE_IDS`) | `optimization.movableIds` |
| Seed `0x4D524443`, `iters 4000` (harness) | `optimization.{seed,iters}` |

---

## B. Engine named-id couplings (BLOCKS-GENERALITY) — must be schema-driven before a non-MRDC room works

### B1. `sim_ada.js:46` — `ADA_PASSABLE_IDS = {corridor, connector, rightOpen, entrance}`
Hardcoded ids that are "always traversable even if their category would mark them as
obstacles." A different project that names its corridor `hallway` would have it treated as a
solid wall in the ADA grid.
**Schema today:** partial — the engine already honors `def.blocksMovement === false`, but the
hardcoded id-set is checked *before* it (`sim_ada.js:52` precedes `:55`), so it wins.
**Proposed:** delete the id-set; drive circulation purely from `blocksMovement:false` (or a new
`role:"circulation"`), which `machineType` can already carry. For the MRDC pin, set
`blocksMovement:false` on those four types so the result is unchanged, then re-pin.

### B2. `sim_egress.js:41` — `EGRESS_PASSABLE_IDS = {corridor, connector, rightOpen, entrance}`
Identical issue and fix as B1, in the egress grid builder.

### B3. `scoring.js` — pervasive named-id rules (the largest surface)
`scoring.js` is **not** loaded by the MOSA validation harness, so it does **not** affect the
frozen pin — but it drives the app's score readout and the legacy `optimizeLayout`, and it is
the most MRDC-specific file in the engine:

| Line | Hardcoded | Proposed schema-driven replacement |
|---|---|---|
| `151` `const exits = ["exitN","exitS"]` | exit ids | derive from `cat === "exit"` (already the convention elsewhere) |
| `172` `beginnerCenters = ["asm1","asm2","craftland","xr"]` | beginner zones | `machineType.beginner === true` (field already exists) |
| `265` `tables = ["asm1","asm2","craftland","electronics"]` | work-table set | a `role`/tag on the type (e.g. `role:"worktable"`) |
| `310` `for (exId of ["exitN","exitS"])` | exit ids | `cat === "exit"` |
| `432` `["exitN","exitS","entrance"].includes(d.id)` (`_scDoors`) | door/opening ids | `cat === "exit"` + `elementClass/subtype === door` (partly there) |
| `559` `adj("asm1","storage",40)` | a specific adjacency preference | `project.adjacency` rules (schema section already reserved) |
| `561` `hrIds = ["welding","waterjet","metal","wood","cnc","laser"]` | high-risk machines | `machineType.risk >= 4` (risk already in the schema) |
| `191`–`232` craftland/entrance/corridor/connector specific proximity rules | named pairs | generalize to `adjacency` rules + `role` tags |

**Proposed umbrella:** introduce `role` (string/enum) and lean on existing `risk`, `beginner`,
`cat`; move the pairwise rules into `project.adjacency`. Then `scoring.js` reads roles/tags/rules
instead of literal ids. High effort — this is the bulk of the V1 phase.

---

## C. Dead schema inputs (DEAD-INPUT) — engine must start reading them

### C1. `optimization.objectiveWeights` — ignored by the optimizer
`sim_mosa.js:262` samples a **random** weight vector on the 3-simplex every iteration
(randomized-weight SA), so configured weights never reach the search.
`sim_eval.js:43` `EVAL_WEIGHTS = {1/3,1/3,1/3}` is a separate fixed set used only by
`evalObjective` for a scalar readout.
**Proposed:** add `optimization.weightMode: "random" | "fixed"`; in `fixed` mode, thread
`objectiveWeights` into `mosaOptimize` (replacing the per-iteration sample) and into
`evalObjective`. Keep `random` as the default so the pin is unaffected.

### C2. `machineType.footprintPolygon` — non-rectangular footprints ignored
The engine derives every footprint from the `w×h` rectangle (`simBlockerFootprint` in
`state.js`). `footprintPolygon` is carried in the schema but unused.
**Proposed:** teach `simBlockerFootprint` to accept a polygon footprint when present; falls back
to the rectangle otherwise (pin unaffected — MRDC uses rectangles).

### C3. `machineType.clearanceZones` — directional keep-clear regions ignored
No engine consumer yet. These are the natural basis for a new "clearance/access" objective.
**Proposed:** a new sim module (future objective phase) that reads `clearanceZones`; the adapter
already round-trips them.

### C4. `machineType.hazards` (dust/spark/hotWork/wet) and `power` — ignored
No consumer. Reserved for future separation/utility objectives.
**Proposed:** new objective(s) keyed off these flags; adapter forwards them when a consumer exists.

### C5. `adjacency` + `ruleModes` — ignored
No consumer in the engine. `scoring.js` currently encodes a couple of these as hardcoded pairs
(see B3, lines 559). **Proposed:** a rule evaluator that reads `project.adjacency` with
`mode: strict|advisory`, replacing the hardcoded pairs.

---

## D. Regulatory / engine constants (CONSTANT) — lower priority

Not MRDC-specific and arguably not *layout* data, but currently un-configurable:

| Location | Constant | Note |
|---|---|---|
| `sim_noise.js:28` | `NOISE_AMBIENT_DBA = 40` | emitter threshold |
| `sim_noise.js` | `NOISE_*_ITERATIONS`, grid res | MC/grid tuning |
| `sim_eval.js:33` | `EVAL_NOISE_ITERATIONS = 25` | optimizer-loop MC count (drives the seed-dependent noise; see Weakness #4) |
| `sim_ada.js:42` | `ADA_GRID_RES_FT = 0.5`, `ADA_MIN_*` widths | ADA thresholds |
| `sim_egress.js` | `NFPA_MAX_TRAVEL_DISTANCE_FT`, `EGRESS_GRID_RES_FT` | NFPA thresholds |

**Proposed (optional, later):** an `engineConfig`/`ruleConfig` block in the schema for the
regulatory thresholds and MC/grid resolutions, defaulting to today's constants so the pin holds.

---

## Suggested V1-phase order

1. **B1/B2** (small, unblocks non-MRDC circulation) → re-pin.
2. **B3** (large, the scoring.js roles/tags/adjacency refactor) → re-pin.
3. **C1** (weight-driven objective) → new pin variant, keep `random` default.
4. **C2–C5** as each new objective lands.
5. **D** last, if wanted.

Every step ends with `node v2/equivalence-test.mjs` green (or a deliberately re-pinned baseline
with the change documented, exactly as Phase 2c did for notch enforcement).
