# v3 Re-platform Plan — SmartDraw engine as the core

**Status:** Approved 2026-07-29. Proceeding with all recommendations.
**Fallback:** v1/ and v2/ stay frozen and untouched throughout.

## Goal & rationale
Make the feet-based, node-graph SVG editor (today's `fpb.html` "SmartDraw" engine) the
**single canvas and object model** for v3. Tools/machines/amenities become first-class
movable objects living in real-world feet alongside walls/rooms/doors. This removes the
awkward %-of-stage layer, gives one interaction model (drag/rotate/snap/marquee/undo) for
*everything*, and lets the simulations read geometry natively.

## Why this is feasible (not a from-scratch rewrite)
- **Sim math stays.** ADA (BFS distance transform), egress (multi-source BFS), noise
  (inverse-square + STC), fire/fumes (radius fields) already operate on **feet grids**
  (`runAdaCheck` builds its grid over `stageDimsUnits()`; `simBlockerFootprint()` returns a
  `test(xFt,yFt)` predicate in feet). We reuse them almost verbatim.
- **Element *definitions* stay.** Footprint shapes, `dba_active`, risk vectors, PPE,
  operator/material footprints, machine library, variable attributes are coordinate-agnostic.
  We keep the defs; we only change how an *instance* is placed (feet x/y/rotation instead of a
  `%` zone in `state.zones`).
- **What gets replaced** is the thin coordinate/render/interaction layer: `simBlockerFootprint`
  + room-scope helpers (rewritten feet-native), `render.js` zone drawing (folded into the
  engine renderer), the transform panel + `walldraw.js` (superseded), and `fpb_bridge.js`
  (deleted — no conversion when there's one coordinate space).

## Target architecture
- **One coordinate space: feet.** Node graph for walls/rooms/openings (as today). Elements are
  *free objects* (not node-bound) so they slide freely: `{ id, defId, x, y, rotation, attrs… }`
  in feet.
- **One renderer.** The engine's SVG `render()` draws walls, rooms, openings, **and** element
  instances (footprint + operator/material footprints + labels) under one pan/zoom transform.
- **One interaction model.** Select / drag / rotate / marquee / snap / undo already exist in the
  engine — elements plug into it.
- **Sim overlays** become canvas layers aligned to the feet viewport, fed by a new feet-native
  footprint adapter.
- **App chrome kept, rewired.** Sidebars, weighted metrics, risk summary, analysis toggles,
  dashboard, top-issues/conclusion — kept, but their data source switches from `state.zones` (%)
  to the new element store.

## Confirmed decisions
1. **Clean break for v3** (feet-native) with a one-way importer for old %-projects; v1/v2 frozen.
2. **Keep existing chrome/sidebars/dashboard and rewire them** (UI redesign is out of scope for now).
3. **Elements are free objects, not snapped to wall nodes** (walls/rooms keep the node graph).
4. **Phase-2 parity bar** = "correct & stable on feet", not exact numeric match to the % raster.

## Phased milestones (each independently testable, with a checkpoint)
1. **Feet object model + element placement.** Engine gains an element store + palette: drop a
   tool/amenity, drag/rotate/snap/marquee/delete/undo, edit attributes in the properties panel.
   Walls/rooms/doors unchanged. *Checkpoint: place & move a machine and an eyewash in feet.*
   - 1a. Bring the engine in-app as a **namespaced module** (no iframe) so it shares `ZONE_DEFS`
     and app state. (Needed because the element library lives in the app.)
   - 1b. Element instances: place/move/rotate/attributes.
2. **Feet-native sim adapter + re-host all 5 sims.** Rewrite `simBlockerFootprint`, room-scope,
   and overlay painting to read the feet model; run ADA/egress/noise/fire/fumes on it.
   *Checkpoint: parity — sane, comparable results.*
3. **Scoring + analysis UI + dashboard** rewired to the feet store. *Checkpoint: weighted score,
   flags, conclusion populate from a feet layout.*
4. **Optimize-layout, export/import, migration.** Optimizer moves element instances in feet;
   unified JSON schema; one-way importer for existing %-projects. *Checkpoint: optimize nudges
   tools for clearance; save/load round-trips.*
5. **Polish + tutorials/docs.**

## Risks & mitigations
- **Element-builder parity** (variable attrs, PPE, risk vectors, machine library) → reuse the def
  schema unchanged; port the editor form as-is.
- **SVG perf with many elements + live sims** → single-pass string render + debounced recompute;
  canvas overlays (not SVG) for heatmaps.
- **Sim-overlay alignment to pan/zoom** → one shared feet→screen transform for SVG + overlay canvas.
- **Scope creep** → v2 stays the working fallback throughout; never touched.

## What gets simpler / retired
`fpb_bridge.js` converter (deleted), the whole %↔feet conversion path, `walldraw.js`, the
transform panel, and the dual object stores (`state.zones` % vs. engine feet) collapse into one.
