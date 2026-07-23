# SPACE Project Schema (v2) — plain-language guide

The v2 project file is a single JSON document that describes **everything a layout
needs as pure data**. There are no hardcoded room sizes, machine lists, or stage
dimensions anywhere in the v2 layer — they all live in this file. The formal contract
is `schema/space-project.v2.json` (JSON Schema draft 2020-12); this document explains
it in prose.

> **V0 scope.** This is the first v2 phase — the *seam*. The schema already carries
> forward-looking fields (per-machine footprint/clearance polygons, hazard flags, power,
> adjacency, rule modes, objective weights) so the shape is stable, but the **current v1
> engine does not read them yet**. Fields that are not yet consumed are marked
> *FORWARD-LOOKING* below and catalogued in `V2_COUPLING.md`.

---

## Coordinate convention

All in-room geometry is **normalized stage percent**: `0..100` of the stage bounding box,
with `x` to the right and `y` downward, origin at the top-left (NW) corner. Real-world
values (feet or meters) are derived through `room.scale`. This matches the engine's native
coordinate system, so geometry passes through the seam without rounding.

- A point at real `(39.6 ft, 48.6 ft)` on a `96.6 × 88.6 ft` stage is
  `x = 39.6/96.6*100 = 40.994 %`, `y = 48.6/88.6*100 = 54.853 %`.

---

## Top-level shape

```jsonc
{
  "schemaVersion": "2.0.0",
  "meta":   { "id": "...", "name": "...", "provenance": { ... } },
  "room":   { ... },              // the room shape + scale + floor outline
  "machineTypes": { ... },        // a library of reusable machine TYPES
  "machines":     [ ... ],        // placed machine INSTANCES (id + position)
  "optimization": { ... },        // movable set, seed, iters, weights
  "adjacency":    [ ... ],        // FORWARD-LOOKING pairwise rules
  "ruleModes":    { ... }         // FORWARD-LOOKING strict/advisory switches
}
```

`schemaVersion` is the version of the schema itself (V0 emits `2.0.0`). Bump the minor
version when adding optional fields, the major when changing the meaning of existing ones.

---

## `room` — one object for every shape

The **common case is a rectangle** with a user-editable width and height. Preset shapes
(L, T) and arbitrary polygons serialize through the *same* object — only `shape` and the
outline source change.

```jsonc
"room": {
  "shape": "rectangle" | "preset" | "polygon",
  "scale": { "pxPerUnit": 9, "unit": "ft", "widthUnits": 96.6, "heightUnits": 88.6 },
  "stage": { "widthPx": 869.4, "heightPx": 797.4 },   // optional; else pxPerUnit*units
  "floorId": "floor_mrdc2323",
  "floorLabel": "MRDC 2323 Floor Boundary (L-shaped)"
}
```

- **rectangle** — the outline is the full stage box `(0,0)-(100,0)-(100,100)-(0,100)`.
  Just set `scale.widthUnits`/`heightUnits`; nothing else needed. This is what a user gets
  by typing a width and height.
- **preset** — set `preset: "L"` or `"T"` plus `presetParams` (notch/stem fractions in
  stage %). The translator expands the preset into the identical polygon form.
- **polygon** — set `polygonPct` to the outline points (each `{x,y}` in stage %). Use this
  for a traced floor plan. The MRDC 2323 L-shape is a 6-point polygon.

`floorId` is the id given to the engine's structural floor element (must not collide with a
machine id). The outline drives the **analysis scope**: the optimizer rejects any placement
that pokes outside it (the SE notch of the MRDC L is excluded, for example).

`verticesUnits` and `notes` are documentation only — never read by the translator.

---

## `machineTypes` — the reusable library

A map from **type id** to shared attributes. Instances reference a type and add position.

```jsonc
"machineTypes": {
  "wood":  { "label": "Wood Room", "short": "Wood", "risk": 4, "w": 10, "h": 7, "dba_active": 105 },
  "exitS": { "label": "Emergency Exit South", "short": "Exit S", "risk": 0, "fixed": true, "cat": "exit", "w": 6.5, "h": 4.5 }
}
```

