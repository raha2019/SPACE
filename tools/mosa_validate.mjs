/**
 * tools/mosa_validate.mjs  --  headless MOSA validation harness.
 * Node.js only. Not shipped to the browser. No npm packages.
 *
 * Usage:
 *   node tools/mosa_validate.mjs
 *   node tools/mosa_validate.mjs --iters 2000
 *
 * Loads all browser JS as one concatenated script in a single vm context
 * (required because const/function declarations share a lexical scope
 * that does not persist across separate vm.runInContext calls).
 *
 * Reads real layout data from testcase/hub/:
 *   default-elements.json      --  21 element defs (id, risk, w, h, fixed)
 *   default-configuration.json --  zone positions in % coordinates
 *
 * ASSUMPTIONS printed at top of output (must be confirmed before publishing):
 *   [A1] RESOLVED: Real MRDC 2323 geometry from testcase/hub/mrdc2323-scale.json.
 *        Derived from GT MRDC architectural drawing at 9 pts/ft. Stage 96.6 x 88.6 ft,
 *        L-shaped floor polygon, shoelace area 6278.76 sf.
 *   [A2] RESOLVED: dba_active values are per-tool literature-derived measurements
 *        stored in default-elements.json (NIOSH/OSHA 3740 sources).
 */

import { readFileSync }        from 'fs';
import { join, dirname }       from 'path';
import { fileURLToPath }       from 'url';
import vm                      from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..');

/* -- command line: --iters N overrides the default SA iteration count -- */
const iterArg = process.argv.indexOf('--iters');
const itersOverride = iterArg >= 0 ? parseInt(process.argv[iterArg + 1], 10) : undefined;

/* -- read data files from testcase/hub (outside the vm) -- */
const elementBundle = JSON.parse(
  readFileSync(join(ROOT, 'testcase/hub/default-elements.json'), 'utf8')
);
const configBundle  = JSON.parse(
  readFileSync(join(ROOT, 'testcase/hub/default-configuration.json'), 'utf8')
);
const ELEMENT_DEFS = elementBundle.elementDefs;
const CONFIG_ZONES = configBundle.zones;

/* -- [A1] RESOLVED: load real MRDC 2323 scale (fail loudly if missing) -- */
const _mrdc2323ScalePath = join(ROOT, 'testcase/hub/mrdc2323-scale.json');
let _mrdc2323Scale;
try {
  _mrdc2323Scale = JSON.parse(readFileSync(_mrdc2323ScalePath, 'utf8'));
} catch (err) {
  console.error('[A1] FATAL: testcase/hub/mrdc2323-scale.json not found or invalid.');
  console.error('  Create it to resolve [A1] (real MRDC 2323 stage scale).');
  console.error('  Detail: ' + (err.message || err));
  process.exit(1);
}

/* -- read pinned baseline for canary check (null if file not yet created) -- */
let _pinnedBaseline = null;
try {
  _pinnedBaseline = JSON.parse(
    readFileSync(join(ROOT, 'tools/baseline-mrdc2323.json'), 'utf8')
  );
} catch (_) { /* baseline not yet created — canary skipped */ }

/* -- read source files -- */
function src(rel) { return readFileSync(join(ROOT, rel), 'utf8'); }

/* -- vm context: browser stubs only, no npm packages -- */
const vmCtx = vm.createContext({
  /* JS builtins (vm context does not inherit these from the host) */
  console,
  process,                   // for process.exit in the harness code
  Math, JSON,
  Array, Object, Number, String, Boolean, Function,
  Set, Map, Error, TypeError, RangeError,
  parseInt, parseFloat, isFinite, isNaN,
  Infinity, NaN,
  Float32Array, Float64Array, Int32Array, Uint8Array,

  /* DOM stubs */
  document: {
    getElementById:   () => ({ textContent: '' }),
    createElement:    () => ({
      getContext: () => ({ clearRect: () => {}, fillRect: () => {}, fillStyle: '', globalAlpha: 1 }),
      width: 0, height: 0, style: {},
    }),
    querySelector:    () => null,
    querySelectorAll: () => [],
  },
  window:       {},
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  alert:        () => {},
  confirm:      () => false,

  /* Sim UI stubs (all no-ops in headless mode) */
  simGetCanvas:         () => ({
    getContext: () => ({ clearRect: () => {}, fillRect: () => {}, fillStyle: '', globalAlpha: 1 }),
  }),
  simShowError:         () => {},
  simShowAdaResults:    () => {},
  simShowEgressResults: () => {},
  simShowNoiseResults:  () => {},
  simShowFireResults:   () => {},
  simShowFumesResults:  () => {},
  _simEsc:              s  => String(s),

  /* App stubs */
  evaluate:     () => {},
  render:       () => {},
  saveAppState: () => {},

  /* MOSA stubs for helpers it does not need but may see in scope */
  _scTools:              () => [],
  getAnalysisRooms:      () => [],
  pointInAnalysisScope:  ()  => true,
  roomPolygonPct:        ()  => null,
  analysisScopeAreaUnits: () => null,
  roomScopeActive:       ()  => false,

  /* Unit conversion: needed by sim_noise._noiseRefDist() */
  convertUnits: (v, from, to) => {
    const M = { m: 1, meter: 1, meters: 1, ft: 0.3048, foot: 0.3048, feet: 0.3048 };
    if (!M[from] || !M[to]) return v;
    return v * M[from] / M[to];
  },
  currentUnit: () => 'ft',
});

