/**
 * v2/engine-adapter.mjs  --  THE SEAM (Node execution half).
 *
 * Takes ONE v2 project JSON, translates it (v2/project-to-engine.mjs), loads the
 * UNMODIFIED v1 engine into a vm context exactly as tools/mosa_validate.mjs does,
 * applies the translated setup to the engine's own `state`/`ZONE_DEFS`, seeds the
 * PRNG identically, calls the UNMODIFIED evaluateLayout / mosaOptimize, and hands
 * results back as plain data. It never reaches into engine internals or
 * re-implements engine math — it only wires schema-in to engine-in and
 * engine-out back to schema.
 *
 * The engine files are loaded verbatim and MUST NOT be edited:
 *   v1/js/state.js, sim_ada.js, sim_egress.js, sim_noise.js, sim_eval.js, sim_mosa.js
 *
 * Public API:
 *   loadEngine(root?)            -> an Engine handle (vm context with the engine loaded)
 *   runProject(project, opts?)   -> { seedVec, frontLength, dominatingCount, stats, front, weights, meta }
 *   evaluateBaseline(project, opts?) -> objective vector for the baseline layout (no optimizer)
 *
 * opts: { iters?: number, seed?: number|string ("0x..."), root?: string }
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';
import { translateProject, applyTranslated } from './project-to-engine.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(__dirname, '..');

/* Engine files, in the exact load order the frozen harness uses. */
const ENGINE_FILES = [
  'v1/js/state.js',
  'v1/js/sim_ada.js',
  'v1/js/sim_egress.js',
  'v1/js/sim_noise.js',
  'v1/js/sim_eval.js',
  'v1/js/sim_mosa.js',
];

/* Mulberry32 — verbatim from the frozen harness's _harnessLCG (itself verbatim
 * from sim_optimizer.js _makeLCG). Injected as source so the seeded sequence is
 * bit-identical to tools/mosa_validate.mjs. */
const HARNESS_LCG_SRC = `
function _harnessLCG(seed) {
  let s = seed >>> 0;
  return function () {
    s += 0x6D2B79F5;
    let z = s;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
}`;

/* The vm-context stub surface, copied from tools/mosa_validate.mjs so the engine
 * sees an identical environment. `__adapterOut` is our result sink (a plain
 * object property of the context, so assignments to it are visible to the host). */
function makeContext() {
  const __adapterOut = {};
  const ctx = vm.createContext({
    console, process,
    Math, JSON,
    Array, Object, Number, String, Boolean, Function,
    Set, Map, Error, TypeError, RangeError,
    parseInt, parseFloat, isFinite, isNaN,
    Infinity, NaN,
    Float32Array, Float64Array, Int32Array, Uint8Array,

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

    simGetCanvas:         () => ({
      getContext: () => ({ clearRect: () => {}, fillRect: () => {}, fillStyle: '', globalAlpha: 1 }),
    }),
    simShowError:         () => {},
    simShowAdaResults:    () => {},
    simShowEgressResults: () => {},
    simShowNoiseResults:  () => {},
    simShowFireResults:   () => {},
    simShowFumesResults:  () => {},
    _simEsc:              s => String(s),

    evaluate:     () => {},
    render:       () => {},
    saveAppState: () => {},

    _scTools:              () => [],
    getAnalysisRooms:      () => [],
    pointInAnalysisScope:  () => true,
    roomPolygonPct:        () => null,
    analysisScopeAreaUnits: () => null,
    roomScopeActive:       () => false,

    convertUnits: (v, from, to) => {
      const M = { m: 1, meter: 1, meters: 1, ft: 0.3048, foot: 0.3048, feet: 0.3048 };
      if (!M[from] || !M[to]) return v;
      return v * M[from] / M[to];
    },
    currentUnit: () => 'ft',

    __adapterOut,
  });
  return { ctx, __adapterOut };
}

const PREAMBLE = `
var ZONE_DEFS  = [];
var PRESETS    = {};
var REGIONS    = [];
var METRIC_DEFS = [];
`;

