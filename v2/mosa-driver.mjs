/**
 * v2/mosa-driver.mjs  --  v2 Phase O1: generalized MOSA driver (N objectives).
 *
 * A drop-in replacement for sim_mosa.js's mosaOptimize that works over an ARBITRARY
 * objective set, WITHOUT editing any engine file. It reuses the engine's proven math
 * (evaluateLayout, allZoneDefs, overlapArea, clamp, stageDimsUnits) through the V0
 * seam vm, and reimplements ONLY the five places sim_mosa hardcodes three objectives
 * (Task 0 finding (b)): the weight sampler, scalarization, dominance, crowding-prune,
 * and archive vector storage — each generalized to n dimensions.
 *
 * ── DRAW-ORDER PRESERVATION (the make-or-break) ───────────────────────────────
 * SA determinism depends on the exact SEQUENCE and COUNT of Math.random() calls.
 * sim_mosa's per-iteration draw sequence is:
 *     _mosaSampleWeights()  -> 3 draws (e0,e1,e2)           [sim_mosa.js:51-53]
 *     movable pick          -> 1 draw                        [sim_mosa.js:267]
 *     move type             -> 1 draw                        [sim_mosa.js:271]
 *     move params           -> 1..4 draws (branch-dependent) [sim_mosa.js:274-283]
 *     (if feasible) evaluateLayout -> N draws (noise MC)     [sim_mosa.js:294]
 *     (if delta>0) acceptance      -> 1 draw                 [sim_mosa.js:299]
 * The ONLY draw whose COUNT depends on the objective count is the weight sampler.
 * Our n-simplex sampler draws exactly `n` in a for-loop; for n=3 that is the SAME
 * three -log(random()) draws in the SAME order as _mosaSampleWeights, with the SAME
 * `e[i]/s` normalization — so the entire per-iteration draw sequence is bit-identical
 * for the three-objective case. Everything else in the loop body is copied verbatim
 * from mosaOptimize (same thresholds 0.25/0.55, same ±12% nudge, same bb jump, same
 * ROTS, same feasibility gate, same acceptance rule), so it draws identically.
 * evaluateLayout is called AT MOST ONCE per candidate (memoized into ctx.engine and
 * shared across all engine objectives) — matching sim_mosa's single call — so the
 * noise-MC draw count per candidate is unchanged.
 *
 * The seed is applied globally (Math.random = _harnessLCG(seed)) before the driver
 * runs, exactly as the frozen harness seeds mosaOptimize; the first draw the driver
 * makes is the seed-layout evaluateLayout, matching sim_mosa.js:227.
 *
 * Public API:
 *   runGeneralizedMosa(project, objectiveIds, opts?) -> { seedVec, front, stats, objIds, ... }
 */

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { loadEngine } from './engine-adapter.mjs';
import { translateProject, applyTranslated } from './project-to-engine.mjs';
import { getObjectives } from './objectives.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(__dirname, '..');

const ARCHIVE_CAP = 40;   // identical to sim_mosa.js:59

function parseSeed(seed) {
  if (seed == null) return 0x4D524443;
  if (typeof seed === 'number') return seed >>> 0;
  const s = String(seed).trim();
  return (s.toLowerCase().startsWith('0x') ? parseInt(s, 16) : parseInt(s, 10)) >>> 0;
}

/* ══════════════════════════════════════════════════════════════════════════
 * _runGenMosa — the vm-side driver. SELF-CONTAINED (references only its args,
 * Math, and the engine globals lexically present in the vm: state, evaluateLayout,
 * allZoneDefs, overlapArea, clamp, stageDimsUnits, getAnalysisRooms, roomPolygonPct,
 * pointInAnalysisScope). Injected via .toString(). Mirrors mosaOptimize verbatim
 * except at the five generalization points, each marked [GEN].
 *
 * objDefs : [ { id, needsEngine, evaluate } ]  (evaluate reconstructed in the vm)
 * movableIds : array of element ids to optimize
 * itersOpt : iteration count (undefined -> sim_mosa default)
 * ════════════════════════════════════════════════════════════════════════ */
