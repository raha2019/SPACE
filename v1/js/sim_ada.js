"use strict";
/* ------------------------------------------------------------------
   SIMULATION: ADA Compliance Validator
   Preliminary model estimate. Not for regulatory use.

   Approximates accessible route widths via a BFS distance transform
   on a discretized occupancy grid. Checks door widths and corridor
   clearance. Does not model slopes, reach ranges, protruding objects,
   restroom requirements, or parking.

   Standards referenced (informational, not enforced):
     ADA Standards for Accessible Design (2010 ADAS)
     ANSI A117.1-2017
   ------------------------------------------------------------------ */

// ADA Standards for Accessible Design (2010), Section 404.2.3:
// minimum clear opening width for doors and doorways.
const ADA_MIN_DOOR_WIDTH_IN = 32;

// Section 404.2.3: preferred exit/entry clear opening width
// (applies to primary exit doors per ANSI A117.1).
const ADA_MIN_EXIT_DOOR_WIDTH_IN = 36;

// Section 305.3: clear floor space minimum width (parallel approach).
const ADA_CLEAR_FLOOR_SPACE_W_IN = 30;

// Section 305.3: clear floor space depth (forward approach).
const ADA_CLEAR_FLOOR_SPACE_D_IN = 48;

// Section 304.3.1: diameter of the turning circle for a wheelchair.
const ADA_TURNING_CIRCLE_DIA_IN = 60;

// Section 402.2: minimum clear width of an accessible route.
const ADA_MIN_CORRIDOR_WIDTH_IN = 36;

// Section 402.2 (recommended): preferred clear width for primary
// circulation paths in facilities with equipment carts and mobility aids.
const ADA_MIN_PRIMARY_CORRIDOR_IN = 44;

// Grid resolution for the occupancy grid (feet).
// 0.5 ft = 6 inches: fine enough to distinguish the 32-in vs 36-in
// thresholds without excessive memory on a typical 80 x 50 ft space.
const ADA_GRID_RES_FT = 0.5;

// Zone IDs that are always traversable even if their category would
// otherwise mark them as obstacles (dedicated circulation areas).
const ADA_PASSABLE_IDS = new Set([
  "corridor", "connector", "rightOpen", "entrance",
]);

function _adaIsBlocking(def) {
  if (!def) return false;
  if (ADA_PASSABLE_IDS.has(def.id)) return false;
  const cat = def.cat || "";
  // Structural doors, floor areas, and exit zones are openings.
  if (cat === "exit" || cat === "structural-floor" || cat === "structural-door") return false;
  // Structural walls are solid obstacles.
  if (cat === "structural-wall" || cat === "wall") return true;
  // All equipment and work zones occupy physical space.
  return true;
}

function _adaBuildGrid(stageW, stageH) {
  const cols = Math.ceil(stageW / ADA_GRID_RES_FT);
  const rows = Math.ceil(stageH / ADA_GRID_RES_FT);
  const grid = new Uint8Array(cols * rows); // 1 = blocked, 0 = free
  for (const def of allZoneDefs()) {
    const z = state.zones[def.id];
    if (!z || !z.included) continue;
    if (!_adaIsBlocking(def)) continue;
    const c1 = Math.floor((z.x / 100) * stageW / ADA_GRID_RES_FT);
    const r1 = Math.floor((z.y / 100) * stageH / ADA_GRID_RES_FT);
    const c2 = Math.ceil(((z.x + z.w) / 100) * stageW / ADA_GRID_RES_FT);
    const r2 = Math.ceil(((z.y + z.h) / 100) * stageH / ADA_GRID_RES_FT);
    for (let r = Math.max(0, r1); r < Math.min(rows, r2); r++) {
      for (let c = Math.max(0, c1); c < Math.min(cols, c2); c++) {
        grid[r * cols + c] = 1;
      }
    }
  }
  return { grid, cols, rows };
}

