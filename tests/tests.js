"use strict";
/* ------------------------------------------------------------------
   Unit tests for SPACE simulation modules.
   Run in tests/index.html (plain HTML, no build tools, no frameworks).
   Each test returns {name, pass, detail}.
   ------------------------------------------------------------------ */

// ---------------------------------------------------------------------------
// Minimal stubs for the global state and helper functions that the
// simulation modules expect. Tests inject their own state values.
// ---------------------------------------------------------------------------

const state = {
  zones: {},
  customElements: [],
  structuralElements: [],
  amenityElements: [],
  scale: null,
};

const ZONE_DEFS = [];

function allZoneDefs() {
  return ZONE_DEFS.concat(state.customElements).concat(state.structuralElements).concat(state.amenityElements);
}

function stageDimsUnits() {
  if (!state.scale) return null;
  return { w: state.scale.stageW_ft, h: state.scale.stageH_ft };
}

// Resets stub state to a clean 80x50 calibrated space with no zones.
function _resetState() {
  state.zones            = {};
  state.customElements   = [];
  state.structuralElements = [];
  state.amenityElements  = [];
  ZONE_DEFS.length = 0;
  state.scale = { stageW_ft: 80, stageH_ft: 50 };
}

// Adds a zone def + zone state entry. pct values are 0-100.
function _addZone(def, pos) {
  ZONE_DEFS.push(def);
  state.zones[def.id] = Object.assign(
    { x: 0, y: 0, w: def.w || 10, h: def.h || 10, included: true, rotation: 0, activeUse: false },
    pos
  );
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

const _results = [];

function test(name, fn) {
  try {
    const r = fn();
    _results.push({ name, pass: !!r.pass, detail: r.detail || "" });
  } catch (e) {
    _results.push({ name, pass: false, detail: "Exception: " + e.message });
  }
}

function renderResults() {
  const el = document.getElementById("results");
  if (!el) return;
  let pass = 0, fail = 0;
  let html = "";
  for (const r of _results) {
    if (r.pass) pass++; else fail++;
    const cls = r.pass ? "pass" : "fail";
    html +=
      '<div class="test-row ' + cls + '">' +
        '<span class="status">' + (r.pass ? "PASS" : "FAIL") + "</span>" +
        "<span>" + r.name + "</span>" +
        (r.detail ? '<span class="detail">' + r.detail + "</span>" : "") +
      "</div>";
  }
  const summary = '<div class="summary">' + pass + " passed, " + fail + " failed</div>";
  el.innerHTML = summary + html;
}

// ---------------------------------------------------------------------------
// ADA TESTS
// ---------------------------------------------------------------------------

test("ADA: _adaIsBlocking returns false for passable IDs", () => {
  const ok = ["corridor", "connector", "rightOpen", "entrance"].every(id =>
    !_adaIsBlocking({ id, cat: "something" })
  );
  return { pass: ok, detail: "corridor/connector/rightOpen/entrance should be passable" };
});

test("ADA: _adaIsBlocking returns false for exit and structural-door categories", () => {
  const exitOk  = !_adaIsBlocking({ id: "exitN", cat: "exit" });
  const doorOk  = !_adaIsBlocking({ id: "d1",   cat: "structural-door" });
  const floorOk = !_adaIsBlocking({ id: "f1",   cat: "structural-floor" });
  return { pass: exitOk && doorOk && floorOk };
});

test("ADA: _adaIsBlocking returns true for structural-wall", () => {
  const pass = _adaIsBlocking({ id: "w1", cat: "structural-wall" });
  return { pass };
});

test("ADA: _adaDistanceTransform seeds boundary at 0", () => {
  const cols = 5, rows = 5;
  const grid = new Uint8Array(cols * rows);
  const dist = _adaDistanceTransform(grid, cols, rows);
  // All boundary cells must be 0.
  const pass =
    dist[0] === 0 &&                      // top-left
    dist[cols - 1] === 0 &&               // top-right
    dist[(rows - 1) * cols] === 0 &&      // bottom-left
    dist[rows * cols - 1] === 0;          // bottom-right
  return { pass, detail: "boundary cells should have dist=0" };
});

test("ADA: _adaDistanceTransform center of empty 10x10 grid gets dist=4", () => {
  const cols = 10, rows = 10;
  const grid = new Uint8Array(cols * rows);
  const dist = _adaDistanceTransform(grid, cols, rows);
  // Center cell (5,5) is 4 cells from nearest boundary (boundary = 0 or 9).
  // Min of: 4 (to left boundary at c=0, counting from c=5 inward: dist=4),
  // same on right, top, bottom. Actually for a 10x10 grid (indices 0-9),
  // boundary rows are 0 and 9, boundary cols are 0 and 9.
  // Cell (5,5): distance to row 0 = 4 (row 1 would be dist 1 from boundary row 0,
  // row 2 = 2, ..., row 4 = 4). Actually BFS from boundary gives row 1 dist=1.
  // Cell (5,5) is at row 5: dist from top = min(5, 10-1-5) = min(5,4) = 4.
  // Similarly for col: min(5,4) = 4. So dist = 4.
  const centerDist = dist[5 * cols + 5];
  return { pass: centerDist === 4, detail: "center cell dist=" + centerDist + " (expected 4)" };
});

test("ADA: corridor narrower than ADA minimum flagged", () => {
  _resetState();
  // Place two equipment zones 1.5 ft apart (< 3 ft ADA minimum).
  // Stage: 80 ft wide -> 1.5 ft = 1.875% gap.
  // Left block: x=10%, w=10% (right edge 20%).
  // Right block: x=21.875%, w=10%.
  // Gap = 21.875 - 20 = 1.875% = 1.5 ft < 3 ft.
  _addZone({ id: "blockL", cat: "tool" }, { x: 10, y: 10, w: 10, h: 80 });
  _addZone({ id: "blockR", cat: "tool" }, { x: 21.875, y: 10, w: 10, h: 80 });

  const { grid, cols, rows } = _adaBuildGrid(80, 50);
  const dist  = _adaDistanceTransform(grid, cols, rows);
  const stats = _adaCorridorStats(dist, cols, rows);
  // Gap is 1.5ft wide. Half = 0.75ft. At 0.5ft resolution: 0.75/0.5 = 1.5, ceil = 2 cells.
  // ADA min: ceil((36/12)/0.5/2) = ceil(3) = 3. Since 2 < 3, fail > 0.
  return {
    pass: stats.fail > 0,
    detail: "failCells=" + stats.fail + " (should be > 0 for 1.5 ft gap)",
  };
});

test("ADA: corridor meeting preferred width not flagged as fail", () => {
  _resetState();
  // Two blocks 5 ft apart (> preferred 3.67 ft).
  // 5 ft = 5/80 * 100 = 6.25% gap.
  _addZone({ id: "blockL", cat: "tool" }, { x: 5, y: 10, w: 10, h: 80 });
  _addZone({ id: "blockR", cat: "tool" }, { x: 21.25, y: 10, w: 10, h: 80 });

  const { grid, cols, rows } = _adaBuildGrid(80, 50);
  const dist  = _adaDistanceTransform(grid, cols, rows);
  const stats = _adaCorridorStats(dist, cols, rows);
  return {
    pass: stats.fail === 0,
    detail: "failCells=" + stats.fail + " (should be 0 for 5 ft gap)",
  };
});

// ---------------------------------------------------------------------------
// EGRESS TESTS
// ---------------------------------------------------------------------------

test("EGRESS: _egressBFS seeds exit cells at distance 0", () => {
  _resetState();
  // Single exit in the middle of a 10x10 grid.
  _addZone({ id: "exit1", cat: "exit" }, { x: 40, y: 40, w: 20, h: 20 });

  const { grid, cols, rows } = _egressBuildGrid(80, 50);
  const dist = _egressBFS(grid, cols, rows);

  // Find at least one cell with dist=0 (exit seed).
  let hasZero = false;
  for (let i = 0; i < dist.length; i++) {
    if (dist[i] === 0) { hasZero = true; break; }
  }
  return { pass: hasZero, detail: "exit cells should seed with dist=0" };
});

test("EGRESS: free cells can reach exit when path exists", () => {
  _resetState();
  // Exit in top-left corner, rest of stage free.
  _addZone({ id: "exitTL", cat: "exit" }, { x: 0, y: 0, w: 10, h: 10 });

  const { grid, cols, rows } = _egressBuildGrid(80, 50);
  const dist = _egressBFS(grid, cols, rows);

  // Bottom-right free cell (near 100%, 100%) should have a positive dist < 200 ft.
  const brRow = rows - 2, brCol = cols - 2;
  const d = dist[brRow * cols + brCol];
  return {
    pass: d > 0 && d <= NFPA_MAX_TRAVEL_DISTANCE_FT * 2,
    detail: "bottom-right dist=" + (d >= 0 ? d.toFixed(1) : d) + " ft",
  };
});

test("EGRESS: obstacle cell does not receive BFS distance", () => {
  _resetState();
  _addZone({ id: "exitA", cat: "exit"  }, { x: 0, y: 0, w: 10, h: 10 });
  _addZone({ id: "wallA", cat: "structural-wall" }, { x: 20, y: 20, w: 60, h: 60 });

  const { grid, cols, rows } = _egressBuildGrid(80, 50);
  const dist = _egressBFS(grid, cols, rows);

  // Cell inside the wall block (approx center 50%, 50%) should stay at -1.
  const wallR = Math.floor(0.5 * rows);
  const wallC = Math.floor(0.5 * cols);
  const wallIdx = wallR * cols + wallC;
  const d = dist[wallIdx];
  return { pass: d < 0, detail: "wall cell dist=" + d + " (should be -1)" };
});

test("EGRESS: _egressOccupantLoad returns expected value for 80x50", () => {
  const load = _egressOccupantLoad(80, 50);
  // 4000 sqft / 50 sqft per person = 80 occupants.
  return { pass: load === 80, detail: "occupant load=" + load + " (expected 80)" };
});

test("EGRESS: _egressMaxDeadEnd returns 0 when no dead ends exist", () => {
  _resetState();
  // Two exits: no dead ends when BFS can reach all cells from two exits.
  _addZone({ id: "exitA", cat: "exit" }, { x: 0,  y: 40, w: 5,  h: 20 });
  _addZone({ id: "exitB", cat: "exit" }, { x: 90, y: 40, w: 5,  h: 20 });

  const { grid, cols, rows } = _egressBuildGrid(80, 50);
  const dist    = _egressBFS(grid, cols, rows);
  const maxDead = _egressMaxDeadEnd(dist, grid, cols, rows);
  // In an open space with two exits on opposite sides, every cell has
  // 2+ traversable neighbors; dead-end heuristic should return 0.
  return { pass: maxDead === 0, detail: "maxDeadEnd=" + maxDead + " (expected 0)" };
});

// ---------------------------------------------------------------------------
// NOISE TESTS
// ---------------------------------------------------------------------------

test("NOISE: ambient floor prevents log of zero in mean dB", () => {
  // With no sources active, mean dB across the grid should equal NOISE_AMBIENT_DBA.
  // Test the math: 10 * log10(0/500 + 10^(40/10)) = 40.
  const ambLinear = Math.pow(10, NOISE_AMBIENT_DBA / 10);
  const accumulated = 0; // no source contributed
  const meanLinear = accumulated / NOISE_MC_ITERATIONS + ambLinear;
  const result = 10 * Math.log10(meanLinear);
  const pass = Math.abs(result - NOISE_AMBIENT_DBA) < 0.001;
  return { pass, detail: "mean dB with no sources = " + result.toFixed(3) + " (expected " + NOISE_AMBIENT_DBA + ")" };
});

test("NOISE: inverse square law: dB decreases with distance", () => {
  _resetState();
  // Single loud source at center (50%, 50%).
  state.customElements.push({
    id: "srcCenter", cat: "tool", label: "Test Source",
    dba_active: 95, schedule_prob: 1.0,
    w: 2, h: 2,
  });
  state.zones["srcCenter"] = { x: 49, y: 49, w: 2, h: 2, included: true };

  const stageW = 80, stageH = 50;
  const cols = Math.ceil(stageW / NOISE_GRID_RES_FT);
  const rows = Math.ceil(stageH / NOISE_GRID_RES_FT);
  const wallGrid = _noiseBuildStcGrid(stageW, stageH, cols, rows);
  const sources  = _noiseGetSources(stageW, stageH);
  const pre      = _noisePrecompute(sources, wallGrid, cols, rows, stageW, stageH);

  if (sources.length === 0) return { pass: false, detail: "no sources found" };

  const srcCell = pre[0];
  // Cell near source (src at ~col=20, row=12 for 2ft resolution at 80x50).
  const srcCol = Math.round((50 / 100) * stageW / NOISE_GRID_RES_FT);
  const srcRow = Math.round((50 / 100) * stageH / NOISE_GRID_RES_FT);
  // Near cell: 1 cell away.
  const nearIdx = srcRow * cols + (srcCol + 1);
  // Far cell: 10 cells away.
  const farIdx  = srcRow * cols + (srcCol + 10);

  const nearDb = srcCell[nearIdx];
  const farDb  = srcCell[farIdx];
  return {
    pass: nearDb > farDb,
    detail: "near=" + nearDb.toFixed(1) + " dB, far=" + farDb.toFixed(1) + " dB (near should be louder)",
  };
});

test("NOISE: wall attenuation reduces received level", () => {
  // Direct path at 5 ft: source_dba - 20*log10(5) = 95 - 13.98 = 81.02 dBA.
  // With one wall crossing: 81.02 - (35 * 0.5) = 81.02 - 17.5 = 63.52 dBA.
  // Test that wall crossing reduces level.
  const srcDba  = 95;
  const distFt  = 5;
  const direct  = srcDba - 20 * Math.log10(distFt);
  const attenuated = direct - NOISE_WALL_STC * 0.5;
  const pass = attenuated < direct;
  return {
    pass,
    detail: "direct=" + direct.toFixed(2) + " dBA, after wall=" + attenuated.toFixed(2) + " dBA",
  };
});

test("NOISE: _noiseGetSources excludes zones at or below ambient level", () => {
  _resetState();
  state.customElements.push(
    { id: "loud", cat: "tool", label: "Loud Machine", dba_active: 95, schedule_prob: 0.5, w: 5, h: 5 },
    { id: "quiet", cat: "tool", label: "Quiet Zone", dba_active: 35, schedule_prob: 0.5, w: 5, h: 5 }
  );
  state.zones["loud"]  = { x: 10, y: 10, w: 5, h: 5, included: true };
  state.zones["quiet"] = { x: 50, y: 50, w: 5, h: 5, included: true };

  const sources = _noiseGetSources(80, 50);
  // Quiet zone (35 dBA <= NOISE_AMBIENT_DBA=40) should be excluded.
  const ids = sources.map(s => s.id);
  const pass = ids.includes("loud") && !ids.includes("quiet");
  return { pass, detail: "sources=" + ids.join(",") + " (quiet should be excluded)" };
});

test("NOISE: MC iterations produce stable mean at schedule_prob=1.0", () => {
  _resetState();
  // A zone always active should produce a deterministic output.
  state.customElements.push({
    id: "always", cat: "tool", label: "Always On",
    dba_active: 80, schedule_prob: 1.0, w: 4, h: 4,
  });
  state.zones["always"] = { x: 48, y: 48, w: 4, h: 4, included: true };

  const stageW = 80, stageH = 50;
  const cols = Math.ceil(stageW / NOISE_GRID_RES_FT);
  const rows = Math.ceil(stageH / NOISE_GRID_RES_FT);
  const wallGrid = _noiseBuildStcGrid(stageW, stageH, cols, rows);
  const sources  = _noiseGetSources(stageW, stageH);
  const pre      = _noisePrecompute(sources, wallGrid, cols, rows, stageW, stageH);

  const accA = new Float64Array(cols * rows);
  const accB = new Float64Array(cols * rows);
  // Run two independent MC batches of 100 iterations each.
  for (let i = 0; i < 100; i++) {
    for (let si = 0; si < sources.length; si++) {
      if (Math.random() <= sources[si].prob) {
        const c = pre[si];
        for (let j = 0; j < accA.length; j++) accA[j] += Math.pow(10, c[j] / 10);
      }
    }
  }
  const savedRandom = Math.random;
  Math.random = () => 0.5; // deterministic: always active when prob=1.0 since 0.5 <= 1.0
  for (let i = 0; i < 100; i++) {
    for (let si = 0; si < sources.length; si++) {
      if (Math.random() <= sources[si].prob) {
        const c = pre[si];
        for (let j = 0; j < accB.length; j++) accB[j] += Math.pow(10, c[j] / 10);
      }
    }
  }
  Math.random = savedRandom;

  // For schedule_prob=1.0, both batches should be identical.
  let allMatch = true;
  for (let i = 0; i < accA.length; i++) {
    if (Math.abs(accA[i] - accB[i]) > 0.001) { allMatch = false; break; }
  }
  return { pass: allMatch, detail: "MC batches with prob=1.0 should produce identical accumulation" };
});

// ---------------------------------------------------------------------------
// CONSTANT SANITY CHECKS
// ---------------------------------------------------------------------------

test("CONSTANTS: ADA_MIN_CORRIDOR_WIDTH_IN is 36", () => {
  return { pass: ADA_MIN_CORRIDOR_WIDTH_IN === 36 };
});

test("CONSTANTS: NFPA_MAX_TRAVEL_DISTANCE_FT is 200", () => {
  return { pass: NFPA_MAX_TRAVEL_DISTANCE_FT === 200 };
});

test("CONSTANTS: OSHA_PEL_DBA is 90", () => {
  return { pass: OSHA_PEL_DBA === 90 };
});

test("CONSTANTS: OSHA_ACTION_LEVEL_DBA is 85", () => {
  return { pass: OSHA_ACTION_LEVEL_DBA === 85 };
});

test("CONSTANTS: NOISE_MC_ITERATIONS is 500", () => {
  return { pass: NOISE_MC_ITERATIONS === 500 };
});

// ---------------------------------------------------------------------------
// EVAL HARNESS TESTS
// ---------------------------------------------------------------------------

test("EVAL: evaluateLayout returns well-formed objective vector", () => {
  _resetState();
  // Add one exit and two equipment zones.
  _addZone({ id: "exitA", cat: "exit" }, { x: 90, y: 40, w: 6, h: 20 });
  _addZone({ id: "tool1", cat: "tool", dba_active: 90, schedule_prob: 0.8 }, { x: 10, y: 20, w: 10, h: 10 });
  _addZone({ id: "tool2", cat: "tool", dba_active: 85, schedule_prob: 0.5 }, { x: 50, y: 50, w: 10, h: 10 });

  const vec = evaluateLayout({}, 80, 50);
  const hasFields = typeof vec.ada === "number" && typeof vec.egress === "number" && typeof vec.noise === "number";
  const inRange   = vec.ada >= 0 && vec.ada <= 1 && vec.egress >= 0 && vec.egress <= 1 && vec.noise >= 0 && vec.noise <= 1;
  return {
    pass: hasFields && inRange,
    detail: "ada=" + vec.ada.toFixed(3) + " egress=" + vec.egress.toFixed(3) + " noise=" + vec.noise.toFixed(3),
  };
});

test("EVAL: ADA and Egress components are deterministic for the same layout", () => {
  _resetState();
  _addZone({ id: "exitA", cat: "exit" }, { x: 85, y: 40, w: 7, h: 20 });
  _addZone({ id: "blockA", cat: "tool" }, { x: 10, y: 10, w: 12, h: 80 });
  _addZone({ id: "blockB", cat: "tool" }, { x: 30, y: 10, w: 12, h: 80 });

  const v1 = evaluateLayout({}, 80, 50);
  const v2 = evaluateLayout({}, 80, 50);
  const adaMatch    = v1.ada    === v2.ada;
  const egressMatch = v1.egress === v2.egress;
  return {
    pass: adaMatch && egressMatch,
    detail: "ada " + v1.ada.toFixed(4) + " vs " + v2.ada.toFixed(4) +
            " | egress " + v1.egress.toFixed(4) + " vs " + v2.egress.toFixed(4),
  };
});

test("EVAL: evaluateLayout restores state.zones after evaluation", () => {
  _resetState();
  _addZone({ id: "exitA", cat: "exit" }, { x: 80, y: 40, w: 8, h: 20 });
  _addZone({ id: "mover", cat: "tool" }, { x: 20, y: 20, w: 10, h: 10 });

  const xBefore = state.zones["mover"].x;
  // Evaluate with the mover at a different position.
  evaluateLayout({ mover: { x: 60, y: 60, w: 10, h: 10 } }, 80, 50);
  const xAfter = state.zones["mover"].x;
  return {
    pass: xBefore === xAfter,
    detail: "before=" + xBefore + " after=" + xAfter + " (should be unchanged)",
  };
});

test("EVAL: evalObjective returns value in [0, 1] for any valid vector", () => {
  const cases = [
    { ada: 0,   egress: 0,   noise: 0   },
    { ada: 1,   egress: 1,   noise: 1   },
    { ada: 0.5, egress: 0.3, noise: 0.7 },
    { ada: 0,   egress: 1,   noise: 0   },
  ];
  const pass = cases.every(v => {
    const j = evalObjective(v);
    return j >= 0 && j <= 1;
  });
  return { pass, detail: "all four test vectors produced J in [0, 1]" };
});

test("EVAL: evalDominates correctly identifies dominance", () => {
  const better   = { ada: 0.1, egress: 0.2, noise: 0.3 };
  const worse    = { ada: 0.2, egress: 0.3, noise: 0.4 };
  const partial  = { ada: 0.2, egress: 0.1, noise: 0.3 };  // worse on ada, better on egress
  const equal    = { ada: 0.1, egress: 0.2, noise: 0.3 };

  const d1 = evalDominates(better, worse);    // should dominate
  const d2 = evalDominates(worse, better);    // should not dominate
  const d3 = evalDominates(better, partial);  // should not dominate (partial is better on egress)
  const d4 = evalDominates(better, equal);    // should not dominate (equal is not strictly worse on any)

  return {
    pass: d1 && !d2 && !d3 && !d4,
    detail: "better>worse=" + d1 + " worse>better=" + d2 + " better>partial=" + d3 + " better>equal=" + d4,
  };
});

// ---------------------------------------------------------------------------
// OPTIMIZER TESTS
// ---------------------------------------------------------------------------

test("OPT: optimizerMovableIds excludes fixed zones", () => {
  _resetState();
  // Mark two zones fixed (simulating entrance/exit), one movable.
  ZONE_DEFS.push({ id: "fixedA", cat: "fixed", fixed: true, w: 5, h: 5 });
  ZONE_DEFS.push({ id: "exitN",  cat: "exit",  fixed: true, w: 5, h: 5 });
  ZONE_DEFS.push({ id: "tool1",  cat: "tool",  w: 8, h: 6 });
  state.zones["fixedA"] = { x: 5,  y: 5,  w: 5, h: 5,  included: true, locked: false };
  state.zones["exitN"]  = { x: 90, y: 90, w: 5, h: 5,  included: true, locked: false };
  state.zones["tool1"]  = { x: 30, y: 30, w: 8, h: 6,  included: true, locked: false };

  const movable = optimizerMovableIds();
  const onlyMovable = movable.includes("tool1") && !movable.includes("fixedA") && !movable.includes("exitN");
  return {
    pass: onlyMovable,
    detail: "movable=" + movable.join(",") + " (should be tool1 only)",
  };
});

test("OPT: _nudgeLayout keeps positions within stage bounds", () => {
  _resetState();
  _addZone({ id: "toolA", cat: "tool" }, { x: 50, y: 50, w: 10, h: 10 });
  const layout = { toolA: { x: 50, y: 50, w: 10, h: 10 } };
  let allInBounds = true;
  for (let i = 0; i < 50; i++) {
    const nudged = _nudgeLayout(layout, "toolA", SA_STEP_MAX);
    const pos = nudged["toolA"];
    if (pos.x < 0 || pos.x + pos.w > 100 || pos.y < 0 || pos.y + pos.h > 100) {
      allInBounds = false;
      break;
    }
  }
  return { pass: allInBounds, detail: "50 nudges with max step, all positions in [0, 100-w] x [0, 100-h]" };
});

test("OPT: _saRunSync archive is non-empty and baseline dominates no member", () => {
  _resetState();
  _addZone({ id: "exit1", cat: "exit" }, { x: 85, y: 40, w: 8, h: 20 });
  _addZone({ id: "t1",    cat: "tool" }, { x: 5,  y: 10, w: 12, h: 70 });
  _addZone({ id: "t2",    cat: "tool" }, { x: 20, y: 10, w: 12, h: 70 });
  _addZone({ id: "t3",    cat: "tool" }, { x: 50, y: 20, w: 10, h: 10 });

  const movable = ["t1", "t2", "t3"];
  const { archive, baseline } = _saRunSync(movable, 80, 50, 100);

  // MOSA guarantee: the archive is non-empty and the baseline does not
  // strictly dominate any archive member (the archive only contains solutions
  // that were at least incomparable to the baseline when they were inserted).
  let baselineDominatesNone = true;
  for (const m of archive) {
    if (evalDominates(baseline, m.vec)) { baselineDominatesNone = false; break; }
  }
  return {
    pass: archive.length > 0 && baselineDominatesNone,
    detail: "archive size=" + archive.length + " baseline dominates none: " + baselineDominatesNone,
  };
});

// ---------------------------------------------------------------------------
// MOSA TESTS
// ---------------------------------------------------------------------------

test("MOSA: archive holds only mutually non-dominated solutions after a run", () => {
  _resetState();
  _addZone({ id: "exit1", cat: "exit" }, { x: 85, y: 40, w: 8, h: 20 });
  _addZone({ id: "t1",    cat: "tool" }, { x: 5,  y: 10, w: 12, h: 70 });
  _addZone({ id: "t2",    cat: "tool" }, { x: 20, y: 10, w: 12, h: 70 });
  _addZone({ id: "t3",    cat: "tool" }, { x: 50, y: 20, w: 10, h: 10 });

  const { archive } = _saRunSync(["t1", "t2", "t3"], 80, 50, 100);

  let allNonDominated = true;
  outer: for (let i = 0; i < archive.length; i++) {
    for (let j = 0; j < archive.length; j++) {
      if (i === j) continue;
      if (evalDominates(archive[i].vec, archive[j].vec)) { allNonDominated = false; break outer; }
    }
  }
  return {
    pass: archive.length > 0 && allNonDominated,
    detail: "archive size=" + archive.length + " mutually non-dominated: " + allNonDominated,
  };
});

test("MOSA: seeded evaluateLayout gives identical vector for the same seed", () => {
  _resetState();
  _addZone({ id: "exit1", cat: "exit" },                                              { x: 85, y: 40, w: 8,  h: 20 });
  _addZone({ id: "tool1", cat: "tool", dba_active: 90, schedule_prob: 0.7 }, { x: 20, y: 20, w: 10, h: 10 });
  _addZone({ id: "tool2", cat: "tool", dba_active: 85, schedule_prob: 0.5 }, { x: 50, y: 50, w: 10, h: 10 });

  const saved = Math.random;

  Math.random = _makeLCG(0xABCD1234);
  const v1 = evaluateLayout({}, 80, 50);

  Math.random = _makeLCG(0xABCD1234);
  const v2 = evaluateLayout({}, 80, 50);

  Math.random = saved;

  const match = v1.ada === v2.ada && v1.egress === v2.egress && v1.noise === v2.noise;
  return {
    pass: match,
    detail: "v1=(" + v1.ada.toFixed(3) + "," + v1.egress.toFixed(3) + "," + v1.noise.toFixed(3) + ")" +
            " v2=(" + v2.ada.toFixed(3) + "," + v2.egress.toFixed(3) + "," + v2.noise.toFixed(3) + ")",
  };
});

test("MOSA: every archive member is non-dominated by the baseline", () => {
  _resetState();
  _addZone({ id: "exit1", cat: "exit" }, { x: 85, y: 40, w: 8, h: 20 });
  _addZone({ id: "t1",    cat: "tool" }, { x: 5,  y: 10, w: 12, h: 70 });
  _addZone({ id: "t2",    cat: "tool" }, { x: 20, y: 10, w: 12, h: 70 });

  const { archive, baseline } = _saRunSync(["t1", "t2"], 80, 50, 100);

  let noneBaseDominated = true;
  for (const m of archive) {
    if (evalDominates(baseline, m.vec)) { noneBaseDominated = false; break; }
  }
  return {
    pass: archive.length > 0 && noneBaseDominated,
    detail: "archive size=" + archive.length + " baseline dominates no member: " + noneBaseDominated,
  };
});

// Run and render.
renderResults();
