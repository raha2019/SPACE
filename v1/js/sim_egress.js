"use strict";
/* ------------------------------------------------------------------
   SIMULATION: Egress / Fire Analyzer
   Preliminary model estimate. Not for regulatory use.

   Multi-source BFS from all exit zones to compute travel distance,
   occupant load estimate, and exit capacity per NFPA 101.
   Dead-end detection uses the maximum BFS distance of any cell with
   only one traversable neighbor (a conservative heuristic).

   Does not model smoke conditions, door swing, stairwells, or
   occupancy sub-classification nuances.

   Standard referenced (informational, not enforced):
     NFPA 101 Life Safety Code, 2021 edition
   ------------------------------------------------------------------ */

// NFPA 101 (2021), Table 7.3.1.2: occupant load factor for industrial
// occupancy (gross sq ft per person). Makerspaces are treated as
// industrial/educational; 50 sq ft is conservative for active use.
const NFPA_OCCUPANT_LOAD_FACTOR_MAKERSPACE = 50;

// NFPA 101 (2021), 7.3.3.1: exit width required per occupant (inches).
const NFPA_EXIT_WIDTH_PER_OCCUPANT_IN = 0.2;

// NFPA 101 (2021), 7.6.1: maximum travel distance to an exit (feet)
// for sprinklered industrial occupancy. Unsprinklered limit is 100 ft.
const NFPA_MAX_TRAVEL_DISTANCE_FT = 200;

// NFPA 101 (2021), 7.5.1.5: maximum common path of travel before
// occupants have access to two separate exit paths (feet).
const NFPA_MAX_COMMON_PATH_FT = 75;

// NFPA 101 (2021), 7.5.1.8: maximum dead-end corridor length (feet).
const NFPA_MAX_DEAD_END_FT = 20;

// BFS grid resolution (feet). Adjusted at runtime by setSimResolution().
let EGRESS_GRID_RES_FT = 1.0;

// Zone IDs that are always traversable for egress purposes.
const EGRESS_PASSABLE_IDS = new Set([
  "corridor", "connector", "rightOpen", "entrance",
]);

function _egressIsBlocking(def) {
  if (!def) return false;
  if (EGRESS_PASSABLE_IDS.has(def.id)) return false;
  // Explicit per-element flag from the wall-draw editor wins: walls block,
  // construction-line dividers / doors / floors do not.
  if (typeof def.blocksMovement === "boolean") return def.blocksMovement;
  // Structural FLOOR elements are non-physical area labels, not solid
  // objects — they mark a named region but never obstruct egress. Treat
  // them as walkable space.
  if (def.elementClass === "structural" && def.subtype === "floor") return false;
  const cat = def.cat || "";
  if (cat === "exit" || cat === "structural-floor" || cat === "structural-door") return false;
  if (cat === "structural-wall" || cat === "wall") return true;
  return true; // equipment and work zones are physical obstacles
}

function _egressBuildGrid(stageW, stageH) {
  const cols = Math.ceil(stageW / EGRESS_GRID_RES_FT);
  const rows = Math.ceil(stageH / EGRESS_GRID_RES_FT);
  // 0 = free walkable, 1 = obstacle wall, 2 = exit seed cell
  const grid = new Uint8Array(cols * rows);
  for (const def of allZoneDefs()) {
    const z = state.zones[def.id];
    if (!z || !z.included) continue;
    const isExit     = (def.cat === "exit");
    const isBlocking = _egressIsBlocking(def);
    const val = isExit ? 2 : (isBlocking ? 1 : 0);
    if (val === 0) continue;
    const c1 = Math.floor((z.x / 100) * stageW / EGRESS_GRID_RES_FT);
    const r1 = Math.floor((z.y / 100) * stageH / EGRESS_GRID_RES_FT);
    const c2 = Math.ceil(((z.x + z.w) / 100) * stageW / EGRESS_GRID_RES_FT);
    const r2 = Math.ceil(((z.y + z.h) / 100) * stageH / EGRESS_GRID_RES_FT);
    for (let r = Math.max(0, r1); r < Math.min(rows, r2); r++) {
      for (let c = Math.max(0, c1); c < Math.min(cols, c2); c++) {
        // Exit value (2) overrides obstacle value (1) so exits stay passable.
        if (val === 2 || grid[r * cols + c] !== 2) {
          grid[r * cols + c] = val;
        }
      }
    }
  }
  return { grid, cols, rows };
}

