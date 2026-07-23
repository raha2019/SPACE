/**
 * v2/zone-to-blocker.mjs  --  v2 Phase G2: zone -> structural wall blockers.
 *
 * GEOMETRY ONLY. Pure, no-UI, no-engine. This is the ONLY no-engine-edit path
 * that makes the existing whole-stage simulations respect a v2 detected zone.
 *
 * The audit (and Phase 2d) established that every sim OBJECTIVE iterates a
 * whole-stage grid and cannot be pointed at a zone without editing an engine file.
 * The proven data-only workaround is "region-as-wall": fill the stage complement
 * of the zone (everything inside the stage rectangle but OUTSIDE the zone polygon)
 * with structural WALL blockers. The engine's existing wall handling then rasterizes
 * those cells as blocked (ADA/egress) and STC-attenuated (noise), so exactly the
 * non-zone cells drop out of the whole-stage objectives. This generalizes the hand-
 * built Phase 2d `notch_mrdc2323` blocker (one rectangular notch) to an arbitrary
 * polygon complement.
 *
 * EXACTNESS depends on the zone being RECTILINEAR (all edges axis-aligned). For a
 * rectilinear polygon the complement is exactly a union of axis-aligned rectangles,
 * which is exactly what the engine wall model can represent (simBlockerFootprint uses
 * the zone rect x/y/w/h). For a polygon with DIAGONAL edges the complement CANNOT be
 * tiled exactly by axis-aligned rectangles; this module refuses to silently
 * approximate — it returns `exact:false` with a warning (see `zoneToBlockers`).
 *
 * NOTHING IN THE LIVE APP CALLS THIS. It is a tested library for Phase G3 (per-zone
 * simulation) to consume. This phase only makes a SINGLE active zone's geometry real
 * to the whole-stage objectives.
 *
 * Public API:
 *   zoneToBlockers(zone, opts?) -> { blockers, exits, exact, warnings, stage, grid }
 *   exitsFromDetection(result, geometry) -> [ { id, from, to } ]   (exit-to-outside doors)
 *   pointInAnyBlocker(pt, blockers) -> bool
 */

import { pointInRing } from './zone-detection.mjs';

const GEO_EPS = 1e-9;
const DEFAULT_STC = 35;                 // matches sim_noise NOISE_WALL_STC (v1/js/sim_noise.js:51)
const RESERVED_PASSABLE_IDS = ['corridor', 'connector', 'rightOpen', 'entrance'];  // ADA/EGRESS_PASSABLE_IDS

/* ── rectilinearity: every edge horizontal or vertical ─────────────────────── */
function isRectilinear(ring, eps = 1e-6) {
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const horiz = Math.abs(a.y - b.y) <= eps;
    const vert = Math.abs(a.x - b.x) <= eps;
    if (!horiz && !vert) return { ok: false, edge: i, a, b };
  }
  return { ok: true };
}

function uniqSorted(arr, eps = 1e-7) {
  const s = arr.slice().sort((p, q) => p - q);
  const out = [];
  for (const v of s) if (!out.length || Math.abs(v - out[out.length - 1]) > eps) out.push(v);
  return out;
}

/**
 * zoneToBlockers — fill the stage complement of a zone with wall blockers.
 *
 * zone : { polygonPct: [{x,y},…] }   (stage-% coordinates)
 * opts :
 *   stage       : { x0, y0, x1, y1 }        default { 0, 0, 100, 100 }
 *   stc         : wall STC (dB)             default 35
 *   idPrefix    : blocker id prefix         default 'zblk'
 *   exits       : [ { id, from:{x,y}, to:{x,y} } ]  exit-to-outside door segments to seed egress
 *   exitThicknessPct : exit rect half-thickness (stage-%)  default 1.0
 *   passableIds : extra reserved ids to avoid colliding with (beyond the engine defaults)
 *   allowApproximate : if true, do NOT refuse a non-rectilinear zone (still exact only if rectilinear)
 *
 * Returns { blockers, exits, exact, warnings, stage, grid:{xs,ys} }.
 */
