# Zone-to-Blocker Translator (v2 Phase G2)

`v2/zone-to-blocker.mjs` — the **only no-engine-edit path** that makes the existing SPACE
simulations respect a v2 detected zone.

## Why this exists

The feature audit (and Phase 2d before it) established a hard fact: **every simulation
*objective* iterates a whole-stage grid.** `sim_ada`, `sim_egress`, and `sim_noise` size their
grids to `ceil(stageW/RES) × ceil(stageH/RES)` and score over *all* cells; `sim_fire`/`sim_fumes`
use per-tool radii. The analysis-scope helpers (`pointInAnalysisScope`/`roomScopeActive`) are
consulted **only in the heatmap paint functions**, never in the objective. So there is no way to
point a sim's objective at a zone *without editing an engine file* — which is forbidden.

The proven data-only workaround is **"region-as-wall"**, first used by hand in Phase 2d as the
`notch_mrdc2323` blocker: fill the part of the stage that is **outside** the zone with structural
**wall** elements. The engine's *existing* wall handling then does the rest — `sim_ada`/`sim_egress`
mark those cells blocked (via `blocksMovement`/`cat:"wall"`), and `sim_noise` rasterizes them into
its STC grid — so exactly the non-zone cells drop out of the whole-stage objectives. No engine edit.

This translator **generalizes** that hand-built single-rectangle notch to the complement of an
**arbitrary rectilinear polygon** (L-shapes, multi-vertex outlines).

## What it does

`zoneToBlockers(zone, opts)` takes a detected zone (its `polygonPct`, stage-%) and the stage bounds
and returns the set of axis-aligned **wall blocker rectangles** that exactly fill the stage
complement of the zone:

> **a point is inside some emitted blocker if and only if it is inside the stage and outside the
> zone polygon.**

Method: coordinate-compression (grid lines at every polygon vertex + the stage bounds) → classify
each grid cell by testing its center against the zone → coalesce the "outside" cells into maximal
rectangles. Because every polygon edge lies on a grid line, the zone is uniform within each cell, so
the decomposition is **exact** (proven over 20,449-point dense grids, 0 mismatches, in
`v2/test-zone-to-blocker.mjs`). For the MRDC 2323 L-zone the translator emits a **single** rectangle
whose coordinates are **bit-identical** to the frozen `notch_mrdc2323` blocker, and — run through the
*unmodified* engine in the V0 adapter — it reproduces the pinned baseline
`{ada 0.13827363048035732, egress 0.4275, noise 0.40589569160997735}` bit-for-bit
(`v2/test-blocker-objective-equivalence.mjs`).

Each emitted blocker carries exactly the fields the engine's wall handling reads:
`elementClass:"structural"`, `subtype:"wall"`, `cat:"wall"`, `blocksMovement:true`, and `stc:35`
(matching `sim_noise`'s `NOISE_WALL_STC = 35`). *Note:* the V0 seam (`applyTranslated`) currently
forwards `subtype/cat/blocksMovement/w/h/x/y` but not `stc`, so the engine falls back to its default
STC — which is also 35, so the result is identical either way. Forwarding a non-default `stc` would
be a small G3 seam addition; it is intentionally not made here to keep the frozen pin untouched.

## Exit seeding (the BUG #4 workaround)

`sim_egress` seeds its BFS **only** from elements with `cat === "exit"` (audit: `sim_egress.js:69`).
A door that a builder/drawer marks `subtype:"door"` is *not* recognized as an exit — this is the
open **BUG #4** (`cat`-vs-`subtype` coupling). So for each door that `zone-detection.mjs` classifies
`exit-to-outside`, the translator emits a small `cat:"exit"` element at the door opening (via
`opts.exits`, extracted with `exitsFromDetection(result, geometry)`), so egress actually seeds from
real exits.

**This is a data-only workaround, not a fix to BUG #4.** The engine still keys on `cat`; we simply
supply data shaped the way the engine expects. Fixing BUG #4 properly (a subtype-aware
`isExit(def)` helper) requires an engine edit and is out of scope.

## The passable-id caveat

The audit found `ADA_PASSABLE_IDS` / `EGRESS_PASSABLE_IDS = {corridor, connector, rightOpen,
entrance}` (`sim_ada.js:46`, `sim_egress.js:41`) are checked **before** `blocksMovement`, so an
element with one of those ids is always walkable regardless of its flags.

- The translator **never** emits an id in that reserved set (ids are prefixed, e.g. `zblk_0`), so its
  blockers can never be accidentally made passable. It guards against collisions explicitly.
- The blockers only fill the zone **complement** (outside the room), so any circulation elements that
  live **inside** the zone are untouched and keep their own behavior.
- For a non-MRDC project whose circulation uses different ids, the caller should pass those ids via
  `opts.passableIds` so the translator continues to avoid them. Arbitrary-id zones are otherwise
  fully supported.

## Honest limitation — rectilinear only

