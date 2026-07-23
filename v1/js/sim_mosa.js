"use strict";
/* ------------------------------------------------------------------
   MOSA — Multi-Objective Simulated Annealing for layout optimization.
   Produces a Pareto front over {ada, egress, noise} from sim_eval.js.

   This file is additive only. It does not modify optimize.js,
   sim_eval.js, or any of Rahul's engine files.

   Load order (browser):
     sim_ada.js → sim_egress.js → sim_noise.js → sim_eval.js → sim_mosa.js

   sim_mosa.js is NOT yet wired to index.html (Rahul's file; no new
   <script> tags allowed there). Wire it the same way the optimizer is
   wired: inline the call inside sim_ui.js once ready.

   Algorithm:
     Randomized-weight SA. Each iteration samples a random weight vector
     w uniformly on the 3-simplex. The scalar w·vec is used as the SA
     acceptance criterion (lower is better). Varying w each step spreads
     search pressure across the front instead of converging to a single
     objective weighting. The archive collects all non-dominated feasible
     candidates encountered; it is pruned to ARCHIVE_CAP using a crowding
     distance criterion when it overflows.

   Constraints (reused from optimize.js):
     • rotation-aware AABB footprint stays inside analysis scope (footInside)
     • no overlap > 0.3 %² with obstacles or other movables (collides)

   State contract:
     Reads and temporarily mutates state.zones[id].{x,y,rotation} during
     the search (same pattern as optimize.js). Always restores the original
     positions before returning, even on error.
   ------------------------------------------------------------------ */

