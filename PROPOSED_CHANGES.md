# PROPOSED_CHANGES.md

---

## Bug fixes

**modals.js lines 695 and 756** -- `renderCustomElementList()` was called after saving or deleting a custom element. That function looks for `#ebCustomList` which does not exist. Changed to `renderChooserExisting()` which targets the actual list element `#chooserExistingList`. Without this the list never refreshed.

**render.js lines 218-227** -- Shape-type zone overlays ignored any offset set in the Element Builder. The code only checked `zone.offset` (old scalar field). The builder now saves `offsetX` / `offsetY` as separate fields, which were never read. Fixed to handle all three cases: new fields, old scalar, and no offset.

**modals.js lines 818 and 829** -- Structural shape delete buttons showed a literal `x`. Tool builder buttons already used `&times;`. Changed both to `&times;` to match.

---

## New files

**v1/js/sim_ada.js** -- ADA corridor width checker. BFS distance transform on a 0.5 ft grid. Each free cell gets its distance to the nearest obstacle, which approximates half the local corridor width. Cells below 36 in are red, 36-44 in are amber, above 44 in are green. Also checks door widths against 32 in / 36 in thresholds.

**v1/js/sim_egress.js** -- Egress travel distance. Multi-source BFS seeded from all exit zones. Reports max travel distance (NFPA limit 200 ft sprinklered), occupant load (50 sq ft / person), exit capacity, and a conservative dead-end estimate. Paints a blue-green-orange-red gradient.

**v1/js/sim_noise.js** -- Monte Carlo noise map. 500 iterations, each machine turns on/off by `schedule_prob`. Received level uses inverse square law plus wall crossings via Bresenham. Wall attenuation is STC 35 * 0.5 dB per crossing. Wall geometry is precomputed once outside the loop so the MC iterations are fast. OSHA thresholds: 85 dBA action level, 90 dBA PEL.

**v1/js/sim_ui.js** -- Wires the four toolbar buttons, manages the canvas overlay, renders the results panel. Canvas is created dynamically inside `#stage` on first run. All result displays include the regulatory disclaimer.

**v1/css/sim.css** -- Styles for the sim button group, pass/warn/fail badges, results rows, legend swatches, disclaimer text, and error state.

**tests/index.html** -- Open in a browser, no server needed. Loads the three sim modules, stubs the five UI functions they call, then runs tests.js.

**tests/tests.js** -- 18 tests: 7 ADA, 5 Egress, 4 Noise, 5 constant checks. Each test injects a stub state, calls the internal computation functions directly, and checks the output. No floor plan image or calibrated scale required.

**BUGS.md** -- Record of the three bugs above.

**MODULES.md** -- Methodology writeup for each module: algorithm, assumptions, color key, applicable standards.

**testcase/demo-elements.json** -- 21-element bundle with `dba_active`, `schedule_prob`, and `accessible` properties so all three sims run immediately. Intentional ADA violation: CNC and Laser are 2 ft apart (below the 3 ft ADA minimum), so the ADA overlay will flag that gap red.

**testcase/demo-configuration.json** -- Zone positions for an 80 x 50 ft space. Import elements first, then this file, then calibrate scale to 80 x 50 ft.

---

## Changes to existing files

**v1/index.html line 11** -- Added `<link rel="stylesheet" href="css/sim.css">` after the four existing stylesheet links.

**v1/index.html lines 68-73** -- Added the sim button group (`ADA Check`, `Egress`, `Noise`, `Clear`) between the Show Sidebar toggle and the spacer div in the controls bar.

**v1/index.html lines 156-159** -- Added `#simResultsCard` (hidden by default) in the right sidebar below the Flags & Warnings card. The sim UI writes results into `#simResults` inside it.

**v1/index.html lines 785-788** -- Added four script tags for `sim_ada.js`, `sim_egress.js`, `sim_noise.js`, `sim_ui.js` before `init.js`. Load order matters: sim modules use `state` and `allZoneDefs` from state.js which loads earlier.

**v1/js/init.js line 10** -- Added `wireSimulations()` after `wireElementBuilder()`. This is the call that attaches the button listeners and creates the canvas.

---

## Note on calibration

The sims need a calibrated scale to run (they need real feet, not just percentages). If there is no scale set, they show an error. Could also just disable the buttons until scale is set -- either works, just pick one before showing anyone.