// BFS outward from every obstacle and stage boundary. Each free cell
// receives its distance (in cells) to the nearest obstacle. This
// distance is the inscribed circle radius, from which we infer whether
// a person using a wheelchair can fit through the local corridor.
function _adaDistanceTransform(grid, cols, rows) {
  const dist = new Int32Array(cols * rows).fill(-1);
  const queue = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (grid[i] || r === 0 || r === rows - 1 || c === 0 || c === cols - 1) {
        dist[i] = 0;
        queue.push(i);
      }
    }
  }
  let head = 0;
  while (head < queue.length) {
    const i = queue[head++];
    const r = (i / cols) | 0;
    const c = i % cols;
    const nd = dist[i] + 1;
    if (r > 0)        { const ni = i - cols; if (dist[ni] < 0) { dist[ni] = nd; queue.push(ni); } }
    if (r < rows - 1) { const ni = i + cols; if (dist[ni] < 0) { dist[ni] = nd; queue.push(ni); } }
    if (c > 0)        { const ni = i - 1;    if (dist[ni] < 0) { dist[ni] = nd; queue.push(ni); } }
    if (c < cols - 1) { const ni = i + 1;    if (dist[ni] < 0) { dist[ni] = nd; queue.push(ni); } }
  }
  return dist;
}

function _adaCheckDoorWidths(stageW) {
  const issues = [];
  for (const el of state.structuralElements) {
    const cat = el.cat || "";
    if (cat !== "structural-door" && cat !== "door") continue;
    const z = state.zones[el.id];
    if (!z || !z.included) continue;
    // The narrower dimension is the clear opening width.
    const wIn = (Math.min(z.w, z.h) / 100) * stageW * 12;
    const isExit = (el.label || "").toLowerCase().includes("exit");
    const minIn = isExit ? ADA_MIN_EXIT_DOOR_WIDTH_IN : ADA_MIN_DOOR_WIDTH_IN;
    if (wIn < minIn) {
      issues.push({ label: el.label || el.id, actualIn: wIn.toFixed(0), requiredIn: minIn });
    }
  }
  return issues;
}

function _adaCorridorStats(dist, cols, rows) {
  // Grid cells required for half the minimum corridor width on each side.
  // A free cell with dist >= minCells provides at least ADA_MIN_CORRIDOR_WIDTH_IN
  // of clear width (obstacle on both sides of the path).
  const minCells  = Math.ceil((ADA_MIN_CORRIDOR_WIDTH_IN  / 12) / ADA_GRID_RES_FT / 2);
  const prefCells = Math.ceil((ADA_MIN_PRIMARY_CORRIDOR_IN / 12) / ADA_GRID_RES_FT / 2);
  let free = 0, fail = 0, marginal = 0;
  for (let i = 0; i < dist.length; i++) {
    if (dist[i] <= 0) continue;
    free++;
    if (dist[i] < minCells)       fail++;
    else if (dist[i] < prefCells) marginal++;
  }
  return { free, fail, marginal, minCells, prefCells };
}

function _adaPaintCanvas(ctx, dist, cols, rows, canvasW, canvasH) {
  const cellW = canvasW / cols;
  const cellH = canvasH / rows;
  const minCells  = Math.ceil((ADA_MIN_CORRIDOR_WIDTH_IN  / 12) / ADA_GRID_RES_FT / 2);
  const prefCells = Math.ceil((ADA_MIN_PRIMARY_CORRIDOR_IN / 12) / ADA_GRID_RES_FT / 2);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const d = dist[r * cols + c];
      if (d <= 0) continue;
      if (d < minCells)       ctx.fillStyle = "rgba(220,55,55,0.55)";
      else if (d < prefCells) ctx.fillStyle = "rgba(230,165,45,0.45)";
      else                    ctx.fillStyle = "rgba(55,185,95,0.30)";
      ctx.fillRect(
        Math.round(c * cellW), Math.round(r * cellH),
        Math.ceil(cellW) + 1, Math.ceil(cellH) + 1
      );
    }
  }
}

function runAdaCheck() {
  const du = stageDimsUnits();
  if (!du) {
    simShowError("ADA check requires a calibrated scale. Import a floor plan and set scale first.");
    return;
  }
  const { grid, cols, rows } = _adaBuildGrid(du.w, du.h);
  const dist  = _adaDistanceTransform(grid, cols, rows);
  const corr  = _adaCorridorStats(dist, cols, rows);
  const doors = _adaCheckDoorWidths(du.w);

  const canvas = simGetCanvas("ada");
  const stage  = document.getElementById("stage");
  const cw = stage.offsetWidth, ch = stage.offsetHeight;
  canvas.width = cw; canvas.height = ch;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, cw, ch);
  _adaPaintCanvas(ctx, dist, cols, rows, cw, ch);

  simShowAdaResults({ doors, corr });
  if (typeof _simResultCache !== "undefined") _simResultCache.ada = { doors, corr };
}
