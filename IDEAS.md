# SPACE — Enhancement Ideas

Potential improvements and future features. Not bugs (see [BUGS.md](BUGS.md) for those).

## Structural Floor element — expanded uses

The floor element is currently a non-blocking, transparent bordered area with a label
(see BUGS.md #1). It could carry metadata to power several analyses:

| # | Idea | What it enables | Notes |
|---|------|-----------------|-------|
| F1 | **Usable-area denominator** | Egress occupant load currently uses the *whole stage* (`stageW × stageH` in [v1/js/sim_egress.js](v1/js/sim_egress.js)). A floor polygon could define the actual usable footprint → more accurate occupant-load and density metrics. | Highest-value; directly improves an existing sim. |
| F2 | **Zone / room tagging** | Named regions ("Wood Shop", "Clean Room") for grouping elements, per-room metrics, and adjacency rules (e.g. high-flammability tools shouldn't share a floor region with the finishing area). | Builds on the existing label. |
| F3 | **Containment for analyses** | Restrict a heatmap or noise calc to one room; flag elements placed *outside* any defined floor. | Useful once multiple floor regions exist. |
| F4 | **Surface / material attribute** | Anti-static, wet area, ESD flooring → feeds future safety checks. | New variable attribute on the floor def. |
| F5 | **Weight-bearing** | Original intended use — load capacity per area for heavy equipment placement. | The user's original motivation. |

All of the above keep the floor's non-blocking, transparent rendering; they only add
optional metadata to the element definition.

## Dashboard / movable-resizable widgets

| # | Idea | Status | Notes |
|---|------|--------|-------|
| D1 | **Draggable + resizable widget dashboard** | ✅ Implemented | Snap-to-grid, vanilla. Every panel (Elements, Risk Summary, Weighted Metrics, Flags, Sim cards, Conclusion, Top Issues, Mentor Note — **and the Layout Builder stage**) can be moved (drag the header grip) and resized in width + height (drag the bottom-right handle), snapping to a 12-column grid. Layout persists via the autosave snapshot (`state.dashboard`); **Reset Widgets** restores the default. See [v1/js/dashboard.js](v1/js/dashboard.js) + [v1/css/dashboard.css](v1/css/dashboard.css). |

## Wall editor — auto-generate from image (implemented)

| # | Idea | Status | Notes |
|---|------|--------|-------|
| W1 | **Generate walls + floor from a B/W floor-plan image** | ✅ Implemented | "✨ Generate from image" in the wall editor ([v1/js/walldraw.js](v1/js/walldraw.js)). Auto-detects polarity (black-on-white or white-on-black), extracts wall **medial centerlines** (thin horizontal/vertical runs) as wall segments, and traces the enclosed building footprint contour (flood-fill + Moore trace + Douglas–Peucker) as a floor polygon. **Limitations:** axis-aligned walls only (diagonals approximate as steps); minor over-segmentation at T-junctions (clean up in Select mode); single floor outline rather than per-room. Future: diagonal/Hough lines, per-room splitting, door-gap detection. |

**D1 follow-ups (not yet done):**
- Upward gravity/compaction so dragging a widget up closes gaps (current behavior pushes colliding widgets *down* only — predictable but leaves gaps).
- Re-resolve collisions when the Sim Results / Sim Penalty cards appear, in case the user has rearranged the left group over their default slots.
- A "Show Sidebar" off currently just hides the left-group widgets, leaving their space empty rather than reflowing the stage/right group to fill it.
- Optional per-preset / named dashboard layouts.

## Analysis sidebar widget

| # | Idea | Status | Notes |
|---|------|--------|-------|
| A1 | **Analysis as an always-visible sidebar widget** | ✅ Implemented | Replaced the toolbar "Analysis" button + popup modal with a persistent `#analysisCard` dashboard widget: run buttons (ADA / Egress / Noise / Run All), Clear overlays, a Live-mode toggle switch, Traffic mode dropdown, and resolution radios + slider. Wired by `wireAnalysisPanel()` in [v1/js/controls.js](v1/js/controls.js); reuses the existing sim helpers. |
| A2 | **New default dashboard layout** | ✅ Implemented | Left: elements → weighted metrics → risk summary. Middle: layout builder on top, with top issues / flags (left) and conclusion (right) beneath. Right: analysis widget, then the sim result widgets. `DASH_DEFAULTS` + `DASH_VERSION` bump in [v1/js/dashboard.js](v1/js/dashboard.js) (existing saved layouts re-seed once). Mentor Note widget removed. |
| A3 | **X/Y coordinate grid toggle** | ✅ Implemented | "Show Grid" toolbar toggle overlays a labelled coordinate grid on the Layout Builder (`renderGrid()` in [v1/js/render.js](v1/js/render.js)); labels show real units when a scale is set, else percent. |
| A4 | **Required PPE / safety practices on elements** | ✅ Implemented (basic) | Element Builder → Variable Attributes now has a PPE checklist + free-text safety practices, stored on `variableAttrs.ppe` / `.safetyPractices`. Higher-risk tools with neither specified raise a safety flag ([v1/js/scoring.js](v1/js/scoring.js)). Deeper PPE→score weighting to come with the analysis hookup. |
| A5 | **No-cache dev server** | ✅ Implemented | [.claude/launch.json](.claude/launch.json) now serves `v1/` via a threaded `ThreadingHTTPServer` with `Cache-Control: no-store`, so live edits always load fresh (the plain `http.server` was letting the browser serve stale JS). Asset includes carry a one-time `?v=4` to evict pre-existing cached copies. |

## Pending — Structural drawing editor (next)

| # | Idea | Status | Notes |
|---|------|--------|-------|
| S1 | **Draw-walls / floor editor** | ✅ Implemented | [v1/js/walldraw.js](v1/js/walldraw.js) + modal in index.html. Click to draw wall polylines over the floor plan; click the first point / "Close room" to enclose a free-form **polygon** floor space. Per-line type (normal/sound/false wall, construction-line divider, door) with per-room/per-segment labels + zone tags. **Replaces** the old shape-based structural builder; reopening the editor reloads everything via each element's `rawDraw` record (it owns all drawn structural pieces; legacy shape-based ones are preserved). New `polygon` shape type added to the renderer ([v1/js/render.js](v1/js/render.js)). Elements carry `blocksMovement` / `wallType` / `stc` / `removable` / `zoneTag` / `color`; ADA + egress honor `blocksMovement` and the noise sim now honors `stc` (BUGS #2 fixed). Editor also has a **Draw/Select mode** (select & drag walls, endpoints, doors, rooms), an integrated **door-template palette** (quarter/semicircle/double/sliding swing symbols placed by click, rotatable), and a **color-editable key** (per-type colors persist in `state.wallTypeColors` and apply to new instances via per-element `color`). **Pending (analysis hookup):** use `removable`/`zoneTag` in scoring. |

---

# Analysis Roadmap (added 2026-06-07)

## New analysis-method ideas

| # | Method | What it measures | Notes |
|---|--------|------------------|-------|
| A1 | **Room-scoped analysis** | Restrict every sim/metric to a *selected* room (floor polygon) so empty/outside areas don't skew scores. | See "Room-scoped analysis" plan below. **High priority** (user-requested). |
| A2 | **Vector-conflict map** | Kickback/material vectors that sweep through another tool's operator footprint (the "inadvertent risk" failure mode). | Implemented as a flag (`vec-*`) + safety-metric penalty in [v1/js/scoring.js](v1/js/scoring.js). Could also render as a stage overlay. |
| A3 | **Reach / supervision (line-of-sight)** | Which high-risk tools are visible from a staff desk / door; ray-cast sightlines blocked by walls. | Generalize the old `mainDesk` supervision metric to any "desk"/door. |
| A4 | **Ventilation / fume dispersion** | Spread of `smellFumes`/flammability sources vs. fume hoods & exterior walls (diffusion field, like the noise Monte-Carlo). | Reuses the grid + STC-style barrier model. |
| A5 | **Thermal / fire-spread** | Flammability load per region + distance to extinguishers/exits; flag rooms exceeding a fuel-density threshold. | Pairs with the fire-safety sim split. |
| A6 | **Density / occupant-load isopleths** | People-per-area by room using floor polygons as the denominator (fixes the whole-stage denominator). | Depends on F1 (floor area). |
| A7 | **Clearance/ADA turning-circle check** | Verify 60-inch turning circles and 36-inch paths fit between obstacles (rotation-aware). | Builds on the rotation-aware ADA grid. |
| A8 | **Travel-time / workflow flow** | Shortest walking paths between related stations (same category / process sequence) over the walkable grid. | Uses the egress distance transform. |
| A9 | **PPE/zoning compliance** | Regions requiring hearing/eye protection (from per-tool dBA/PPE) drawn as zones; flag overlap with beginner areas. | Uses existing `variableAttrs`. |

## Room-scoped analysis — plan (A1, user-requested)

**Goal:** run sims + metrics only inside one or more selected room polygons.

1. **Selection UI** — in the Analysis widget add a "Run in rooms" multi-select listing every `subtype:"floor"` element (by label). Default = all rooms. Persist `state.analysisRooms = [floorId,…]`.
2. **Region mask** — build a point-in-polygon test against the union of selected room polygons (polygons already stored in each floor's `shapes[0].points`, local→stage via its zone). Add `inSelectedRooms(xPct,yPct)`.
3. **Grid sims** (ADA/egress/noise): skip/!paint cells whose center fails `inSelectedRooms`; use the selected rooms' summed area as the occupant-load / density denominator (fixes F1/A6).
4. **Metrics + flags** (`scoring.js`): filter `_scTools()`/`_scDoors()` to elements whose center is in a selected room; clustering/overlap/vector checks then ignore out-of-room elements.
5. **Edge cases**: no rooms defined → fall back to whole stage (current behavior); element straddling two rooms → counted in the room containing its center.

## D-OPT — "Optimize Layout" algorithm plan

**Button:** ✦ Optimize Layout (row 2). **Scope:** all *included*, *non-fixed* elements; everything else (walls, doors, floors, fixed/amenity, excluded) is a frozen constraint. **Objective:** maximize the weighted metric score (using the user's `metricWeights`) minus a heavy penalty for any `crit` flag.

Proposed approach — **constrained simulated annealing / greedy hybrid**:

1. **Domain** — the selected room polygon(s) (or stage). Discretize candidate positions to a grid (e.g., 1–2 ft) and rotations to {0,90,180,270} (+ free angle later).
2. **Constraints (hard)** — element footprint (rotation-aware) must (a) lie inside the room, (b) not overlap walls/fixed elements/other movables, (c) not block any door/exit clearance. Reject candidate states that violate these.
3. **Objective (soft)** — `score = Σ wᵢ·metricᵢ(state)` from the existing generic `computeMetrics`, minus `crit×K`, minus vector-conflict count, minus clearance/overlap penalties. Reuse `evaluate()` so the optimizer scores exactly what the UI shows.
4. **Search**
   - *Seed*: keep current positions (so "optimize" never starts from scratch).
   - *Moves*: pick a random movable element → propose a new (x,y,rotation) from its neighborhood (or a free cell). Optionally swap two elements.
   - *Accept*: simulated annealing — always accept improvements; accept worse states with probability `exp(Δ/T)`, cooling `T` over N iterations. This escapes local minima that pure greedy/gradient would get stuck in.
   - *Repair*: snap to grid; nudge out of overlaps before scoring.
5. **Heuristic priors** (speed up convergence): place high-risk tools toward the perimeter/away from doors & beginner zones; cluster same-category tools; point kickback/material vectors toward walls, not operators; keep egress bands clear.
6. **Termination**: fixed iteration budget or no improvement for K steps. Show before/after score; require user confirmation before committing (write into the active preset so Reset Layout can undo).
7. **Stretch**: multi-start (run several seeds, keep best); Pareto view across competing metrics; "lock" individual elements the user is happy with.

## Failure-modes / flags catalog (target rule set)

Implemented now (generic, any layout): **overlap**, **door/exit blockage**, **kickback/material vector → another tool's operator zone**, **missing PPE on higher-risk tools**. Proposed additions:

- High-risk tool adjacent to a **beginner-friendly** element or main circulation path.
- Tool placed **outside any defined room** (floor polygon).
- **Egress path** width < ADA minimum, or an exit unreachable (from the egress sim).
- **Noise** > OSHA action level (85 dBA) overlapping an operator zone without hearing-PPE.
- **Flammable** source within X of another flammable source / far from an extinguisher.
- **Fume** source (smell ≥ 3) without an adjacent fume hood / exterior wall.
- **Clearance/maintenance** footprint of a tool overlapping another tool (can't service it).
- **Sound-isolation** mismatch: loud tool in a room sharing a low-STC wall with a quiet/beginner room.
- Conclusion *primary failure mode* = the highest-severity, highest-weight contributor (drives the Conclusion widget text).

## A5b — Path-based Fire-Safety simulation (user spec, 2026-06-07)

Replace the current radius-based extinguisher coverage with a **walking-distance** model:

- Treat every tool/element **and** every fire extinguisher as a **node**. Extinguishers have **no fixed radius**.
- For each tool, compute the **shortest walkable path** to the nearest extinguisher over the egress walkability grid (obstacles = walls/tools, so the path routes *around* equipment, not through it) — reuse the egress BFS/distance-transform.
- Risk(tool) = increasing function of that path distance/time (and optionally the tool's flammability). A tool in a far corner with a circuitous route to the only extinguisher reads **red**; one next to an extinguisher reads green.
- Build the heatmap by **overlaying every tool's risk field** (e.g., each tool contributes a falloff around itself weighted by its path-distance risk; sum/ް max across tools) so the final map shows where a fire would be slowest to reach an extinguisher.
- No extinguisher present → whole area is high risk. Honors room scope (A1).
- Implementation: extend `sim_fire.js` (already split from egress) to do multi-source BFS from extinguishers, then per-tool path lookup + accumulation. Flag tools whose nearest-extinguisher path exceeds a threshold (e.g., NFPA travel-distance to an extinguisher).

## Done 2026-06-07
- **Room-scoped analysis** (A1) implemented: "Run analysis in rooms" chips in the Analysis widget; ADA/egress/noise grids + metrics/flags are masked to the selected room polygons; egress occupant-load uses the scoped room area. ([state.js](v1/js/state.js) helpers, [scoring.js](v1/js/scoring.js), sim_*.js paint loops, [controls.js](v1/js/controls.js) selector.)
- **Optimize Layout** v1 implemented ([v1/js/optimize.js](v1/js/optimize.js)) — see D-OPT.
- **Removed** the Clearance Zones toggle (low value) and the Show Circulation toggle (broken on custom layouts; the ADA/Egress sims supersede it).
