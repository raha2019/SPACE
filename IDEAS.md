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
| S1 | **Draw-walls / floor editor** | ✅ Implemented | [v1/js/walldraw.js](v1/js/walldraw.js) + modal in index.html. Click to draw wall polylines over the floor plan; click the first point / "Close room" to enclose a free-form **polygon** floor space. Per-line type (normal/sound/false wall, construction-line divider, door) with per-room/per-segment labels + zone tags. **Replaces** the old shape-based structural builder; reopening the editor reloads everything via each element's `rawDraw` record (it owns all drawn structural pieces; legacy shape-based ones are preserved). New `polygon` shape type added to the renderer ([v1/js/render.js](v1/js/render.js)). Elements carry `blocksMovement` / `wallType` / `stc` / `removable` / `zoneTag`; ADA + egress now honor `blocksMovement` (walls block; construction lines, doors, floors don't). **Pending (analysis hookup):** wire `stc` into the noise sim (BUGS #2) and use `removable`/`zoneTag` in scoring. |
