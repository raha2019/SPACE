# STAGING_REPORT.md

Generated after git fetch revealed origin/main at 26acf1d (Rahul, "Squashed commit of the following", Jun 7).
Neil's local branch is at 06eead8 (Neil, "Round 4", May 25). Branch is 1 commit behind; fast-forward is clean.

---

## STEP 1: SYNC AND DIFF

git fetch pulled one new commit from origin: 26acf1d (squashed from Rahul's rahuls_version branch).
32 files changed, 6,580 insertions and 771 deletions.

### Rahul's files that changed

| File | Net change | What changed at high level |
|---|---|---|
| v1/index.html | +548 | Completely restructured. Now 1,008 lines. Sim buttons (ADA, Egress, Noise) moved from toolbar into an Analysis panel widget. New sim_fire.js and sim_fumes.js buttons added there. Toolbar now holds Import Project, Element Builder, Optimize Layout, Reset, Export. Dashboard widget system introduced (data-widget / data-dgroup). |
| v1/js/state.js | +353 | Added: localStorage persistence (saveAppState/loadAppState/clearAppState), simBlockerFootprint() for rotation-aware zone footprints, room-scope analysis (getAnalysisRooms, pointInAnalysisScope, analysisScopeAreaUnits), refitElementsToScale(), convertUnits(), clampZonePos(), metricWeight helpers, many new state fields (showLabels, showGrid, projectInfo, elementsSort, simResolution, simResolutionFactor, analysisLive, analysisLastSim, categories, dashboard, wallTypeColors, metricWeights). |
| v1/js/controls.js | +1,043 | Major additions. |
| v1/js/modals.js | +969 | Major additions including rebuilt structural element builder. |
| v1/js/render.js | +430 | Major additions. |
| v1/js/scoring.js | +291 | Major additions. |
| v1/js/init.js | +28 | Now calls wireProjectImportWizard(), wireAnalysisPanel(), wireWallDraw(), wireLeftColResizer(), initDashboard(). The wireSimulations() call is now guarded: `if(typeof wireSimulations === "function") wireSimulations()`. Same guard for wireAnalysisPanel and wireWallDraw. |
| v1/js/data.js | +6 | Minor additions. |
| v1/css/components.css | +403 | Major additions. |
| v1/css/layout.css | +46 | Additions. |
| v1/css/stage.css | +119 | Additions. |

### Rahul's new files

| File | Description |
|---|---|
| v1/js/dashboard.js | 267 lines. Snap-to-grid widget layout for the dashboard. |
| v1/js/walldraw.js | 1,291 lines. Wall/floor-plan drawing editor that replaced the shape-based structural builder. |
| v1/js/optimize.js | 138 lines. Constrained simulated annealing optimizer wired to id="optimizeLayoutBtn" in the toolbar. THIS OVERLAPS WITH Neil's sim_optimizer.js. See MANUAL REVIEW section. |
| v1/js/sim_fire.js | 137 lines. Fire extinguisher coverage heatmap. New sim. |
| v1/js/sim_fumes.js | 132 lines. Fume/odor dispersion heatmap. New sim. |
| v1/css/dashboard.css | 99 lines. Dashboard widget styles. |
| IDEAS.md | 129 lines. New. Rahul's notes. |

### Rahul's changes to Neil's sim files

| File | What Rahul changed |
|---|---|
| v1/js/sim_ada.js | ADA_GRID_RES_FT changed from const to let (runtime-adjustable via setSimResolution). _adaIsBlocking() now respects a blocksMovement boolean flag and treats structural floor elements as non-blocking. _adaBuildGrid() now uses simBlockerFootprint() for rotation-aware obstacle marking instead of axis-aligned bounding box. _adaPaintCanvas() respects room scope (skips cells outside the analysis selection). |
| v1/js/sim_egress.js | EGRESS_GRID_RES_FT changed from const to let. _egressIsBlocking() same blocksMovement and structural-floor additions as ADA. _egressBuildGrid() uses simBlockerFootprint(). _egressOccupantLoad() uses analysisScopeAreaUnits() instead of whole-stage area. Fire-extinguisher section removed from this file (moved to sim_fire.js). _egressPaintCanvas() respects room scope. Result object packaged as a named variable before passing to both simShowEgressResults and the cache. |
| v1/js/sim_noise.js | NOISE_GRID_RES_FT changed from const to let. _noiseBuildWallGrid() RENAMED TO _noiseBuildStcGrid(). Return type changed from Uint8Array to Float32Array. Now recognizes wall-draw editor elements (elementClass+subtype) and door elements. Per-element stc field supported. _noiseWallCrossings() now sums STC values instead of counting crossings. _noisePrecompute() uses _noiseRefDist() (1 m in current unit) instead of NOISE_MIN_DIST_FT. Monte Carlo loop in runNoiseCheck() REPLACED with a deterministic weighted sum (schedule_prob weights each source's energy directly; no random sampling). dba_active now falls back to variableAttrs.noiseDb. _noisePaintCanvas() respects room scope. NOISE_MC_ITERATIONS const is kept (still 500) but is no longer used in runNoiseCheck. |
| v1/js/sim_ui.js | _simResultCache expanded to include fire and fumes entries. getSimScoreContribution() expanded with fire and fumes penalty terms; total cap changed from 40 to 53 points. SIM_CANVAS_IDS and SIM_CANVAS_ZINDEX expanded to include fire (z=13) and fumes (z=14). wireSimulations() stripped of all button click handlers (those moved to wireAnalysisPanel()). wireSimulations() now only creates the five canvases and reads the persisted resolution from state. New exported functions: setSimResolution(), runSingleSim(), runAllSims(), clearSimOverlays(), triggerLiveSim(). simShowEgressResults header changed from "Egress / Fire Analysis" to "Egress Analysis". _simSetActive() now includes "fire" in its button loop. _updatePenaltyCard() expanded for fire and fumes rows. |

---

## STEP 2: INTEGRATION CHECK

Neil's additive files checked against Rahul's new structure (26acf1d).

### v1/js/sim_eval.js (untracked)

Dependencies checked line by line against Rahul's sim modules:

| Function called in sim_eval.js | Status in 26acf1d |
|---|---|
| _adaBuildGrid(stageW, stageH) | EXISTS |
| _adaDistanceTransform(ag, ac, ar) | EXISTS |
| _adaCorridorStats(adaDist, ac, ar) | EXISTS |
| _adaCheckDoorWidths(stageW) | EXISTS |
| _egressBuildGrid(stageW, stageH) | EXISTS |
| _egressBFS(eg, ec, er) | EXISTS |
| _egressOccupantLoad(stageW, stageH) | EXISTS |
| _egressExitCapacity(stageW) | EXISTS |
| _noiseGetSources(stageW, stageH) | EXISTS |
| **_noiseBuildWallGrid(stageW, stageH, cols, rows)** | **MISSING. BREAKS BECAUSE RAHUL RENAMED _noiseBuildWallGrid TO _noiseBuildStcGrid. See sim_eval.js line 92.** |
| _noisePrecompute(sources, grid, cols, rows, stageW, stageH) | EXISTS. Second argument is now Float32Array instead of Uint8Array but this is compatible. |
| NOISE_GRID_RES_FT | EXISTS (now let, still number) |
| NOISE_AMBIENT_DBA | EXISTS |
| OSHA_ACTION_LEVEL_DBA | EXISTS |
| state.zones | EXISTS |
| stageDimsUnits() | EXISTS |

VERDICT: One broken dependency. Fix: change `_noiseBuildWallGrid` to `_noiseBuildStcGrid` on sim_eval.js line 92. This is a one-word change.

Note: sim_eval.js runs its own MC loop with EVAL_NOISE_ITERATIONS=25 separate from runNoiseCheck(). The MC loop is inside the try block in evaluateLayout() and is unaffected by Rahul's change to runNoiseCheck(). Only the function name on line 92 is wrong.

### v1/js/sim_optimizer.js (untracked)

| Dependency | Status |
|---|---|
| evaluateLayout(), evalDominates(), evalPctImprovement() | Defined in sim_eval.js; will load before sim_optimizer.js once script tags are added. EXISTS |
| stageDimsUnits(), allZoneDefs(), state.zones | EXISTS in state.js |
| evaluate(), render() | Both still exist as globals from controls.js / render.js. EXISTS |
| _simEsc(s) | EXISTS in Rahul's sim_ui.js |
| document.getElementById("simOptimizeBtn") | NOT IN RAHUL'S INDEX.HTML. Returns null; wireOptimizer() fails silently (checks if(optBtn)). See MANUAL REVIEW. |
| document.getElementById("optResultsCard"), "optResultsBody" | NOT IN RAHUL'S INDEX.HTML. _showOptError and _showOptResults will silently no-op. See MANUAL REVIEW. |
| document.getElementById("optProgressWrap"), "optProgressBar" | NOT IN RAHUL'S INDEX.HTML. _showOptProgress silently no-ops. |
| document.getElementById("stage") | EXISTS |
| _drawGhostOverlay() | Self-defined, stage.appendChild works |

VERDICT: sim_optimizer.js loads without throwing. No hard runtime errors. All DOM lookups have null guards or graceful no-ops. HOWEVER the optimizer UI is completely dark because the HTML elements it writes to do not exist in Rahul's index.html yet. The optimizer will not be usable until the index.html additions (BLOCKER 3) are re-applied.

### v1/js/sim_ui.js (local modification: adds wireOptimizer() call at end of wireSimulations)

Neil's change adds:
```
if (typeof wireOptimizer === "function") wireOptimizer();
```
at the end of wireSimulations() (old file, around line 435).

Rahul completely rewrote wireSimulations(). His new version (in 26acf1d) ends at line 428 of the new sim_ui.js, just after the `if(state){ ... }` block that reads the persisted resolution. The button click handlers were stripped out; wireSimulations() now only creates canvases and reads resolution.

A git pull will refuse to fast-forward because this file is locally modified AND changed by Rahul. Manual re-apply required. See BLOCKER 2.

The call is still correct and needed. Neil's wireOptimizer() call needs to go at the end of Rahul's new wireSimulations(), after the resolution block.

### v1/index.html (local modification)

Neil's local diff adds to the 06eead8 version of index.html:
1. opt-ctrl-group div (after simClearBtn in the toolbar)
2. optResultsCard (after simPenaltyCard in the left sidebar)
3. Script tags for sim_eval.js and sim_optimizer.js

In Rahul's 1,008-line index.html, all three insertion points have moved or do not exist in the same form:
- The old sim-buttons toolbar div is gone. Sim buttons are now inside an Analysis widget inside the dashboard.
- simClearBtn still exists (id unchanged) but is inside the Analysis widget, not the toolbar.
- simPenaltyCard still exists (id unchanged) and is at approximately line 214 in Rahul's new file, right before the stage card.
- The script loading block is at lines 985-1006 of Rahul's new file.

A git pull will refuse to fast-forward because this file is locally modified AND changed by Rahul. Manual re-apply required. See BLOCKER 3.

### v1/css/sim.css (local modification: adds optimizer CSS)

Rahul did NOT touch this file between 06eead8 and 26acf1d. Git pull will update sim.css to the same content it already has (no change needed). Neil's local modifications to sim.css will survive the pull cleanly. NO CONFLICT.

### tests/index.html and tests/tests.js (local modifications)

Rahul did NOT touch either tests file between 06eead8 and 26acf1d. Both local modifications survive the pull cleanly. NO CONFLICT.

---

## STEP 3: INDEX.HTML NEIL-TAGGED COMMENT BLOCKS

Neil's Round 4 added two comment-wrapped blocks to v1/index.html:

**Block 1: simRunAllBtn**

Neil's block:
```html
<!-- Neil: Run All button ... -->
<button class="btn ghost" id="simRunAllBtn" title="...">Run All</button>
<!-- end Neil -->
```

Status: GONE from Rahul's index.html. Rahul replaced it with his own Run All button inside the Analysis widget:
```html
<button class="btn ghost an-run an-run-all" id="simAllBtn" title="...">Run All</button>
```

The element ID changed from simRunAllBtn to simAllBtn. The button moved from the toolbar to the Analysis panel. Neil's comment wrappers are absent. The button still exists functionally; it is wired by wireAnalysisPanel() (not wireSimulations()).

**Block 2: simPenaltyCard**

Neil's block:
```html
<!-- Neil: Simulation Penalty Adjustment card ... -->
<div class="card" id="simPenaltyCard" style="display:none">
  <h3>Simulation Penalty Adjustment</h3>
  <div class="body" id="simPenaltyBody"></div>
</div>
<!-- end Neil -->
```

Status: Card still exists in Rahul's index.html (id="simPenaltyCard", id="simPenaltyBody" preserved) but the comment wrappers are gone. Rahul integrated it into the dashboard widget system:
```html
<div class="card" id="simPenaltyCard" data-widget="simPenalty" data-dgroup="right" style="display:none">
  <h3>Simulation Penalty Adjustment</h3>
  <div class="body" id="simPenaltyBody"></div>
</div>
```

The IDs that Neil's sim_ui.js reads (simPenaltyCard, simPenaltyBody) are unchanged. This block works correctly in Rahul's version even without Neil's comment wrappers.

**Conclusion:** Neither comment block survived. Block 2's functional content (card and body IDs) did survive, incorporated into Rahul's structure. Block 1's functional content (button) survived under a different ID.

---

## STEP 4: TESTS

Tests are analyzed statically against Rahul's new sim modules (26acf1d). Running the test harness now (before pull) would use the old sim modules from 06eead8 and all tests would likely pass. The analysis below reflects the state AFTER a pull, which is the target for the push.

| Test group | Pass/Fail | Notes |
|---|---|---|
| ADA tests 1-7 | PASS | sim_ada.js functions unchanged in signature. simBlockerFootprint() is in state.js and available. Non-rotated zones produce identical grid markings. |
| Egress tests 8-12 | PASS | sim_egress.js functions unchanged in signature. simBlockerFootprint() available. analysisScopeAreaUnits() exists. |
| Noise test 13 | FAIL | Calls _noiseBuildWallGrid() directly (tests/tests.js line 275). BREAKS BECAUSE RAHUL RENAMED _noiseBuildWallGrid TO _noiseBuildStcGrid. |
| Noise test 14 | FAIL | Calls _noiseBuildWallGrid() directly (tests/tests.js line 341). Same cause. |
| Noise tests 15-16 | DEPENDS | If these tests call _noiseBuildWallGrid or invoke evaluateLayout, they fail for the same reason. Noise tests 13-16 are the 4 tests in the "4 Noise" group and likely all exercise _noiseBuildWallGrid. |
| Constant tests (NOISE_MC_ITERATIONS, ADA thresholds, NFPA limit, OSHA level) | PASS | All constants still present in Rahul's files. |
| EVAL tests 19-21 (evaluateLayout, determinism, state restore) | FAIL | evaluateLayout() calls _noiseBuildWallGrid on sim_eval.js line 92. ReferenceError propagates out of the try block's finally clause, which restores state.zones correctly but still throws. |
| EVAL tests (evalObjective, evalDominates) | PASS | These do not call evaluateLayout or any noise function. Pure computation on plain objects. |
| OPT test (optimizerMovableIds) | PASS | Checks movable ID filtering logic only. Does not call evaluateLayout. |
| OPT test (_nudgeLayout bounds) | PASS | Checks position arithmetic only. Does not call evaluateLayout. |
| OPT test (_saRunSync archive) | FAIL | Calls _saRunSync which calls evaluateLayout. Same root cause as EVAL tests. |
| MOSA tests (archive non-dominance, seeded repeatability, baseline dominance) | FAIL | All call _saRunSync -> evaluateLayout -> _noiseBuildWallGrid. Same root cause. |

**Root cause of all failures:** Single function rename in Rahul's sim_noise.js: `_noiseBuildWallGrid` became `_noiseBuildStcGrid`. This is a private internal function that Neil's eval harness depended on. Fix requires three one-line changes -- none in Rahul's files:
1. sim_eval.js line 92: change `_noiseBuildWallGrid` to `_noiseBuildStcGrid`
2. tests/tests.js line 275: change `_noiseBuildWallGrid` to `_noiseBuildStcGrid`
3. tests/tests.js line 341: change `_noiseBuildWallGrid` to `_noiseBuildStcGrid`

Classification: these are Neil's files calling a function from Rahul's module that Rahul renamed. Rahul's rename is legitimate (the function now returns a Float32Array with per-element STC values rather than a binary wall mask). The dependency was never documented as stable API.

---

## STEP 5: PUSH READINESS REPORT

### BLOCKERS (resolve before pushing)

**BLOCKER 1 -- MUST FIX: _noiseBuildWallGrid rename**
Priority: Highest. One-line fix in three files (all Neil's).

In sim_eval.js line 92:
```
- const wallGrid = _noiseBuildWallGrid(stageW, stageH, nCols, nRows);
+ const wallGrid = _noiseBuildStcGrid(stageW, stageH, nCols, nRows);
```

In tests/tests.js line 275:
```
- const wallGrid = _noiseBuildWallGrid(stageW, stageH, cols, rows);
+ const wallGrid = _noiseBuildStcGrid(stageW, stageH, cols, rows);
```

In tests/tests.js line 341:
```
- const wallGrid = _noiseBuildWallGrid(stageW, stageH, cols, rows);
+ const wallGrid = _noiseBuildStcGrid(stageW, stageH, cols, rows);
```

No changes to Rahul's files.

**BLOCKER 2 -- MUST FIX: sim_ui.js conflict on git pull**
Priority: High.

Neil's local sim_ui.js (adds wireOptimizer call at end of wireSimulations) conflicts with Rahul's new sim_ui.js (rewrote wireSimulations body completely). Git pull will refuse because both the incoming commit and the working tree modify this file.

Resolution (additive, do not touch Rahul's logic):
```
git stash push v1/js/sim_ui.js v1/index.html
git pull
```

Then manually append to Rahul's wireSimulations() in v1/js/sim_ui.js. The function is at line 415 of Rahul's new sim_ui.js and ends at approximately:
```javascript
function wireSimulations() {
  simGetCanvas("ada");
  simGetCanvas("egress");
  simGetCanvas("fire");
  simGetCanvas("noise");
  simGetCanvas("fumes");
  if(state){
    if(Number.isFinite(state.simResolutionFactor) && state.simResolutionFactor > 0){
      setSimResolution(state.simResolutionFactor);
    } else if(state.simResolution){
      setSimResolution(state.simResolution);
    }
  }
  // ADD THIS LINE:
  if (typeof wireOptimizer === "function") wireOptimizer();
}
```

The guard `if (typeof wireOptimizer === "function")` preserves the additive contract: if sim_optimizer.js is not loaded, wireSimulations() still works. Neil must add this line after the resolution block and before the closing brace.

**BLOCKER 3 -- MUST FIX: index.html conflict on git pull and manual re-apply**
Priority: High.

Neil's local index.html adds three things to the 06eead8 version. Rahul restructured the file to 1,008 lines. Git pull will refuse. After stashing (see BLOCKER 2), the pull succeeds and Neil can re-apply manually.

Three insertions needed in Rahul's 1,008-line index.html:

**Insertion A: Script tags**
After `<script src="js/sim_ui.js?v=4"></script>` (currently around line 998) and before `<script src="js/dashboard.js?v=4"></script>`:
```html
<!-- Neil: Optimizer modules -- sim_eval.js defines evaluateLayout/evalObjective/evalDominates; sim_optimizer.js defines the SA engine and UI -->
<script src="js/sim_eval.js?v=4"></script>
<script src="js/sim_optimizer.js?v=4"></script>
<!-- end Neil -->
```

Load order matters: sim_eval.js needs sim_ada.js, sim_egress.js, sim_noise.js already loaded (they are, above); sim_optimizer.js needs sim_eval.js and sim_ui.js already loaded (they are).

**Insertion B: optResultsCard**
After `<div class="card" id="simPenaltyCard" ...>` block (approximately lines 214-217 in Rahul's file), before the stage card:
```html
<!-- Neil: Optimizer Results card -- hidden by default; sim_optimizer.js fills #optResultsBody after a run -->
<div class="card" id="optResultsCard" data-widget="optResults" data-dgroup="right" style="display:none">
  <h3>Optimizer Results</h3>
  <div class="body" id="optResultsBody"></div>
</div>
<!-- end Neil -->
```

Note: data-widget and data-dgroup attributes are added to match Rahul's dashboard widget system (simPenaltyCard uses the same pattern).

**Insertion C: Optimize button (opt-ctrl-group)**
This is NOT a safe automatic re-apply. See MANUAL REVIEW section.

**MANUAL REVIEW ITEM -- DECISION REQUIRED: Two optimize buttons**
Priority: High. Neil cannot resolve this alone.

Rahul added `optimize.js` (138 lines, constrained SA) wired to `id="optimizeLayoutBtn"` in the controls bar. Neil has `sim_optimizer.js` (691 lines, MOSA with Pareto archive) wired to `id="simOptimizeBtn"` in a separate opt-ctrl-group.

These are two different optimizers, different entry points, different results UI. They do not conflict in code (different IDs, different wiring). However presenting two "optimize" buttons to the user without explanation is confusing.

Options:
1. Keep both. Wire Neil's MOSA optimizer to a clearly labeled second button ("MOSA Optimizer") so the user understands they are different tools.
2. Subsume. Neil's opt-ctrl-group HTML (simOptimizeBtn, simOptCancelBtn, optProgressWrap) needs to be inserted in the controls bar alongside or after Rahul's optimizeLayoutBtn. Both buttons must be visible and clearly labeled.
3. Defer. Do not add Neil's opt-ctrl-group to index.html in this push. Push sim_eval.js and sim_optimizer.js as module files only, make them available for integration later.

This decision must be Neil's. The opt-ctrl-group insertion (Insertion C above) is blocked pending this choice. All other blockers are independent and can be resolved first.

---

### SAFE TO PUSH AS-IS (after pull, no manual resolution needed)

- v1/css/sim.css: optimizer CSS appended to unchanged file. Applies cleanly after pull. Stage and push normally.
- tests/index.html: stubs and script tags appended. Rahul did not touch this file. Applies cleanly after pull.
- tests/tests.js: 8 new eval and MOSA tests appended. Rahul did not touch this file. Applies cleanly after pull. Tests 19-26 will fail until BLOCKER 1 is fixed; once fixed they should pass.
- OPTIMIZER_DESIGN.md: untracked, new file. No conflict.
- v1/js/sim_eval.js: untracked, new file. No conflict. Fix line 92 (BLOCKER 1) before staging.
- v1/js/sim_optimizer.js: untracked, new file. No conflict. Loads cleanly. UI dark until BLOCKER 3 index.html insertions are done.
- v1/js/sim_score_bridge.js: already committed in 06eead8. Not modified by Rahul. No action needed.

---

### GIT COMMANDS TO PUSH (run in this order, after completing all blockers above)

```bash
# Step 1: stash the two conflicting files
git stash push v1/js/sim_ui.js v1/index.html -m "neil-optimizer-additions"

# Step 2: pull Rahul's commit
git pull

# Step 3: fix BLOCKER 1 (one-line change in sim_eval.js and two lines in tests/tests.js, see above)

# Step 4: manually re-apply sim_ui.js addition (wireOptimizer call at end of wireSimulations)

# Step 5: manually re-apply index.html insertions A and B
#         (script tags and optResultsCard -- see above)
#         Insertion C (opt-ctrl-group) pending your decision on the dual-optimizer question

# Step 6: stage everything
git add v1/js/sim_eval.js
git add v1/js/sim_optimizer.js
git add OPTIMIZER_DESIGN.md
git add v1/css/sim.css
git add v1/js/sim_ui.js
git add v1/index.html
git add tests/index.html
git add tests/tests.js

# Step 7: verify the list before committing
git diff --staged --stat

# Step 8: commit (do not push -- you push manually after reading the diff)
git commit -m "Add MOSA layout optimizer and fix _noiseBuildWallGrid rename"

# When you are ready to push:
# git push
```

---

## SUMMARY

Rahul's squashed commit was a major sprint: wall drawing editor, persistent state, dashboard, two new sims, his own optimizer, and significant updates to Neil's three sim modules. None of it touched tests/ or sim.css.

Everything Neil added is still valid architecturally. The only real breakage is one renamed function (_noiseBuildWallGrid -> _noiseBuildStcGrid) affecting 3 lines across 2 files. Everything else is a re-apply or a placement question.

The only decision Neil must make before pushing is what to do about two optimize-layout buttons in the same controls bar.