Fields the **engine reads today** (V0):

| Field | Meaning |
|-------|---------|
| `w`, `h` | Default footprint size, stage % (an instance can override). |
| `dba_active` | Operating sound level at 1 m (dBA). Below 40 dBA (ambient) ⇒ not a noise source; **absent ⇒ non-emitter**. |
| `cat` | Category the engine keys off: `exit` (an egress seed), `corridor`/`open` (kept out of the movable pool), `structural-wall`/`wall` (solid), `structural-door`/`door`, `structural-floor`. Empty/other ⇒ solid equipment. |
| `fixed` | `true` ⇒ the instance is locked (never movable). |
| `label` | Display name; also used by ADA door-width checks (a door whose label contains "exit" uses the exit minimum width). |
| `elementClass` + `subtype` | For structural elements: a `structural`+`floor` element is a non-blocking area label; `wall`/`door` get STC/opening handling. |
| `blocksMovement` | Explicit boolean override for ADA/egress blocking (wins over `cat`). |
| `schedule_prob` | Duty-cycle probability for the noise Monte Carlo; absent ⇒ engine default. |
| `risk`, `short`, `beginner` | Carried through; not read by the sim objectives (used by scoring/UI). |

Fields present in the schema but **not yet consumed** (*FORWARD-LOOKING*):
`footprintPolygon`, `clearanceZones`, `hazards`, `power`, `ventilation`, `utilities`,
`amenityLinks`, `occupancy` (the E1 attribute layer, schema `2.1.0`). They are safe to include —
the translator does not forward them, so they cannot change engine results — and they reserve the
shape for the phases that will wire them in. See the next section and `v2/ELEMENT_ATTRIBUTES.md`.

---

## Element attributes (E1, schema `2.1.0`) — FORWARD-LOOKING

E1 makes the machine attributes every planned objective needs **real, schema'd, and
provenance-tagged**, without building any objective that reads them. Every attribute is optional
with an **inert default**, so a `2.0.0` project omitting them validates and behaves identically. The
full specification (with provenance for every value) is `v2/ELEMENT_ATTRIBUTES.md`; a starter
library of 21 standard makerspace machines is `v2/machine-library.json`.

| Group | Field | What it carries |
|-------|-------|-----------------|
| **Hazards** | `hazards.{dustProducing,dustSensitive,sparkSource,hotWork,wetProcess,flammable,vibrationSource,vibrationSensitive}` | Independent booleans (a machine may carry several). Drive the future adjacency-compatibility matrix. |
| **Acoustic** | `dba_active`, `schedule_prob` | **The only attributes read today** (noise sim). Pinned dBA are preserved exactly. |
| **Ventilation/utilities** | `ventilation.{localExhaustRequired,cfm,requiresExteriorWallOrDuct}`, `power.{volts,amps,phase}`, `utilities.{compressedAir,waterSupply,floorDrain}` | Exhaust, exterior-wall/duct, power, air/water/drain. |
| **Clearance zones** | `clearanceZones[]` | First-class, rotation-aware, **directional** keep-clear regions (see below). |
| **Amenity links** | `amenityLinks[]` | Typed link to a required amenity (eyewash, extinguisher, …) with a max distance/time and mode. |
| **Occupancy** | `occupancy.{operatorCount,personSpaceAreaUnits,footprintsMayOverlap}` + existing `operatorFootprints` | Inputs for a future active-users metric. |

### Clearance zones — rotation-aware and directional

Each entry has a `type` (`operatorEnvelope`, `infeedCorridor`, `outfeedCorridor`,
`maintenanceAccess`, `kickbackCone`, `sparkArc`, `doorSwing`), a `geometry` (a parametric
`template` — `rect` or `cone` — **or** an explicit machine-local `polygon`), a `severity`
(`hard`/`advisory`), and an `orientation.angleDeg` **relative to the machine's principal axis** so
the zone rotates with the machine (the same convention `scoring.js` uses for vectors). Distances are
real units.

