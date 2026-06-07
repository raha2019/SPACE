"use strict";
/* ------------------------------------------------------------------
   SIMULATION: Fire Safety
   Preliminary model estimate. Not for regulatory use.

   Fire-extinguisher reach coverage: the fraction of the floor that lies
   within an extinguisher's coverage radius. Split out from the egress
   analysis so fire safety can grow independently (flammable-zone
   adjacency, suppression coverage, etc.).
   ------------------------------------------------------------------ */

// BFS/coverage grid resolution (feet). Adjusted by setSimResolution().
let FIRE_GRID_RES_FT = 1.0;

// Target fraction of the floor that should be within extinguisher reach.
const FIRE_MIN_COVERAGE_PCT = 60;

function _fireCoverage(stageW, stageH) {
  const cols = Math.ceil(stageW / FIRE_GRID_RES_FT);
  const rows = Math.ceil(stageH / FIRE_GRID_RES_FT);
  const coverage = new Uint8Array(cols * rows);
  const points = [];
  for (const def of (state.amenityElements || [])) {
    const isExt = (def.subtype === "fire_extinguisher") ||
      /fire\s*extinguisher/i.test(def.label || "");
    if (!isExt) continue;
    const z = state.zones[def.id];
    if (!z || !z.included) continue;
    const cxFt = ((z.x + z.w / 2) / 100) * stageW;
    const cyFt = ((z.y + z.h / 2) / 100) * stageH;
    const rFt  = Number.isFinite(def.coverage) && def.coverage > 0 ? def.coverage : 25;
    points.push({ cxFt, cyFt, rFt });
  }
  let covered = 0;
  if (points.length) {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const xFt = (c + 0.5) * FIRE_GRID_RES_FT;
        const yFt = (r + 0.5) * FIRE_GRID_RES_FT;
        for (const p of points) {
          if (Math.hypot(xFt - p.cxFt, yFt - p.cyFt) <= p.rFt) {
            coverage[r * cols + c] = 1; covered++; break;
          }
        }
      }
    }
  }
  return { coverage, cols, rows, covered, total: cols * rows, count: points.length };
}

function _firePaintCanvas(ctx, coverage, cols, rows, canvasW, canvasH) {
  const cellW = canvasW / cols, cellH = canvasH / rows;
  ctx.fillStyle = "rgba(80,220,140,0.30)";
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!coverage[r * cols + c]) continue;
      ctx.fillRect(Math.round(c * cellW), Math.round(r * cellH),
                   Math.ceil(cellW) + 1, Math.ceil(cellH) + 1);
    }
  }
}

function runFireCheck() {
  const du = stageDimsUnits();
  if (!du) {
    simShowError("Fire safety analysis requires a calibrated scale. Import a floor plan and set scale first.");
    return;
  }
  const f = _fireCoverage(du.w, du.h);
  const canvas = simGetCanvas("fire");
  const stage  = document.getElementById("stage");
  const cw = stage.offsetWidth, ch = stage.offsetHeight;
  canvas.width = cw; canvas.height = ch;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, cw, ch);
  _firePaintCanvas(ctx, f.coverage, f.cols, f.rows, cw, ch);

  const pct = f.total > 0 ? (f.covered / f.total) * 100 : 0;
  const result = { count: f.count, coveragePct: pct };
  simShowFireResults(result);
  if (typeof _simResultCache !== "undefined") _simResultCache.fire = result;
}

function simShowFireResults(r) {
  const status = r.count === 0 ? "fail"
    : (r.coveragePct >= FIRE_MIN_COVERAGE_PCT ? "pass" : "warn");
  let h = _simHeader("Fire Safety", status);
  h += '<div class="sim-section">';
  h += _simRow("Fire extinguishers", r.count + " unit" + (r.count !== 1 ? "s" : ""),
               r.count > 0 ? "good" : "bad");
  h += _simRow("Floor within reach",
               r.coveragePct.toFixed(1) + "% (target ≥ " + FIRE_MIN_COVERAGE_PCT + "%)",
               r.count === 0 ? "bad" : (r.coveragePct >= FIRE_MIN_COVERAGE_PCT ? "good" : "warn"));
  h += '</div>';
  h += '<div class="sim-legend">' +
    '<span class="sim-swatch" style="background:rgba(80,220,140,0.5)"></span>Extinguisher coverage' +
    '</div>';
  _simShowCard(h);
}
