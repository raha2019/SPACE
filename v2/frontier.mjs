/**
 * v2/frontier.mjs  --  v2 Phase O1 Task 5: n-objective frontier presentation.
 *
 * The audit noted the live frontier scatterplot is 2-D (ADA vs noise, egress as
 * opacity), which does not generalize past three objectives. This module is the
 * PRESENTATION-DATA layer (NO UI): given an n-dimensional Pareto front, it returns
 * the pieces a renderer needs for any n:
 *   - knee        : the min-max-normalized knee (distance to the per-objective
 *                   ideal in [0,1]^n space), generalized to n dimensions.
 *   - kneeOrigin  : the RAW distance-to-origin knee — bit-for-bit the metric the
 *                   current sim_mosa.js mosaOptimizeUI uses (Math.hypot over the raw
 *                   objective vector, first-wins ties). Kept so the existing poster's
 *                   highlighted knee does NOT move when this layer is adopted.
 *   - perObjectiveBest : the front member minimizing each objective.
 *   - parallelCoords   : a parallel-coordinates-ready structure (one axis per
 *                        objective with min/max, one polyline per member with raw +
 *                        normalized values) — the n-D replacement for the 2-D scatter.
 *
 * All current objectives MINIMIZE, so the ideal on each axis is its minimum over the
 * front and the theoretical-perfect point is the origin.
 *
 * presentFront(front, objIds) -> presentation object.
 *   front  : [ { pos, vec:[...] } ]   vec length === objIds.length
 *   objIds : [ objectiveId, ... ]     order matches vec
 */

export function presentFront(front, objIds) {
  if (!Array.isArray(front) || front.length === 0) {
    return { n: objIds ? objIds.length : 0, objIds: objIds || [], empty: true };
  }
  const n = objIds.length;
  const pts = front.map((m, i) => ({ index: i, pos: m.pos, vec: m.vec.slice() }));

  // Per-objective ideal (min) and nadir (max) over the front.
  const ideal = new Array(n).fill(Infinity);
  const nadir = new Array(n).fill(-Infinity);
  for (const p of pts) {
    for (let k = 0; k < n; k++) {
      if (p.vec[k] < ideal[k]) ideal[k] = p.vec[k];
      if (p.vec[k] > nadir[k]) nadir[k] = p.vec[k];
    }
  }

  // Min-max normalized distance to the ideal (ideal -> 0). A degenerate axis
  // (nadir === ideal) contributes 0 (all members equal there).
  function normDistToIdeal(vec) {
    let s = 0;
    for (let k = 0; k < n; k++) {
      const range = nadir[k] - ideal[k];
      const t = range > 0 ? (vec[k] - ideal[k]) / range : 0;
      s += t * t;
    }
    return Math.sqrt(s);
  }

  // Raw distance to the origin — EXACTLY sim_mosa.js mosaOptimizeUI's knee metric
  // (Math.hypot over the objective vector). hypot.apply preserves that call.
  function distToOrigin(vec) { return Math.hypot.apply(Math, vec); }

  // Generalized (min-max) knee — first-wins ties, same discipline as sim_ui.
  let knee = pts[0], kneeDist = Infinity;
  for (const p of pts) {
    p.normDist = normDistToIdeal(p.vec);
    if (p.normDist < kneeDist) { kneeDist = p.normDist; knee = p; }
  }

  // Origin knee — bit-identical to sim_ui (front order, strict <, first-wins).
  let kneeO = pts[0], kneeODist = Infinity;
  for (const p of pts) {
    p.originDist = distToOrigin(p.vec);
    if (p.originDist < kneeODist) { kneeODist = p.originDist; kneeO = p; }
  }

  // Per-objective best member (min on that objective; first-wins ties).
  const perObjectiveBest = {};
  for (let k = 0; k < n; k++) {
    let best = pts[0];
    for (const p of pts) if (p.vec[k] < best.vec[k]) best = p;
    perObjectiveBest[objIds[k]] = { index: best.index, vec: best.vec.slice() };
  }

  // Parallel-coordinates structure: axes + one polyline per member.
  const axes = objIds.map((id, k) => ({ id, min: ideal[k], max: nadir[k] }));
  const series = pts.map(p => ({
    index: p.index,
    normDist: p.normDist,
    originDist: p.originDist,
    values: objIds.map((id, k) => {
      const range = nadir[k] - ideal[k];
      return { axis: id, value: p.vec[k], norm: range > 0 ? (p.vec[k] - ideal[k]) / range : 0 };
    }),
  }));

  return {
    n, objIds,
    ideal: ideal.slice(),
    nadir: nadir.slice(),
    knee: { index: knee.index, vec: knee.vec.slice(), normDist: knee.normDist },
    kneeOrigin: { index: kneeO.index, vec: kneeO.vec.slice(), originDist: kneeO.originDist },
    kneeAgrees: knee.index === kneeO.index,
    perObjectiveBest,
    parallelCoords: { axes, series },
  };
}

export default { presentFront };