> **Relationship to the existing `kickbackVectors`/`materialVectors`.** Those arrays are still read
> by `scoring.js`'s conflict check (a metrics/flags path, **not** the noise/ADA/egress objective) and
> are **retained unchanged**. `clearanceZones` is a **superset** the future objectives will consume.
> A machine may declare both; keep a `kickbackCone` clearance zone consistent with its
> `kickbackVector`. E1 does not auto-derive one from the other — see the GAPS note in
> `v2/ELEMENT_ATTRIBUTES.md`.

### Worked example — a table saw (`machineTypes` entry)

A table saw exercises the whole layer: hazard flags, a kickback cone, infeed/outfeed corridors,
dust production, a dust-collection link, and a real dBA.

```jsonc
"tableSaw": {
  "label": "Table Saw", "short": "TSaw", "w": 6, "h": 5, "risk": 5,
  "dba_active": 105,                       // NIOSH power-tool noise (approx.)
  "schedule_prob": 0.3,                    // duty cycle (design assumption)
  "principalAxis": { "angle": 0, "length": 40 },
  "hazards": { "dustProducing": true, "sparkSource": false, "flammable": false },
  "ventilation": { "localExhaustRequired": true, "cfm": 350, "requiresExteriorWallOrDuct": false },
  "power": { "volts": 240, "amps": 15, "phase": 1 },
  "occupancy": { "operatorCount": 1, "personSpaceAreaUnits": 15, "footprintsMayOverlap": false },

  // Directional clearances (real units = feet), each rotates with the machine:
  "clearanceZones": [
    { "id": "infeed",  "type": "infeedCorridor",  "severity": "hard",
      "geometry": { "kind": "template", "template": "rect",
                    "params": { "offsetUnits": 0, "alongUnits": 8, "acrossUnits": 3 } },
      "orientation": { "relativeTo": "principalAxis", "angleDeg": 180 },
      "provenance": "OSHA 1910.213 (woodworking); stock length = design assumption" },
    { "id": "outfeed", "type": "outfeedCorridor", "severity": "hard",
      "geometry": { "kind": "template", "template": "rect",
                    "params": { "offsetUnits": 0, "alongUnits": 8, "acrossUnits": 3 } },
      "orientation": { "relativeTo": "principalAxis", "angleDeg": 0 },
      "provenance": "OSHA 1910.213; design assumption" },
    { "id": "kickback", "type": "kickbackCone", "severity": "hard",
      "geometry": { "kind": "template", "template": "cone",
                    "params": { "apexOffsetUnits": 0, "spreadDeg": 20, "lengthUnits": 12 } },
      "orientation": { "relativeTo": "principalAxis", "angleDeg": 180 },
      "provenance": "design assumption (no standard cone geometry)" }
  ],

  // Existing scoring-consumed cone kept CONSISTENT with the kickbackCone above:
  "kickbackVectors": [ { "type": "vector", "offsetX": 0, "offsetY": 0, "angle": 180, "angleSpread": 20 } ],
  "operatorFootprints": [ { "type": "rect", "offsetX": 0, "offsetY": -20 } ],

  "amenityLinks": [
    { "amenityType": "dustCollection", "maxDistanceUnits": 30, "mode": "advisory",
      "provenance": "NFPA 664 (system); 30 ft duct run = design assumption" }
  ]
}
```

Because none of these fields is in the seam's `ENGINE_DEF_FIELDS`, adding this block to a project
changes **no** engine result — proven bit-for-bit in `v2/test-element-attributes.mjs`.

---

## `machines` — placed instances

An **ordered** array. Order matters: it flows into the engine's zone list. Each instance:

```jsonc
{ "id": "wood", "type": "wood", "x": 14, "y": 38, "w": 9, "h": 6 }   // w/h override the type
{ "id": "storage", "type": "storage", "x": 4, "y": 4 }               // inherits type w/h
```

