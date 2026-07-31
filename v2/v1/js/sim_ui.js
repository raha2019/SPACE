"use strict";
/* ------------------------------------------------------------------
   SIMULATION UI
   Canvas overlay management, button wiring, and results rendering
   for the three simulation modules (ADA, Egress, Noise).
   ------------------------------------------------------------------ */

/* ------------------------------------------------------------------
   SIMULATION SCORE BRIDGE (inlined from sim_score_bridge.js)
   sim_score_bridge.js is the companion reference file. The code lives
   here so no <script> tag needs to be added to Rahul's index.html.
   _simResultCache is written by each sim module after a successful run.
   ------------------------------------------------------------------ */
const _simResultCache = {
  ada:    null,
  egress: null,
  fire:   null,
  noise:  null,
  fumes:  null,
};

function getSimScoreContribution() {
  let adaPenalty = 0, egressPenalty = 0, firePenalty = 0, noisePenalty = 0, fumesPenalty = 0;
  const details = {
    ada:    "No ADA check run yet.",
    egress: "No egress check run yet.",
    fire:   "No fire-safety check run yet.",
    noise:  "No noise check run yet.",
    fumes:  "No fumes check run yet.",
  };

  const ada = _simResultCache.ada;
  if (ada) {
    const failFrac = ada.corr.free > 0 ? ada.corr.fail / ada.corr.free : 0;
    adaPenalty = Math.min(15, Math.round(failFrac * 15));
    if (ada.doors.length > 0) adaPenalty = Math.min(15, adaPenalty + ada.doors.length * 2);
    if (failFrac > 0) {
      details.ada = (failFrac * 100).toFixed(1) + "% of walkable area fails corridor width check.";
    } else if (ada.doors.length > 0) {
      details.ada = ada.doors.length + " door(s) below ADA minimum width.";
    } else {
      details.ada = "No corridor or door violations detected.";
    }
  }

  const egress = _simResultCache.egress;
  if (egress) {
    let travelPenalty = 0;
    if (egress.maxTravel > 100) {
      travelPenalty = Math.min(10, Math.round((egress.maxTravel - 100) / 100 * 10));
    }
    const shortfall = Math.max(0, egress.occupants - egress.exitCap.capacity);
    const capacityPenalty = shortfall > 0 ? Math.min(5, Math.ceil(shortfall / 10)) : 0;
    egressPenalty = Math.min(15, travelPenalty + capacityPenalty);
    const parts = [];
    if (egress.maxTravel > 100) parts.push("max travel " + egress.maxTravel.toFixed(0) + " ft (limit 200 ft)");
    if (shortfall > 0) parts.push("exit capacity short by " + shortfall + " persons");
    details.egress = parts.length > 0 ? parts.join("; ") + "." : "Travel distance and exit capacity acceptable.";
  }

  const fire = _simResultCache.fire;
  if (fire) {
    if (fire.count === 0) {
      firePenalty = 5;
      details.fire = "No fire extinguishers placed — every tool is at risk.";
    } else if (fire.beyond > 0 && fire.tools > 0) {
      firePenalty = Math.min(5, Math.ceil((fire.beyond / fire.tools) * 5));
      const w = fire.worst && Number.isFinite(fire.worst.d) ? ` (farthest: ${fire.worst.label} ~${fire.worst.d.toFixed(0)} ${fire.unit})` : "";
      details.fire = `${fire.beyond} of ${fire.tools} tools are a long walk from an extinguisher${w}.`;
    } else {
      details.fire = "All tools have quick walking access to an extinguisher.";
    }
  }

  const noise = _simResultCache.noise;
  if (noise && noise.totalCells > 0) {
    const actionFrac = noise.actionCells / noise.totalCells;
    const pelFrac    = noise.pelCells    / noise.totalCells;
    noisePenalty = Math.min(10, Math.round(actionFrac * 5 + pelFrac * 10));
    details.noise = (actionFrac * 100).toFixed(1) + "% of space above action level; " +
                    (pelFrac * 100).toFixed(1) + "% above PEL.";
  }

  const fumes = _simResultCache.fumes;
  if (fumes) {
    if (fumes.sources === 0) {
      details.fumes = "No fume / odor sources.";
    } else if (fumes.uncovered > 0) {
      fumesPenalty = Math.min(8, Math.ceil((fumes.uncovered / fumes.sources) * 8));
      details.fumes = `${fumes.uncovered} of ${fumes.sources} fume source(s) lack hood capture` +
        (fumes.worst ? ` (worst: ${fumes.worst.label})` : "") + ".";
    } else {
      details.fumes = "All fume sources have hood capture nearby.";
    }
  }

  return {
    adaPenalty,
    egressPenalty,
    firePenalty,
    noisePenalty,
    fumesPenalty,
    totalPenalty: adaPenalty + egressPenalty + firePenalty + noisePenalty + fumesPenalty,
    details,
  };
}

