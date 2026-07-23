# Element Attribute Layer (v2 Phase E1)

The data foundation for every planned v2 objective. This phase makes machine/element
attributes **real, schema'd, provenance-tagged, round-trippable, and testable** — but builds
**no objective that consumes them**. Building the data and the metric in one phase would let a
wrong metric hide a wrong attribute, so they are deliberately separated.

**Inertness bar.** Adding a field that nothing reads changes nothing. Guaranteed by
construction: the V0 seam forwards only the fields in `ENGINE_DEF_FIELDS`
(`v2/project-to-engine.mjs`). None of the E1 attributes below are added to that list, so
`translateProject` drops them and `evaluateLayout` never sees them. The frozen WSC pin
(`0.13827363048035732 / 0.4275 / 0.40589569160997735`, front 18, 18/18) reproduces bit-for-bit
(proven in `v2/test-element-attributes.mjs` §4e).

**Provenance is mandatory.** Every numeric default is either a specific standard clause, a
published measurement, or the literal string **"design assumption"**. A value with provenance
`"unknown"` is not acceptable. Attributes with no governing standard are flagged explicitly.

Schema: `schema/space-project.v2.json` (bumped to `2.1.0`). Library: `v2/machine-library.json`.
Coordinates are stage-% for footprints (matching the engine); clearance/utility distances are in
**real units** (`room.scale.unit`, feet in MRDC).

---

## (a) Hazard flags — `hazards`

**Type choice: independent booleans, not an enum.** A single machine routinely carries several
hazards at once (a CNC router is `dustProducing` **and** `vibrationSource`; a welder is
`sparkSource` **and** `flammable`-adjacent). An enum forces one value and cannot express
combinations; a boolean set expresses any subset. These drive the future adjacency-compatibility
matrix (e.g. `sparkSource` must stay far from `flammable`, `dustProducing` far from
`dustSensitive`).

| Attribute | Type | Default | Consumed by (future) | Provenance |
|---|---|---|---|---|
| `hazards.dustProducing` | bool | `false` | dust/adjacency objective | design assumption (hazard taxonomy); combustible wood dust context NFPA 664 |
| `hazards.dustSensitive` | bool | `false` | dust/adjacency objective | design assumption (e.g. electronics, optics, food) |
| `hazards.sparkSource` | bool | `false` | spark/hot-work separation objective | NFPA 51B §5.6 (hot-work spark hazard) |
| `hazards.hotWork` | bool | `false` | hot-work separation objective | NFPA 51B (hot work definition) |
| `hazards.wetProcess` | bool | `false` | wet/electrical separation objective | design assumption; OSHA 1910.303 (wet + electrical) context |
| `hazards.flammable` | bool | `false` | flammable-separation objective | NFPA 30 / OSHA 1910.106 (flammable liquids) |
| `hazards.vibrationSource` | bool | `false` | vibration-separation objective | design assumption (no makerspace-specific clause) |
| `hazards.vibrationSensitive` | bool | `false` | vibration-separation objective | design assumption (e.g. metrology, microscopy) |

Absent `hazards` object ⇒ all flags `false` ⇒ no hazard declared ⇒ inert. **No standard sets a
numeric threshold for any of these flags themselves** — they are categorical; the *pairwise
separation distances* they trigger are standard-cited where one exists (spark↔flammable NFPA 51B
35 ft) and design assumptions otherwise. Flagged: `vibrationSource`/`vibrationSensitive` have **no
governing standard**.

## (b) Acoustic — `dba_active`, `schedule_prob`

| Attribute | Type | Units | Default | Consumed by | Provenance |
|---|---|---|---|---|---|
| `dba_active` | number | dBA @ 1 m | absent ⇒ non-emitter (< 40 dBA ambient) | **noise objective (LIVE, sim_noise)** | **pinned in the SPACE frozen project — NOT re-derived here**; library values from NIOSH power-tool noise data (approximate, see note) |
| `schedule_prob` | number | probability [0,1] | engine default (sim_noise) | **noise objective (LIVE)** | design assumption (duty cycle); engine-consumed today |