function _runGenMosa(objDefs, movableIds, itersOpt) {
  var NOBJ = objDefs.length;

  /* [GEN] n-simplex weight sampler. For n=3 this draws e0,e1,e2 in order and
     returns e[i]/s — bit-identical to _mosaSampleWeights (sim_mosa.js:48-56). */
  function _sampleWeightsN(n) {
    var e = new Array(n), s = 0, i;
    for (i = 0; i < n; i++) { e[i] = -Math.log(Math.random() || 1e-10); s += e[i]; }
    for (i = 0; i < n; i++) { e[i] = e[i] / s; }
    return e;
  }

  /* [GEN] scalarization: sum_i w[i]*vec[i]. Left-to-right accumulation from 0 is
     bit-identical to `wa*v0 + we*v1 + wn*v2` (0+w0v0 == w0v0 exactly). */
  function _scalar(w, vec) {
    var s = 0;
    for (var i = 0; i < w.length; i++) { s += w[i] * vec[i]; }
    return s;
  }

  /* [GEN] Pareto dominance over all objectives (minimize). Identical booleans to
     evalDominates (sim_eval.js:139-146) on the three-objective case. */
  function _dominates(a, b) {
    var allLE = true, anyLT = false;
    for (var i = 0; i < a.length; i++) {
      if (a[i] > b[i]) allLE = false;
      if (a[i] < b[i]) anyLT = true;
    }
    return allLE && anyLT;
  }

  /* [GEN] archive insert + crowding prune, n-dimensional. Mirrors _mosaArchiveInsert
     (sim_mosa.js:61-90): same reject-check order, same backward removal, same push,
     same "drop smallest min-distance, first-wins-ties" prune. Math.hypot over the
     n diffs == the literal 3-arg hypot for n=3. */
  function _archiveInsert(archive, pos, vec) {
    for (var m = 0; m < archive.length; m++) {
      if (_dominates(archive[m].vec, vec)) return false;
    }
    for (var i = archive.length - 1; i >= 0; i--) {
      if (_dominates(vec, archive[i].vec)) archive.splice(i, 1);
    }
    archive.push({ pos: pos, vec: vec.slice() });

    if (archive.length > 40) {
      var dropIdx = 0, dropMinDist = Infinity;
      for (var a = 0; a < archive.length; a++) {
        var minD = Infinity;
        var vi = archive[a].vec;
        for (var j = 0; j < archive.length; j++) {
          if (a === j) continue;
          var vj = archive[j].vec;
          var diffs = new Array(vi.length);
          for (var d = 0; d < vi.length; d++) { diffs[d] = vi[d] - vj[d]; }
          var dist = Math.hypot.apply(Math, diffs);
          if (dist < minD) minD = dist;
        }
        if (minD < dropMinDist) { dropMinDist = minD; dropIdx = a; }
      }
      archive.splice(dropIdx, 1);
    }
    return true;
  }

  /* --- stage dimensions (required) --- */
  var du = (typeof stageDimsUnits === "function") ? stageDimsUnits() : null;
  if (!du) return { front: [], seedVec: null, stats: { error: "no_scale" }, objIds: [] };
  var stageW = du.w, stageH = du.h;

  /* --- identify movable tools (mirrors mosaOptimize opts.movableIds branch) --- */
  var movable = movableIds
    .map(function (id) { return allZoneDefs().find(function (d) { return d.id === id; }) || { id: id }; })
    .filter(function (d) { return state.zones[d.id] && !state.zones[d.id].locked; });
  if (movable.length < 2) {
    return { front: [], seedVec: null, stats: { error: "too_few_movable", count: movable.length }, objIds: [] };
  }
  var movIds = movable.map(function (m) { return m.id; });

  /* --- scope bounding box (identical to mosaOptimize) --- */
  var rooms = (typeof getAnalysisRooms === "function") ? getAnalysisRooms() : [];
  var bb = { x1: 2, y1: 2, x2: 98, y2: 98 };
  if (rooms.length) {
    bb = { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity };
    for (var f = 0; f < rooms.length; f++) {
      var poly = (typeof roomPolygonPct === "function") ? roomPolygonPct(rooms[f]) : null;
      if (!poly) continue;
      for (var p = 0; p < poly.length; p++) {
        bb.x1 = Math.min(bb.x1, poly[p].x); bb.y1 = Math.min(bb.y1, poly[p].y);
        bb.x2 = Math.max(bb.x2, poly[p].x); bb.y2 = Math.max(bb.y2, poly[p].y);
      }
    }
  }
  var inScope = function (x, y) {
    return (typeof pointInAnalysisScope === "function") ? pointInAnalysisScope(x, y) : true;
  };

  /* --- obstacles and constraint helpers (mirrors optimize.js / mosaOptimize) --- */
  var movableIdSet = {};
  for (var mi = 0; mi < movable.length; mi++) { movableIdSet[movable[mi].id] = true; }
  var obstacles = allZoneDefs().filter(function (d) {
    var z = state.zones[d.id];
    if (!z || z.included === false) return false;
    if (d.elementClass === "structural" && d.subtype === "floor") return false;
    return !movableIdSet[d.id];
  });

  var rotAABB = function (z) {
    var a = (z.rotation || 0) * Math.PI / 180;
    var c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
    var ew = z.w * c + z.h * s, eh = z.w * s + z.h * c;
    var cx = z.x + z.w / 2, cy = z.y + z.h / 2;
    return { x1: cx - ew / 2, y1: cy - eh / 2, x2: cx + ew / 2, y2: cy + eh / 2 };
  };
  var footInside = function (z) {
    var a = rotAABB(z), pd = 0.3;
    return inScope(a.x1 + pd, a.y1 + pd) && inScope(a.x2 - pd, a.y1 + pd) &&
           inScope(a.x1 + pd, a.y2 - pd) && inScope(a.x2 - pd, a.y2 - pd) &&
           inScope((a.x1 + a.x2) / 2, (a.y1 + a.y2) / 2);
  };
  var collides = function (id, z) {
    var ra = rotAABB(z);
    for (var o = 0; o < obstacles.length; o++) {
      var oz = state.zones[obstacles[o].id];
      if (oz && overlapArea(ra, rotAABB(oz)) > 0.3) return true;
    }
    for (var mm = 0; mm < movable.length; mm++) {
      if (movable[mm].id === id) continue;
      var mz = state.zones[movable[mm].id];
      if (mz && overlapArea(ra, rotAABB(mz)) > 0.3) return true;
    }
    return false;
  };

  var ROTS = [0, 90, 180, 270];

  var snapshot = function () {
    var s = {};
    for (var t = 0; t < movable.length; t++) {
      var z = state.zones[movable[t].id];
      s[movable[t].id] = { x: z.x, y: z.y, rotation: z.rotation || 0 };
    }
    return s;
  };
  var restore = function (s) {
    for (var id in s) {
      var z = state.zones[id];
      if (z) { z.x = s[id].x; z.y = s[id].y; z.rotation = s[id].rotation; }
    }
  };

  /* --- build an n-dim objective vector for the CURRENT layout. Calls
     evaluateLayout AT MOST ONCE (shared across engine objectives), matching
     sim_mosa's single evaluateLayout per candidate. No objective evaluate() draws
     randomness, so this preserves the draw sequence. --- */
  function buildVec() {
    var needEngine = false;
    for (var k = 0; k < objDefs.length; k++) { if (objDefs[k].needsEngine) { needEngine = true; break; } }
    var ctx = {
      engine: null, movableIds: movIds, state: state,
      stageW: stageW, stageH: stageH,
    };
    if (needEngine) ctx.engine = evaluateLayout({}, stageW, stageH);   // ONE draw-bearing call
    var vec = new Array(objDefs.length);
    for (var k2 = 0; k2 < objDefs.length; k2++) { vec[k2] = objDefs[k2].evaluate(ctx); }
    return vec;
  }

  /* --- snapshot original + seed baseline (mirrors sim_mosa.js:220-227) --- */
  var original = snapshot();
  var seedVec = buildVec();               // first draw-bearing call == sim_mosa.js:227

  /* --- SA parameters (identical to mosaOptimize) --- */
  var n = movable.length;
  var ITERS = (itersOpt !== undefined && itersOpt !== null)
    ? itersOpt : Math.min(2000, Math.max(800, 80 * n));
  var startT = 0.15, endT = 0.005;
  var COOL = Math.pow(endT / startT, 1 / Math.max(1, ITERS - 1));
  var T = startT;

  /* --- archive + initial seed (mirrors sim_mosa.js:242-254) --- */
  var archive = [];
  var baseFeasible = true;
  for (var tf = 0; tf < movable.length; tf++) {
    var zf = state.zones[movable[tf].id];
    if (!footInside(zf) || collides(movable[tf].id, zf)) { baseFeasible = false; break; }
  }
  if (baseFeasible) _archiveInsert(archive, snapshot(), seedVec);

  var curVec = seedVec.slice();
  var accepted = 0, rejected = 0, infeasible = 0, archived = 0;

  try {
    for (var it = 0; it < ITERS; it++) {
      T *= COOL;

      /* [GEN] sample n-simplex weights (n draws; 3 for the frozen case). */
      var w = _sampleWeightsN(NOBJ);
      var curScalar = _scalar(w, curVec);

      /* pick a random movable + propose a move (verbatim from sim_mosa.js:267-284) */
      var t = movable[Math.floor(Math.random() * movable.length)];
      var z = state.zones[t.id];
      var prev = { x: z.x, y: z.y, rotation: z.rotation || 0 };

      var move = Math.random();
      if (move < 0.25) {
        z.rotation = ROTS[Math.floor(Math.random() * ROTS.length)];
      } else if (move < 0.55) {
        z.x = clamp(prev.x + (Math.random() - 0.5) * 12, 0, 100 - z.w);
        z.y = clamp(prev.y + (Math.random() - 0.5) * 12, 0, 100 - z.h);
      } else {
        z.x = clamp(bb.x1 + Math.random() * Math.max(0.1, bb.x2 - bb.x1 - z.w), 0, 100 - z.w);
        z.y = clamp(bb.y1 + Math.random() * Math.max(0.1, bb.y2 - bb.y1 - z.h), 0, 100 - z.h);
        if (Math.random() < 0.5) z.rotation = ROTS[Math.floor(Math.random() * ROTS.length)];
      }

      /* hard constraints: reject infeasible immediately (NO evaluateLayout draw) */
      if (!footInside(z) || collides(t.id, z)) {
        z.x = prev.x; z.y = prev.y; z.rotation = prev.rotation;
        infeasible++;
        continue;
      }

      /* evaluate (ONE evaluateLayout draw-batch, same as sim_mosa.js:294) */
      var newVec = buildVec();
      var newScalar = _scalar(w, newVec);
      var delta = newScalar - curScalar;

      /* SA acceptance — same short-circuit so the acceptance draw fires iff delta>0 */
      if (delta <= 0 || Math.random() < Math.exp(-delta / Math.max(1e-9, T))) {
        curVec = newVec;
        if (_archiveInsert(archive, snapshot(), newVec)) archived++;
        accepted++;
      } else {
        z.x = prev.x; z.y = prev.y; z.rotation = prev.rotation;
        rejected++;
      }
    }
  } finally {
    restore(original);
  }

  return {
    front: archive.map(function (mo) { return { pos: mo.pos, vec: mo.vec }; }),
    seedVec: seedVec,
    stats: {
      iters: ITERS, accepted: accepted, rejected: rejected, infeasible: infeasible,
      archived: archived, archiveSize: archive.length, finalT: T,
    },
    objIds: objDefs.map(function (o) { return o.id; }),
  };
}