The engine wall model is **axis-aligned rectangles** (`simBlockerFootprint` builds a footprint from
the zone's `x/y/w/h`). The complement of a **rectilinear** polygon (all edges horizontal/vertical) is
exactly a union of such rectangles — exact. The complement of a polygon with **diagonal** edges
**cannot** be tiled exactly by axis-aligned rectangles, and the current engine wall model **cannot
represent a non-axis-aligned blocker**. Rather than silently approximate, `zoneToBlockers` **refuses**
a non-rectilinear zone: it returns `exact:false`, `blockers:[]`, and a `non-rectilinear-zone` warning
(unless the caller explicitly opts into an approximation, which this phase does not implement). The
recommended path is to rectify the zone to axis-aligned edges upstream. (The MRDC L, the rectangle
fixture, and the two-room fixture are all rectilinear, so all are exact.)

## What this does NOT do (scope boundary)

- It makes **one active zone's geometry real to the whole-stage objectives** via a zone's stage
  **complement**. It does **not** do **per-zone simulation** — that is **Phase G3**.
- It does **not** modify any engine file, the frozen project, or the pin. The frozen WSC pin
  (`0.13827363048035732 / 0.4275 / 0.40589569160997735`, front 18, 18/18) reproduces bit-for-bit.

## v2 Phase V1 — structural geometry now flows through the seam automatically

As of **V1**, a project carrying `structuralGeometry` no longer needs any caller-side wall/exit
materialisation: `v2/project-to-engine.mjs` `translateProject` materialises it into the engine
`blockers` channel automatically (interior walls → `cat:"wall"` blockers, `exit-to-outside` doors →
`cat:"exit"` seeds), and `applyTranslated` registers them through the **unchanged** Phase 2d path.
A1's `active-users.mjs` and the A1 MOSA test previously carried their own copy of this
materialisation; that duplication has been **deleted** and both now get zone-aware engine state
through the seam alone (proven bit-for-bit equivalent).

**Relationship to this translator (be precise — two different jobs):**

- `zoneToBlockers` (G2) fills a **single zone's complement** with walls — for **isolating one zone**
  (used by G3 per-zone evaluation). It cannot express a whole building's *interior partition* walls,
  because a complement is one connected outside region.
- The V1 seam does the **complementary** job: it materialises **each wall segment** as a thin
  blocker so the **whole-building** grid sees every partition at once (the composition the whole-stage
  MOSA needs). Both share the same engine wall/exit representation; they differ only in what they
  produce (one zone's complement vs. all segments).

## GAPS (v2 Phase V1)

- **E1 attributes are still NOT forwarded — intentionally.** `hazards`, `clearanceZones`,
  `amenityLinks`, `ventilation`, `power`, `utilities`, and `occupancy` remain absent from
  `ENGINE_DEF_FIELDS` and are not materialised by the seam, because **no engine objective consumes
  them yet** (E1 proved they are inert; A1's active-users reads `occupancy`/operator geometry
  *outside* the engine, in `active-users.mjs`, not through the seam). This is still true and still
  intentional; each will be wired in by the phase that adds an objective that reads it.
- **Rectilinear walls only.** Wall segments must be axis-aligned; a diagonal wall is **skipped with a
  warning**, not approximated. This is the same limitation `zoneToBlockers` has, inherited because the
  engine wall model is axis-aligned rectangles. Rectify geometry to axis-aligned edges upstream.
- **`cat:"exit"` emission — workaround or architecture? (flag for the collaborator conversation.)**
  Egress seeds from `cat:"exit"` because `sim_egress` seeds its BFS only from `cat==="exit"` cells and
  there is no builder/draw path that turns a `subtype:"door"` door into an exit — the open **BUG #4**
  (`cat`-vs-`subtype` coupling). The seam therefore emits `cat:"exit"` blockers for `exit-to-outside`
  doors. In G2 this was a documented *data workaround*; now that the seam **relies on it for every
  forwarded project**, it has effectively become **load-bearing architecture**. Fixing BUG #4
  properly (a subtype-aware `isExit(def)` helper) requires an engine edit, which is out of scope — so
  this is a **question for the collaborator conversation**: keep the `cat:"exit"` convention as the
  supported contract, or schedule the engine change. Flagged, not silently entrenched.

## API

```js
import { zoneToBlockers, exitsFromDetection, pointInAnyBlocker } from './zone-to-blocker.mjs';

const zone = detectZones(geometry, scale).zones[0];              // from v2/zone-detection.mjs
const { blockers, exits, exact, warnings } = zoneToBlockers(zone, {
  stage: { x0: 0, y0: 0, x1: 100, y1: 100 },   // default
  stc: 35,                                     // default (matches NOISE_WALL_STC)
  exits: exitsFromDetection(result, geometry), // exit-to-outside door segments
  passableIds: [],                             // extra ids to avoid colliding with
});
// blockers[] and exits[] are ready to drop into a project's room.structuralBlockers (+ machines
// for exits) for the V0 adapter to register — G3 will do this per active zone.
```