**The pinned project dBA values are preserved exactly and are not touched by E1** (mainDesk 55,
craftland 60, xr 45, asm1/asm2 70, bike 70, electronics 45, print3d 50, laser 65, cnc 103, metal
91, wood 105, welding 90, waterjet 92). The library's per-machine dBA are separate values (tool
granularity, not room granularity) provenance-tagged individually. `dba_active` and
`schedule_prob` are the **only** attributes in this document that a simulation reads today; every
other attribute is inert until a later phase.

## (c) Ventilation & utilities — `ventilation`, `power`, `utilities`

| Attribute | Type | Units | Default | Consumed by (future) | Provenance |
|---|---|---|---|---|---|
| `ventilation.localExhaustRequired` | bool | — | `false` | ventilation/placement objective | OSHA 1910.94 (ventilation); ACGIH Industrial Ventilation Manual |
| `ventilation.cfm` | number\|null | ft³/min | `null` (unknown) | ventilation sizing | design assumption / manufacturer spec (per-machine) |
| `ventilation.requiresExteriorWallOrDuct` | bool | — | `false` | exterior-wall placement objective | design assumption (laser/welding exhaust routing) |
| `power.volts` | number | V | absent | power-routing objective | design assumption / NEC 210; nameplate |
| `power.amps` | number | A | absent | power-routing objective | design assumption / nameplate |
| `power.phase` | enum `1`\|`3` | — | absent | power-routing objective | design assumption / nameplate |
| `utilities.compressedAir` | bool | — | `false` | utility-routing objective | design assumption |
| `utilities.waterSupply` | bool | — | `false` | utility-routing objective | design assumption |
| `utilities.floorDrain` | bool | — | `false` | utility-routing objective | design assumption |

All absent/false/null ⇒ inert. Flagged: specific `cfm`, `amps`, `volts` are **manufacturer/model
dependent** — the library uses representative values marked design assumption, not measured
nameplates.

## (d) Clearance zones — `clearanceZones` (first-class, rotation-aware, directional)

Each machine carries zero or more clearance zones. Each zone:

| Field | Type | Allowed values | Default | Provenance |
|---|---|---|---|---|
| `id` | string | unique within the machine | — | — |
| `type` | enum | `operatorEnvelope`, `infeedCorridor`, `outfeedCorridor`, `maintenanceAccess`, `kickbackCone`, `sparkArc`, `doorSwing` | — | design assumption (taxonomy) |
| `geometry.kind` | enum | `template` \| `polygon` | — | — |
| `geometry.template` | enum | `rect`, `cone` | (when kind=template) | design assumption |
| `geometry.params` | object | template params, real units (see below) | — | per-value provenance |
| `geometry.points` | point[] | machine-local coords (real units), when kind=polygon | — | design assumption |
| `severity` | enum | `hard` \| `advisory` | `advisory` | design assumption (OSHA 1910.212 guarding → hard) |
| `orientation.relativeTo` | const | `principalAxis` | `principalAxis` | — |
| `orientation.angleDeg` | number | degrees, relative to the machine's principal axis | `0` | — |

**Template params.** `rect`: `{ offsetUnits, alongUnits, acrossUnits }` (a keep-clear rectangle at
`offsetUnits` in front, `alongUnits` deep × `acrossUnits` wide). `cone`: `{ apexOffsetUnits,
spreadDeg, lengthUnits }` (apex at `apexOffsetUnits` from center along the zone direction, half-angle
`spreadDeg`, reach `lengthUnits`).