/**
 * runGeneralizedMosa — host entry. Loads the engine into the V0 seam vm, applies the
 * translated project, seeds identically to the frozen harness, injects the driver +
 * the selected objectives' evaluate sources, runs, and returns plain data.
 *
 * project      : v2 project JSON
 * objectiveIds : array of registry ids (e.g. ['ada','egress','noise'])
 * opts         : { seed?, iters?, root? }
 *
 * Returns { seedVec:[...], seedVecObj:{id:val}, front:[{pos,vec:[...]}], stats,
 *           objIds:[...], seed, iters }.
 */
export function runGeneralizedMosa(project, objectiveIds, opts = {}) {
  const root = opts.root || DEFAULT_ROOT;
  const objectives = getObjectives(objectiveIds);
  const t = translateProject(project);
  const seed = parseSeed(opts.seed != null ? opts.seed
    : (project.optimization && project.optimization.seed));
  const iters = opts.iters != null ? opts.iters
    : (project.optimization && project.optimization.iters);

  const movableIds = t.movableIds;

  // Reconstruct each objective's evaluate() in the vm from its source. The defs are
  // pure (reference only ctx/Math/vm globals), so .toString() round-trips cleanly.
  const objLiteral = '[' + objectives.map(o =>
    `{ id: ${JSON.stringify(o.id)}, needsEngine: ${!!o.needsEngine}, evaluate: (${o.evaluate.toString()}) }`
  ).join(', ') + ']';

  const itersArg = (typeof iters === 'number' && iters > 0) ? String(iters) : 'undefined';

  const injected = `
/* ---- v2 O1: apply translated project, then run the GENERALIZED driver ---- */
(${applyTranslated.toString()})(state, ZONE_DEFS, ${JSON.stringify(t)});

var __OBJ = ${objLiteral};
${_runGenMosa.toString()}

Math.random = _harnessLCG(${seed});
var __r = _runGenMosa(__OBJ, ${JSON.stringify(movableIds)}, ${itersArg});
__adapterOut.value = {
  seedVec: __r.seedVec,
  front: __r.front,
  stats: __r.stats,
  objIds: __r.objIds,
};
`;

  const out = loadEngine(root).run(injected);
  if (!out) throw new Error('generalized driver produced no result');

  // Convenience: seedVec as an {id: value} object.
  const seedVecObj = {};
  out.objIds.forEach((id, i) => { seedVecObj[id] = out.seedVec[i]; });

  return { ...out, seedVecObj, seed, iters: (typeof iters === 'number' ? iters : undefined) };
}

export default { runGeneralizedMosa, ARCHIVE_CAP };