/* ---- Mulberry32 PRNG (verbatim from sim_optimizer.js _makeLCG) ---- */
function _makeLCG(seed) {
  let s = seed >>> 0;
  return function () {
    s += 0x6D2B79F5;
    let z = s;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---- weight vector sampling: uniform distribution on the 3-simplex ---- */
function _mosaSampleWeights() {
  // Exponential normalisation: if E_i ~ Exp(1), then (E_0,E_1,E_2)/sum is
  // uniform on the simplex. -log(U) gives an Exp(1) sample from U~Uniform(0,1).
  const e0 = -Math.log(Math.random() || 1e-10);
  const e1 = -Math.log(Math.random() || 1e-10);
  const e2 = -Math.log(Math.random() || 1e-10);
  const s = e0 + e1 + e2;
  return [e0 / s, e1 / s, e2 / s];
}

/* ---- archive management ---- */
const ARCHIVE_CAP = 40;

function _mosaArchiveInsert(archive, pos, vec) {
  // Reject if any existing member Pareto-dominates this candidate.
  for (const m of archive) {
    if (evalDominates(m.vec, vec)) return false;
  }
  // Remove members the new candidate dominates.
  for (let i = archive.length - 1; i >= 0; i--) {
    if (evalDominates(vec, archive[i].vec)) archive.splice(i, 1);
  }
  archive.push({ pos, vec: { ada: vec.ada, egress: vec.egress, noise: vec.noise } });

  // Prune if over cap: drop the most crowded member (smallest min-distance
  // to any other member in objective space). This preserves spread.
  if (archive.length > ARCHIVE_CAP) {
    let dropIdx = 0, dropMinDist = Infinity;
    for (let i = 0; i < archive.length; i++) {
      let minD = Infinity;
      const vi = archive[i].vec;
      for (let j = 0; j < archive.length; j++) {
        if (i === j) continue;
        const vj = archive[j].vec;
        const d = Math.hypot(vi.ada - vj.ada, vi.egress - vj.egress, vi.noise - vj.noise);
        if (d < minD) minD = d;
      }
      if (minD < dropMinDist) { dropMinDist = minD; dropIdx = i; }
    }
    archive.splice(dropIdx, 1);
  }
  return true;
}

/* ======================================================================
   mosaOptimize(opts) — headless Pareto optimizer, DOM-free.

   opts (all optional):
     movableIds  — array of element id strings to move. When absent,
                   falls back to _scTools() filtered for non-locked zones
                   (browser context only).
     iters       — SA iteration count (default: 80 * movable.length,
                   clamped to [800, 2000]).
     startT      — initial SA temperature (default 0.15; objectives are
                   normalised to [0,1]).
     cool        — geometric per-step multiplier (default derived to
                   reach ~0.005 by end).
     seed        — if provided, patches Math.random with Mulberry32(seed)
                   for the full duration of the search (seed layout eval +
                   move selection + noise MC draws), then restores the
                   original Math.random on every exit path. Makes the front
                   fully reproducible. Default: unseeded.

   Returns { front, seedVec, stats } where:
     front     — array of { pos, vec } at the Pareto non-dominated set.
                 pos is a snapshot {id: {x,y,rotation}}, vec is {ada,egress,noise}.
     seedVec   — objective vector for the original (seed) layout.
     stats     — diagnostic counters.

   Restores state.zones to the original layout on every exit path.
   ====================================================================== */
function mosaOptimize(opts) {
  opts = opts || {};

  /* --- stage dimensions (required) --- */
  const du = (typeof stageDimsUnits === "function") ? stageDimsUnits() : null;
  if (!du) return { front: [], seedVec: null, stats: { error: "no_scale" } };
  const stageW = du.w, stageH = du.h;

  /* --- identify movable tools --- */
  let movable;
  if (opts.movableIds) {
    movable = opts.movableIds
      .map(id => allZoneDefs().find(d => d.id === id) || { id })
      .filter(d => state.zones[d.id] && !state.zones[d.id].locked);
  } else if (typeof _scTools === "function") {
    movable = _scTools().filter(t => { const z = state.zones[t.id]; return z && !z.locked; });
  } else {
    return { front: [], seedVec: null, stats: { error: "no_tools_fn" } };
  }
  if (movable.length < 2) {
    return { front: [], seedVec: null, stats: { error: "too_few_movable", count: movable.length } };
  }

  /* --- scope bounding box --- */
  const rooms = (typeof getAnalysisRooms === "function") ? getAnalysisRooms() : [];
  let bb = { x1: 2, y1: 2, x2: 98, y2: 98 };
  if (rooms.length) {
    bb = { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity };
    for (const f of rooms) {
      const poly = (typeof roomPolygonPct === "function") ? roomPolygonPct(f) : null;
      if (!poly) continue;
      for (const p of poly) {
        bb.x1 = Math.min(bb.x1, p.x); bb.y1 = Math.min(bb.y1, p.y);
        bb.x2 = Math.max(bb.x2, p.x); bb.y2 = Math.max(bb.y2, p.y);
      }
    }
  }
  const inScope = (x, y) =>
    (typeof pointInAnalysisScope === "function") ? pointInAnalysisScope(x, y) : true;

  /* --- obstacles and constraint helpers (mirrors optimize.js exactly) --- */
  const movableIds = new Set(movable.map(t => t.id));
  const obstacles = allZoneDefs().filter(d => {
    const z = state.zones[d.id];
    if (!z || z.included === false) return false;
    if (d.elementClass === "structural" && d.subtype === "floor") return false;
    return !movableIds.has(d.id);
  });

  const rotAABB = z => {
    const a = (z.rotation || 0) * Math.PI / 180;
    const c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
    const ew = z.w * c + z.h * s, eh = z.w * s + z.h * c;
    const cx = z.x + z.w / 2, cy = z.y + z.h / 2;
    return { x1: cx - ew / 2, y1: cy - eh / 2, x2: cx + ew / 2, y2: cy + eh / 2 };
  };
  const footInside = z => {
    const a = rotAABB(z), p = 0.3;
    return inScope(a.x1 + p, a.y1 + p) && inScope(a.x2 - p, a.y1 + p) &&
           inScope(a.x1 + p, a.y2 - p) && inScope(a.x2 - p, a.y2 - p) &&
           inScope((a.x1 + a.x2) / 2, (a.y1 + a.y2) / 2);
  };
  const collides = (id, z) => {
    const ra = rotAABB(z);
    for (const o of obstacles) {
      const oz = state.zones[o.id];
      if (oz && overlapArea(ra, rotAABB(oz)) > 0.3) return true;
    }
    for (const m of movable) {
      if (m.id === id) continue;
      const mz = state.zones[m.id];
      if (mz && overlapArea(ra, rotAABB(mz)) > 0.3) return true;
    }
    return false;
  };

  const ROTS = [0, 90, 180, 270];

  /* Snapshot/restore: record {x,y,rotation} for all movables. */
  const snapshot = () => {
    const s = {};
    for (const t of movable) {
      const z = state.zones[t.id];
      s[t.id] = { x: z.x, y: z.y, rotation: z.rotation || 0 };
    }
    return s;
  };
  const restore = s => {
    for (const id in s) {
      const z = state.zones[id];
      if (z) { z.x = s[id].x; z.y = s[id].y; z.rotation = s[id].rotation; }
    }
  };

  /* --- PRNG seeding: patch Math.random if opts.seed is given --- */
  // Covers the seed layout eval, all move selection draws, and all noise MC
  // draws inside evaluateLayout — restored in the finally block below.
  const _savedRandom = Math.random;
  if (opts.seed !== undefined) Math.random = _makeLCG(opts.seed);

  /* --- seed and baseline --- */
  const original = snapshot();

  /* evaluateLayout({}, stageW, stageH): passes empty layout so sims use
     state.zones as-is. Since we mutate zone objects directly (same pattern
     as optimize.js), the mutations are visible to evaluateLayout's shallow
     copy of state.zones, and they persist after evaluateLayout restores the
     state.zones reference in its finally block. */
  const seedVec = evaluateLayout({}, stageW, stageH);

  /* --- SA parameters --- */
  const n = movable.length;
  const ITERS = opts.iters !== undefined
    ? opts.iters
    : Math.min(2000, Math.max(800, 80 * n));
  const startT = opts.startT !== undefined ? opts.startT : 0.15;
  const endT   = 0.005;
  const COOL   = opts.cool !== undefined
    ? opts.cool
    : Math.pow(endT / startT, 1 / Math.max(1, ITERS - 1));

  let T = startT;

  /* --- archive and initial seed --- */
  const archive = [];

  /* Seed archive with the baseline if it is feasible. */
  let baseFeasible = true;
  for (const t of movable) {
    const z = state.zones[t.id];
    if (!footInside(z) || collides(t.id, z)) { baseFeasible = false; break; }
  }
  if (baseFeasible) _mosaArchiveInsert(archive, snapshot(), seedVec);

  /* Current objective vector: tracks the "current" SA state. */
  let curVec = { ada: seedVec.ada, egress: seedVec.egress, noise: seedVec.noise };

  let accepted = 0, rejected = 0, infeasible = 0, archived = 0;

  try {
    for (let it = 0; it < ITERS; it++) {
      T *= COOL;

      /* Sample a random weight vector uniformly on the 3-simplex. */
      const [wa, we, wn] = _mosaSampleWeights();
      const curScalar = wa * curVec.ada + we * curVec.egress + wn * curVec.noise;

      /* Pick a random movable and propose a move (same three types as optimize.js). */
      const t = movable[Math.floor(Math.random() * movable.length)];
      const z = state.zones[t.id];
      const prev = { x: z.x, y: z.y, rotation: z.rotation || 0 };

      const move = Math.random();
      if (move < 0.25) {
        /* Rotation. */
        z.rotation = ROTS[Math.floor(Math.random() * ROTS.length)];
      } else if (move < 0.55) {
        /* Local nudge (±12 % of stage). */
        z.x = clamp(prev.x + (Math.random() - 0.5) * 12, 0, 100 - z.w);
        z.y = clamp(prev.y + (Math.random() - 0.5) * 12, 0, 100 - z.h);
      } else {
        /* Global jump inside bounding box. */
        z.x = clamp(bb.x1 + Math.random() * Math.max(0.1, bb.x2 - bb.x1 - z.w), 0, 100 - z.w);
        z.y = clamp(bb.y1 + Math.random() * Math.max(0.1, bb.y2 - bb.y1 - z.h), 0, 100 - z.h);
        if (Math.random() < 0.5) z.rotation = ROTS[Math.floor(Math.random() * ROTS.length)];
      }

      /* Hard constraints: reject infeasible moves immediately. */
      if (!footInside(z) || collides(t.id, z)) {
        z.x = prev.x; z.y = prev.y; z.rotation = prev.rotation;
        infeasible++;
        continue;
      }

      /* Evaluate. evaluateLayout reads state.zones (which we just mutated). */
      const newVec = evaluateLayout({}, stageW, stageH);
      const newScalar = wa * newVec.ada + we * newVec.egress + wn * newVec.noise;
      const delta = newScalar - curScalar;

      /* SA acceptance criterion (lower scalar = better). */
      if (delta <= 0 || Math.random() < Math.exp(-delta / Math.max(1e-9, T))) {
        curVec = newVec;
        if (_mosaArchiveInsert(archive, snapshot(), newVec)) archived++;
        accepted++;
      } else {
        /* Reject: restore the single mutated zone. */
        z.x = prev.x; z.y = prev.y; z.rotation = prev.rotation;
        rejected++;
      }
    }
  } finally {
    /* Always restore the original layout — headless safety. */
    restore(original);
    /* Always restore Math.random (no-op when opts.seed was not provided). */
    Math.random = _savedRandom;
  }

  return {
    front: archive.slice(),
    seedVec: { ada: seedVec.ada, egress: seedVec.egress, noise: seedVec.noise },
    stats: {
      iters: ITERS, accepted, rejected, infeasible, archived,
      archiveSize: archive.length,
      finalT: T,
    },
  };
}

/* ---- thin browser wrapper: apply the knee point and ask for confirmation ---- */
function mosaOptimizeUI() {
  /* This function may touch the DOM. Do NOT call it from the validation harness. */
  const result = mosaOptimize();
  if (!result.front.length) {
    if (typeof alert === "function") {
      alert("MOSA: no feasible Pareto solutions found. Layout unchanged.");
    }
    return;
  }

  /* Knee: front point closest to the ideal point (all zeros) in objective space. */
  let knee = result.front[0], kneeDist = Infinity;
  for (const pt of result.front) {
    const d = Math.hypot(pt.vec.ada, pt.vec.egress, pt.vec.noise);
    if (d < kneeDist) { kneeDist = d; knee = pt; }
  }

  /* Save original positions so we can revert. */
  const original = {};
  for (const id in knee.pos) {
    const z = state.zones[id];
    if (z) original[id] = { x: z.x, y: z.y, rotation: z.rotation || 0 };
  }

  /* Apply the knee point. */
  for (const id in knee.pos) {
    const z = state.zones[id];
    if (!z) continue;
    z.x = knee.pos[id].x; z.y = knee.pos[id].y; z.rotation = knee.pos[id].rotation;
  }
  if (typeof evaluate === "function") evaluate();
  if (typeof render   === "function") render();

  const s = result.seedVec, b = knee.vec;
  const fmt = v => (v * 100).toFixed(1);
  const keep = typeof confirm === "function" && confirm(
    "MOSA Optimizer: " + result.front.length + " Pareto front solutions found.\n" +
    "Knee point shown (closest to ideal):\n" +
    "  ADA:    " + fmt(s.ada)    + "% -> " + fmt(b.ada)    + "%\n" +
    "  Egress: " + fmt(s.egress) + "% -> " + fmt(b.egress) + "%\n" +
    "  Noise:  " + fmt(s.noise)  + "% -> " + fmt(b.noise)  + "%\n\n" +
    "Keep this arrangement? (Cancel to revert)"
  );
  if (!keep) {
    for (const id in original) {
      const z = state.zones[id]; if (!z) continue;
      z.x = original[id].x; z.y = original[id].y; z.rotation = original[id].rotation;
    }
    if (typeof evaluate === "function") evaluate();
    if (typeof render   === "function") render();
  }
  if (typeof saveAppState === "function") saveAppState();
}
