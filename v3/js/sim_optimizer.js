"use strict";
/* ------------------------------------------------------------------
   MULTI-OBJECTIVE SIMULATED ANNEALING LAYOUT OPTIMIZER (MOSA)
   Preliminary model estimate. Not for regulatory use.

   Searches for Pareto-optimal zone placements across three objectives:
   ADA corridor accessibility (sim_ada.js), NFPA egress travel distance
   (sim_egress.js), and OSHA noise action-level area (sim_noise.js).
   Rather than collapsing these into an arbitrary weighted scalar, MOSA
   uses dominance-based move acceptance and maintains a non-dominated
   archive of solutions found during the search.

   Fixed zones (entrance, exits, main desk) and user-locked zones are
   never moved. Corridors, structural, and amenity elements are also
   excluded because they define the physical container.

   Variance reduction for noise: Math.random is replaced with a seeded
   deterministic PRNG (Mulberry32) for the full duration of each run.
   This makes the noise component of evaluateLayout repeatable within a
   single search pass so that MC variance does not corrupt dominance
   comparisons. Normal randomness is restored before the display pass.
   See OPTIMIZER_DESIGN.md, section "How uncertainty enters."

   Async execution: the SA loop runs in setTimeout batches of SA_BATCH
   steps so the browser stays responsive. A progress bar updates between
   batches.

   The optimizer does NOT auto-apply results. The user selects a Pareto
   front solution from the frontier table and clicks Apply to write
   positions into state.zones and trigger evaluate() and render() through
   Rahul's public API.

   Dependencies: sim_eval.js (evaluateLayout, evalDominates,
                 evalPctImprovement), sim_ada.js, sim_egress.js,
                 sim_noise.js, sim_ui.js (for _simEsc), state.js.
   ------------------------------------------------------------------ */

// SA hyperparameters -- named so trade-offs are auditable.
//
// T_INIT / T_MIN ratio controls acceptance of worsening moves.
// At T_INIT = 0.15, a candidate worsening one objective by 0.15 is
// accepted with probability exp(-0.15 / 0.15) = 37%, giving broad
// early exploration. At T_MIN = 0.001 the algorithm is near-greedy.
//
// SA_N_ITER = 500 finishes in under 5 s on a typical 15-element layout
// in a modern browser. Increase for deeper search if performance allows.
const SA_T_INIT  = 0.15;
const SA_T_MIN   = 0.001;
const SA_N_ITER  = 500;
const SA_BATCH   = 50;    // steps per setTimeout slice

// Step size bounds in percent of stage. Shrinks with temperature so
// early iterations explore broadly and late ones refine locally.
const SA_STEP_MAX = 5.0;  // percent -- ~4 ft on an 80 ft stage
const SA_STEP_MIN = 0.5;  // percent -- ~0.4 ft on an 80 ft stage

// Geometric cooling rate. Derived so T reaches T_MIN after SA_N_ITER steps.
const SA_COOLING = Math.pow(SA_T_MIN / SA_T_INIT, 1 / SA_N_ITER);

// Archive cap. Larger values keep more diverse solutions but slow archive
// operations and clutter the results panel.
const MOSA_ARCHIVE_MAX = 12;

// Seed for the deterministic PRNG used during the optimizer run. Fixed so
// the noise component of evaluateLayout is repeatable within a single run,
// preventing MC variance from corrupting dominance comparisons. The display
// layer (runNoiseCheck, 500 iterations) always uses the real Math.random,
// which is restored after the SA loop completes.
const MOSA_NOISE_SEED = 0x4E65696C;  // ASCII bytes for "Neil"

// Module-level run state.
let _optRunning    = false;
let _lastOptResult = null;   // {baseline, archive} after a successful run
let _previewIdx    = 0;      // which archive member is ghosted and apply-ready
let _ghostVisible  = true;

// Ghost overlay CSS class.
const OPT_GHOST_CLASS = "opt-ghost";


/* ------------------------------------------------------------------
   DETERMINISTIC PRNG  (Mulberry32)
   Exposed so the test suite can patch Math.random independently
   of the optimizer's own seeding logic.
   ------------------------------------------------------------------ */