function readEngine(root) {
  return ENGINE_FILES.map(rel => readFileSync(join(root, rel), 'utf8'))
    .join('\n\n/* ---- next engine file ---- */\n\n');
}

function parseSeed(seed) {
  if (seed == null) return 0x4D524443;
  if (typeof seed === 'number') return seed >>> 0;
  const s = String(seed).trim();
  return (s.toLowerCase().startsWith('0x') ? parseInt(s, 16) : parseInt(s, 10)) >>> 0;
}

/**
 * loadEngine — build a fresh vm context with the engine loaded but NO project
 * applied yet. Returns a handle whose `run(setupAndRunSrc)` executes injected
 * code in the engine's lexical scope and returns the __adapterOut payload.
 */
export function loadEngine(root = DEFAULT_ROOT) {
  const { ctx, __adapterOut } = makeContext();
  const engineSrc = readEngine(root);
  return {
    /** Execute injected code (which sees state, ZONE_DEFS, evaluateLayout, mosaOptimize). */
    run(injected) {
      __adapterOut.value = undefined;
      const full = [PREAMBLE, engineSrc, HARNESS_LCG_SRC, injected].join('\n\n');
      vm.runInContext(full, ctx, { filename: 'v2_adapter_bundle.js' });
      return __adapterOut.value;
    },
  };
}

/**
 * runProject — full MOSA run through the seam.
 * Applies the project, seeds identically to the frozen harness, and calls the
 * unmodified mosaOptimize. Returns the seed (baseline) vector, front size,
 * domination count, stats, and the front's objective vectors.
 */
export function runProject(project, opts = {}) {
  const root = opts.root || DEFAULT_ROOT;
  const t = translateProject(project);
  const seed = parseSeed(opts.seed != null ? opts.seed
    : (project.optimization && project.optimization.seed));
  const iters = opts.iters != null ? opts.iters
    : (project.optimization && project.optimization.iters);

  const mosaOpts = { movableIds: t.movableIds };
  if (typeof iters === 'number' && iters > 0) mosaOpts.iters = iters;

  const injected = `
/* ---- v2 adapter: apply translated project, then run the UNMODIFIED engine ---- */
(${applyTranslated.toString()})(state, ZONE_DEFS, ${JSON.stringify(t)});

Math.random = _harnessLCG(${seed});
var __r = mosaOptimize(${JSON.stringify(mosaOpts)});
var __dom = 0;
for (var __i = 0; __i < __r.front.length; __i++) {
  if (evalDominates(__r.front[__i].vec, __r.seedVec)) __dom++;
}
__adapterOut.value = {
  seedVec: __r.seedVec,
  frontLength: __r.front.length,
  dominatingCount: __dom,
  stats: __r.stats,
  front: __r.front.map(function (p) { return { vec: p.vec, pos: p.pos }; }),
};
`;

  const out = loadEngine(root).run(injected);
  if (!out) throw new Error('adapter run produced no result');
  return { ...out, weights: t.weights, meta: t.meta, seed, iters: mosaOpts.iters };
}

/**
 * evaluateBaseline — the baseline objective vector only (no optimizer), seeded
 * identically. Handy for schema round-trip checks. Note: because the noise MC
 * draws from the PRNG, this is only meaningful under a fixed seed.
 */
export function evaluateBaseline(project, opts = {}) {
  const root = opts.root || DEFAULT_ROOT;
  const t = translateProject(project);
  const seed = parseSeed(opts.seed != null ? opts.seed
    : (project.optimization && project.optimization.seed));
  const injected = `
(${applyTranslated.toString()})(state, ZONE_DEFS, ${JSON.stringify(t)});
var __du = stageDimsUnits();
Math.random = _harnessLCG(${seed});
__adapterOut.value = { vec: evaluateLayout({}, __du.w, __du.h), stage: __du };
`;
  return loadEngine(root).run(injected);
}

export default { loadEngine, runProject, evaluateBaseline };
