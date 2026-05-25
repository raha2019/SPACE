"use strict";
/* ------------------------------------------------------------------
   SIMULATION UI
   Canvas overlay management, button wiring, and results rendering
   for the three simulation modules (ADA, Egress, Noise).
   ------------------------------------------------------------------ */

const SIM_CANVAS_ID  = "simCanvas";
const SIM_RESULTS_ID = "simResults";
const SIM_CARD_ID    = "simResultsCard";

// Tracks which simulation is currently displayed so the button
// highlight and clear behavior stay consistent.
let _simActive = null;

// Returns the shared canvas overlay, creating it inside #stage if needed.
// The canvas sits above zone divs (z-index 10) but receives no pointer events.
function simGetCanvas() {
  let canvas = document.getElementById(SIM_CANVAS_ID);
  if (!canvas) {
    canvas = document.createElement("canvas");
    canvas.id = SIM_CANVAS_ID;
    canvas.style.cssText =
      "position:absolute;top:0;left:0;width:100%;height:100%;" +
      "pointer-events:none;z-index:10;";
    const stage = document.getElementById("stage");
    if (stage) stage.appendChild(canvas);
  }
  return canvas;
}

function simClearCanvas() {
  const canvas = document.getElementById(SIM_CANVAS_ID);
  if (!canvas) return;
  canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
}

function simShowError(msg) {
  const card = document.getElementById(SIM_CARD_ID);
  const body = document.getElementById(SIM_RESULTS_ID);
  if (!body) return;
  body.innerHTML = '<div class="sim-error">' + _simEsc(msg) + '</div>';
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

  let h = _simHeader("Egress / Fire Analysis", status);
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
  ["ada", "egress", "noise"].forEach(k => {
    const btn = document.getElementById("sim" + k.charAt(0).toUpperCase() + k.slice(1) + "Btn");
    if (btn) btn.classList.toggle("sim-active", k === name);
  });
  const clearBtn = document.getElementById("simClearBtn");
  if (clearBtn) clearBtn.disabled = !name;
}

function wireSimulations() {
  simGetCanvas(); // ensure canvas exists in DOM before first render

  const adaBtn    = document.getElementById("simAdaBtn");
  const egressBtn = document.getElementById("simEgressBtn");
  const noiseBtn  = document.getElementById("simNoiseBtn");
  const clearBtn  = document.getElementById("simClearBtn");

  if (adaBtn) {
    adaBtn.addEventListener("click", () => {
      _simSetActive("ada");
      runAdaCheck();
    });
  }
  if (egressBtn) {
    egressBtn.addEventListener("click", () => {
      _simSetActive("egress");
      runEgressCheck();
    });
  }
  if (noiseBtn) {
    noiseBtn.addEventListener("click", () => {
      _simSetActive("noise");
      runNoiseCheck();
    });
  }
  if (clearBtn) {
    clearBtn.disabled = true;
    clearBtn.addEventListener("click", () => {
      simClearCanvas();
      _simSetActive(null);
      const card = document.getElementById(SIM_CARD_ID);
      if (card) card.style.display = "none";
    });
  }
}