**Rotation model (directional, rotates with the machine).** A zone's world direction is
`principalAxis.angle + machine.rotation + orientation.angleDeg`, and its local geometry is rotated
about the machine footprint **center** by `machine.rotation` — the **same convention scoring.js
already uses** for vectors (`baseAngle = principalAxis.angle + z.rotation`, offsets rotated by
`(ox·cosθ − oy·sinθ, ox·sinθ + oy·cosθ)`; note stage-y is down). `v2/clearance.mjs`
implements `clearanceWorldGeometry(zone, machine)`; §4d proves a `kickbackCone` at 0/90/180/270°
is the exact rotation of its local geometry.

**Relationship to the existing `kickbackVectors` / `materialVectors` (be explicit — do not silently
duplicate).**

- The **existing** model — `kickbackVectors`, `materialVectors` (arrays of
  `{type:"vector", offsetX, offsetY, angle, angleSpread}`), plus `operatorFootprints` and
  `principalAxis` — is consumed **today** by `scoring.js` `_scVectorConflicts` (a **metrics/flags**
  check that fires when one tool's cone reaches another tool's operator footprint). It is **NOT part
  of `evaluateLayout`** (the MOSA objective vector), so it does not affect the frozen pin.
- The **new** `clearanceZones` model is a **superset**: a `kickbackCone` clearance zone expresses the
  same cone as a `kickbackVector`, and the model additionally covers operator envelopes, infeed/outfeed
  corridors, maintenance access, spark arcs, and door swings that the vector arrays cannot.
- **Decision: BOTH RETAINED (no silent duplication, no migration that breaks scoring).** `scoring.js`
  is a no-edit engine file and keeps reading `kickbackVectors`/`materialVectors`/`operatorFootprints`.
  `clearanceZones` is the forward-looking model that **future v2 objectives** consume. A machine MAY
  declare both; when it does, the `kickbackCone` clearance zone should be kept **consistent** with the
  corresponding `kickbackVector` (same apex/direction/spread). E1 does **not** auto-derive one from the
  other (that is a later phase); the disagreement risk is called out in GAPS. The rotation math is
  deliberately identical between the two models so a consistent pair stays consistent under rotation.

## (e) Amenity linkages — `amenityLinks` (Dr. Jariwala's typed-link design)

A typed link from a machine to a **required amenity type**, each with a maximum distance (or
travel-time) and a mode. This is user-definable typed linkages with distance penalties — **not
hardcoded rules**.

| Field | Type | Allowed values | Default | Provenance |
|---|---|---|---|---|
| `amenityType` | enum | `eyewash`, `fireExtinguisher`, `fumeHood`, `sink`, `dustCollection`, `flammablesCabinet`, `firstAid`, `shower` | — | design assumption (taxonomy) |
| `maxDistanceUnits` | number\|null | real units | `null` | per-type standard below |
| `maxTravelSeconds` | number\|null | seconds | `null` | per-type standard below |
| `mode` | enum | `strict` \| `advisory` | `advisory` | design assumption |
| `provenance` | string | (required per link) | — | — |

Per-type distance provenance:

| amenityType | Typical requirement | Provenance |
|---|---|---|
| `eyewash` | ≤ 10 s travel (~55 ft), same level, unobstructed | **ANSI/ISEA Z358.1-2014 §4.5.2** |
| `shower` | ≤ 10 s travel (~55 ft) | **ANSI/ISEA Z358.1-2014 §4.5.2** |
| `fireExtinguisher` | ≤ 75 ft travel (Class A); 30/50 ft (Class B) | **NFPA 10 (2022) §6.2.1.1 / §6.3** |
| `firstAid` | "near vicinity" (no fixed distance) | OSHA 1910.151(b) (no numeric distance → design assumption for the value) |
| `flammablesCabinet` | proximity for flammable-using tools | NFPA 30 / OSHA 1910.106 (storage), distance = design assumption |
| `fumeHood` | at the process | OSHA 1910.94 / ACGIH; distance = design assumption |
| `sink` | post-processing proximity | design assumption |
| `dustCollection` | duct run to dust producers | NFPA 664 (system), distance = design assumption |

Flagged: only `eyewash`/`shower` (Z358.1) and `fireExtinguisher` (NFPA 10) have **numeric**
standards; every other distance is a **design assumption**.

