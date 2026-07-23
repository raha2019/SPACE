/**
 * v2/objectives.mjs  --  v2 Phase O1: the objective registry.
 *
 * The audit found MOSA hardcodes exactly three objectives (ada, egress, noise)
 * across the dominance test, crowding distance, archive, frontier, and weight
 * sampler. This registry makes the objective SET configurable and arbitrary in
 * count, so every planned objective (tool adjacency, safety zones, workflow
 * distance, supervision sightlines, active-users, amenity linkages) plugs in
 * without rewriting the plumbing.
 *
 * An objective is a declared object:
 *   {
 *     id         : stable string key (also the vec order key),
 *     name       : human-readable label,
 *     direction  : "minimize"  (all current objectives minimize; lower = better),
 *     needsEngine: whether evaluate() reads the shared evaluateLayout result,
 *     provenance : a source clause or "design assumption" (the project discipline),
 *     evaluate   : function(ctx) -> normalized value in [0,1].
 *   }
 *
 * CRITICAL — determinism & the single engine eval:
 *   Each evaluate(ctx) must be SELF-CONTAINED (reference only its `ctx` arg, Math,
 *   and vm globals) because the driver injects evaluate.toString() into the engine
 *   vm. And evaluate() MUST NOT itself call evaluateLayout — the driver calls
 *   evaluateLayout AT MOST ONCE per candidate and hands the result in as ctx.engine.
 *   If each of ada/egress/noise called evaluateLayout separately, that would triple
 *   the noise-MC draws and destroy the frozen-pin determinism. So the three engine
 *   objectives are thin wrappers that PULL a field from the shared ctx.engine result
 *   produced by the UNMODIFIED evaluateLayout — the current value, current code path.
 *
 * ctx (built by the driver, per candidate):
 *   { engine, movableIds, dims, state, stageW, stageH }
 *     engine     : the evaluateLayout({},stageW,stageH) result (or null if no
 *                  registered objective needsEngine)
 *     movableIds : the ids actually being optimized (filtered, in order)
 *     dims       : { id: {w,h} } base footprint dims for the movables
 *     state      : the engine state object (state.zones[id].{x,y,w,h,rotation})
 */

/* ── The three existing objectives (thin wrappers over evaluateLayout) ─────────
 * direction "minimize", provenance from the paper's clauses. evaluate pulls the
 * field the UNMODIFIED engine already computed — no reimplementation of the math. */

export const ADA = {
  id: 'ada',
  name: 'ADA corridor non-compliance',
  direction: 'minimize',
  needsEngine: true,
  provenance: 'ADA 2010 §403.5 accessible-route clear width (sim_ada.js corridor stats)',
  evaluate: function (ctx) { return ctx.engine.ada; },
};

export const EGRESS = {
  id: 'egress',
  name: 'Egress risk (travel + capacity)',
  direction: 'minimize',
  needsEngine: true,
  provenance: 'NFPA 101 travel distance & egress capacity (sim_egress.js)',
  evaluate: function (ctx) { return ctx.engine.egress; },
};

export const NOISE = {
  id: 'noise',
  name: 'Noise action-level exposure fraction',
  direction: 'minimize',
  needsEngine: true,
  provenance: 'OSHA 1910.95 action level 85 dBA (sim_noise.js MC)',
  evaluate: function (ctx) { return ctx.engine.noise; },
};

/**
 * SYNTHETIC generality probe (Task 4). Deterministic, engine-free, hand-checkable:
 * the mean distance of movable footprint centers from the stage centroid (50,50),
 * normalized by the max possible distance hypot(50,50) so it lands in [0,1].
 * NOT a real design metric — it exists only to prove the plumbing carries a 4th
 * objective (dominance/crowding/archive/weights all generalize). needsEngine:false.
 */
export const CENTROID_SPREAD = {
  id: 'centroidSpread',
  name: 'Mean movable distance from stage center (synthetic)',
  direction: 'minimize',
  needsEngine: false,
  provenance: 'design assumption (synthetic generality probe, not a real metric)',
  evaluate: function (ctx) {
    var ids = ctx.movableIds, st = ctx.state;
    var sum = 0, k = 0;
    for (var i = 0; i < ids.length; i++) {
      var z = st.zones[ids[i]];
      if (!z) continue;
      var cx = z.x + z.w / 2, cy = z.y + z.h / 2;
      sum += Math.hypot(cx - 50, cy - 50);
      k++;
    }
    var mean = k > 0 ? sum / k : 0;
    return mean / Math.hypot(50, 50);   // normalize to [0,1]
  },
};

/**
 * Active-users (usable capacity) — v2 Phase A1. The normalized shortfall of
 * code-permitted occupancy the layout fails to deliver (minimize). Unlike the other
 * objectives, its evaluate must be BAKED PER PROJECT (it embeds each machine's
 * operator-region geometry + person-space + the zone reference capacity), so the
 * static entry's evaluate is a guard: call registerObjective(makeActiveUsersObjective(
 * project, opts)) from v2/active-users.mjs to install the real, project-specific
 * evaluate before running the O1 driver. See v2/ACTIVE_USERS.md.
 */
