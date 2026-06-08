"use strict";
/* ------------------------------------------------------------------
   SIMULATION: Fumes / Odor dispersion — radius heatmap (bounded).
   Preliminary model estimate. Not for regulatory use.

   • Each tool projects an ODOR/FUME radius scaled by its smell/fume
     rating (variableAttrs.smellFumes, 0–4).
   • Fume hoods / sinks / exhaust amenities project a CAPTURE radius that
     reduces concentration nearby.
   • Cell concentration = source plume, reduced where a hood captures it.
   The grid is hard-capped so the sim can never freeze the app.
   ------------------------------------------------------------------ */

let FUMES_GRID_RES_FT = 1.5;
const FUMES_MAX_CELLS = 140;
const FUMES_BASE_FT = 7;            // base plume radius
const FUMES_PER_LEVEL_FT = 8;       // extra radius per smell/fume level
const FUMES_HOOD_FT = 14;           // default hood capture radius

// Amenity subtypes (or labels) that capture/extract fumes.
function _fumesIsHood(d){
  if(d.elementClass !== "amenity") return false;
  const st = d.subtype || "";
  return /hood|fume|exhaust|vent|sink/i.test(st) || /fume\s*hood|exhaust|ventilation/i.test(d.label||"");
}

function _fumesSources(stageW, stageH){
  const plumes = [], hoods = [];
  for(const d of allZoneDefs()){
    const z = state.zones[d.id];
    if(!z || z.included === false) continue;
    if(_fumesIsHood(d)){
      hoods.push({ cx:(z.x+z.w/2)/100*stageW, cy:(z.y+z.h/2)/100*stageH,
        r:(Number.isFinite(d.coverage) && d.coverage>0 ? d.coverage : FUMES_HOOD_FT), label:d.label });
      continue;
    }
    if(d.elementClass === "structural" || d.elementClass === "amenity") continue;
    const sm = (d.variableAttrs && Number.isFinite(d.variableAttrs.smellFumes)) ? d.variableAttrs.smellFumes : 0;
    if(sm <= 0) continue;
    plumes.push({ cx:(z.x+z.w/2)/100*stageW, cy:(z.y+z.h/2)/100*stageH,
      r: FUMES_BASE_FT + sm*FUMES_PER_LEVEL_FT, conc: clamp(sm/4, 0, 1), label:d.label });
  }
  return { plumes, hoods };
}

function _fumesCaptured(p, hoods){
  let best = 0;
  for(const h of hoods){
    const d = Math.hypot(p.cx-h.cx, p.cy-h.cy);
    if(d < h.r) best = Math.max(best, 1 - d/h.r);
  }
  return best;
}

function runFumesCheck(){
  const du = stageDimsUnits();
  if(!du){ simShowError("Fumes analysis requires a calibrated scale. Import a floor plan and set scale first."); return; }
  const stageW = du.w, stageH = du.h;

  const cols = Math.min(FUMES_MAX_CELLS, Math.max(1, Math.ceil(stageW / FUMES_GRID_RES_FT)));
  const rows = Math.min(FUMES_MAX_CELLS, Math.max(1, Math.ceil(stageH / FUMES_GRID_RES_FT)));
  const resX = stageW / cols, resY = stageH / rows;

  const { plumes, hoods } = _fumesSources(stageW, stageH);

  const canvas = simGetCanvas("fumes");
  const stage  = document.getElementById("stage");
  const cw = stage.offsetWidth, ch = stage.offsetHeight;
  canvas.width = cw; canvas.height = ch;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, cw, ch);

  const scoped = (typeof roomScopeActive === "function") && roomScopeActive();
  const cellW = cw / cols, cellH = ch / rows;
  for(let r = 0; r < rows; r++){
    for(let c = 0; c < cols; c++){
      const xf = (c+0.5)*resX, yf = (r+0.5)*resY;
      if(scoped && !pointInAnalysisScope(xf/stageW*100, yf/stageH*100)) continue;
      let conc = 0;
      for(const p of plumes){
        const d = Math.hypot(xf-p.cx, yf-p.cy);
        if(d < p.r) conc = Math.max(conc, p.conc * (1 - d/p.r));
      }
      if(conc <= 0.02) continue;
      let cap = 0;
      for(const h of hoods){
        const d = Math.hypot(xf-h.cx, yf-h.cy);
        if(d < h.r) cap = Math.max(cap, 1 - d/h.r);
      }
      const val = clamp(conc * (1 - 0.8*cap), 0, 1);
      if(val < 0.03) continue;
      // purple→orange scale (odor intensity)
      const hue = 280 - val*250;     // 280 (violet, low) → 30 (orange, high)
      ctx.fillStyle = `hsla(${hue},80%,55%,${(0.2 + val*0.45).toFixed(2)})`;
      ctx.fillRect(Math.round(c*cellW), Math.round(r*cellH), Math.ceil(cellW)+1, Math.ceil(cellH)+1);
    }
  }

  let uncovered = 0, worst = null;
  for(const p of plumes){
    const cap = _fumesCaptured(p, hoods);
    if(cap <= 0) uncovered++;
    const exposure = p.conc * (1 - cap);
    if(!worst || exposure > worst.exposure) worst = { label:p.label, exposure, captured: cap > 0 };
  }

  const result = {
    sources: plumes.length, hoods: hoods.length, uncovered,
    worst: worst ? { label:worst.label, captured:worst.captured } : null,
  };
  simShowFumesResults(result);
  if(typeof _simResultCache !== "undefined") _simResultCache.fumes = result;
}

function simShowFumesResults(r){
  const status = r.sources === 0 ? "pass" : (r.uncovered > 0 ? "warn" : "pass");
  let h = _simHeader("Fumes / Odor dispersion", status);
  h += '<div class="sim-section">';
  h += _simRow("Fume / odor sources", String(r.sources), r.sources > 0 ? "warn" : "good");
  h += _simRow("Fume hoods / exhaust", String(r.hoods), r.hoods > 0 ? "good" : (r.sources > 0 ? "warn" : "good"));
  if(r.sources > 0){
    h += _simRow("Sources without capture", String(r.uncovered), r.uncovered > 0 ? "warn" : "good");
    if(r.worst) h += _simRow("Strongest plume", r.worst.label + (r.worst.captured ? " (captured)" : " (uncaptured)"),
                             r.worst.captured ? "good" : "bad");
  }
  h += '</div>';
  h += '<div class="sim-legend">' +
    '<span class="sim-swatch" style="background:hsla(280,80%,55%,0.6)"></span>Light odor' +
    '<span class="sim-swatch" style="background:hsla(30,80%,55%,0.7);margin-left:10px"></span>Strong fumes' +
    '</div>';
  _simShowCard(h);
}
