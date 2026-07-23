/**
 * tests/run_mosa_tests.mjs  --  Node test runner for sim_mosa.js.
 *
 * Usage:
 *   node tests/run_mosa_tests.mjs
 *
 * Loads all required browser JS as a single concatenated vm script (the
 * same architecture as tools/mosa_validate.mjs) so const/function
 * declarations in each file share one lexical scope.
 *
 * Does NOT load state.js (avoids const re-declaration conflicts).
 * Provides minimal stubs for simBlockerFootprint, overlapArea, clamp, etc.
 */

import { readFileSync }  from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import vm                from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..');

function src(rel) { return readFileSync(join(ROOT, rel), 'utf8'); }

/* -- vm context: browser stubs only -- */
const vmCtx = vm.createContext({
  console, process,
  Math, JSON,
  Array, Object, Number, String, Boolean, Function,
  Set, Map, Error, TypeError, RangeError,
  parseInt, parseFloat, isFinite, isNaN,
  Infinity, NaN,
  Float32Array, Float64Array, Int32Array, Uint8Array,

  /* DOM stubs */
  document: {
    getElementById:   () => ({ innerHTML: '' }),
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

  /* sim_ui.js stubs */
  simGetCanvas: () => ({
    getContext: () => ({ clearRect: () => {}, fillRect: () => {}, fillStyle: '', globalAlpha: 1 }),
  }),
  simShowError:         () => {},
  simShowAdaResults:    () => {},
  simShowEgressResults: () => {},
  simShowNoiseResults:  () => {},
  simShowFireResults:   () => {},
  simShowFumesResults:  () => {},
  _simEsc: s => String(s),

  /* simBlockerFootprint: simple AABB stub (mirrors _node_runner.js). */
  simBlockerFootprint(def, z, stageW, stageH) {
    const cxf = (z.x + z.w / 2) / 100 * stageW;
    const cyf = (z.y + z.h / 2) / 100 * stageH;
    const hw  = z.w / 100 * stageW / 2;
    const hh  = z.h / 100 * stageH / 2;
    const x1  = cxf - hw, y1 = cyf - hh, x2 = cxf + hw, y2 = cyf + hh;
    return {
      test: (xf, yf) => xf >= x1 && xf <= x2 && yf >= y1 && yf <= y2,
      aabb: { x1, y1, x2, y2 },
    };
  },

  /* Scope stubs */
  pointInAnalysisScope:   () => true,
  analysisScopeAreaUnits: () => null,
  roomScopeActive:        () => false,
  getAnalysisRooms:       () => [],
  roomPolygonPct:         () => null,

  /* Unit conversion for sim_noise._noiseRefDist() */
  convertUnits(v, from, to) {
    const M = { m: 1, meter: 1, meters: 1, ft: 0.3048, foot: 0.3048, feet: 0.3048 };
    if (!M[from] || !M[to]) return v;
    return v * M[from] / M[to];
  },
  currentUnit: () => 'ft',

  /* App stubs */
  evaluate:     () => {},
  render:       () => {},
  saveAppState: () => {},
});

/* -- harness preamble: var declarations for globals state.js would provide -- */
const PREAMBLE = `
/* Prerequisites */
var ZONE_DEFS  = [];
var PRESETS    = {};
var REGIONS    = [];
var METRIC_DEFS = [];

/* overlapArea and clamp: needed by mosaOptimize constraint helpers. */
function overlapArea(a, b) {
  var ix = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1));
  var iy = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
  return ix * iy;
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/* State stubs (mirrors tests.js exactly). */
var state = {
  zones: {},
  customElements: [],
  structuralElements: [],
  amenityElements: [],
  activeUse: false,
  analysisRooms: null,
  scale: null,
};

function allZoneDefs() {
  return ZONE_DEFS
    .concat(state.customElements)
    .concat(state.structuralElements)
    .concat(state.amenityElements);
}

function stageDimsUnits() {
  if (!state.scale) return null;
  return { w: state.scale.stageW_ft, h: state.scale.stageH_ft };
}

function _resetState() {
  state.zones              = {};
  state.customElements     = [];
  state.structuralElements = [];
  state.amenityElements    = [];
  ZONE_DEFS.length         = 0;
  state.scale = { stageW_ft: 80, stageH_ft: 50 };
}

function _addZone(def, pos) {
  ZONE_DEFS.push(def);
  state.zones[def.id] = Object.assign(
    { x: 0, y: 0, w: def.w || 10, h: def.h || 10, included: true, rotation: 0, activeUse: false },
    pos
  );
}

/* Test runner */
var _results = [];

function test(name, fn) {
  try {
    var r = fn();
    _results.push({ name: name, pass: !!r.pass, detail: r.detail || '' });
  } catch (e) {
    _results.push({ name: name, pass: false, detail: 'Exception: ' + e.message });
  }
}

function renderResults() {
  /* In Node: print results to stdout after all tests run. */
  var pass = _results.filter(function(r) { return r.pass; }).length;
  var fail = _results.filter(function(r) { return !r.pass; }).length;
  console.log('');
  console.log('=== MOSA Test Results ===');
  console.log(pass + ' passed, ' + fail + ' failed');
  console.log('');
  for (var i = 0; i < _results.length; i++) {
    var r = _results[i];
    var marker = r.pass ? 'PASS' : 'FAIL';
    var detail = r.detail ? '  [' + r.detail + ']' : '';
    console.log(marker + '  ' + r.name + detail);
  }
  if (fail > 0) process.exit(1);
}
`;

/* -- build single concatenated script -- */
const fullScript = [
  PREAMBLE,
  src('v1/js/sim_ada.js'),
  src('v1/js/sim_egress.js'),
  src('v1/js/sim_noise.js'),
  src('v1/js/sim_eval.js'),
  src('v1/js/sim_mosa.js'),
  src('tests/tests_mosa.js'),
].join('\n\n/* ---- next file ---- */\n\n');

/* -- run -- */
try {
  vm.runInContext(fullScript, vmCtx, { filename: 'mosa_tests_bundle.js' });
} catch (err) {
  console.error('VM execution error:', err.message);
  if (err.stack) console.error(err.stack.split('\n').slice(0, 10).join('\n'));
  process.exit(1);
}