## (f) Occupancy — `occupancy` (+ existing `operatorFootprints`)

`operatorFootprints` (existing, rotation-aware, consumed by scoring's risk-zone centers) supply the
operator positions. For a future **active-users** metric we add:

| Attribute | Type | Units | Default | Consumed by (future) | Provenance |
|---|---|---|---|---|---|
| `occupancy.operatorCount` | integer | persons | `1` | active-users / occupant-load objective | design assumption |
| `occupancy.personSpaceAreaUnits` | number | real units² | `15` | active-users density objective | design assumption (≈ANSI/HFES 100 workstation clearance; NFPA 101 occupant-load factors are coarser) |
| `occupancy.footprintsMayOverlap` | bool | — | `false` | active-users conflict objective | design assumption |

`operatorFootprints` are stage-% offsets as today. `occupancy` defaults (`operatorCount:1`,
`personSpaceAreaUnits:15`, `footprintsMayOverlap:false`) are inert (no consumer). Flagged:
`personSpaceAreaUnits` has **no single governing standard** for makerspaces; 15 ft²/person is a
design assumption.

---

## Versioning & inertness invariants

- Schema bumped **2.0.0 → 2.1.0** (added optional fields only). A `2.0.0` project omitting every E1
  field validates unchanged and behaves identically (all defaults are inert).
- **Not forwarded through the seam.** `hazards`, `clearanceZones`, `ventilation`, `power`,
  `utilities`, `amenityLinks`, `occupancy` are absent from `ENGINE_DEF_FIELDS`, so they are dropped in
  translation and cannot reach `evaluateLayout`. (`operatorFootprints`/`principalAxis` are already
  forwarded for the browser scoring path and already do not affect `evaluateLayout`.)
- Every numeric value in `v2/machine-library.json` carries a provenance string; §4b prints the
  standard-cited vs design-assumption tally.

---

# GAPS (Task 5)

## Attributes defined but with NO consumer yet (expected — E1 builds data, not metrics)

Every attribute below is **inert today**: schema'd, provenance-tagged, in the library, proven not
to change any objective (§4e), but read by **no** simulation. Each names the future objective that
will consume it.

| Attribute | Future consumer (objective / phase) |
|---|---|
| `hazards.{dustProducing,dustSensitive}` | dust separation / adjacency-compatibility objective |
| `hazards.{sparkSource,hotWork}` | hot-work / spark-separation objective (pairs with `flammable`) |
| `hazards.{wetProcess,flammable}` | wet-electrical / flammable-separation objective |
| `hazards.{vibrationSource,vibrationSensitive}` | vibration-separation objective (no standard — see below) |
| `ventilation.{localExhaustRequired,cfm,requiresExteriorWallOrDuct}` | ventilation / exterior-wall placement objective |
| `power.{volts,amps,phase}`, `utilities.{compressedAir,waterSupply,floorDrain}` | utility-routing / feasibility objective |
| `clearanceZones[]` (all types) | clearance-overlap objective (operator envelope, infeed/outfeed, maintenance, kickback, spark arc, door swing) |
| `amenityLinks[]` | amenity-distance objective (Dr. Jariwala's typed-link penalties) |
| `occupancy.{operatorCount,personSpaceAreaUnits,footprintsMayOverlap}` | active-users / occupant-density objective |

The **only** attributes any simulation reads today remain `dba_active` and `schedule_prob` (noise).
This is the intended state: data first, metrics later, so a wrong metric cannot mask a wrong
attribute.

## Existing v1 attributes superseded by the new model — and the migration path

| v1 attribute | Superseded by | Migration path |
|---|---|---|
| `hazards.{dust,spark,wet}` (v2.0.0 stub) | `hazards.{dustProducing,sparkSource,wetProcess}` | The old keys are **retained as deprecated aliases** in the schema. New code reads the explicit names; a later phase can drop the aliases once no project uses them. |
| `clearanceZones` v2.0.0 stub (`{direction,polygon,mode}`) | E1 first-class `clearanceZone` (`type`/`geometry`/`severity`/`orientation`) | The stub fields are **still accepted** (kept in the schema). Authoring should move to the new shape; `mode`→`severity`, `direction`+`polygon`→`geometry`+`orientation`. No auto-migration is run in E1. |
| `kickbackVectors` / `materialVectors` (cone `{type:"vector",…}`) | **NOT superseded — retained** (see next section) | Both models coexist. `clearanceZones` of type `kickbackCone`/`sparkArc` is the richer form future objectives read; the vector arrays stay because `scoring.js` (no-edit) still reads them. |
| `operatorFootprints` / `principalAxis` | **NOT superseded — retained** | Consumed by `scoring.js` today; `occupancy` + `clearanceZones.orientation` build **on** them (principal axis is the rotation reference for both), not over them. |

## Where the new clearance model and the existing vectors could DISAGREE

`scoring.js` (`_scVectorConflicts`, a no-edit engine file) consumes `kickbackVectors` /
`materialVectors` — cone vectors `{type:"vector", offsetX, offsetY, angle, angleSpread}`, rotated by
`principalAxis.angle + zone.rotation`, fixed reach 45 stage-% — to raise a **metrics/flags** conflict
when a cone reaches another tool's operator footprint. This is **not** part of `evaluateLayout`, so it
does not affect the frozen pin. The E1 `clearanceZones` model can express the same cone
(`type: kickbackCone`, `geometry.template: cone`), and `v2/clearance.mjs` deliberately reproduces
scoring's rotation convention exactly. **The two can nonetheless disagree** in these ways:

1. **Independent parameters.** A machine may declare a `kickbackCone` clearance zone with
   `spreadDeg`/`lengthUnits` that differ from its `kickbackVector`'s `angleSpread` (and scoring's hard
   reach of 45 stage-%). `scoring.js` uses the vector; a future clearance objective uses the zone. If
   the two are authored inconsistently, they will flag different conflicts. **E1 does not auto-derive
   one from the other** (that requires either editing `scoring.js` — forbidden — or a seam-side
   projection that is deferred). The library keeps the table saw's `kickbackVector` consistent with its
   `kickbackCone` as the recommended discipline, but the schema does not enforce it.
2. **Units.** Vectors carry `offsetX/offsetY` in stage-% and a **fixed 45 stage-% reach**; clearance
   templates use **real units** (feet) with an explicit `lengthUnits`. A consistent pair must convert
   via `room.scale`; a mismatch is silent.
3. **Spread convention.** `scoring.js` adds a **+6°** tolerance to `angleSpread` inside `inCone`; the
   clearance `spreadDeg` is the literal half-angle. A clearance objective that wants to match scoring's
   effective cone must add the same +6°.

**Recommendation (documented, not enforced):** when a machine needs a kickback/spark cone that both
the scoring flags **and** a future objective should see, author the `clearanceZones` entry as the
source of truth and keep the `kickbackVector` a consistent projection of it (same apex, direction,
half-angle), converting reach through `room.scale`. A later phase may add a seam-side validator that
warns when a declared pair diverges — it cannot be auto-reconciled without editing `scoring.js`.

## Attributes with NO governing standard (flagged)

`hazards.vibrationSource` / `hazards.vibrationSensitive`, `occupancy.personSpaceAreaUnits`, all
clearance **geometries** (cone spread/length, corridor lengths), most `ventilation.cfm`, and every
`power` nameplate are **design assumptions** — there is no makerspace-specific standard for them.
The §4b tally quantifies this: **~88% of numeric values are design assumptions**, ~12% standard-cited
(eyewash ANSI Z358.1, extinguisher NFPA 10, spark separation NFPA 51B, dBA NIOSH). That ratio is the
honest map of where the tool is guessing, and it is exactly why E1 tags provenance on every value
before any objective is allowed to trust it.