const SIM_CANVAS_IDS   = { ada: "simCanvasAda", egress: "simCanvasEgress", fire: "simCanvasFire", noise: "simCanvasNoise", fumes: "simCanvasFumes" };
const SIM_CANVAS_ZINDEX = { ada: 10, egress: 11, fire: 13, noise: 12, fumes: 14 };
const SIM_RESULTS_ID = "simResults";
const SIM_CARD_ID    = "simResultsCard";

// Tracks which simulation is currently displayed so the button
// highlight and clear behavior stay consistent.
let _simActive = null;

// Run All accumulator. When _runAllActive is true, _simShowCard and
// simShowError append into _runAllAccum instead of replacing the panel.
// The caller sets both flags, runs all three sims, then commits the result.
let _runAllActive = false;
let _runAllAccum  = "";

// Returns the named canvas overlay ('ada', 'egress', or 'noise'), creating
// it inside #stage if needed. Each canvas is hidden by default; button
// handlers call _simShowOnlyCanvas or _simShowAllCanvases to control visibility.
function simGetCanvas(name) {
  const id = SIM_CANVAS_IDS[name];
  if (!id) return null;
  let canvas = document.getElementById(id);
  if (!canvas) {
    canvas = document.createElement("canvas");
    canvas.id = id;
    canvas.style.cssText =
      "position:absolute;top:0;left:0;width:100%;height:100%;" +
      "pointer-events:none;z-index:" + SIM_CANVAS_ZINDEX[name] + ";display:none;";
    const stage = document.getElementById("stage");
    if (stage) stage.appendChild(canvas);
  }
  return canvas;
}

function _simShowOnlyCanvas(name) {
  for (const k of Object.keys(SIM_CANVAS_IDS)) {
    const c = document.getElementById(SIM_CANVAS_IDS[k]);
    if (c) c.style.display = k === name ? "" : "none";
  }
}

function _simShowAllCanvases() {
  for (const id of Object.values(SIM_CANVAS_IDS)) {
    const c = document.getElementById(id);
    if (c) c.style.display = "";
  }
}

function _simHideAllCanvases() {
  for (const id of Object.values(SIM_CANVAS_IDS)) {
    const c = document.getElementById(id);
    if (c) c.style.display = "none";
  }
}

function simShowError(msg) {
  const card = document.getElementById(SIM_CARD_ID);
  const body = document.getElementById(SIM_RESULTS_ID);
  if (!body) return;
  const html = '<div class="sim-error">' + _simEsc(msg) + '</div>';
  if (_runAllActive) {
    if (_runAllAccum) _runAllAccum += '<hr style="border:none;border-top:1px solid var(--line);margin:8px 0">';
    _runAllAccum += html;
    return;
  }
  body.innerHTML = html;
  if (card) card.style.display = "";
}

