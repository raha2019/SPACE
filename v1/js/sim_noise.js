"use strict";
/* ------------------------------------------------------------------
   SIMULATION: Noise / Acoustic Monte Carlo Simulator
   Preliminary model estimate. Not for regulatory use.

   Estimates steady-state sound pressure levels across the floor using
   inverse-square-law propagation with wall attenuation. Monte Carlo
   sampling draws each machine on/off according to its schedule_prob,
   giving a mean dB map over NOISE_MC_ITERATIONS trials.

   Does not model room reflections, reverberation time, HVAC noise,
   directivity, or hearing protector attenuation factors.

   Standard referenced (informational, not enforced):
     OSHA 29 CFR 1910.95 Occupational Noise Exposure
   ------------------------------------------------------------------ */

// OSHA 29 CFR 1910.95(a): action level. Above this SPL, the employer
// must implement a hearing conservation program.
const OSHA_ACTION_LEVEL_DBA = 85;

// OSHA 29 CFR 1910.95(a): permissible exposure limit (PEL) for
// continuous 8-hour exposure without engineering controls.
const OSHA_PEL_DBA = 90;

// Background ambient noise floor (no machinery). Typical for a
// large indoor space with HVAC and no power tools running.
const NOISE_AMBIENT_DBA = 40;

// Grid resolution (feet). Adjusted at runtime by setSimResolution().
let NOISE_GRID_RES_FT = 2;

// Number of Monte Carlo trials. At 500 iterations the mean dB
// stabilizes to within ~0.5 dB standard error for schedule_prob >= 0.2.
const NOISE_MC_ITERATIONS = 500;

// Minimum source-to-receiver distance in the inverse-square-law
// calculation. Prevents log(0) and approximates near-field behavior.
const NOISE_MIN_DIST_FT = 1.0;

// Sound transmission class of typical interior makerspace partitions
// (metal stud + drywall, no special acoustic treatment). The insertion
// loss per wall crossing is STC * 0.5 -- a conservative approximation
// valid for broadband noise at the A-weighted measurement frequencies.
const NOISE_WALL_STC = 35;

// Default dBA when a zone has no dba_active property. Set to ambient
// so untagged zones do not contribute to the noise map.
const NOISE_DEFAULT_SOURCE_DBA = NOISE_AMBIENT_DBA;

// Default probability that a machine is running during any given
// observation window when schedule_prob is not specified.
const NOISE_DEFAULT_SCHEDULE_PROB = 0.5;

function _noiseGetSources(stageW, stageH) {
  const sources = [];
  for (const def of allZoneDefs()) {
    const z = state.zones[def.id];
    if (!z || !z.included) continue;
    const dba  = def.dba_active    !== undefined ? def.dba_active    : NOISE_DEFAULT_SOURCE_DBA;
    const prob = def.schedule_prob !== undefined ? def.schedule_prob : NOISE_DEFAULT_SCHEDULE_PROB;
    if (dba <= NOISE_AMBIENT_DBA) continue; // not a meaningful emitter
    // Center of zone in feet from the stage origin.
    const cx = ((z.x + z.w / 2) / 100) * stageW;
    const cy = ((z.y + z.h / 2) / 100) * stageH;
    sources.push({ id: def.id, dba, prob, cx, cy });
  }
  return sources;
}

/* Per-cell STC grid. A cell's value is the STC of the wall/door element
   covering it (0 if no obstacle). Walls and doors both attenuate sound;
   doors with a stcOverride field use that value instead of the global
   default. This lets the user mark a "noise barrier" by upping STC. */
function _noiseBuildStcGrid(stageW, stageH, cols, rows) {
  const stcGrid = new Float32Array(cols * rows);
  for (const el of state.structuralElements) {
    const cat = el.cat || "";
    const isWall = (cat === "structural-wall" || cat === "wall");
    const isDoor = (cat === "structural-door" || cat === "door");
    if (!isWall && !isDoor) continue;
    const z = state.zones[el.id];
    if (!z || !z.included) continue;
    const stc = Number.isFinite(el.stcOverride) ? el.stcOverride : NOISE_WALL_STC;
    if (stc <= 0) continue;
    const c1 = Math.floor((z.x / 100) * stageW / NOISE_GRID_RES_FT);
    const r1 = Math.floor((z.y / 100) * stageH / NOISE_GRID_RES_FT);
    const c2 = Math.ceil(((z.x + z.w) / 100) * stageW / NOISE_GRID_RES_FT);
    const r2 = Math.ceil(((z.y + z.h) / 100) * stageH / NOISE_GRID_RES_FT);
    for (let r = Math.max(0, r1); r < Math.min(rows, r2); r++) {
      for (let c = Math.max(0, c1); c < Math.min(cols, c2); c++) {
        // Use the strongest STC if cells overlap (e.g. a wall passing
        // through a door frame — pick whichever blocks more sound).
        const i = r * cols + c;
        if (stc > stcGrid[i]) stcGrid[i] = stc;
      }
    }
  }
  return stcGrid;
}