// Multi-source BFS from all exit cells. Free cells that cannot reach
// any exit receive -1 (blocked or isolated).
function _egressBFS(grid, cols, rows) {
  const dist = new Float32Array(cols * rows).fill(-1);
  const queue = [];
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] === 2) { dist[i] = 0; queue.push(i); }
  }
  let head = 0;
  while (head < queue.length) {
    const i = queue[head++];
    const r = (i / cols) | 0;
    const c = i % cols;
    const nd = dist[i] + EGRESS_GRID_RES_FT;
    if (r > 0)        { const ni = i - cols; if (grid[ni] !== 1 && dist[ni] < 0) { dist[ni] = nd; queue.push(ni); } }
    if (r < rows - 1) { const ni = i + cols; if (grid[ni] !== 1 && dist[ni] < 0) { dist[ni] = nd; queue.push(ni); } }
    if (c > 0)        { const ni = i - 1;    if (grid[ni] !== 1 && dist[ni] < 0) { dist[ni] = nd; queue.push(ni); } }
    if (c < cols - 1) { const ni = i + 1;    if (grid[ni] !== 1 && dist[ni] < 0) { dist[ni] = nd; queue.push(ni); } }
  }
  return dist;
}

function _egressOccupantLoad(stageW, stageH) {
  return Math.ceil((stageW * stageH) / NFPA_OCCUPANT_LOAD_FACTOR_MAKERSPACE);
}

function _egressExitCapacity(stageW) {
  let totalWidthIn = 0, exitCount = 0;
  for (const def of allZoneDefs()) {
    if (def.cat !== "exit") continue;
    const z = state.zones[def.id];
    if (!z || !z.included) continue;
    totalWidthIn += (Math.min(z.w, z.h) / 100) * stageW * 12;
    exitCount++;
  }
  return {
    capacity: Math.floor(totalWidthIn / NFPA_EXIT_WIDTH_PER_OCCUPANT_IN),
    exitCount,
    totalWidthIn,
  };
}

// Dead-end terminus: a free cell with exactly one traversable neighbor.
// The BFS distance of that terminus approximates how far someone must
// backtrack before reaching a choice of two paths. This overestimates
// true dead-end length but is a conservative safety check.
function _egressMaxDeadEnd(dist, grid, cols, rows) {
  let maxLen = 0;
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] === 1 || dist[i] < 0) continue;
    const r = (i / cols) | 0;
    const c = i % cols;
    let traversable = 0;
    if (r > 0        && grid[i - cols] !== 1) traversable++;
    if (r < rows - 1 && grid[i + cols] !== 1) traversable++;
    if (c > 0        && grid[i - 1]    !== 1) traversable++;
    if (c < cols - 1 && grid[i + 1]    !== 1) traversable++;
    if (traversable === 1 && dist[i] > maxLen) maxLen = dist[i];
  }
  return maxLen;
}

/* Fire-extinguisher coverage mask. Any cell whose Euclidean distance to
   any included fire-extinguisher amenity is within that extinguisher's
   coverage radius gets marked. Painted as a soft green tint over the
   travel-distance heatmap and reported as a coverage percentage. */
