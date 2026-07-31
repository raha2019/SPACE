"use strict";
/* ------------------------------------------------------------------
   HEADLESS EVALUATION HARNESS
   Preliminary model estimate. Not for regulatory use.

   evaluateLayout(layout, stageW, stageH) accepts a candidate zone
   placement and returns an objective vector {ada, egress, noise}
   without touching the DOM or any canvas element.

   Each component is normalized to [0, 1]. Lower is better.

   ADA:    fraction of walkable cells below the 36-in corridor minimum
           plus a door-width penalty term.
   Egress: mean of normalized max-travel and exit-capacity sub-terms.
   Noise:  fraction of grid cells at or above the OSHA 85 dBA action
           level, estimated via Monte Carlo with EVAL_NOISE_ITERATIONS.

   State contract:
     evaluateLayout temporarily swaps state.zones with a shallow
     copy that merges the candidate positions. JavaScript is
     single-threaded, so this swap is safe within a synchronous
     call. state.zones is always restored in the finally block.

   Dependency contract:
     Requires sim_ada.js, sim_egress.js, and sim_noise.js to be
     loaded first (they define the internal helper functions).
   ------------------------------------------------------------------ */

// Reduced MC iterations for the optimizer inner loop.
// 25 iterations gives roughly 1 to 2 dB variance at typical
// schedule_prob values, which is acceptable for a search heuristic.
// The full NOISE_MC_ITERATIONS (500) is used by the display layer.
const EVAL_NOISE_ITERATIONS = 25;

// Door-width penalty: 2 advisory points per narrow door, out of 15
// maximum ADA penalty. Normalized to [0, 1] contribution: 2/15 per door.
const EVAL_ADA_DOOR_PENALTY = 2 / 15;

// Objective weights for the combined scalar used by the SA acceptance
// criterion. Equal weights are the defensible starting assumption.
// Adjust here once empirical observations from the space provide a basis
// for weighting one objective more heavily.
const EVAL_WEIGHTS = { ada: 1 / 3, egress: 1 / 3, noise: 1 / 3 };


/* evaluateLayout
   Accepts a partial layout object and returns an objective vector.

   layout:  { id: { x, y, w, h }, ... } -- only IDs present here
            are moved. IDs absent from layout keep their current
            positions from state.zones.
   stageW, stageH: stage dimensions in real units (feet), from
            stageDimsUnits().

   Returns { ada, egress, noise }, each in [0, 1].
   Returns { ada: 1, egress: 1, noise: 1 } on error.          */
function evaluateLayout(layout, stageW, stageH) {
  const saved = state.zones;
  const candidate = Object.assign({}, saved);
  for (const id of Object.keys(layout)) {
    if (!candidate[id]) continue;
    candidate[id] = Object.assign({}, candidate[id], layout[id]);
  }
  state.zones = candidate;

  const vec = { ada: 1, egress: 1, noise: 1 };
  try {
    // ADA objective
    const { grid: ag, cols: ac, rows: ar } = _adaBuildGrid(stageW, stageH);
    const adaDist = _adaDistanceTransform(ag, ac, ar);
    const corr    = _adaCorridorStats(adaDist, ac, ar);
    const doors   = _adaCheckDoorWidths(stageW);
    const failFrac = corr.free > 0 ? corr.fail / corr.free : 0;
    vec.ada = Math.min(1, failFrac + doors.length * EVAL_ADA_DOOR_PENALTY);

    // Egress objective
    const { grid: eg, cols: ec, rows: er } = _egressBuildGrid(stageW, stageH);
    const eDist    = _egressBFS(eg, ec, er);
    const maxTrav  = eDist.reduce((mx, d) => (d > mx ? d : mx), 0);
    const occupants = _egressOccupantLoad(stageW, stageH);
    const exitCap   = _egressExitCapacity(stageW);
    const travelNorm = Math.min(1, maxTrav / NFPA_MAX_TRAVEL_DISTANCE_FT);
    const shortfall  = Math.max(0, occupants - exitCap.capacity);
    const capNorm    = occupants > 0 ? Math.min(1, shortfall / occupants) : 0;
    vec.egress = (travelNorm + capNorm) / 2;

    // Noise objective (reduced MC)
    const nCols   = Math.ceil(stageW / NOISE_GRID_RES_FT);
    const nRows   = Math.ceil(stageH / NOISE_GRID_RES_FT);
    const sources = _noiseGetSources(stageW, stageH);
    if (sources.length > 0) {
      const wallGrid = _noiseBuildStcGrid(stageW, stageH, nCols, nRows);
      const precomp  = _noisePrecompute(sources, wallGrid, nCols, nRows, stageW, stageH);
      const accum    = new Float64Array(nCols * nRows);
      for (let iter = 0; iter < EVAL_NOISE_ITERATIONS; iter++) {
        for (let si = 0; si < sources.length; si++) {
          if (Math.random() > sources[si].prob) continue;
          const cell = precomp[si];
          for (let i = 0; i < accum.length; i++) {
            accum[i] += Math.pow(10, cell[i] / 10);
          }
        }
      }
      const ambLin = Math.pow(10, NOISE_AMBIENT_DBA / 10);
      let actionCells = 0;
      const total = nCols * nRows;
      for (let i = 0; i < total; i++) {
        const dB = 10 * Math.log10(accum[i] / EVAL_NOISE_ITERATIONS + ambLin);
        if (dB >= OSHA_ACTION_LEVEL_DBA) actionCells++;
      }
      vec.noise = actionCells / total;
    } else {
      vec.noise = 0;
    }
  } finally {
    state.zones = saved;
  }
  return vec;
}


/* evalObjective
   Maps an objective vector to a single scalar for SA acceptance.
   Lower is better. Returns a value in [0, 1].                  */
function evalObjective(vec) {
  return (
    EVAL_WEIGHTS.ada    * vec.ada    +
    EVAL_WEIGHTS.egress * vec.egress +
    EVAL_WEIGHTS.noise  * vec.noise
  );
}


/* evalDominates
   Returns true if vecA strictly Pareto-dominates vecB.
   vecA dominates vecB if A is no worse on every objective and
   strictly better on at least one. Used by the Pareto front
   extension (future increment, not active tonight).            */
function evalDominates(vecA, vecB) {
  return (
    vecA.ada    <= vecB.ada    &&
    vecA.egress <= vecB.egress &&
    vecA.noise  <= vecB.noise  &&
    (vecA.ada < vecB.ada || vecA.egress < vecB.egress || vecA.noise < vecB.noise)
  );
}


/* evalPctImprovement
   Signed percentage improvement of optimized relative to baseline.
   Positive means the optimized value is lower (better).
   Returns null when baseline is zero (no violation to improve).  */
function evalPctImprovement(baseline, optimized) {
  if (baseline === 0) return null;
  return ((baseline - optimized) / baseline) * 100;
}