export const ACTIVE_USERS = {
  id: 'activeUsers',
  name: 'Active users (usable-capacity shortfall)',
  direction: 'minimize',
  needsEngine: false,
  provenance: 'design assumption (person-space 15 ft^2); reference = NFPA 101 occupant load 50 ft^2/person (sim_egress.js:21); reachability via the engine egress BFS',
  evaluate: function () {
    throw new Error('activeUsers must be baked per project: registerObjective(makeActiveUsersObjective(project, opts)) — see v2/active-users.mjs');
  },
};

/**
 * Tool-adjacency (hazard/workflow) — v2 Phase N1. The normalized weighted violation
 * of pairwise separation/synergy relationships (minimize). Like activeUsers, its
 * evaluate must be BAKED PER PROJECT (it embeds the resolved compatibility matrix +
 * weights + reference), so the static entry's evaluate is a guard: call
 * registerObjective(makeAdjacencyObjective(project, opts)) from v2/adjacency.mjs
 * before running the O1 driver. See v2/ADJACENCY.md.
 */
export const ADJACENCY = {
  id: 'adjacency',
  name: 'Tool-adjacency violation (hazard/workflow)',
  direction: 'minimize',
  needsEngine: false,
  provenance: 'rule-derived from E1 hazard flags (NFPA 51B/33, OSHA 1910.252/.107/.303, NFPA 664/30) + SLP workflow pairs + user overrides; weights = design assumption (v2/adjacency-defaults.json)',
  evaluate: function () {
    throw new Error('adjacency must be baked per project: registerObjective(makeAdjacencyObjective(project, opts)) — see v2/adjacency.mjs');
  },
};

/**
 * Amenity linkage — v2 Phase L1. The normalized weighted violation of required
 * machine->amenity links (minimize). Like activeUsers/adjacency, its evaluate must be
 * BAKED PER PROJECT (it embeds the resolved links + amenity ids + reference and runs
 * per-candidate travel BFS), so the static entry's evaluate is a guard: call
 * registerObjective(makeAmenityLinksObjective(project, opts)) from v2/amenity-links.mjs
 * before running the O1 driver. See v2/AMENITY_LINKS.md.
 */
export const AMENITY_LINKS = {
  id: 'amenityLinks',
  name: 'Amenity linkage (required-amenity reach)',
  direction: 'minimize',
  needsEngine: false,
  provenance: 'rule-derived from E1 hazard/ventilation flags + explicit library links + user overrides; NFPA 10 / ANSI Z358.1 / NFPA 30/664 / OSHA 1910.94; path-based travel reuses the engine egress grid (v2/amenity-link-defaults.json)',
  evaluate: function () {
    throw new Error('amenityLinks must be baked per project: registerObjective(makeAmenityLinksObjective(project, opts)) — see v2/amenity-links.mjs');
  },
};

/* ── Registry ─────────────────────────────────────────────────────────────── */
export const REGISTRY = {
  ada: ADA,
  egress: EGRESS,
  noise: NOISE,
  centroidSpread: CENTROID_SPREAD,
  activeUsers: ACTIVE_USERS,
  adjacency: ADJACENCY,
  amenityLinks: AMENITY_LINKS,
};

/** The canonical three-objective set, IN ENGINE ORDER (ada, egress, noise).
 *  This order is load-bearing for the frozen pin: the scalarization and weight
 *  sampler must line up with sim_mosa's `wa*ada + we*egress + wn*noise`. */
export const FROZEN_THREE = ['ada', 'egress', 'noise'];

/**
 * getObjectives(ids) -> ordered array of objective defs.
 * Validates each id exists, each direction is "minimize" (the only supported
 * direction this phase — the driver assumes lower-is-better), and each has an
 * evaluate function.
 */
export function getObjectives(ids) {
  if (!Array.isArray(ids) || ids.length < 1) {
    throw new Error('getObjectives: need a non-empty array of objective ids');
  }
  return ids.map(id => {
    const o = REGISTRY[id];
    if (!o) throw new Error(`getObjectives: unknown objective id "${id}"`);
    if (o.direction !== 'minimize') {
      throw new Error(`getObjectives: objective "${id}" has unsupported direction "${o.direction}" (only "minimize" this phase)`);
    }
    if (typeof o.evaluate !== 'function') {
      throw new Error(`getObjectives: objective "${id}" has no evaluate function`);
    }
    return o;
  });
}

/** Register a new objective (for downstream phases / tests). Enforces the contract. */
export function registerObjective(obj) {
  for (const f of ['id', 'name', 'direction', 'evaluate', 'provenance']) {
    if (obj[f] === undefined) throw new Error(`registerObjective: missing required field "${f}"`);
  }
  if (obj.direction !== 'minimize') throw new Error('registerObjective: only "minimize" supported this phase');
  if (typeof obj.evaluate !== 'function') throw new Error('registerObjective: evaluate must be a function');
  REGISTRY[obj.id] = obj;
  return obj;
}

export default { REGISTRY, FROZEN_THREE, getObjectives, registerObjective, ADA, EGRESS, NOISE, CENTROID_SPREAD };