function _egressFireCoverage(stageW, stageH, cols, rows) {
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
  if (!points.length) return { coverage, covered: 0, total: cols * rows, count: 0 };
  let covered = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const xFt = (c + 0.5) * EGRESS_GRID_RES_FT;
      const yFt = (r + 0.5) * EGRESS_GRID_RES_FT;
      for (const p of points) {
        if (Math.hypot(xFt - p.cxFt, yFt - p.cyFt) <= p.rFt) {
          coverage[r * cols + c] = 1; covered++; break;
        }
      }
    }
  }
  return { coverage, covered, total: cols * rows, count: points.length };
}

function _egressPaintCoverage(ctx, coverage, cols, rows, canvasW, canvasH) {
  const cellW = canvasW / cols;
  const cellH = canvasH / rows;
  ctx.fillStyle = "rgba(80,220,140,0.22)";
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!coverage[r * cols + c]) continue;
      ctx.fillRect(
        Math.round(c * cellW), Math.round(r * cellH),
        Math.ceil(cellW) + 1, Math.ceil(cellH) + 1
      );
    }
  }
}

function _egressPaintCanvas(ctx, dist, grid, cols, rows, canvasW, canvasH) {
  const cellW = canvasW / cols;
  const cellH = canvasH / rows;
  const mid = NFPA_MAX_TRAVEL_DISTANCE_FT * 0.5;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const d = dist[i];
      if (grid[i] === 1) continue; // wall: leave transparent
      if (grid[i] === 2) {
        ctx.fillStyle = "rgba(50,140,240,0.65)";  // exit zone: blue
      } else if (d < 0) {
        ctx.fillStyle = "rgba(150,0,150,0.55)";   // unreachable: purple
      } else if (d <= mid) {
        // Low end: green fading to yellow-green
        const t = d / mid;
        ctx.fillStyle = `rgba(${Math.round(55 + 175 * t)},${Math.round(185 - 110 * t)},55,0.4)`;
      } else if (d <= NFPA_MAX_TRAVEL_DISTANCE_FT) {
        // Approaching limit: yellow to orange
        const t = (d - mid) / mid;
        ctx.fillStyle = `rgba(230,${Math.round(165 - 90 * t)},45,0.5)`;
      } else {
        ctx.fillStyle = "rgba(220,50,50,0.65)";   // exceeds NFPA limit: red
      }
      ctx.fillRect(
        Math.round(c * cellW), Math.round(r * cellH),
        Math.ceil(cellW) + 1, Math.ceil(cellH) + 1
      );
    }
  }
}

function runEgressCheck() {
  const du = stageDimsUnits();
  if (!du) {
    simShowError("Egress analysis requires a calibrated scale. Import a floor plan and set scale first.");
    return;
  }
  const { grid, cols, rows } = _egressBuildGrid(du.w, du.h);
  const dist      = _egressBFS(grid, cols, rows);
  const occupants = _egressOccupantLoad(du.w, du.h);
  const exitCap   = _egressExitCapacity(du.w);
  const maxTravel = dist.reduce((mx, d) => d > mx ? d : mx, 0);
  const deadEnd   = _egressMaxDeadEnd(dist, grid, cols, rows);

  const fire = _egressFireCoverage(du.w, du.h, cols, rows);

  const canvas = simGetCanvas("egress");
  const stage  = document.getElementById("stage");
  const cw = stage.offsetWidth, ch = stage.offsetHeight;
  canvas.width = cw; canvas.height = ch;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, cw, ch);
  _egressPaintCanvas(ctx, dist, grid, cols, rows, cw, ch);
  // Paint fire-extinguisher coverage on top so it's still readable.
  _egressPaintCoverage(ctx, fire.coverage, cols, rows, cw, ch);

  const fireCoveragePct = fire.total > 0 ? (fire.covered / fire.total) * 100 : 0;
  const result = { occupants, exitCap, maxTravel, deadEnd,
                   fireExt: { count: fire.count, coveragePct: fireCoveragePct } };
  simShowEgressResults(result);
  if (typeof _simResultCache !== "undefined") _simResultCache.egress = result;
}
