"use strict";
/* ------------------------------------------------------------------
   SIMULATION: Fire Safety — radius heatmap (simple, bounded).
   Preliminary model estimate. Not for regulatory use.

   • Each tool projects a HAZARD radius scaled by its flammability (0–4).
   • Each fire extinguisher projects a COVERAGE radius (its `coverage`).
   • Cell risk = hazard, reduced where an extinguisher covers it.
   The grid is hard-capped so the sim can never freeze the app.
   ------------------------------------------------------------------ */

let FIRE_GRID_RES_FT = 1.5;            // nominal resolution (feet)
const FIRE_MAX_CELLS = 140;            // hard cap per axis (prevents runaway grids)
const FIRE_HAZARD_BASE_FT = 6;         // base hazard radius
const FIRE_HAZARD_PER_FLAM_FT = 6;     // extra radius per flammability point
const FIRE_DEFAULT_COVERAGE_FT = 25;   // extinguisher reach if unset

function _fireSources(stageW, stageH){
  const hazards = [], exts = [];
  for(const d of allZoneDefs()){
    const z = state.zones[d.id];
    if(!z || z.included === false) continue;
    if(d.elementClass === "amenity"){
      const isExt = d.subtype === "fire_extinguisher" || /fire\s*extinguisher/i.test(d.label||"");
      if(!isExt) continue;
      exts.push({
        cx:(z.x+z.w/2)/100*stageW, cy:(z.y+z.h/2)/100*stageH,
        r: (Number.isFinite(d.coverage) && d.coverage > 0 ? d.coverage : FIRE_DEFAULT_COVERAGE_FT),
        id:d.id, label:d.label,
      });
      continue;
    }
    if(d.elementClass === "structural") continue;     // walls/floors/doors aren't hazards
    const flam = (d.variableAttrs && Number.isFinite(d.variableAttrs.flammability)) ? d.variableAttrs.flammability : 0;
    if(flam <= 0) continue;
    hazards.push({
      cx:(z.x+z.w/2)/100*stageW, cy:(z.y+z.h/2)/100*stageH,
      r: FIRE_HAZARD_BASE_FT + flam * FIRE_HAZARD_PER_FLAM_FT,
      risk: clamp(flam/4, 0, 1), id:d.id, label:d.label,
    });
  }
  return { hazards, exts };
}

function _fireCovered(h, exts){
  // Fraction [0..1] of an extinguisher's coverage at the hazard center.
  let best = 0;
  for(const e of exts){
    const d = Math.hypot(h.cx - e.cx, h.cy - e.cy);
    if(d < e.r) best = Math.max(best, 1 - d / e.r);
  }
  return best;
}

function runFireCheck(){
  const du = stageDimsUnits();
  if(!du){ simShowError("Fire safety analysis requires a calibrated scale. Import a floor plan and set scale first."); return; }
  const stageW = du.w, stageH = du.h;

  let cols = Math.min(FIRE_MAX_CELLS, Math.max(1, Math.ceil(stageW / FIRE_GRID_RES_FT)));
  let rows = Math.min(FIRE_MAX_CELLS, Math.max(1, Math.ceil(stageH / FIRE_GRID_RES_FT)));
  const resX = stageW / cols, resY = stageH / rows;

  const { hazards, exts } = _fireSources(stageW, stageH);

  const canvas = simGetCanvas("fire");
  const stage  = document.getElementById("stage");
  const cw = stage.offsetWidth, ch = stage.offsetHeight;
  canvas.width = cw; canvas.height = ch;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, cw, ch);

  const scoped = (typeof roomScopeActive === "function") && roomScopeActive();
  const cellW = cw / cols, cellH = ch / rows;
  for(let r = 0; r < rows; r++){
    for(let c = 0; c < cols; c++){
      const xf = (c + 0.5) * resX, yf = (r + 0.5) * resY;
      if(scoped && !pointInAnalysisScope(xf/stageW*100, yf/stageH*100)) continue;
      // hazard at this cell (max over tools), reduced by extinguisher coverage
      let hz = 0;
      for(const h of hazards){
        const d = Math.hypot(xf - h.cx, yf - h.cy);
        if(d < h.r) hz = Math.max(hz, h.risk * (1 - d / h.r));
      }
      if(hz <= 0.02) continue;
      let cov = 0;
      for(const e of exts){
        const d = Math.hypot(xf - e.cx, yf - e.cy);
        if(d < e.r) cov = Math.max(cov, 1 - d / e.r);
      }
      const risk = clamp(hz * (1 - 0.75 * cov), 0, 1);   // coverage mitigates up to 75%
      if(risk < 0.03) continue;
      const hue = (1 - risk) * 120;                       // green → red
      ctx.fillStyle = `hsla(${hue},85%,50%,${(0.2 + risk*0.45).toFixed(2)})`;
      ctx.fillRect(Math.round(c*cellW), Math.round(r*cellH), Math.ceil(cellW)+1, Math.ceil(cellH)+1);
    }
  }

  // Per-hazard coverage summary.
  let uncovered = 0, worst = null;
  for(const h of hazards){
    const cov = _fireCovered(h, exts);
    if(cov <= 0) uncovered++;
    const exposure = h.risk * (1 - cov);
    if(!worst || exposure > worst.exposure) worst = { label:h.label, exposure, covered:cov > 0 };
  }

  const result = {
    count: exts.length,
    tools: hazards.length,
    beyond: uncovered,           // flammable tools with no extinguisher coverage
    worst: worst ? { label: worst.label, d: null, covered: worst.covered } : null,
    unit: (state.scale && state.scale.unit) || "ft",
  };
  simShowFireResults(result);
  if(typeof _simResultCache !== "undefined") _simResultCache.fire = result;
}

function simShowFireResults(r){
  const status = r.tools === 0 ? "pass" : (r.count === 0 ? "fail" : (r.beyond > 0 ? "warn" : "pass"));
  let h = _simHeader("Fire Safety — hazard vs. extinguisher coverage", status);
  h += '<div class="sim-section">';
  h += _simRow("Fire extinguishers", r.count + " unit" + (r.count !== 1 ? "s" : ""), r.count > 0 ? "good" : "bad");
  h += _simRow("Flammable tools", String(r.tools), r.tools > 0 ? "warn" : "good");
  if(r.tools > 0){
    h += _simRow("Tools without coverage", String(r.beyond),
                 r.count === 0 ? "bad" : (r.beyond > 0 ? "warn" : "good"));
    if(r.worst) h += _simRow("Highest exposure", r.worst.label + (r.worst.covered ? " (covered)" : " (no extinguisher)"),
                             r.worst.covered ? "good" : "bad");
  }
  h += '</div>';
  h += '<div class="sim-legend">' +
    '<span class="sim-swatch" style="background:hsla(120,85%,50%,0.6)"></span>Low risk' +
    '<span class="sim-swatch" style="background:hsla(0,85%,50%,0.6);margin-left:10px"></span>High fire risk' +
    '</div>';
  _simShowCard(h);
}