function _makeLCG(seed) {
  let s = seed >>> 0;
  return function () {
    s += 0x6D2B79F5;
    let z = s;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
}


/* ------------------------------------------------------------------
   MOVE SET
   ------------------------------------------------------------------ */

// Returns IDs of all zones the optimizer is allowed to move.
// Excludes: fixed=true defs, user-locked zones, corridors, open areas,
// structural and amenity elements.
function optimizerMovableIds() {
  const defs     = allZoneDefs();
  const fixedSet = new Set(defs.filter(function (d) { return d.fixed; }).map(function (d) { return d.id; }));
  const result   = [];
  for (const [id, z] of Object.entries(state.zones)) {
    if (fixedSet.has(id))                                  continue;
    if (z.locked)                                          continue;
    if (!z.included)                                       continue;
    const def = defs.find(function (d) { return d.id === id; });
    if (!def)                                              continue;
    if (def.cat === "corridor" || def.cat === "open")      continue;
    if (def.elementClass === "structural")                 continue;
    if (def.elementClass === "amenity")                    continue;
    result.push(id);
  }
  return result;
}

// Copies x, y, w, h for a set of zone IDs into a plain object.
function _snapshotLayout(ids) {
  const snap = {};
  for (const id of ids) {
    const z = state.zones[id];
    if (z) snap[id] = { x: z.x, y: z.y, w: z.w, h: z.h };
  }
  return snap;
}

// Produces a candidate layout by nudging one element within valid bounds.
// Returns a new plain object; does not mutate layout.
function _nudgeLayout(layout, id, stepPct) {
  const z = state.zones[id];
  if (!z) return layout;
  const current = layout[id] || { x: z.x, y: z.y, w: z.w, h: z.h };
  const dx = (Math.random() * 2 - 1) * stepPct;
  const dy = (Math.random() * 2 - 1) * stepPct;
  const nx = Math.max(0, Math.min(100 - current.w, current.x + dx));
  const ny = Math.max(0, Math.min(100 - current.h, current.y + dy));
  const next = Object.assign({}, layout);
  next[id] = Object.assign({}, current, { x: nx, y: ny });
  return next;
}


/* ------------------------------------------------------------------
   MOSA ACCEPTANCE
   A candidate is accepted if its delta is zero (it is no worse on any
   objective) or with Boltzmann probability exp(-delta / T) when it is
   worse on at least one. Delta is the sum of positive per-objective
   deteriorations, so the acceptance probability naturally scales with
   how much the candidate worsens objectives it does make worse.
   ------------------------------------------------------------------ */
function _mosaDelta(currentVec, candVec) {
  return (
    Math.max(0, candVec.ada    - currentVec.ada)    +
    Math.max(0, candVec.egress - currentVec.egress) +
    Math.max(0, candVec.noise  - currentVec.noise)
  );
}


/* ------------------------------------------------------------------
   PARETO ARCHIVE
   A set of mutually non-dominated solutions accumulated during search.
   Capped at MOSA_ARCHIVE_MAX; excess entries are removed by dropping
   the member with the lowest crowding distance (the most redundant
   representative of the frontier).
   ------------------------------------------------------------------ */

// Per-member crowding distance summed across all three objectives.
// Boundary members (extreme on any objective) receive Infinity.
// Interior members receive (next - prev) / range for each objective.
function _crowdingDistances(archive) {
  const n  = archive.length;
  const cd = new Array(n).fill(0);
  if (n <= 2) {
    for (let i = 0; i < n; i++) cd[i] = Infinity;
    return cd;
  }
  const objectives = ["ada", "egress", "noise"];
  for (const obj of objectives) {
    const sorted = archive
      .map(function (m, i) { return { val: m.vec[obj], idx: i }; })
      .sort(function (a, b) { return a.val - b.val; });
    const range = sorted[n - 1].val - sorted[0].val || 1;
    cd[sorted[0].idx]     = Infinity;
    cd[sorted[n - 1].idx] = Infinity;
    for (let k = 1; k < n - 1; k++) {
      cd[sorted[k].idx] += (sorted[k + 1].val - sorted[k - 1].val) / range;
    }
  }
  return cd;
}

// Inserts a candidate into the archive if not dominated by any member.
// Prunes members now dominated by the candidate. Thins if over cap.
// Returns true if the candidate was inserted.
function _archiveInsert(archive, vec, layout) {
  for (const m of archive) {
    if (evalDominates(m.vec, vec)) return false;
    // Skip exact duplicates (possible when seeded RNG produces the same evaluation).
    if (m.vec.ada === vec.ada && m.vec.egress === vec.egress && m.vec.noise === vec.noise) return false;
  }
  for (let i = archive.length - 1; i >= 0; i--) {
    if (evalDominates(vec, archive[i].vec)) archive.splice(i, 1);
  }
  archive.push({ vec: Object.assign({}, vec), layout: Object.assign({}, layout) });
  if (archive.length > MOSA_ARCHIVE_MAX) _archiveThin(archive);
  return true;
}

// Drops the archive member with the lowest crowding distance.
function _archiveThin(archive) {
  const cd = _crowdingDistances(archive);
  let minIdx = 0, minCd = cd[0];
  for (let i = 1; i < cd.length; i++) {
    if (cd[i] < minCd) { minCd = cd[i]; minIdx = i; }
  }
  archive.splice(minIdx, 1);
}

// Returns the archive member with the highest crowding distance: the most
// spread-out representative of the frontier rather than a cluster center.
// Ties (both Infinity for small archives) broken by lowest mean objective.
function _archiveBest(archive) {
  if (archive.length === 0) return null;
  const cd = _crowdingDistances(archive);
  let bestIdx = 0, bestCd = cd[0];
  for (let i = 1; i < cd.length; i++) {
    const tieBreak =
      cd[i] === bestCd &&
      (archive[i].vec.ada + archive[i].vec.egress + archive[i].vec.noise) <
      (archive[bestIdx].vec.ada + archive[bestIdx].vec.egress + archive[bestIdx].vec.noise);
    if (cd[i] > bestCd || tieBreak) {
      bestCd  = cd[i];
      bestIdx = i;
    }
  }
  return archive[bestIdx];
}


/* ------------------------------------------------------------------
   SYNCHRONOUS MOSA CORE
   Exposed as _saRunSync so the test suite can call it without the
   async wrappers. The optional rng parameter, if provided, replaces
   Math.random for the duration of the run to make the noise objective
   deterministic (variance reduction).

   Returns { archive, baseline }.
   ------------------------------------------------------------------ */
function _saRunSync(movable, stageW, stageH, nIter, rng) {
  const savedRandom = Math.random;
  if (rng) Math.random = rng;

  const archive = [];
  try {
    const baseline = evaluateLayout({}, stageW, stageH);
    let current    = _snapshotLayout(movable);
    let currentVec = Object.assign({}, baseline);
    _archiveInsert(archive, baseline, current);

    let T = SA_T_INIT;
    for (let iter = 0; iter < nIter; iter++) {
      const id   = movable[Math.floor(Math.random() * movable.length)];
      const step = SA_STEP_MIN + (SA_STEP_MAX - SA_STEP_MIN) * (T / SA_T_INIT);
      const cand    = _nudgeLayout(current, id, step);
      const candVec = evaluateLayout(cand, stageW, stageH);
      const delta   = _mosaDelta(currentVec, candVec);

      if (delta === 0 || Math.random() < Math.exp(-delta / T)) {
        current    = cand;
        currentVec = candVec;
      }
      _archiveInsert(archive, candVec, current);
      T *= SA_COOLING;
    }
    return { archive: archive, baseline: baseline };
  } finally {
    if (rng) Math.random = savedRandom;
  }
}


/* ------------------------------------------------------------------
   ASYNC OPTIMIZER ENTRY POINT
   ------------------------------------------------------------------ */
function runOptimizer() {
  if (_optRunning) return;

  const du = stageDimsUnits();
  if (!du) {
    _showOptError("Optimizer requires a calibrated floor plan. Import a floor plan and set scale first.");
    return;
  }
  const stageW  = du.w;
  const stageH  = du.h;
  const movable = optimizerMovableIds();
  if (movable.length === 0) {
    _showOptError("No movable elements to optimize. Load an elements bundle and import a configuration first.");
    return;
  }

  _clearGhostOverlay();
  _optRunning    = true;
  _lastOptResult = null;
  _previewIdx    = 0;
  _setOptButtonState(true);
  _showOptProgress(0);

  const baseline = evaluateLayout({}, stageW, stageH);
  let current    = _snapshotLayout(movable);
  let currentVec = Object.assign({}, baseline);
  const archive  = [];
  _archiveInsert(archive, baseline, current);

  // Patch Math.random with a seeded PRNG for the full SA loop so that the
  // noise MC draws are deterministic within this run. This prevents MC
  // variance from flipping dominance comparisons on nearly-equal layouts.
  // Math.random is restored after the last batch (or on cancel).
  const savedRandom = Math.random;
  Math.random = _makeLCG(MOSA_NOISE_SEED);

  let T    = SA_T_INIT;
  let iter = 0;

  function batch() {
    if (!_optRunning) {
      Math.random = savedRandom;
      _finish(baseline, archive);
      return;
    }
    const end = Math.min(iter + SA_BATCH, SA_N_ITER);
    while (iter < end) {
      const id   = movable[Math.floor(Math.random() * movable.length)];
      const step = SA_STEP_MIN + (SA_STEP_MAX - SA_STEP_MIN) * (T / SA_T_INIT);
      const cand    = _nudgeLayout(current, id, step);
      const candVec = evaluateLayout(cand, stageW, stageH);
      const delta   = _mosaDelta(currentVec, candVec);

      if (delta === 0 || Math.random() < Math.exp(-delta / T)) {
        current    = cand;
        currentVec = candVec;
      }
      _archiveInsert(archive, candVec, current);
      T    *= SA_COOLING;
      iter++;
    }
    _showOptProgress(iter / SA_N_ITER);
    if (iter < SA_N_ITER) {
      setTimeout(batch, 0);
    } else {
      Math.random = savedRandom;
      _finish(baseline, archive);
    }
  }
  setTimeout(batch, 0);
}

function cancelOptimizer() {
  _optRunning = false;
}

function _finish(baseline, archive) {
  _optRunning    = false;
  _lastOptResult = { baseline: baseline, archive: archive };
  _setOptButtonState(false);
  _showOptProgress(0);

  // Default preview: archive member with the best crowding distance, the
  // most spread-out representative of the frontier rather than a cluster.
  const best = _archiveBest(archive);
  _previewIdx = archive.indexOf(best);
  if (_previewIdx < 0) _previewIdx = 0;

  _showOptResults(baseline, archive);
  if (archive.length > 0) _drawGhostOverlay(archive[_previewIdx].layout);
}


/* ------------------------------------------------------------------
   PREVIEW AND APPLY
   ------------------------------------------------------------------ */

// Switches the ghost overlay and Apply button to a specific archive member.
// Called by onclick handlers in the frontier table and SVG dots.
function previewFrontierSolution(idx) {
  if (!_lastOptResult) return;
  const archive = _lastOptResult.archive;
  if (!archive || idx < 0 || idx >= archive.length) return;
  _previewIdx = idx;
  _drawGhostOverlay(archive[idx].layout);

  document.querySelectorAll(".opt-frontier-row").forEach(function (row, i) {
    row.classList.toggle("opt-frontier-selected", i === idx);
  });

  const applyBtn = document.getElementById("optApplyBtn");
  if (applyBtn) applyBtn.textContent = "Apply Solution " + (idx + 1);
}

// Writes the selected archive member into state.zones and calls Rahul's
// evaluate() and render(). Removes the ghost overlay first.
function applyOptimizerResult() {
  if (!_lastOptResult) return;
  const archive = _lastOptResult.archive;
  if (!archive || archive.length === 0) return;
  const idx    = Math.min(_previewIdx, archive.length - 1);
  const member = archive[idx];
  _clearGhostOverlay();
  for (const [id, pos] of Object.entries(member.layout)) {
    const z = state.zones[id];
    if (!z) continue;
    z.x = pos.x;
    z.y = pos.y;
  }
  evaluate();
  render();
  _lastOptResult = null;
  const card = document.getElementById("optResultsCard");
  if (card) card.style.display = "none";
}


/* ------------------------------------------------------------------
   GHOST OVERLAY
   Shows suggested positions as dashed blue rectangles on the stage.
   Drawn as absolutely-positioned divs inside #stage, same coordinate
   system as Rahul's zone divs.
   ------------------------------------------------------------------ */
function _clearGhostOverlay() {
  document.querySelectorAll("." + OPT_GHOST_CLASS).forEach(function (n) { n.remove(); });
}

function _drawGhostOverlay(layout) {
  _clearGhostOverlay();
  _ghostVisible = true;
  const stage = document.getElementById("stage");
  if (!stage || !layout) return;

  const defs = allZoneDefs();
  for (const [id, pos] of Object.entries(layout)) {
    const z = state.zones[id];
    if (!z) continue;
    if (Math.abs(pos.x - z.x) < 0.05 && Math.abs(pos.y - z.y) < 0.05) continue;

    const def = defs.find(function (d) { return d.id === id; });
    const el  = document.createElement("div");
    el.className = OPT_GHOST_CLASS;
    el.style.cssText = [
      "position:absolute",
      "left:"   + pos.x + "%",
      "top:"    + pos.y + "%",
      "width:"  + pos.w + "%",
      "height:" + pos.h + "%",
      "border:2px dashed rgba(90,160,255,0.75)",
      "background:rgba(90,160,255,0.10)",
      "pointer-events:none",
      "z-index:20",
      "box-sizing:border-box",
    ].join(";");

    const lbl = document.createElement("span");
    lbl.style.cssText = [
      "position:absolute",
      "bottom:2px",
      "left:3px",
      "font-size:9px",
      "color:rgba(110,170,255,.95)",
      "white-space:nowrap",
      "overflow:hidden",
      "max-width:98%",
    ].join(";");
    lbl.textContent = (def ? (def.short || def.label) : id) + " (suggested)";
    el.appendChild(lbl);
    stage.appendChild(el);
  }

  const btn = document.getElementById("optGhostToggleBtn");
  if (btn) btn.textContent = "Hide Ghost";
}

function toggleOptimizerGhost() {
  _ghostVisible = !_ghostVisible;
  document.querySelectorAll("." + OPT_GHOST_CLASS).forEach(function (n) {
    n.style.display = _ghostVisible ? "" : "none";
  });
  const btn = document.getElementById("optGhostToggleBtn");
  if (btn) btn.textContent = _ghostVisible ? "Hide Ghost" : "Show Ghost";
}


/* ------------------------------------------------------------------
   UI HELPERS
   ------------------------------------------------------------------ */
function _setOptButtonState(running) {
  const optBtn    = document.getElementById("simOptimizeBtn");
  const cancelBtn = document.getElementById("simOptCancelBtn");
  if (optBtn)    optBtn.disabled = running;
  if (cancelBtn) cancelBtn.style.display = running ? "" : "none";
}

function _showOptProgress(frac) {
  const wrap = document.getElementById("optProgressWrap");
  const bar  = document.getElementById("optProgressBar");
  if (wrap) wrap.style.display = frac > 0 && frac < 1 ? "" : "none";
  if (bar)  bar.style.width = (frac * 100).toFixed(0) + "%";
}

function _showOptError(msg) {
  const card = document.getElementById("optResultsCard");
  const body = document.getElementById("optResultsBody");
  if (!body) return;
  body.innerHTML = '<div class="sim-error">' + _simEsc(msg) + "</div>";
  if (card) card.style.display = "";
}

// Generates a plain-English trade-off sentence from two real archive members.
// Compares the member with the best ADA score against the one with the worst.
// Returns null if the archive is too small or no trade-off is visible.
function _tradeOffSentence(archive) {
  if (archive.length < 2) return null;

  const byAda   = archive.slice().sort(function (a, b) { return a.vec.ada - b.vec.ada; });
  const bestAda  = byAda[0];
  const worstAda = byAda[byAda.length - 1];

  if (worstAda.vec.ada <= 0) {
    // No ADA spread; try ADA vs Egress instead.
    const byEg    = archive.slice().sort(function (a, b) { return a.vec.egress - b.vec.egress; });
    const bestEg   = byEg[0];
    const worstEg  = byEg[byEg.length - 1];
    if (worstEg.vec.egress <= 0) return null;
    const egImprove  = ((worstEg.vec.egress - bestEg.vec.egress) / worstEg.vec.egress) * 100;
    const adaWorsen  = ((bestEg.vec.ada - worstEg.vec.ada) / (worstEg.vec.ada || 1)) * 100;
    if (egImprove > 1 && adaWorsen > 1) {
      return (
        "Accepting " + adaWorsen.toFixed(0) + "% worse ADA clearance " +
        "buys " + egImprove.toFixed(0) + "% better egress score."
      );
    }
    return null;
  }

  const adaImprove  = ((worstAda.vec.ada   - bestAda.vec.ada)    / worstAda.vec.ada) * 100;
  const noiseWorsen = ((bestAda.vec.noise   - worstAda.vec.noise) / (worstAda.vec.noise || 1)) * 100;

  if (adaImprove > 1 && noiseWorsen > 1) {
    return (
      "Accepting " + noiseWorsen.toFixed(0) + "% worse noise exposure " +
      "buys " + adaImprove.toFixed(0) + "% better ADA clearance."
    );
  }
  return null;
}

// Builds a small inline SVG scatter of the archive on the ADA vs Noise plane.
// Dot opacity encodes the egress score (more opaque = better egress).
// All dots are clickable and trigger previewFrontierSolution(i).
// Baseline is shown as an open dashed circle for reference.
function _frontierSVG(archive, baseline) {
  if (archive.length === 0) return "";
  const W = 170, H = 112, PAD = 22;
  const plotW = W - 2 * PAD;
  const plotH = H - PAD - 16;

  // X = ADA violation [0,1]; left edge = 0 (good).
  // Y = Noise [0,1]; bottom edge = 0 (good) -- flipped for screen coords.
  function px(ada)   { return PAD + ada   * plotW; }
  function py(noise) { return PAD + (1 - noise) * plotH; }

  let s = '<svg class="opt-frontier-scatter" width="' + W + '" height="' + H +
          '" viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg">';

  // Axes.
  s += '<line x1="' + PAD + '" y1="' + PAD + '" x2="' + PAD + '" y2="' + (PAD + plotH) + '" stroke="#3a3f52" stroke-width="0.8"/>';
  s += '<line x1="' + PAD + '" y1="' + (PAD + plotH) + '" x2="' + (PAD + plotW) + '" y2="' + (PAD + plotH) + '" stroke="#3a3f52" stroke-width="0.8"/>';

  // Axis labels.
  s += '<text x="' + (PAD + plotW / 2) + '" y="' + (H - 2) +
       '" text-anchor="middle" font-size="7" fill="#666">ADA violation</text>';
  s += '<text x="7" y="' + (PAD + plotH / 2) +
       '" text-anchor="middle" font-size="7" fill="#666" transform="rotate(-90 7 ' + (PAD + plotH / 2) + ')">Noise</text>';

  // "better" corner hint.
  s += '<text x="' + (PAD + 2) + '" y="' + (PAD + plotH - 3) +
       '" font-size="6" fill="#3ab976" opacity="0.8">better</text>';

  // Baseline reference circle (dashed, amber).
  const bx = px(baseline.ada).toFixed(1);
  const by = py(baseline.noise).toFixed(1);
  s += '<circle cx="' + bx + '" cy="' + by +
       '" r="4" fill="none" stroke="#d08030" stroke-width="1.5" stroke-dasharray="2,2" opacity="0.8"/>';
  s += '<text x="' + (parseFloat(bx) + 5) + '" y="' + (parseFloat(by) + 3) +
       '" font-size="6" fill="#d08030" opacity="0.8">base</text>';

  // Archive dots -- clickable.
  for (let i = 0; i < archive.length; i++) {
    const m        = archive[i];
    const cx       = px(m.vec.ada).toFixed(1);
    const cy       = py(m.vec.noise).toFixed(1);
    const selected = (i === _previewIdx);
    // Egress encoded as fill opacity: lower egress score (better) = more opaque.
    const op = (0.35 + 0.65 * (1 - m.vec.egress)).toFixed(2);
    const r  = selected ? 6 : 4;
    s += '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '"' +
         ' fill="rgba(90,160,255,' + op + ')"' +
         (selected ? ' stroke="rgba(90,160,255,1)" stroke-width="1.5"' : '') +
         ' style="cursor:pointer" onclick="previewFrontierSolution(' + i + ')"/>';
    s += '<text x="' + (parseFloat(cx) + r + 1) + '" y="' + (parseFloat(cy) + 3) +
         '" font-size="6" fill="#8ab4e4" opacity="0.9">' + (i + 1) + '</text>';
  }

  s += "</svg>";
  return s;
}

function _showOptResults(baseline, archive) {
  const card = document.getElementById("optResultsCard");
  const body = document.getElementById("optResultsBody");
  if (!body) return;

  function pctStr(v) { return (v * 100).toFixed(1) + "%"; }
  function chgStr(base, opt) {
    const p = evalPctImprovement(base, opt);
    if (p === null)  return "n/a";
    if (p >  0.5)    return "-" + p.toFixed(0) + "%";
    if (p < -0.5)    return "+" + Math.abs(p).toFixed(0) + "%";
    return "0%";
  }
  function chgStyle(base, opt) {
    const p = evalPctImprovement(base, opt);
    if (p === null) return "";
    return p > 0.5 ? "color:var(--good)" : (p < -0.5 ? "color:var(--bad)" : "");
  }

  let h = '<div class="sim-disclaimer">Preliminary model estimate. Not for regulatory use. ' +
          'Noise uses a seeded MC during search for repeatability; ' +
          'display values reflect the full 500-iteration simulation.</div>';

  const sentence = _tradeOffSentence(archive);
  if (sentence) {
    h += '<div class="opt-tradeoff">' + _simEsc(sentence) + "</div>";
  }

  h += _frontierSVG(archive, baseline);
  h += '<div style="font-size:9px;color:var(--text);opacity:0.5;margin:2px 0 6px;">Dot opacity: egress (opaque = better). Click a dot or row to preview.</div>';

  // Frontier table.
  h += '<div class="sim-section opt-table">';
  h += '<div class="opt-hdr-row"><span>Sol.</span><span>ADA</span><span>Egress</span><span>Noise</span></div>';
  for (let i = 0; i < archive.length; i++) {
    const m  = archive[i];
    const sc = (i === _previewIdx) ? " opt-frontier-selected" : "";
    h += '<div class="sim-row opt-frontier-row' + sc +
         '" onclick="previewFrontierSolution(' + i + ')">';
    h += "<span>#" + (i + 1) + "</span>";
    h += '<b style="' + chgStyle(baseline.ada,    m.vec.ada)    + '">' + chgStr(baseline.ada,    m.vec.ada)    + "</b>";
    h += '<b style="' + chgStyle(baseline.egress, m.vec.egress) + '">' + chgStr(baseline.egress, m.vec.egress) + "</b>";
    h += '<b style="' + chgStyle(baseline.noise,  m.vec.noise)  + '">' + chgStr(baseline.noise,  m.vec.noise)  + "</b>";
    h += "</div>";
  }
  h += "</div>";

  h += '<div class="sim-section" style="display:flex;gap:6px;flex-wrap:wrap;">';
  h += '<button class="btn primary" id="optApplyBtn" onclick="applyOptimizerResult()">Apply Solution ' +
       (_previewIdx + 1) + "</button>";
  h += '<button class="btn ghost" id="optGhostToggleBtn" onclick="toggleOptimizerGhost()">Hide Ghost</button>';
  h += "</div>";

  body.innerHTML = h;
  if (card) card.style.display = "";
}


/* ------------------------------------------------------------------
   INITIALIZATION
   Called from wireSimulations() at the bottom of sim_ui.js.
   ------------------------------------------------------------------ */
function wireOptimizer() {
  const optBtn    = document.getElementById("simOptimizeBtn");
  const cancelBtn = document.getElementById("simOptCancelBtn");
  if (optBtn)    optBtn.addEventListener("click",    runOptimizer);
  if (cancelBtn) cancelBtn.addEventListener("click", cancelOptimizer);
  if (cancelBtn) cancelBtn.style.display = "none";
}