function _simEsc(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function _simHeader(title, status) {
  // status: "pass" | "warn" | "fail"
  const cls = { pass: "sim-pass", warn: "sim-warn", fail: "sim-fail" }[status] || "";
  return (
    '<div class="sim-header">' +
      '<span class="sim-title">' + _simEsc(title) + '</span>' +
      '<span class="sim-badge ' + cls + '">' + status.toUpperCase() + '</span>' +
    '</div>' +
    '<div class="sim-disclaimer">Preliminary model estimate. Not for regulatory use.</div>'
  );
}

function _simShowCard(html) {
  const body = document.getElementById(SIM_RESULTS_ID);
  const card = document.getElementById(SIM_CARD_ID);
  if (!body) return;
  if (_runAllActive) {
    if (_runAllAccum) _runAllAccum += '<hr style="border:none;border-top:1px solid var(--line);margin:8px 0">';
    _runAllAccum += html;
    return; // deferred — caller commits to DOM after all three sims finish
  }
  body.innerHTML = html;
  if (card) card.style.display = "";
}

function simShowAdaResults(r) {
  const failPct = (r.corr.fail     / Math.max(1, r.corr.free) * 100).toFixed(1);
  const margPct = (r.corr.marginal / Math.max(1, r.corr.free) * 100).toFixed(1);
  const status  = (r.doors.length > 0 || r.corr.fail > 0) ? "fail"
    : (r.corr.marginal > 0 ? "warn" : "pass");

  let h = _simHeader("ADA Compliance Check", status);
  h += '<div class="sim-section">';
  h += _simRow(
    "Corridor width violations",
    failPct + "% of walkable area",
    r.corr.fail > 0 ? "bad" : "good"
  );
  h += _simRow(
    "Marginal width (meets min, below preferred)",
    margPct + "% of walkable area",
    r.corr.marginal > 0 ? "warn" : "good"
  );
  h += '</div>';

  if (r.doors.length > 0) {
    h += '<div class="sim-section"><b>Door width issues:</b><ul class="sim-list">';
    for (const d of r.doors) {
      h += '<li>' + _simEsc(d.label) + ': ' + d.actualIn + '" found, ' + d.requiredIn + '" required</li>';
    }
    h += '</ul></div>';
  }

  h += '<div class="sim-legend">' +
    '<span class="sim-swatch" style="background:rgba(55,185,95,0.55)"></span>OK ' +
    '<span class="sim-swatch" style="background:rgba(230,165,45,0.65)"></span>Marginal ' +
    '<span class="sim-swatch" style="background:rgba(220,55,55,0.65)"></span>Violation' +
    '</div>';

  _simShowCard(h);
}

function simShowEgressResults(r) {
  const travelOk   = r.maxTravel <= NFPA_MAX_TRAVEL_DISTANCE_FT;
  const capacityOk = r.exitCap.capacity >= r.occupants;
  const deadEndOk  = r.deadEnd <= NFPA_MAX_DEAD_END_FT;
  const status = (!travelOk || !capacityOk || !deadEndOk) ? "fail"
    : (r.maxTravel > NFPA_MAX_TRAVEL_DISTANCE_FT * 0.75 ? "warn" : "pass");

  let h = _simHeader("Egress Analysis", status);
  h += '<div class="sim-section">';
  h += _simRow("Occupant load estimate",  r.occupants + " persons", "");
  h += _simRow(
    "Exit capacity",
    r.exitCap.capacity + " persons (" + r.exitCap.exitCount + " exit" + (r.exitCap.exitCount !== 1 ? "s" : "") + ")",
    capacityOk ? "good" : "bad"
  );
  h += _simRow(
    "Max travel distance",
    r.maxTravel.toFixed(0) + " ft (limit: " + NFPA_MAX_TRAVEL_DISTANCE_FT + " ft)",
    travelOk ? "good" : "bad"
  );
  h += _simRow(
    "Max dead-end length",
    r.deadEnd.toFixed(0) + " ft (limit: " + NFPA_MAX_DEAD_END_FT + " ft)",
    deadEndOk ? "good" : "bad"
  );
  h += '</div>';

  h += '<div class="sim-legend">' +
    '<span class="sim-swatch" style="background:rgba(50,140,240,0.7)"></span>Exit ' +
    '<span class="sim-swatch" style="background:rgba(55,185,55,0.55)"></span>Near ' +
    '<span class="sim-swatch" style="background:rgba(230,140,40,0.65)"></span>Mid ' +
    '<span class="sim-swatch" style="background:rgba(220,50,50,0.65)"></span>Far/Fail' +
    '</div>';

  _simShowCard(h);
}

function simShowNoiseResults(r) {
  const actionPct = (r.actionCells / Math.max(1, r.totalCells) * 100).toFixed(1);
  const pelPct    = (r.pelCells    / Math.max(1, r.totalCells) * 100).toFixed(1);
  const status    = r.pelCells > 0 ? "fail" : (r.actionCells > 0 ? "warn" : "pass");

  let h = _simHeader("Noise Simulation (" + NOISE_MC_ITERATIONS + " iterations)", status);
  h += '<div class="sim-section">';
  h += _simRow("Active noise sources", r.sources + "", "");
  h += _simRow(
    "Peak estimated level",
    r.maxDb.toFixed(1) + " dBA",
    r.maxDb >= OSHA_PEL_DBA ? "bad" : r.maxDb >= OSHA_ACTION_LEVEL_DBA ? "warn" : "good"
  );
  h += _simRow("Space mean level", r.meanDb.toFixed(1) + " dBA", "");
  h += _simRow(
    "Area above action level (" + OSHA_ACTION_LEVEL_DBA + " dBA)",
    actionPct + "% of space",
    r.actionCells > 0 ? "warn" : "good"
  );
  h += _simRow(
    "Area above PEL (" + OSHA_PEL_DBA + " dBA)",
    pelPct + "% of space",
    r.pelCells > 0 ? "bad" : "good"
  );
  h += '</div>';

  h += '<div class="sim-legend">' +
    '<span class="sim-swatch" style="background:rgba(55,185,95,0.45)"></span>&lt;70 dBA ' +
    '<span class="sim-swatch" style="background:rgba(230,210,50,0.55)"></span>70-85 dBA ' +
    '<span class="sim-swatch" style="background:rgba(230,140,40,0.65)"></span>85-90 dBA ' +
    '<span class="sim-swatch" style="background:rgba(220,45,45,0.7)"></span>&gt;90 dBA' +
    '</div>';

  _simShowCard(h);
}

function _simRow(label, value, colorKey) {
  const style = colorKey ? ' style="color:var(--' + colorKey + ')"' : '';
  return (
    '<div class="sim-row">' +
      '<span>' + _simEsc(label) + '</span>' +
      '<b' + style + '>' + _simEsc(value) + '</b>' +
    '</div>'
  );
}

function _simSetActive(name) {
  _simActive = name;
  ["ada", "egress", "fire", "noise"].forEach(k => {
    const btn = document.getElementById("sim" + k.charAt(0).toUpperCase() + k.slice(1) + "Btn");
    if (btn) btn.classList.toggle("sim-active", k === name);
  });
  const clearBtn = document.getElementById("simClearBtn");
  if (clearBtn) clearBtn.disabled = !name;
}

/* ------------------------------------------------------------------
   PENALTY CARD — shows advisory sim penalty breakdown below the
   Simulation Results card. Created dynamically so index.html stays
   unchanged. Updated after every sim run.
   ------------------------------------------------------------------ */
const SIM_PENALTY_CARD_ID = "simPenaltyCard";
const SIM_PENALTY_BODY_ID = "simPenaltyBody";

function _penaltyColor(v, warnAt, badAt) {
  if (v >= badAt)  return "var(--bad)";
  if (v >= warnAt) return "var(--warn)";
  return "var(--good)";
}

function _simPenRow(label, penalty, warnAt, badAt) {
  const color = _penaltyColor(penalty, warnAt, badAt);
  return (
    '<div class="sim-row">' +
      '<span>' + _simEsc(label) + '</span>' +
      '<b style="color:' + color + '">-' + penalty + ' pts</b>' +
    '</div>'
  );
}

function _updatePenaltyCard() {
  const card = document.getElementById(SIM_PENALTY_CARD_ID);
  const body = document.getElementById(SIM_PENALTY_BODY_ID);
  if (!card || !body) return;

  const hasAny = _simResultCache.ada || _simResultCache.egress || _simResultCache.fire || _simResultCache.noise || _simResultCache.fumes;
  if (!hasAny) { card.style.display = "none"; return; }

  const c = getSimScoreContribution();
  card.style.display = "";
  body.innerHTML =
    '<div class="sim-section">' +
      _simPenRow("ADA corridor penalty",      c.adaPenalty,     5, 10) +
      _simPenRow("Egress penalty",            c.egressPenalty,  5, 10) +
      _simPenRow("Fire safety penalty",       c.firePenalty,    3,  5) +
      _simPenRow("Noise exposure penalty",    c.noisePenalty,   3,  7) +
      _simPenRow("Fume exposure penalty",     c.fumesPenalty,   3,  6) +
      '<div class="sim-row" style="border-top:1px solid var(--line);margin-top:4px;padding-top:4px">' +
        "<span><b>Total advisory penalty</b></span>" +
        "<b>-" + c.totalPenalty + " pts (max -53)</b>" +
      "</div>" +
    "</div>" +
    '<div class="sim-section" style="font-size:11px;color:var(--text-mute);line-height:1.6">' +
      "<div>ADA: "    + _simEsc(c.details.ada)    + "</div>" +
      "<div>Egress: " + _simEsc(c.details.egress) + "</div>" +
      "<div>Fire: "   + _simEsc(c.details.fire)   + "</div>" +
      "<div>Noise: "  + _simEsc(c.details.noise)  + "</div>" +
      "<div>Fumes: "  + _simEsc(c.details.fumes)  + "</div>" +
    "</div>" +
    '<div class="sim-disclaimer">Advisory only. Does not modify the main risk score above.</div>';
}

/* Adjust the grid resolution of every sim from the Analysis modal.
   Accepts either a named preset ("coarse" | "medium" | "fine") or a
   numeric multiplier — small = finer/slower, large = coarser/faster. */
function setSimResolution(modeOrFactor){
  let factor;
  if(typeof modeOrFactor === "number" && isFinite(modeOrFactor) && modeOrFactor > 0){
    factor = modeOrFactor;
  } else {
    factor = modeOrFactor === "coarse" ? 2
           : modeOrFactor === "fine"   ? 0.5
           : 1;
  }
  ADA_GRID_RES_FT    = Math.max(0.05, 0.5 * factor);
  EGRESS_GRID_RES_FT = Math.max(0.10, 1.0 * factor);
  if (typeof FIRE_GRID_RES_FT !== "undefined") FIRE_GRID_RES_FT = Math.max(0.10, 1.0 * factor);
  NOISE_GRID_RES_FT  = Math.max(0.25, 2.0 * factor);
}

/* In v1 the three sims are invoked from the Analysis modal cards (not
   from toolbar buttons). The helpers below are what those cards call.
   wireSimulations() just makes sure the canvas overlays exist in the
   DOM ahead of the first render so styles attach cleanly. */
function wireSimulations() {
  simGetCanvas("ada");
  simGetCanvas("egress");
  simGetCanvas("fire");
  simGetCanvas("noise");
  simGetCanvas("fumes");
  // Pick up any persisted resolution choice (loaded by loadAppState).
  if(state){
    if(Number.isFinite(state.simResolutionFactor) && state.simResolutionFactor > 0){
      setSimResolution(state.simResolutionFactor);
    } else if(state.simResolution){
      setSimResolution(state.simResolution);
    }
  }

  // Wire MOSA button (Task 3).
  const mosaBtnEl = document.getElementById('simMosaBtn');
  if (mosaBtnEl) mosaBtnEl.addEventListener('click', _runMosa);

  // Delegate Apply / Restore clicks from the MOSA results table (Task 4).
  // Added once here so it survives innerHTML replacements in the results card.
  const simResBody = document.getElementById(SIM_RESULTS_ID);
  if (simResBody) simResBody.addEventListener('click', _mosaResultClick);
}

function runSingleSim(name) {
  _simSetActive(name);
  _simShowOnlyCanvas(name);
  if (name === "ada")    runAdaCheck();
  else if (name === "egress") runEgressCheck();
  else if (name === "fire")   runFireCheck();
  else if (name === "noise")  runNoiseCheck();
  else if (name === "fumes")  runFumesCheck();
  _updatePenaltyCard();
}

function runAllSims() {
  _simSetActive(null);
  // Accumulate all three sims' HTML, then commit in one shot.
  _runAllActive = true;
  _runAllAccum  = "";
  runAdaCheck();
  runEgressCheck();
  runFireCheck();
  runNoiseCheck();
  runFumesCheck();
  _runAllActive = false;
  const body = document.getElementById(SIM_RESULTS_ID);
  const card = document.getElementById(SIM_CARD_ID);
  if (body) body.innerHTML = _runAllAccum;
  if (card) card.style.display = "";
  _simShowAllCanvases();
  _updatePenaltyCard();
}

function clearSimOverlays() {
  _simHideAllCanvases();
  _simSetActive(null);
  const card = document.getElementById(SIM_CARD_ID);
  if (card) card.style.display = "none";
  const penCard = document.getElementById(SIM_PENALTY_CARD_ID);
  if (penCard) penCard.style.display = "none";
}

/* Live mode hook — called from the end of render() with debouncing so
   drags don't fire one analysis per pointermove. When the user toggles
   "Live mode" in the Analysis modal, this re-runs the last analysis
   ~250ms after the layout stops changing. */
let _simLiveTimer = null;
function triggerLiveSim() {
  if (!state || !state.analysisLive || !state.analysisLastSim) return;
  if (_simLiveTimer) clearTimeout(_simLiveTimer);
  _simLiveTimer = setTimeout(() => {
    const which = state.analysisLastSim;
    if      (which === "all")    runAllSims();
    else if (which === "ada" || which === "egress" || which === "fire" || which === "noise" || which === "fumes") runSingleSim(which);
  }, 250);
}

/* ------------------------------------------------------------------
   MOSA (Multi-Objective Simulated Annealing) — Tasks 3 and 4.
   Requires sim_eval.js and sim_mosa.js loaded before sim_ui.js.
   ------------------------------------------------------------------ */

// Module-level state shared between _runMosa, _renderMosaFront, _mosaResultClick.
let _mosaCurrentFront = null;  // last Pareto front (array of {pos, vec})
let _mosaCurrentSnap  = null;  // zone snapshot taken just before the run

/* Task 3: button handler — show indicator, defer 50 ms, run SA, render. */
function _runMosa() {
  if (typeof mosaOptimize !== 'function') {
    simShowError('MOSA optimizer not loaded. Check that sim_eval.js and sim_mosa.js are included in index.html.');
    return;
  }
  const du = (typeof stageDimsUnits === 'function') ? stageDimsUnits() : null;
  if (!du || !(du.w > 0) || !(du.h > 0)) {
    simShowError('MOSA needs a calibrated floor-plan scale. Import a project first.');
    return;
  }

  // Busy indicator — button label + message in results card.
  const btn = document.getElementById('simMosaBtn');
  const origLabel = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Running MOSA…'; }
  const resBody = document.getElementById(SIM_RESULTS_ID);
  const resCard = document.getElementById(SIM_CARD_ID);
  if (resBody) resBody.innerHTML =
    '<div class="sim-row" style="color:var(--text-dim)">Running MOSA optimizer—please wait…</div>';
  if (resCard) resCard.style.display = '';

  // 50 ms deferral so the indicator paints before the synchronous SA loop.
  setTimeout(function () {
    // Capture pre-run zone positions (mosaOptimize restores them internally,
    // so this snapshot equals post-run state — it is what "Restore original" returns to).
    const snap = {};
    for (const id in state.zones) {
      const z = state.zones[id];
      snap[id] = { x: z.x, y: z.y, rotation: z.rotation || 0 };
    }

    let result;
    try {
      // Call with no movableIds so mosaOptimize uses _scTools() (current selection).
      // Pass opts.seed only if state.mosaSeed is explicitly set (default: unseeded).
      const opts = {};
      if (state && state.mosaSeed !== undefined) opts.seed = state.mosaSeed;
      result = mosaOptimize(opts);
    } catch (err) {
      if (resBody) resBody.innerHTML =
        '<div class="sim-error">MOSA error: ' + _simEsc(String(err.message || err)) + '</div>';
      if (btn) { btn.disabled = false; btn.textContent = origLabel; }
      return;
    }

    if (btn) { btn.disabled = false; btn.textContent = origLabel; }

    if (!result || !result.front || result.front.length === 0) {
      const why = (result && result.stats && result.stats.error) ? ' (' + result.stats.error + ')' : '';
      if (resBody) resBody.innerHTML =
        '<div class="sim-error">MOSA: no feasible Pareto solutions found' + why +
        '. Ensure at least 2 unlocked, included tools are on the stage with a calibrated scale.</div>';
      return;
    }

    _renderMosaFront(result, snap);
  }, 50);
}

/* Task 4: render the Pareto front table into the simulation results card. */
function _renderMosaFront(result, snap) {
  _mosaCurrentFront = result.front;
  _mosaCurrentSnap  = snap;

  const front   = result.front;
  const seedVec = result.seedVec;
  const stats   = result.stats;

  // Knee point: min-max normalize across front, then find closest to ideal (all-zero).
  function _mm(key) {
    let lo = Infinity, hi = -Infinity;
    for (const p of front) {
      if (p.vec[key] < lo) lo = p.vec[key];
      if (p.vec[key] > hi) hi = p.vec[key];
    }
    return { lo, hi };
  }
  const rA = _mm('ada'), rE = _mm('egress'), rN = _mm('noise');
  const nrm = (v, r) => r.hi > r.lo ? (v - r.lo) / (r.hi - r.lo) : 0;
  let kneeIdx = 0, kd = Infinity;
  for (let i = 0; i < front.length; i++) {
    const d = Math.hypot(
      nrm(front[i].vec.ada,    rA),
      nrm(front[i].vec.egress, rE),
      nrm(front[i].vec.noise,  rN)
    );
    if (d < kd) { kd = d; kneeIdx = i; }
  }

  const f2 = v => (v * 100).toFixed(2) + '%';

  let h = '<div class="sim-header">' +
    '<span class="sim-title">MOSA Pareto Front</span>' +
    '<span class="sim-badge sim-pass">' + front.length + ' solutions</span>' +
    '</div>' +
    '<div class="sim-disclaimer">Preliminary model estimate. Not for regulatory use.</div>';

  // Diagnostics line.
  h += '<div class="sim-section" style="font-size:10.5px;color:var(--text-dim)">' +
    stats.iters + ' iters \xb7 ' + stats.accepted + ' accepted \xb7 ' +
    stats.archived + ' archived \xb7 T<sub>f</sub>=' + stats.finalT.toExponential(2) +
    '</div>';

  // Baseline row.
  h += '<div class="sim-section">';
  h += '<div style="font-size:11px;font-weight:600;margin-bottom:4px">Baseline (current layout)</div>';
  h += '<table style="width:100%;font-size:11px;border-collapse:collapse">';
  h += '<tr><td style="color:var(--text-dim);padding:2px 0">ADA</td>' +
    '<td style="text-align:right;padding:2px 0">' + f2(seedVec.ada) + '</td></tr>';
  h += '<tr><td style="color:var(--text-dim);padding:2px 0">Egress</td>' +
    '<td style="text-align:right;padding:2px 0">' + f2(seedVec.egress) + '</td></tr>';
  h += '<tr><td style="color:var(--text-dim);padding:2px 0">Noise</td>' +
    '<td style="text-align:right;padding:2px 0">' + f2(seedVec.noise) + '</td></tr>';
  h += '</table></div>';

  // Pareto front table with Apply buttons and single Restore button.
  h += '<div class="sim-section">';
  h += '<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">';
  h += '<span style="font-size:11px;font-weight:600;flex:1">Pareto front (' + front.length + ')</span>';
  h += '<button class="btn ghost" id="mosRestoreBtn" ' +
    'style="font-size:10.5px;padding:2px 8px">↩ Restore original</button>';
  h += '</div>';

  h += '<table style="width:100%;font-size:11px;border-collapse:collapse">';
  h += '<thead><tr style="border-bottom:1px solid var(--line);color:var(--text-dim)">' +
    '<th style="text-align:left;padding:2px 4px;font-weight:500">#</th>' +
    '<th style="text-align:right;padding:2px 4px;font-weight:500">ADA</th>' +
    '<th style="text-align:right;padding:2px 4px;font-weight:500">Egress</th>' +
    '<th style="text-align:right;padding:2px 4px;font-weight:500">Noise</th>' +
    '<th style="padding:2px 4px"></th>' +
    '</tr></thead><tbody>';

  for (let i = 0; i < front.length; i++) {
    const pt     = front[i];
    const isKnee = (i === kneeIdx);
    const bg     = isKnee ? 'background:rgba(90,169,255,.08);' : '';
    const lb     = isKnee ? 'border-left:2px solid rgba(90,169,255,.6);'
                           : 'border-left:2px solid transparent;';
    h += '<tr style="' + bg + lb + '">';
    h += '<td style="padding:3px 4px;color:var(--text-dim)">' +
      (isKnee ? '★ ' : '') + (i + 1) + '</td>';
    h += '<td style="text-align:right;padding:3px 4px">' + f2(pt.vec.ada)    + '</td>';
    h += '<td style="text-align:right;padding:3px 4px">' + f2(pt.vec.egress) + '</td>';
    h += '<td style="text-align:right;padding:3px 4px">' + f2(pt.vec.noise)  + '</td>';
    h += '<td style="padding:3px 4px">' +
      '<button class="btn ghost" data-mosa-idx="' + i + '" ' +
      'style="font-size:10px;padding:2px 6px">Apply</button></td>';
    h += '</tr>';
  }

  h += '</tbody></table>';
  h += '<div style="font-size:10px;color:var(--text-dim);margin-top:4px">' +
    '★ = knee point (closest to ideal after min-max normalization)</div>';
  h += '</div>';

  const resBody = document.getElementById(SIM_RESULTS_ID);
  const resCard = document.getElementById(SIM_CARD_ID);
  if (resBody) resBody.innerHTML = h;
  if (resCard) resCard.style.display = '';
}

/* Task 4: delegated click handler wired once in wireSimulations().
   Handles Apply (data-mosa-idx) and Restore (#mosRestoreBtn) clicks
   even after resBody.innerHTML is replaced between runs. */
function _mosaResultClick(e) {
  // Apply a specific Pareto front member to state.zones.
  const applyBtn = e.target.closest && e.target.closest('[data-mosa-idx]');
  if (applyBtn && _mosaCurrentFront) {
    const idx = parseInt(applyBtn.dataset.mosaIdx, 10);
    const pt  = _mosaCurrentFront[idx];
    if (!pt || !pt.pos) return;
    for (const id in pt.pos) {
      if (state.zones[id]) {
        state.zones[id].x        = pt.pos[id].x;
        state.zones[id].y        = pt.pos[id].y;
        state.zones[id].rotation = pt.pos[id].rotation;
      }
    }
    if (typeof evaluate === 'function') evaluate();
    if (typeof render   === 'function') render();
    return;
  }
  // Restore: write the pre-run snapshot back to state.zones.
  if (e.target.id === 'mosRestoreBtn' && _mosaCurrentSnap) {
    for (const id in _mosaCurrentSnap) {
      if (state.zones[id]) {
        state.zones[id].x        = _mosaCurrentSnap[id].x;
        state.zones[id].y        = _mosaCurrentSnap[id].y;
        state.zones[id].rotation = _mosaCurrentSnap[id].rotation;
      }
    }
    if (typeof evaluate === 'function') evaluate();
    if (typeof render   === 'function') render();
    return;
  }
}