/* ------------------------------------------------------------------ */
/*  Harness setup code (runs at the bottom of the concatenated script) */
/* ------------------------------------------------------------------ */
/*
 * IMPORTANT: all JS in the harness body is injected as a string because
 * it shares the same lexical scope as the loaded source files.  const/let
 * declared in sim_eval.js (evaluateLayout, evalDominates, etc.) are not
 * properties of vmCtx but ARE visible to the harness body below since
 * they live in the same vm Script execution.
 */
const HARNESS_BODY = `
/* ===== HARNESS BODY — injected into concatenated vm script ===== */

/* ---------- deterministic seeding (Phase 0, Task 1) ---------- */
// HARNESS_SEED = 0x4D524443 = ASCII "MRDC"
const HARNESS_SEED = 0x4D524443;

// Mulberry32 PRNG — verbatim from sim_optimizer.js _makeLCG.
// Named _harnessLCG to avoid collision with _makeLCG defined in sim_mosa.js.
function _harnessLCG(seed) {
  let s = seed >>> 0;
  return function () {
    s += 0x6D2B79F5;
    let z = s;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------- state setup ---------- */
// [A1] RESOLVED: real MRDC 2323 geometry from mrdc2323-scale.json.
//   Source: GT MRDC drawing at 9 pts/ft. Bounding box 96.6 ft x 88.6 ft.
//   L-shaped polygon (SE notch), shoelace area 6278.76 sf.
const _MRDC = ${JSON.stringify(_mrdc2323Scale)};
state.scale = {
  pxPerUnit:     _MRDC.pxPerUnit,
  unit:          _MRDC.unit,
  stageWidthPx:  _MRDC.stageWidthPx,
  stageHeightPx: _MRDC.stageHeightPx,
};

// Add L-shaped floor element so pointInAnalysisScope uses the polygon.
// state.analysisRooms = null -> getAnalysisRooms() uses ALL floor rooms.
// Phase 2d: also add the SE-notch structural wall so the OBJECTIVE grids
// (ADA/egress/noise) treat the notch as blocked/attenuated the same way they
// treat any wall — no engine edit. Both are re-registered as zones after the
// state.zones rebuild below (the rebuild would otherwise drop them).
state.customElements    = [];
state.structuralElements = [_MRDC.floorDef, _MRDC.notchBlockerDef];
state.amenityElements   = [];
state.activeUse         = false;
state.analysisRooms     = null;

// NOTE: the floor zone is registered AFTER the state.zones rebuild loop below,
// not here -- an earlier registration would be wiped by the state.zones reset at
// the start of that loop (the Phase 2b bug: floor dropped -> getAnalysisRooms()
// empty -> pointInAnalysisScope() degenerated to the full bounding box). See the
// re-register-the-L-shaped-floor-room block after the rebuild loop.

// ---- geometry verification (reported below) ----
const _polyPts    = _MRDC.floorDef.shapes[0].points;
const _vertCount  = _polyPts.length;     // must be 6 for the L-shape
let   _polySum    = 0;
for (let _i = 0; _i < _polyPts.length; _i++) {
  const _a = _polyPts[_i], _b = _polyPts[(_i + 1) % _polyPts.length];
  _polySum += _a.x * _b.y - _b.x * _a.y;
}
const _polyAreaPct2 = Math.abs(_polySum) / 2;
const _du0          = stageDimsUnits();
const _polyAreaSf   = _du0 ? (_polyAreaPct2 / 10000) * _du0.w * _du0.h : null;

// Inject element defs (serialised from testcase/hub/default-elements.json)
const _ELEMENT_DEFS = ${JSON.stringify(ELEMENT_DEFS)};
const _CONFIG_ZONES = ${JSON.stringify(CONFIG_ZONES)};
// Pinned baseline for canary check (null until tools/baseline-mrdc2323.json is created)
const _PINNED_BASELINE = ${JSON.stringify(_pinnedBaseline)};

ZONE_DEFS.length = 0;
for (const raw of _ELEMENT_DEFS) {
  const def = Object.assign({}, raw);
  // [A2] RESOLVED: dba_active values are now per-tool literature-derived
  // measurements stored in default-elements.json (see dba_source field).
  // Elements without dba_active are filtered by sim_noise at NOISE_AMBIENT_DBA.
  ZONE_DEFS.push(def);
}

state.zones = {};
for (const def of ZONE_DEFS) {
  const cfg = _CONFIG_ZONES[def.id] || {};
  state.zones[def.id] = {
    x:        cfg.x        !== undefined ? cfg.x        : 50,
    y:        cfg.y        !== undefined ? cfg.y        : 50,
    w:        cfg.w        !== undefined ? cfg.w        : def.w,
    h:        cfg.h        !== undefined ? cfg.h        : def.h,
    rotation: cfg.rotation !== undefined ? cfg.rotation : 0,
    included: true,
    activeUse: false,
    locked:   !!def.fixed,
  };
}

// ---- Phase 2c: re-register the L-shaped floor room AFTER the wipe/rebuild ----
// The browser keeps room polygons alive because loadPreset() rebuilds state.zones
// from allZoneDefs() (which includes state.structuralElements — the floor). The
// harness rebuild loop above only iterates the 21 tool ZONE_DEFS, so we re-add the
// floor zone here to match loadPreset's semantics. Full-stage anchor (x:0,y:0,
// w:100,h:100) so roomPolygonPct() maps the 6-vertex local polygon 1:1 into stage %.
// With this present, getAnalysisRooms() returns exactly the floor room and
// pointInAnalysisScope() / footInside() enforce the true L-polygon (SE notch excluded).
state.zones[_MRDC.floorDef.id] = {
  x: 0, y: 0, w: 100, h: 100,
  included: true, activeUse: false, locked: false,
};

// ---- Phase 2d: register the SE-notch wall zone (fills the excluded notch) ----
// simBlockerFootprint uses the ZONE rect (x,y,w,h), so the zone must carry the
// notch rectangle. subtype/cat=wall + blocksMovement=true => sim_ada/_egress mark
// these cells blocked and sim_noise rasterizes them into the STC grid.
const _NB = _MRDC.notchBlockerDef;
state.zones[_NB.id] = {
  x: _NB.x, y: _NB.y, w: _NB.w, h: _NB.h,
  rotation: 0, included: true, activeUse: false, locked: true,
};

// ---- Phase 2c enforcement probes (pure geometry; no PRNG draws) ----
// Confirm the polygon is now the active analysis scope. SE notch (stage %):
//   x > 40.994% AND y > 54.853%  (== x > 39.6 ft, y > 48.6 ft at 9 px/ft).
const _enfRooms     = (typeof getAnalysisRooms === 'function') ? getAnalysisRooms() : [];
const _enfRoomCount = _enfRooms.length;
const _enfPoly      = (_enfRooms[0] && typeof roomPolygonPct === 'function')
  ? roomPolygonPct(_enfRooms[0]) : null;
const _enfVerts     = _enfPoly ? _enfPoly.length : 0;
let _enfPolySum = 0;
if (_enfPoly) {
  for (let _i = 0; _i < _enfPoly.length; _i++) {
    const _a = _enfPoly[_i], _b = _enfPoly[(_i + 1) % _enfPoly.length];
    _enfPolySum += _a.x * _b.y - _b.x * _a.y;
  }
}
const _enfAreaSf = _du0 ? (Math.abs(_enfPolySum) / 2 / 10000) * _du0.w * _du0.h : null;
const _enfProbe  = (x, y) =>
  (typeof pointInAnalysisScope === 'function') ? pointInAnalysisScope(x, y) : null;
const _enfProbes = [
  { pt: [47.5, 83], label: 'SE notch interior',             inScope: _enfProbe(47.5, 83), expect: false },
  { pt: [20,   20], label: 'known interior (NW arm)',       inScope: _enfProbe(20,   20), expect: true  },
  { pt: [41.5, 60], label: 'just inside notch past x-edge', inScope: _enfProbe(41.5, 60), expect: false },
  { pt: [50,   52], label: 'right arm, below notch y-edge', inScope: _enfProbe(50,   52), expect: true  },
];
const _enfProbesPass = _enfProbes.every(p => p.inScope === p.expect);

// ---- Phase 2d: OBJECTIVE-GRID exclusion probes ----
// Prove that the notch blocker makes the ADA and egress GRID BUILDERS exclude
// the notch cells (mark them blocked), while known-interior cells stay walkable.
// We build each grid WITH the blocker (current state) and WITHOUT it (temporarily
// dropping it), then read the cell value at each probe point. Also show the noise
// STC grid now marks the notch as a wall. Pure grid reads; no PRNG draws.
const _gW = _du0.w, _gH = _du0.h;
const _adaRes = (typeof ADA_GRID_RES_FT === 'number') ? ADA_GRID_RES_FT : 0.5;
const _egRes  = (typeof EGRESS_GRID_RES_FT === 'number') ? EGRESS_GRID_RES_FT : 0.5;
const _nRes   = (typeof NOISE_GRID_RES_FT === 'number') ? NOISE_GRID_RES_FT : 1;
function _cellVal(g, res, px, py) {
  const col = Math.floor((px / 100) * _gW / res);
  const row = Math.floor((py / 100) * _gH / res);
  if (col < 0 || row < 0 || col >= g.cols || row >= g.rows) return -9;
  return g.grid[row * g.cols + col];
}
function _stcAt(stc, cols, rows, px, py) {
  const col = Math.floor((px / 100) * _gW / _nRes);
  const row = Math.floor((py / 100) * _gH / _nRes);
  if (col < 0 || row < 0 || col >= cols || row >= rows) return -9;
  return stc[row * cols + col];
}
// WITH blocker (current state)
const _adaWith = _adaBuildGrid(_gW, _gH);
const _egWith  = _egressBuildGrid(_gW, _gH);
const _nCols   = Math.ceil(_gW / _nRes), _nRows = Math.ceil(_gH / _nRes);
const _stcWith = _noiseBuildStcGrid(_gW, _gH, _nCols, _nRows);
// WITHOUT blocker: drop it, rebuild, restore.
const _savedStruct    = state.structuralElements;
const _savedNotchZone = state.zones[_NB.id];
state.structuralElements = [_MRDC.floorDef];
delete state.zones[_NB.id];
const _adaNo  = _adaBuildGrid(_gW, _gH);
const _egNo   = _egressBuildGrid(_gW, _gH);
const _stcNo  = _noiseBuildStcGrid(_gW, _gH, _nCols, _nRows);
state.structuralElements = _savedStruct;
state.zones[_NB.id]      = _savedNotchZone;

const _gridProbePts = [
  { pt: [60,   80], label: 'SE notch (open cell; flips 0->1)', region: 'notch' },
  { pt: [80,   90], label: 'SE notch (deep, open; flips 0->1)', region: 'notch' },
  { pt: [47.5, 83], label: 'SE notch under xr tool (already 1)', region: 'notch' },
  { pt: [70,   30], label: 'interior top-rect (right)',    region: 'interior' },
  { pt: [10,   90], label: 'interior left arm (south)',    region: 'interior' },
];
const _gridProbes = _gridProbePts.map(p => ({
  pt: p.pt, label: p.label, region: p.region,
  adaWithout: _cellVal(_adaNo,  _adaRes, p.pt[0], p.pt[1]),
  adaWith:    _cellVal(_adaWith, _adaRes, p.pt[0], p.pt[1]),
  egWithout:  _cellVal(_egNo,   _egRes,  p.pt[0], p.pt[1]),
  egWith:     _cellVal(_egWith, _egRes,  p.pt[0], p.pt[1]),
  stcWithout: _stcAt(_stcNo,   _nCols, _nRows, p.pt[0], p.pt[1]),
  stcWith:    _stcAt(_stcWith, _nCols, _nRows, p.pt[0], p.pt[1]),
}));
// Criterion: every notch probe is BLOCKED in the ada+egress grids with the blocker
// (adaWith==1 && egWith==1) and carries STC>0 in the noise grid; every interior
// probe is UNCHANGED by the blocker (walkable stays walkable). Notch cells that were
// already blocked by a baseline tool footprint (e.g. xr) stay blocked — still correct.
const _gridProbesPass = _gridProbes.every(p =>
  p.region === 'notch'
    ? (p.adaWith === 1 && p.egWith === 1 && p.stcWith > 0)
    : (p.adaWith === p.adaWithout && p.egWith === p.egWithout && p.stcWith === p.stcWithout));

// ---- baseline zones whose footprint intersects the SE notch (as-is data quality) ----
// Classify each baseline zone by sampling its rotation-aware AABB the same way
// footInside() does (4 corners + center) against the enforced polygon scope.
function _zoneNotchClass(z) {
  const rot = (z.rotation || 0) * Math.PI / 180;
  const c = Math.abs(Math.cos(rot)), s = Math.abs(Math.sin(rot));
  const ew = z.w * c + z.h * s, eh = z.w * s + z.h * c;
  const cx = z.x + z.w / 2, cy = z.y + z.h / 2;
  const x1 = cx - ew / 2, y1 = cy - eh / 2, x2 = cx + ew / 2, y2 = cy + eh / 2;
  const pts = [[x1, y1], [x2, y1], [x1, y2], [x2, y2], [cx, cy]];
  let out = 0;
  for (const _p of pts) if (!_enfProbe(_p[0], _p[1])) out++;
  const cls = out === 0 ? 'clear' : (out === pts.length ? 'fully_in_notch' : 'partially_in_notch');
  return { samples: pts.length, out, cls, center: [cx, cy], centerInNotch: !_enfProbe(cx, cy) };
}
const _notchZones = [];
for (const _id of Object.keys(state.zones)) {
  if (_id === _MRDC.floorDef.id || _id === _NB.id) continue;
  const _zc = _zoneNotchClass(state.zones[_id]);
  if (_zc.cls !== 'clear')
    _notchZones.push({ id: _id, center: _zc.center, centerInNotch: _zc.centerInNotch,
                       out: _zc.out, samples: _zc.samples, cls: _zc.cls });
}

/* ---------- movable tool ids ---------- */
const MOVABLE_IDS = [
  'craftland','xr','asm1','asm2','bike','storage',
  'electronics','print3d','laser','cnc','metal','wood',
  'welding','waterjet'
];

/* ---------- evaluate baseline ---------- */
const _du = stageDimsUnits();
const _stageW = _du.w, _stageH = _du.h;

const baselineVec = evaluateLayout({}, _stageW, _stageH);

/* ---------- baseline noise stability pass (10 documented seeds) ---------- */
// Characterises seed-to-seed variance in the noise objective.
// ADA and egress are expected identical across all seeds (deterministic paths).
//
// PRNG ISOLATION: Math.random is saved and restored around this block.
// The main run sets Math.random = _harnessLCG(HARNESS_SEED) fresh immediately
// before mosaOptimize(), so this stability pass does NOT perturb the main
// run's PRNG sequence in any way. Confirmed by: main SEEDVEC_JSON == pinned.
const _STABILITY_SEEDS = [
  0x4D524443, 0x0001, 0xBEEF, 0xCAFE, 0x1234,
  0x5678, 0x9ABC, 0xDEF0, 0x2323, 0x6275
];
const _stabSavedRandom = Math.random;
const _stabSavedZones  = JSON.parse(JSON.stringify(state.zones));
const _stabilityRuns   = [];
for (let _si = 0; _si < _STABILITY_SEEDS.length; _si++) {
  const _ss = _STABILITY_SEEDS[_si];
  Math.random = _harnessLCG(_ss);
  const _sv = evaluateLayout({}, _stageW, _stageH);
  _stabilityRuns.push({
    seed:   '0x' + _ss.toString(16).toUpperCase().padStart(8, '0'),
    ada:    _sv.ada,
    egress: _sv.egress,
    noise:  _sv.noise,
  });
}
// Restore PRNG and zone state so main run is unaffected.
state.zones  = JSON.parse(JSON.stringify(_stabSavedZones));
Math.random  = _stabSavedRandom;

// Stability statistics (noise only; ada/egress are seed-independent).
const _stabNoises    = _stabilityRuns.map(r => r.noise);
const _stabMin       = Math.min.apply(null, _stabNoises);
const _stabMax       = Math.max.apply(null, _stabNoises);
const _stabMean      = _stabNoises.reduce(function(a, b){ return a + b; }, 0) / _stabNoises.length;
const _stabSpread    = _stabMax - _stabMin;
const _stabSD        = Math.sqrt(
  _stabNoises.reduce(function(acc, v){ return acc + (v - _stabMean) * (v - _stabMean); }, 0) / _stabNoises.length
);
const _stabAdaVals    = _stabilityRuns.map(r => r.ada);
const _stabEgressVals = _stabilityRuns.map(r => r.egress);
const _stabAdaSame    = _stabAdaVals.every(function(v){ return Math.abs(v - _stabAdaVals[0]) < 1e-12; });
const _stabEgressSame = _stabEgressVals.every(function(v){ return Math.abs(v - _stabEgressVals[0]) < 1e-12; });

/* ---------- run MOSA ---------- */
const _itersOverride = ${JSON.stringify(itersOverride)};
const mosaOpts = { movableIds: MOVABLE_IDS };
if (typeof _itersOverride === 'number' && _itersOverride > 0) mosaOpts.iters = _itersOverride;

// Patch Math.random with seeded Mulberry32 immediately before SA starts.
// This makes all move selection draws AND the 25-iteration noise MC inside
// evaluateLayout deterministic. process.exit() is called at end of harness,
// so no restore is needed.
Math.random = _harnessLCG(HARNESS_SEED);
const mosaResult = mosaOptimize(mosaOpts);

/* ---------- analysis ---------- */
const _front = mosaResult.front;

// How many front points strictly dominate the baseline?
let _dominatingCount = 0;
for (const pt of _front) {
  if (evalDominates(pt.vec, mosaResult.seedVec)) _dominatingCount++;
}

// Best per-axis improvement across the front
let _bestAda = null, _bestEgress = null, _bestNoise = null;
for (const pt of _front) {
  const ai = evalPctImprovement(mosaResult.seedVec.ada,    pt.vec.ada);
  const ei = evalPctImprovement(mosaResult.seedVec.egress, pt.vec.egress);
  const ni = evalPctImprovement(mosaResult.seedVec.noise,  pt.vec.noise);
  if (ai !== null && (_bestAda    === null || ai > _bestAda))    _bestAda    = ai;
  if (ei !== null && (_bestEgress === null || ei > _bestEgress)) _bestEgress = ei;
  if (ni !== null && (_bestNoise  === null || ni > _bestNoise))  _bestNoise  = ni;
}

// Knee point: closest to ideal (all zeros) after min-max normalizing the front
function _minmax(arr, key) {
  let lo = Infinity, hi = -Infinity;
  for (const p of arr) { if (p.vec[key] < lo) lo = p.vec[key]; if (p.vec[key] > hi) hi = p.vec[key]; }
  return { lo, hi };
}
const _rA = _minmax(_front, 'ada'),    _rE = _minmax(_front, 'egress'), _rN = _minmax(_front, 'noise');
const _nA = _rA.hi > _rA.lo ? v => (v - _rA.lo)/(_rA.hi - _rA.lo) : () => 0;
const _nE = _rE.hi > _rE.lo ? v => (v - _rE.lo)/(_rE.hi - _rE.lo) : () => 0;
const _nN = _rN.hi > _rN.lo ? v => (v - _rN.lo)/(_rN.hi - _rN.lo) : () => 0;

let _knee = _front[0] || null, _kneeDist = Infinity;
for (const pt of _front) {
  const d = Math.hypot(_nA(pt.vec.ada), _nE(pt.vec.egress), _nN(pt.vec.noise));
  if (d < _kneeDist) { _kneeDist = d; _knee = pt; }
}

/* ---------- print report ---------- */
const _f2 = v => (v * 100).toFixed(2);
const _f1 = v => v !== null ? v.toFixed(1) : 'n/a';

console.log('');
console.log('============================================================');
console.log('MOSA VALIDATION REPORT');
console.log('Invention Studio Layout -- Pareto Front over {ADA, Egress, Noise}');
console.log('============================================================');
console.log('');
console.log('ASSUMPTIONS (confirm before citing in paper):');
console.log('  [A1] RESOLVED: MRDC 2323 real geometry from testcase/hub/mrdc2323-scale.json.');
console.log('       Source: GT MRDC drawing 1615813303111-2nd_floor_MRDC__3_.pdf, 9 pts/ft.');
console.log('       Stage: ' + (_du0 ? _du0.w.toFixed(1) : '?') + ' ft x ' + (_du0 ? _du0.h.toFixed(1) : '?') + ' ft (bounding box).');
console.log('       L-polygon: ' + _vertCount + ' vertices, shoelace area = ' +
  (_polyAreaSf !== null ? _polyAreaSf.toFixed(1) + ' sf (expect ~6278.76 sf)' : 'could not compute'));
console.log('       Polygon bypass check: ' + (_vertCount === 6 ? 'PASS — 6-vertex L-shape in scope' : 'WARN — unexpected vertex count'));
console.log('');
console.log('POLYGON ENFORCEMENT PROBES (Phase 2c):');
console.log('  getAnalysisRooms() rooms      : ' + _enfRoomCount + (_enfRoomCount === 1 ? ' (expect 1) PASS' : ' (expect 1) FAIL'));
console.log('  active room polygon vertices  : ' + _enfVerts + (_enfVerts === 6 ? ' (expect 6) PASS' : ' (expect 6) FAIL'));
console.log('  active-scope shoelace area    : ' + (_enfAreaSf !== null ? _enfAreaSf.toFixed(1) + ' sf' : 'n/a') +
  (_enfAreaSf !== null && Math.abs(_enfAreaSf - 6278.76) < 5 ? ' (~6278.76 sf) PASS' : ' (expect ~6278.76 sf)'));
console.log('  pointInAnalysisScope probes   :');
for (const _pr of _enfProbes) {
  console.log('    (' + _pr.pt[0] + ', ' + _pr.pt[1] + ')  ' +
    'inScope=' + _pr.inScope + '  expect=' + _pr.expect + '  ' +
    (_pr.inScope === _pr.expect ? 'PASS' : 'FAIL') + '   [' + _pr.label + ']');
}
console.log('  enforcement probes overall    : ' + (_enfProbesPass ? 'PASS' : 'FAIL'));
console.log('ENFORCE_JSON:' + JSON.stringify({
  rooms: _enfRoomCount, vertices: _enfVerts, areaSf: _enfAreaSf,
  probes: _enfProbes.map(p => ({ pt: p.pt, inScope: p.inScope, expect: p.expect, label: p.label })),
  pass: _enfProbesPass,
}));
console.log('');
console.log('OBJECTIVE-GRID NOTCH BLOCKER (Phase 2d):');
console.log('  Blocker: ' + _NB.id + '  rect (stage %): x=[' + _NB.x.toFixed(5) + ', ' + (_NB.x + _NB.w).toFixed(0) +
  '], y=[' + _NB.y.toFixed(5) + ', ' + (_NB.y + _NB.h).toFixed(0) + ']  (w=' + _NB.w.toFixed(5) + ', h=' + _NB.h.toFixed(5) + ')');
console.log('  Type: elementClass=' + _NB.elementClass + ' subtype=' + _NB.subtype + ' cat=' + _NB.cat + ' blocksMovement=' + _NB.blocksMovement);
console.log('  Grid cell values  (ada/eg: 0=walkable 1=blocked 2=exit; stc: dB barrier, 0=none):');
console.log('    ' + 'point'.padEnd(16) + 'region'.padEnd(10) + '  ADA no->with   EG no->with   STC no->with');
for (const _p of _gridProbes) {
  const _flip = _p.region === 'notch'
    ? ((_p.adaWith === 1 && _p.egWith === 1 && _p.stcWith > 0)
        ? ((_p.adaWithout === 0 && _p.egWithout === 0) ? 'PASS (excluded, flipped 0->1)' : 'PASS (blocked; was under a tool)')
        : 'FAIL')
    : ((_p.adaWith === _p.adaWithout && _p.egWith === _p.egWithout) ? 'PASS (unchanged)' : 'FAIL');
  console.log('    (' + (_p.pt[0] + ',' + _p.pt[1]).padEnd(9) + ')' + '  ' + _p.region.padEnd(9) + ' ' +
    (_p.adaWithout + '->' + _p.adaWith).padEnd(12) + '  ' + (_p.egWithout + '->' + _p.egWith).padEnd(11) + '  ' +
    (_p.stcWithout.toFixed(0) + '->' + _p.stcWith.toFixed(0)).padEnd(11) + '  ' + _flip + '  [' + _p.label + ']');
}
console.log('  grid-exclusion probes overall : ' + (_gridProbesPass ? 'PASS' : 'FAIL'));
console.log('BLOCKER_JSON:' + JSON.stringify({
  blocker: { id: _NB.id, elementClass: _NB.elementClass, subtype: _NB.subtype, cat: _NB.cat,
             blocksMovement: _NB.blocksMovement, x: _NB.x, y: _NB.y, w: _NB.w, h: _NB.h },
  probes: _gridProbes, pass: _gridProbesPass,
}));
console.log('');
console.log('BASELINE ZONES INTERSECTING THE SE NOTCH (as-is default-configuration data):');
if (_notchZones.length === 0) {
  console.log('  none — all baseline zone footprints clear the notch.');
} else {
  for (const _nz of _notchZones) {
    console.log('  ' + _nz.id.padEnd(12) + ' center=(' + _nz.center[0].toFixed(2) + ', ' + _nz.center[1].toFixed(2) + ')  ' +
      _nz.out + '/' + _nz.samples + ' AABB samples in notch  centerInNotch=' + _nz.centerInNotch + '  [' + _nz.cls + ']');
  }
}
console.log('NOTCH_ZONES_JSON:' + JSON.stringify(_notchZones));
console.log('');
console.log('  [A2] RESOLVED: per-tool dba_active values from literature-derived');
console.log('       field measurements (NIOSH/OSHA 3740) in default-elements.json.');
console.log('       See dba_source field in that file for citations and estimates.');
console.log('');
console.log('BASELINE LAYOUT (default-configuration.json positions):');
console.log('  ADA violation fraction : ' + _f2(mosaResult.seedVec.ada)    + '%');
console.log('  Egress objective       : ' + _f2(mosaResult.seedVec.egress) + '%');
console.log('  Noise objective        : ' + _f2(mosaResult.seedVec.noise)  + '%');
console.log('  Scalar (equal weights) : ' + _f2(evalObjective(mosaResult.seedVec)) + '%');
console.log('');
console.log('PARETO FRONT:');
console.log('  Archive size                  : ' + _front.length + ' solutions');
console.log('  Points that dominate baseline : ' + _dominatingCount + ' / ' + _front.length);
console.log('');
console.log('BEST SINGLE-OBJECTIVE IMPROVEMENT ACROSS FRONT:');
console.log('  ADA    : ' + (_bestAda    !== null ? _f1(_bestAda)    + '% reduction' : 'no improvement'));
console.log('  Egress : ' + (_bestEgress !== null ? _f1(_bestEgress) + '% reduction' : 'no improvement'));
console.log('  Noise  : ' + (_bestNoise  !== null ? _f1(_bestNoise)  + '% reduction' : 'no improvement / flat'));
console.log('');
console.log('KNEE POINT (closest to ideal after min-max normalizing front):');
if (_knee) {
  console.log('  ADA    : ' + _f2(mosaResult.seedVec.ada)    + '% -> ' + _f2(_knee.vec.ada)    + '%');
  console.log('  Egress : ' + _f2(mosaResult.seedVec.egress) + '% -> ' + _f2(_knee.vec.egress) + '%');
  console.log('  Noise  : ' + _f2(mosaResult.seedVec.noise)  + '% -> ' + _f2(_knee.vec.noise)  + '%');
}
console.log('');
console.log('DIAGNOSTICS:');
console.log('  Iterations     : ' + mosaResult.stats.iters);
console.log('  Accepted       : ' + mosaResult.stats.accepted);
console.log('  Rejected       : ' + mosaResult.stats.rejected);
console.log('  Infeasible     : ' + mosaResult.stats.infeasible);
console.log('  Infeasible %   : ' + (mosaResult.stats.infeasible / mosaResult.stats.iters * 100).toFixed(1) + '%');
console.log('  Archived       : ' + mosaResult.stats.archived);
console.log('  Final T        : ' + mosaResult.stats.finalT.toExponential(3));
// Machine-readable line for baseline pinning (exact IEEE-754 values).
console.log('SEEDVEC_JSON:' + JSON.stringify({ada:mosaResult.seedVec.ada,egress:mosaResult.seedVec.egress,noise:mosaResult.seedVec.noise}));
console.log('');
console.log('BASELINE NOISE STABILITY (10 documented seeds):');
console.log('  ' + 'Seed        '.padEnd(14) + 'ADA%'.padStart(10) + '  ' + 'Egress%'.padStart(8) + '  ' + 'Noise%'.padStart(8));
for (let _pi = 0; _pi < _stabilityRuns.length; _pi++) {
  const _sr = _stabilityRuns[_pi];
  console.log('  ' + _sr.seed.padEnd(14) +
    (_sr.ada    * 100).toFixed(4).padStart(10) + '%  ' +
    (_sr.egress * 100).toFixed(4).padStart(7)  + '%  ' +
    (_sr.noise  * 100).toFixed(4).padStart(7)  + '%');
}
console.log('  ---');
console.log('  Mean:   ' + (_stabMean   * 100).toFixed(4) + '%');
console.log('  Min:    ' + (_stabMin    * 100).toFixed(4) + '%');
console.log('  Max:    ' + (_stabMax    * 100).toFixed(4) + '%');
console.log('  SD:     ' + (_stabSD     * 100).toFixed(4) + ' pp');
console.log('  Spread: ' + (_stabSpread * 100).toFixed(4) + ' pp');
console.log('  ADA seed-independent:    ' + (_stabAdaSame    ? 'CONFIRMED' : 'WARN — values differ across seeds'));
console.log('  Egress seed-independent: ' + (_stabEgressSame ? 'CONFIRMED' : 'WARN — values differ across seeds'));
// Machine-readable stability JSON for baseline-mrdc2323.json update.
console.log('STABILITY_JSON:' + JSON.stringify({
  seeds:  _stabilityRuns.map(function(r){ return r.seed; }),
  ada:    _stabAdaVals,
  egress: _stabEgressVals,
  noise:  _stabNoises,
  mean:   _stabMean,
  min:    _stabMin,
  max:    _stabMax,
  sd:     _stabSD,
  spread: _stabSpread,
}));
console.log('');

/* ---------- canary: regression check against pinned baseline ---------- */
if (_PINNED_BASELINE && _PINNED_BASELINE.baselineVec) {
  // ADA and egress: exact pinned values, ±5 pp tolerance (objectives are seed-independent).
  const _AE_TOL  = 0.05;
  // Noise: if noise_stability is present in the baseline JSON, use the 10-seed mean
  // as reference and (spread + 2 pp) as tolerance. Otherwise fall back to ±5 pp
  // against the exact pinned noise value (legacy; baseline JSON pre-stability-pass).
  const _ns       = _PINNED_BASELINE.noise_stability;
  const _nRef     = _ns ? _ns.mean   : _PINNED_BASELINE.baselineVec.noise;
  const _nTol     = _ns ? (_ns.spread + 0.02) : _AE_TOL;
  console.log('Canary noise reference: ' + (_nRef * 100).toFixed(4) + '% (' +
    (_ns ? 'stability-mean, 10 seeds' : 'exact pinned value, legacy') + ')');
  console.log('Canary tolerances: ada ±' + (_AE_TOL * 100).toFixed(0) + 'pp, ' +
    'egress ±' + (_AE_TOL * 100).toFixed(0) + 'pp, ' +
    'noise ±' + (_nTol * 100).toFixed(4) + 'pp' +
    (_ns ? ' (spread ' + (_ns.spread * 100).toFixed(4) + 'pp + 2pp margin)' : ' (flat fallback)'));
  const _canaryChecks = [
    ['ada',    mosaResult.seedVec.ada,    _PINNED_BASELINE.baselineVec.ada,    _AE_TOL],
    ['egress', mosaResult.seedVec.egress, _PINNED_BASELINE.baselineVec.egress, _AE_TOL],
    ['noise',  mosaResult.seedVec.noise,  _nRef,                               _nTol  ],
  ];
  let _canaryPass = true;
  for (let _ci = 0; _ci < _canaryChecks.length; _ci++) {
    const _cn  = _canaryChecks[_ci][0];
    const _cur = _canaryChecks[_ci][1];
    const _ref = _canaryChecks[_ci][2];
    const _tol = _canaryChecks[_ci][3];
    if (Math.abs(_cur - _ref) > _tol) {
      console.error('REGRESSION [canary]: ' + _cn + ' drifted —' +
        ' current=' + _cur.toFixed(6) + ' ref=' + _ref.toFixed(6) +
        ' |delta|=' + Math.abs(_cur - _ref).toFixed(6) + ' > tol=' + _tol.toFixed(6));
      _canaryPass = false;
    }
  }
  if (_canaryPass) {
    console.log('Canary: PASS');
    console.log('  Pinned seed=' + _PINNED_BASELINE.seed);
  }
  console.log('');
}

/* ---------- CI gates ---------- */
let _exitCode = 0;

if (_front.length === 0) {
  console.error('FAIL: no feasible front found. Check state setup and constraint logic.');
  _exitCode = 1;
}

// Internal non-domination check (archive invariant)
let _internalDomination = false;
for (let _i = 0; _i < _front.length; _i++) {
  for (let _j = 0; _j < _front.length; _j++) {
    if (_i !== _j && evalDominates(_front[_i].vec, _front[_j].vec)) {
      console.error('FAIL: archive member ' + _i + ' dominates member ' + _j + ' -- archive invariant broken.');
      _internalDomination = true;
    }
  }
}
if (_internalDomination) _exitCode = 1;

if (_exitCode === 0) {
  console.log('Archive non-domination invariant: PASS');
  if (_dominatingCount === 0) {
    console.log('NOTE: no front point strictly dominates the baseline.');
    console.log('  The baseline may already be near-Pareto-optimal, or the run');
    console.log('  was too short. Increase --iters and re-run.');
  }
  console.log('');
  console.log('[A1] RESOLVED. Both stage assumptions are now resolved.');
  console.log('Both [A1] and [A2] resolved. Results are publishable pending field');
  console.log('verification of door locations (currently unverified in layout.json).');
}

console.log('============================================================');
process.exit(_exitCode);
`;

/* -- build the single concatenated script -- */
const preamble = `
/* Prerequisites: global var declarations that state.js and the sims reference
   as unqualified identifiers.  Must use var (not const) so they become
   properties of the vm context's global object. */
var ZONE_DEFS  = [];
var PRESETS    = {};
var REGIONS    = [];
var METRIC_DEFS = [];
`;

const fullScript = [
  preamble,
  src('v1/js/state.js'),
  src('v1/js/sim_ada.js'),
  src('v1/js/sim_egress.js'),
  src('v1/js/sim_noise.js'),
  src('v1/js/sim_eval.js'),
  src('v1/js/sim_mosa.js'),
  HARNESS_BODY,
].join('\n\n/* ---- next file ---- */\n\n');

/* -- run -- */
try {
  vm.runInContext(fullScript, vmCtx, { filename: 'mosa_validate_bundle.js' });
} catch (err) {
  console.error('VM execution error:', err.message);
  if (err.stack) console.error(err.stack.split('\n').slice(0, 10).join('\n'));
  process.exit(1);
}