// Walk the Bresenham line from (c1,r1) to (c2,r2) and SUM the STC value
// of every wall/door cell along the way. Cells with stcGrid[i] === 0 are
// free space. The returned value is fed into the inverse-square calc as
// totalStc * 0.5 dB of insertion loss.
function _noiseWallCrossings(stcGrid, cols, rows, c1, r1, c2, r2) {
  let x = c1, y = r1;
  const dx = Math.abs(c2 - c1), dy = Math.abs(r2 - r1);
  const sx = c1 < c2 ? 1 : -1, sy = r1 < r2 ? 1 : -1;
  let err = dx - dy;
  let totalStc = 0;
  while (true) {
    if ((x !== c1 || y !== r1) && (x !== c2 || y !== r2)) {
      const i = y * cols + x;
      if (i >= 0 && i < stcGrid.length) totalStc += stcGrid[i];
    }
    if (x === c2 && y === r2) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 <  dx) { err += dx; y += sy; }
  }
  return totalStc;
}

// Precompute received dB at each grid cell for each source (walls
// fixed between iterations). This separates the deterministic geometry
// from the stochastic scheduling, so the Monte Carlo loop is cheap.
function _noisePrecompute(sources, stcGrid, cols, rows, stageW, stageH) {
  return sources.map(src => {
    const srcC = Math.round(src.cx / NOISE_GRID_RES_FT);
    const srcR = Math.round(src.cy / NOISE_GRID_RES_FT);
    const cell = new Float32Array(cols * rows);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const distFt = Math.max(
          NOISE_MIN_DIST_FT,
          Math.hypot(c - srcC, r - srcR) * NOISE_GRID_RES_FT
        );
        const directDb = src.dba - 20 * Math.log10(distFt);
        // Sum of STC values for every wall/door cell crossed. Per-element
        // stcOverride lets the user customize attenuation per barrier.
        const stcSum = _noiseWallCrossings(stcGrid, cols, rows, srcC, srcR, c, r);
        cell[r * cols + c] = directDb - stcSum * 0.5;
      }
    }
    return cell;
  });
}

function _noisePaintCanvas(ctx, meanDb, cols, rows, canvasW, canvasH) {
  const cellW = canvasW / cols;
  const cellH = canvasH / rows;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const d = meanDb[r * cols + c];
      if (d >= OSHA_PEL_DBA) {
        ctx.fillStyle = "rgba(220,45,45,0.65)";    // exceeds PEL
      } else if (d >= OSHA_ACTION_LEVEL_DBA) {
        ctx.fillStyle = "rgba(230,140,40,0.55)";   // exceeds action level
      } else if (d >= 70) {
        ctx.fillStyle = "rgba(230,210,50,0.40)";   // moderate, noticeable
      } else {
        ctx.fillStyle = "rgba(55,185,95,0.25)";    // low noise level
      }
      ctx.fillRect(
        Math.round(c * cellW), Math.round(r * cellH),
        Math.ceil(cellW) + 1, Math.ceil(cellH) + 1
      );
    }
  }
}

function runNoiseCheck() {
  const du = stageDimsUnits();
  if (!du) {
    simShowError("Noise simulation requires a calibrated scale. Import a floor plan and set scale first.");
    return;
  }
  const stageW = du.w, stageH = du.h;
  const cols = Math.ceil(stageW / NOISE_GRID_RES_FT);
  const rows = Math.ceil(stageH / NOISE_GRID_RES_FT);

  const sources = _noiseGetSources(stageW, stageH);
  if (sources.length === 0) {
    simShowError("No noise sources found. Add zones with a dba_active property via the Element Builder.");
    return;
  }

  const stcGrid     = _noiseBuildStcGrid(stageW, stageH, cols, rows);
  const precomputed = _noisePrecompute(sources, stcGrid, cols, rows, stageW, stageH);

  // Accumulate linear pressure squared over all MC iterations.
  const accumulator = new Float64Array(cols * rows);
  for (let iter = 0; iter < NOISE_MC_ITERATIONS; iter++) {
    for (let si = 0; si < sources.length; si++) {
      if (Math.random() > sources[si].prob) continue;
      const cell = precomputed[si];
      for (let i = 0; i < accumulator.length; i++) {
        accumulator[i] += Math.pow(10, cell[i] / 10);
      }
    }
  }

  // Convert to mean dB (ambient floor prevents log of zero).
  const ambientLinear = Math.pow(10, NOISE_AMBIENT_DBA / 10);
  const meanDb = new Float32Array(cols * rows);
  for (let i = 0; i < accumulator.length; i++) {
    meanDb[i] = 10 * Math.log10(accumulator[i] / NOISE_MC_ITERATIONS + ambientLinear);
  }

  const canvas = simGetCanvas("noise");
  const stage  = document.getElementById("stage");
  const cw = stage.offsetWidth, ch = stage.offsetHeight;
  canvas.width = cw; canvas.height = ch;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, cw, ch);
  _noisePaintCanvas(ctx, meanDb, cols, rows, cw, ch);

  let maxDb = -Infinity, sumDb = 0, n = 0, actionCells = 0, pelCells = 0;
  for (let i = 0; i < meanDb.length; i++) {
    const d = meanDb[i];
    if (d > maxDb) maxDb = d;
    sumDb += d; n++;
    if (d >= OSHA_ACTION_LEVEL_DBA) actionCells++;
    if (d >= OSHA_PEL_DBA) pelCells++;
  }
  const noiseResult = { maxDb, meanDb: n > 0 ? sumDb / n : 0, actionCells, pelCells, totalCells: n, sources: sources.length };
  simShowNoiseResults(noiseResult);
  if (typeof _simResultCache !== "undefined") _simResultCache.noise = noiseResult;
}