export function zoneToBlockers(zone, opts = {}) {
  if (!zone || !Array.isArray(zone.polygonPct) || zone.polygonPct.length < 3) {
    throw new Error('zoneToBlockers: zone.polygonPct (>=3 points) required');
  }
  const ring = zone.polygonPct.map(p => ({ x: p.x, y: p.y }));
  const stage = Object.assign({ x0: 0, y0: 0, x1: 100, y1: 100 }, opts.stage || {});
  const stc = opts.stc != null ? opts.stc : DEFAULT_STC;
  const prefix = opts.idPrefix || 'zblk';
  const reserved = new Set(RESERVED_PASSABLE_IDS.concat(opts.passableIds || []));
  const warnings = [];

  // Rectilinearity gate — the engine wall model is axis-aligned rectangles.
  const rect = isRectilinear(ring);
  const exact = rect.ok;
  if (!rect.ok) {
    warnings.push({
      code: 'non-rectilinear-zone',
      message: `zone edge ${rect.edge} from (${rect.a.x},${rect.a.y}) to (${rect.b.x},${rect.b.y}) is diagonal. ` +
        `The engine wall model (axis-aligned zone rectangles via simBlockerFootprint) CANNOT represent a diagonal ` +
        `complement exactly. Refusing to emit blockers unless opts.allowApproximate is set. ` +
        `Recommended: rectify the zone to axis-aligned edges, or wait for a future non-axis-aligned wall model.`,
    });
    if (!opts.allowApproximate) {
      return { blockers: [], exits: [], exact: false, warnings, stage, grid: { xs: [], ys: [] } };
    }
  }

  // Coordinate compression: grid lines at every vertex coordinate + stage bounds.
  const xs = uniqSorted([stage.x0, stage.x1, ...ring.map(p => p.x)].filter(v => v >= stage.x0 - GEO_EPS && v <= stage.x1 + GEO_EPS));
  const ys = uniqSorted([stage.y0, stage.y1, ...ring.map(p => p.y)].filter(v => v >= stage.y0 - GEO_EPS && v <= stage.y1 + GEO_EPS));

  // Classify each grid cell: a cell is a blocker iff its center is OUTSIDE the zone.
  // Because every polygon edge lies on a grid line, the zone is uniform within a cell.
  const nCol = xs.length - 1, nRow = ys.length - 1;
  const isBlk = [];   // [row][col]
  for (let r = 0; r < nRow; r++) {
    isBlk.push([]);
    const cy = (ys[r] + ys[r + 1]) / 2;
    for (let c = 0; c < nCol; c++) {
      const cx = (xs[c] + xs[c + 1]) / 2;
      isBlk[r][c] = !pointInRing({ x: cx, y: cy }, ring);   // outside zone => blocker
    }
  }

  // Merge blocker cells into maximal axis-aligned rectangles:
  //   1) per row, coalesce consecutive blocker cells into horizontal strips;
  //   2) coalesce vertically-adjacent strips that share the same x-span.
  const strips = [];   // { c0, c1, r, x0, x1, y0, y1 }
  for (let r = 0; r < nRow; r++) {
    let c = 0;
    while (c < nCol) {
      if (!isBlk[r][c]) { c++; continue; }
      let c1 = c;
      while (c1 + 1 < nCol && isBlk[r][c1 + 1]) c1++;
      strips.push({ c0: c, c1, r, x0: xs[c], x1: xs[c1 + 1], y0: ys[r], y1: ys[r + 1] });
      c = c1 + 1;
    }
  }
  // vertical coalesce
  const rects = [];
  const used = new Array(strips.length).fill(false);
  for (let i = 0; i < strips.length; i++) {
    if (used[i]) continue;
    let s = strips[i];
    used[i] = true;
    let y1 = s.y1, rr = s.r;
    // find a strip in the next row with identical c0/c1
    let extended = true;
    while (extended) {
      extended = false;
      for (let j = 0; j < strips.length; j++) {
        if (used[j]) continue;
        const t = strips[j];
        if (t.r === rr + 1 && t.c0 === s.c0 && t.c1 === s.c1) {
          y1 = t.y1; rr = t.r; used[j] = true; extended = true; break;
        }
      }
    }
    rects.push({ x0: s.x0, y0: s.y0, x1: s.x1, y1 });
  }

  // Emit blockers.
  const blockers = rects.map((r, i) => {
    let id = `${prefix}_${i}`;
    if (reserved.has(id)) id = `${prefix}_blk_${i}`;   // never collide with passable ids
    return {
      id,
      label: `Zone complement blocker ${i}`,
      elementClass: 'structural',
      subtype: 'wall',
      cat: 'wall',
      blocksMovement: true,
      stc,
      x: r.x0, y: r.y0, w: r.x1 - r.x0, h: r.y1 - r.y0,
    };
  });

  // Emit exit elements (data-only egress-seeding workaround for BUG #4).
  const exitThk = opts.exitThicknessPct != null ? opts.exitThicknessPct : 1.0;
  const exits = (opts.exits || []).map((d, i) => {
    const x0 = Math.min(d.from.x, d.to.x) - exitThk, x1 = Math.max(d.from.x, d.to.x) + exitThk;
    const y0 = Math.min(d.from.y, d.to.y) - exitThk, y1 = Math.max(d.from.y, d.to.y) + exitThk;
    let id = d.id || `${prefix}_exit_${i}`;
    if (reserved.has(id)) id = `${prefix}_exit_${i}`;
    return {
      id,
      label: `Exit (zone-to-blocker) ${i}`,
      elementClass: 'structural',
      subtype: 'door',
      cat: 'exit',                 // sim_egress seeds BFS from cat==="exit" (data-only workaround)
      walkThrough: true,
      blocksMovement: false,
      x: Math.max(stage.x0, x0), y: Math.max(stage.y0, y0),
      w: Math.min(stage.x1, x1) - Math.max(stage.x0, x0),
      h: Math.min(stage.y1, y1) - Math.max(stage.y0, y0),
    };
  });

  return { blockers, exits, exact, warnings, stage, grid: { xs, ys } };
}

/* ── extract exit-to-outside door segments from a detection result ─────────── */
export function exitsFromDetection(result, geometry) {
  const doorGeom = new Map();
  for (const d of ((geometry && geometry.doors) || [])) doorGeom.set(d.id, d);
  const out = [];
  for (const rec of (result.doors || [])) {
    if (rec.role !== 'exit-to-outside') continue;
    const g = doorGeom.get(rec.id);
    if (g) out.push({ id: rec.id, from: { x: g.from.x, y: g.from.y }, to: { x: g.to.x, y: g.to.y } });
  }
  return out;
}

/* ── point-in-any-blocker (for tests + G3) ─────────────────────────────────── */
export function pointInAnyBlocker(pt, blockers) {
  for (const b of blockers) {
    if (pt.x >= b.x && pt.x <= b.x + b.w && pt.y >= b.y && pt.y <= b.y + b.h) return true;
  }
  return false;
}

export default { zoneToBlockers, exitsFromDetection, pointInAnyBlocker, RESERVED_PASSABLE_IDS };