- `id` is the unique instance id **and** the engine zone id.
- `x`, `y` are the top-left corner in stage % (default `50` if omitted).
- `w`, `h`, `rotation` are optional overrides (else the type's `w`/`h`, rotation `0`).

In v1 each element was a singleton, so here every instance's `type` equals its `id`; the
type/instance split is what lets v2 place many machines of one type later.

---

## `optimization`

```jsonc
"optimization": {
  "movableIds": ["craftland","xr","asm1", ...],   // the ids the optimizer may move
  "seed": "0x4D524443",                            // PRNG seed (hex string or int)
  "iters": 4000,                                    // SA iterations
  "objectiveWeights": { "ada": 0.333, "egress": 0.333, "noise": 0.333 }
}
```

- `movableIds` is the exact set handed to the optimizer; everything else is a fixed obstacle.
- `seed` + `iters` make a run reproducible.
- `objectiveWeights` is **FORWARD-LOOKING**: the current MOSA optimizer uses *randomized-weight*
  simulated annealing (it samples a fresh weight vector on the 3-simplex every iteration), so it
  does **not** read these weights. They are retained for a future weighted-scalar report and for a
  weight-driven objective (see `V2_COUPLING.md`).

---

## `adjacency` — tool-adjacency overrides (v2 Phase N1, schema `2.2.0`)

`adjacency` is now **consumed** by the `adjacency` MOSA objective (`v2/adjacency.mjs`). It answers
"can these two machines sit next to each other?" using built-in defaults (safety-standard rules
derived from E1 hazard flags, plus explicit SLP workflow pairs — all in `v2/adjacency-defaults.json`
with provenance), and this array lets a project **override** any pair:

```jsonc
"adjacency": [
  { "a": "weldingStation", "b": "tableSaw", "level": "NEUTRAL",
    "provenance": "user: fire wall installed between them" },
  { "a": "bandSaw", "b": "assemblyTable", "level": "SYNERGISTIC", "mode": "advisory",
    "requiredSeparationUnits": 4, "provenance": "shop workflow" }
]
```

- `level` ∈ `PROHIBITED` | `DISCOURAGED` | `NEUTRAL` | `SYNERGISTIC` (SLP REL X / X / U / A–E).
- `a`,`b` match a machine **type** pair or instance **id** pair, unordered unless `directed: true`.
- `mode` ∈ `strict` | `advisory` (strict weighted 5×; **scoring only in N1** — hard rejection is R1).
- `requiredSeparationUnits` (real units, ft) — required separation for PROHIBITED/DISCOURAGED, ideal
  adjacency distance for SYNERGISTIC; omitted ⇒ level default (35 / 10 / 5 ft).
- `provenance` — a standard clause, `design assumption`, or a user note; recorded in the objective's
  diagnostics for auditability.

**Precedence:** this array (user override) > built-in explicit pair > rule-derived hazard rule >
NEUTRAL. **Optional and inert by default** — an absent/empty array leaves the built-in defaults in
force, and a pre-2.2.0 project omitting it is unaffected. `ruleModes` remains forward-looking
(global strict/advisory switches for the future R1 enforcement phase).

## `amenityLinks` — amenity-link overrides (v2 Phase L1, schema `2.3.0`)

`amenityLinks` (top level) is **consumed** by the `amenityLinks` MOSA objective
(`v2/amenity-links.mjs`). It answers "is each machine within reach of the amenities it requires?" —
a hazardous tool near a fire extinguisher and eyewash, a laser near ventilation. Built-in required
links come from the machine type's own `amenityLinks` (E1) plus rule-derived defaults from hazard
flags (`v2/amenity-link-defaults.json`); this top-level array lets a project **override** a specific
`(machine, amenityType)` requirement:

```jsonc
"amenityLinks": [
  { "machine": "laserCutter", "amenityType": "fireExtinguisher", "maxDistanceUnits": 50,
    "provenance": "user: portable Class-B extinguisher rated for 50 ft here" }
]
```

- `machine` matches a machine **id** or **type**; `amenityType` names the required amenity.
- Requirement: `maxDistanceUnits` (ft) or `maxTravelSeconds` (converted at 5.5 ft/s). `mode`
  strict (×5) / advisory. `provenance` required.
- **Path-based vs straight-line:** `eyewash`/`fireExtinguisher`/`firstAid`/`shower` use **walking
  travel** through the engine's egress grid (a wall really does defeat a nearby eyewash);
  `fumeHood`/`flammablesCabinet`/`dustCollection`/`sink` use **straight-line** proximity.
- **Precedence:** this array (override) > machine type's `amenityLinks` > rule-derived > none.
  **Optional and inert by default**; scoring only (hard rejection is R1).

---

## `structuralGeometry` — walls, doors, floors, zones (v2 Phase G1)

> **Now forwarded through the seam automatically (v2 Phase V1).** This section describes the room
> as a set of **linked** structural elements that form closed, calculable zones. It is the
> input/output of `v2/zone-detection.mjs`. **As of V1, `translateProject` materialises it into the
> engine automatically** — interior walls become `cat:"wall"` blockers and `exit-to-outside` doors
> become `cat:"exit"` egress seeds — so the whole-stage engine grid (ADA, egress, noise,
> active-users) sees the zones **natively**, with **no caller-side materialisation**. Two rules:
>
> - **Precedence.** Explicit `room.structuralBlockers` (the Phase 2d pre-materialised rects) **win**:
>   if a project carries both `structuralBlockers` and `structuralGeometry`, the geometry is **not**
>   auto-materialised, so the same cells can never be double-registered (double walls would double
>   the noise-STC attenuation even if the walkable grid looked identical). The frozen MRDC project
>   uses only `structuralBlockers` and carries no `structuralGeometry`, so **its path is untouched
>   and the pin reproduces bit-for-bit.**
> - **Composition.** The **whole building** is forwarded (all zones' walls + all exterior exits), not
>   a single isolated zone. G3 owns per-zone isolation (via G2 complement blockers); the whole-stage
>   MOSA path needs the full building geometry, and the objective grids are exit-seeded correctly by
>   forwarding every `exit-to-outside` door. Interior-bridge doors are left as wall gaps (walkable,
>   not seeds). Rectilinear walls only (inherited G2 limitation) — a diagonal wall is skipped with a
>   warning rather than silently approximated.

Before G1, walls, doors, and floors were separate, unlinked elements — nothing formed a closed
contour, so no zone-scoped calculation was possible. G1 links them:

- a **wall** is a segment between two endpoints (stage-%). Walls that share endpoints (within a
  small snap tolerance) knit together into a graph;
- a **door** is a *permeable* wall segment (`walkThrough: true`). It still bounds a zone for area
  purposes, but is flagged as an opening. A door either **bridges two zones** (`interior-bridge`)
  or connects a zone **to outside** (`exit-to-outside`);
- a **zone** is a region enclosed by a closed loop of wall/door segments. Each zone knows its
  bounding segments (`boundary`) and its doors, and carries an `attributes` bag reserved for later
  sim use (noise/dust/etc), **empty-but-present** now;
- a **floor** is the region bounded by a zone's closed loop (1:1 with a zone in G1).

Everything is **linked by reference**: a door names the wall it lies on and the zones it connects;
a zone names its bounding walls and its doors; a floor names its loop and zone.

```jsonc
"structuralGeometry": {
  "snapTol": 0.05,
  "walls": [ { "id": "w0", "from": {"x":0,"y":0}, "to": {"x":100,"y":0}, "thickness": 0.5, "stc": 45, "blocksMovement": true } ],
  "doors": [ { "id": "d0", "wall": "w_bottom_a", "from": {"x":40,"y":100}, "to": {"x":60,"y":100},
              "walkThrough": true, "width": 3, "role": "exit-to-outside", "zones": ["zone0"] } ],
  "floors":[ { "id": "floor_zone0", "zoneId": "zone0", "loop": ["w0","w1","w2","w_bottom_a","d0","w_bottom_b"] } ],
  "zones": [ { "id": "zone0", "boundary": ["w0","w1","w2","w_bottom_a","d0","w_bottom_b"],
              "doors": ["d0"], "polygonPct": [ /* computed */ ], "areaUnits": 1200, "isRoom": true, "attributes": {} } ]
}
```

**Coordinates & area.** Endpoints are stage-% (0..100). Areas are computed by converting the zone
polygon to real units via `room.scale` (which may be anisotropic — different feet-per-percent on x
and y) and then applying the shoelace formula.

### Worked example 1 — one rectangular room with one exit door

Stage 40 ft × 30 ft. Four walls form a rectangle; the bottom wall is carved into
`wall | door | wall` so the door is a real segment on the boundary:

```jsonc
"walls": [
  { "id": "top",    "from": {"x":0,"y":0},   "to": {"x":100,"y":0}   },
  { "id": "right",  "from": {"x":100,"y":0}, "to": {"x":100,"y":100} },
  { "id": "bot_a",  "from": {"x":100,"y":100},"to": {"x":60,"y":100} },
  { "id": "bot_b",  "from": {"x":40,"y":100},"to": {"x":0,"y":100}   },
  { "id": "left",   "from": {"x":0,"y":100}, "to": {"x":0,"y":0}     }
],
"doors": [ { "id": "exit", "from": {"x":60,"y":100}, "to": {"x":40,"y":100}, "wall": "bot_a", "role": "exit-to-outside" } ]
```

`detectZones` returns **one zone** of area **1,200 ft²** whose boundary includes the door, and
classifies `exit` as **exit-to-outside** (it borders the room on one side and outside on the other).

### Worked example 2 — one room split by an interior false wall into two zones sharing a doorway

Add an interior wall down the middle, carved into `wall | door | wall`. The two outer walls it
touches are also split at the junction so all four meet at shared nodes:

```jsonc
"walls": [
  /* outer loop split at x=50 on top & bottom … */
  { "id": "int_top", "from": {"x":50,"y":0},  "to": {"x":50,"y":40}  },
  { "id": "int_bot", "from": {"x":50,"y":60}, "to": {"x":50,"y":100} }
],
"doors": [ { "id": "inner", "from": {"x":50,"y":40}, "to": {"x":50,"y":60}, "wall": "int_top", "role": "interior-bridge" } ]
```

`detectZones` returns **two zones** (left and right), each with its computed area, and classifies
`inner` as **interior-bridge** (it borders *both* zones). The false wall is a normal wall; only the
`inner` segment is a door. Removing the false wall later is a one-line correction
(`{ op: "merge", zones: ["zone0","zone1"] }`) — see the correction interface.

### Auto-detection, correction, and validation

`v2/zone-detection.mjs` (pure functions, no UI):

- `detectZones(structuralGeometry, scale)` finds closed loops in the wall graph → zones, each with
  `polygonPct` and `areaUnits`; classifies doors; and reports degenerate cases as **flags** rather
  than crashing: open contour (dangling wall end), wall crossing another wall, a door not attached
  to any wall, and nested/overlapping loops.
- `validateGeometry(result)` flags: zones with no door (unreachable — sims should later default to
  zero), doors not linked to a wall, walls not part of any zone boundary, and notes that area
  outside all zones is intentionally **not-computed**.
- `applyCorrections(result, [...])` accepts user overrides and returns a corrected zone set:
  `{ op: "merge", zones: [a,b] }`, `{ op: "split", zone: id, line: {from,to} }`,
  `{ op: "not-a-room", zone: id }`.
- `polygonToWalls(polygonPct, opts)` derives a wall loop from a room outline (used to run the
  detector on the frozen MRDC L-polygon).

---

## How the seam uses this file

`v2/project-to-engine.mjs` `translateProject(project)` extracts exactly the subset the engine
consumes and returns engine inputs (`scale`, structural `floorDef`, `blockers`, ordered
`elementDefs`, per-zone `configZones`, `movableIds`). **V1:** `blockers` now includes any walls and
exit seeds materialised from `structuralGeometry` (subject to the precedence rule above), so a
project carrying G1 geometry produces zone-aware engine state through the seam alone.
`applyTranslated(state, ZONE_DEFS, inputs)` then builds the engine's `state`/`ZONE_DEFS` identically
to the frozen harness (including the Phase 2c floor re-registration); the geometry blockers flow
through the **unchanged** Phase 2d blocker registration. The equivalence test
(`v2/equivalence-test.mjs`) proves the MRDC 2323 project reproduces `tools/baseline-mrdc2323.json`
bit-for-bit, and `v2/active-users.mjs` now obtains its zone-aware grid through the seam with no local
materialisation.
