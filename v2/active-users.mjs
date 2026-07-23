/**
 * v2/active-users.mjs  --  v2 Phase A1: the active-users (usable capacity) metric.
 *
 * "As machines move, how many people can actually use the space?" Per the spec
 * (v2/ACTIVE_USERS.md): a person counts iff their 1 ft standing cell is inside an
 * operator standing region, is clear (not a machine footprint / wall / hard clearance),
 * and is REACHABLE from an exit by a walkable path.
 *
 * Reachability REUSES the engine's own grid: this module injects code that calls the
 * unmodified `_egressBuildGrid` / `_egressBFS` (sim_egress.js) via the V0 seam vm — the
 * same functions, so "walkable" is byte-for-byte what egress means. No engine edit.
 *
 * Public:
 *   computeActiveUsers(project, opts)      -> per-machine / per-zone / building capacity + shortfall
 *   makeActiveUsersObjective(project,opts) -> a baked O1 objective (evaluate runs in the vm)
 */

import { loadEngine } from './engine-adapter.mjs';
import { translateProject, applyTranslated } from './project-to-engine.mjs';
import { detectZones, pointInRing, ringAreaUnits } from './zone-detection.mjs';
import { rotate as clRotate, templatePolygon as clTemplatePolygon } from './clearance.mjs';

const OCCUPANT_LOAD_FACTOR = 50;     // NFPA 101 occupant load (sim_egress.js:21)
const DEFAULT_PERSON_SPACE = 15;     // ft^2/operator (design assumption; ACTIVE_USERS.md (b))
const EGRESS_RES_FT = 1.0;           // EGRESS_GRID_RES_FT (sim_egress.js:38)

/* ═══ pure geometry (also serialised into the vm for the objective) ═══════════ */
export function pointInPolygon(px, py, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
    if (((yi > py) !== (yj > py)) && (px < ((xj - xi) * (py - yi)) / ((yj - yi) || 1e-12) + xi)) inside = !inside;
  }
  return inside;
}
/** Rotate each local point by rotDeg (scoring/clearance convention) and translate to (cx,cy). */
export function worldPolys(localPolys, cx, cy, rotDeg) {
  const a = rotDeg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  return localPolys.map(poly => poly.map(p => ({ x: cx + (p.x * c - p.y * s), y: cy + (p.x * s + p.y * c) })));
}
export function polysAABB(polys) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const poly of polys) for (const p of poly) { x1 = Math.min(x1, p.x); y1 = Math.min(y1, p.y); x2 = Math.max(x2, p.x); y2 = Math.max(y2, p.y); }
  return { x1, y1, x2, y2 };
}

/* ═══ core capacity computation — pure, grid-based (serialised into the vm) ════
 * machines: [{ opPolys:[[{x,y}...]], hardPolys:[[...]], personSpace }] in world ft.
 * Returns per-machine usableArea + rejection tallies; overlap by even-split | layer-priority. */
export function auCore(gridData, machines, mode) {
  const { grid, dist, cols, rows, res } = gridData;
  const cellArea = res * res;
  const owners = new Map();                     // cellIndex -> [machineIndex...]
  const rejected = machines.map(() => ({ blocked: 0, unreachable: 0, hard: 0 }));
  const rawCells = machines.map(() => 0);
  for (let mi = 0; mi < machines.length; mi++) {
    const m = machines[mi];
    const aabb = polysAABB(m.opPolys);
    const c1 = Math.max(0, Math.floor(aabb.x1 / res)), c2 = Math.min(cols, Math.ceil(aabb.x2 / res));
    const r1 = Math.max(0, Math.floor(aabb.y1 / res)), r2 = Math.min(rows, Math.ceil(aabb.y2 / res));
    for (let r = r1; r < r2; r++) for (let c = c1; c < c2; c++) {
      const px = (c + 0.5) * res, py = (r + 0.5) * res;
      let inOp = false; for (const poly of m.opPolys) if (pointInPolygon(px, py, poly)) { inOp = true; break; }
      if (!inOp) continue;
      const k = r * cols + c;
      if (grid[k] === 1) { rejected[mi].blocked++; continue; }
      if (dist[k] < 0) { rejected[mi].unreachable++; continue; }
      let inHard = false; for (const poly of m.hardPolys) if (pointInPolygon(px, py, poly)) { inHard = true; break; }
      if (inHard) { rejected[mi].hard++; continue; }
      rawCells[mi]++;
      if (!owners.has(k)) owners.set(k, []);
      owners.get(k).push(mi);
    }
  }
  const usableArea = machines.map(() => 0);
  for (const owns of owners.values()) {
    if (mode === 'layer-priority') { usableArea[Math.max.apply(null, owns)] += cellArea; }
    else { const share = cellArea / owns.length; for (const mi of owns) usableArea[mi] += share; }
  }
  return { usableArea, rejected, rawCells };
}

/* ═══ operator standing region + hard clearance -> LOCAL ft polygons ══════════ */
function machineWH_ft(m, type, scale) {
  const wPct = m.w != null ? m.w : type.w, hPct = m.h != null ? m.h : type.h;
  return { wFt: wPct / 100 * scale.widthUnits, hFt: hPct / 100 * scale.heightUnits, wPct, hPct };
}
function rectPoly(cx, cy, hw, hh) { return [{ x: cx - hw, y: cy - hh }, { x: cx + hw, y: cy - hh }, { x: cx + hw, y: cy + hh }, { x: cx - hw, y: cy + hh }]; }

/** Operator standing region as LOCAL ft polygons (base frame; world rotation applied later). */
export function operatorLocalPolys(type, wFt, hFt, personSpace) {
  // 1) explicit operatorZonesFt (A1 hand-checkable form)
  if (Array.isArray(type.operatorZonesFt) && type.operatorZonesFt.length) {
    return type.operatorZonesFt.map(z => rectPoly(z.offsetX || 0, z.offsetY || 0, (z.w || 0) / 2, (z.h || 0) / 2));
  }
  // 2) E1 operatorEnvelope clearance zone
  const env = (type.clearanceZones || []).find(z => z.type === 'operatorEnvelope' && z.geometry);
  if (env) {
    const base = clTemplatePolygon(env);                       // zone-direction frame (ft)
    const oa = (env.orientation && env.orientation.angleDeg) || 0;
    return [base.map(p => clRotate(p, oa))];                    // apply envelope orientation
  }
  // 3) synthesise from occupancy: rect in front (local +y), area = operatorCount*personSpace
  const occ = type.occupancy || {};
  const opCount = occ.operatorCount != null ? occ.operatorCount : 1;
  const area = opCount * personSpace;
  const width = wFt > 0 ? wFt : Math.sqrt(area);
  const depth = area / width;
  return [rectPoly(0, hFt / 2 + depth / 2, width / 2, depth / 2)];
}
export function hardLocalPolys(type) {
  const out = [];
  for (const z of (type.clearanceZones || [])) {
    if (z.severity !== 'hard' || !z.geometry) continue;
    const base = clTemplatePolygon(z);
    const oa = (z.orientation && z.orientation.angleDeg) || 0;
    out.push(base.map(p => clRotate(p, oa)));
  }
  return out;
}

/* ═══ machine classification + zone assignment ════════════════════════════════ */
function isEquipment(m, project) {
  const t = project.machineTypes[m.type] || {};
  if (t.amenityProvides) return false;
  if (t.elementClass === 'amenity' || t.elementClass === 'structural') return false;
  const cat = t.cat || '';
  return !['exit', 'corridor', 'open', 'wall', 'door', 'floor', 'amenity', 'fixed'].includes(cat);
}
function machineCenterFt(m, type, scale) {
  const { wPct, hPct } = machineWH_ft(m, type, scale);
  const x = (m.x != null ? m.x : 50) + wPct / 2, y = (m.y != null ? m.y : 50) + hPct / 2;
  return { cx: x / 100 * scale.widthUnits, cy: y / 100 * scale.heightUnits };
}

/* ═══ V1: wall/door materialisation now lives in the seam ══════════════════════
 * The former local materializeGeometry() (walls -> blockers, exit doors -> cat:"exit")
 * was moved into v2/project-to-engine.mjs translateProject, which auto-materialises
 * room/project.structuralGeometry into the engine blocker channel. gridFromProject
 * therefore gets zone-aware engine state through the seam alone — no caller-side
 * materialisation. */

/* ═══ grid via the engine's own functions (V0 seam) ═══════════════════════════ */
function parseSeed(seed) {
  if (seed == null) return 0x4D524443;
  if (typeof seed === 'number') return seed >>> 0;
  const s = String(seed).trim();
  return (s.toLowerCase().startsWith('0x') ? parseInt(s, 16) : parseInt(s, 10)) >>> 0;
}
export function gridFromProject(project, opts = {}) {
  const t = translateProject(project);
  const injected = `
(${applyTranslated.toString()})(state, ZONE_DEFS, ${JSON.stringify(t)});
var __du = stageDimsUnits();
var __g = _egressBuildGrid(__du.w, __du.h);
var __d = _egressBFS(__g.grid, __g.cols, __g.rows);
__adapterOut.value = { cols: __g.cols, rows: __g.rows, grid: Array.from(__g.grid), dist: Array.from(__d), stageW: __du.w, stageH: __du.h };
`;
  const out = loadEngine(opts.root).run(injected);
  if (!out) throw new Error('active-users: grid injection produced no result');
  return { grid: out.grid, dist: out.dist, cols: out.cols, rows: out.rows, res: EGRESS_RES_FT, stageW: out.stageW, stageH: out.stageH };
}

/* ═══ zone resolution (G1) ════════════════════════════════════════════════════ */
function resolveZones(project) {
  const scale = project.room.scale;
  if (project.structuralGeometry && Array.isArray(project.structuralGeometry.walls) && project.structuralGeometry.walls.length) {
    const det = detectZones(project.structuralGeometry, scale);
    return det.zones.map(z => ({ id: z.id, polygonPct: z.polygonPct, areaUnits: z.areaUnits, hasExit: (z.doors || []).length > 0 }));
  }
  const poly = project.room.polygonPct || [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
  return [{ id: 'zone0', polygonPct: poly, areaUnits: ringAreaUnits(poly, scale), hasExit: true }];
}

/* ═══ PUBLIC: standalone metric ═══════════════════════════════════════════════ */
export function computeActiveUsers(project, opts = {}) {
  const mode = opts.mode || 'even-split';
  const scale = project.room.scale;
  const zones = resolveZones(project);
  // V1: the seam auto-materialises structuralGeometry, so the raw project yields
  // zone-aware engine state directly (no caller-side wall/exit materialisation).
  const gridData = gridFromProject(project, { root: opts.root, seed: opts.seed });

  const equip = project.machines.filter(m => isEquipment(m, project));
  const built = equip.map(m => {
    const type = project.machineTypes[m.type];
    const personSpace = (type.occupancy && type.occupancy.personSpaceAreaUnits) || DEFAULT_PERSON_SPACE;
    const { wFt, hFt } = machineWH_ft(m, type, scale);
    const { cx, cy } = machineCenterFt(m, type, scale);
    const rotDeg = (m.rotation || 0) + ((type.principalAxis && type.principalAxis.angle) || 0);
    const opPolys = worldPolys(operatorLocalPolys(type, wFt, hFt, personSpace), cx, cy, rotDeg);
    const hardPolys = worldPolys(hardLocalPolys(type), cx, cy, rotDeg);
    // zone assignment by footprint centre (stage-%)
    const cxPct = cx / scale.widthUnits * 100, cyPct = cy / scale.heightUnits * 100;
    let zoneId = null;
    for (const z of zones) if (pointInRing({ x: cxPct, y: cyPct }, z.polygonPct)) { zoneId = z.id; break; }
    return { id: m.id, type: m.type, personSpace, opPolys, hardPolys, zoneId };
  });

  const core = auCore(gridData, built, mode);
  const perMachine = built.map((m, i) => ({
    id: m.id, type: m.type, zoneId: m.zoneId, personSpace: m.personSpace,
    usableArea: core.usableArea[i], usableUsers: core.usableArea[i] / m.personSpace,
    rejected: core.rejected[i],
  }));

  const perZone = zones.map(z => {
    const ms = perMachine.filter(m => m.zoneId === z.id);
    const users = ms.reduce((a, m) => a + m.usableUsers, 0);
    const reference = z.areaUnits / OCCUPANT_LOAD_FACTOR;
    return { id: z.id, areaUnits: z.areaUnits, hasExit: z.hasExit, usableUsers: users, headcount: Math.floor(users), referenceCapacity: reference, machines: ms.map(m => m.id) };
  });

  const buildingUsers = perZone.reduce((a, z) => a + z.usableUsers, 0);
  const referenceCapacity = perZone.reduce((a, z) => a + z.referenceCapacity, 0);
  const shortfall = Math.max(0, Math.min(1, 1 - buildingUsers / (referenceCapacity || 1e-9)));

  return {
    mode, perMachine, perZone,
    buildingUsers, buildingHeadcount: Math.floor(buildingUsers),
    referenceCapacity, shortfall,
  };
}

/* ═══ PUBLIC: baked O1 objective (evaluate runs inside the vm) ═════════════════
 * Bakes per-machine LOCAL polygons + personSpace + reference into the evaluate
 * source (via new Function, whose .toString() the O1 driver injects), so it needs
 * no driver change. Per candidate it rebuilds the world regions from the current
 * state.zones positions and the engine's fresh egress grid. */
export function makeActiveUsersObjective(project, opts = {}) {
  const mode = opts.mode || 'even-split';
  const scale = project.room.scale;
  const zones = resolveZones(project);
  const referenceCapacity = zones.reduce((a, z) => a + z.areaUnits / OCCUPANT_LOAD_FACTOR, 0);
  const equip = project.machines.filter(m => isEquipment(m, project));
  const data = {
    mode, referenceCapacity, res: EGRESS_RES_FT,
    stageW: scale.widthUnits, stageH: scale.heightUnits,
    machines: equip.map(m => {
      const type = project.machineTypes[m.type];
      const personSpace = (type.occupancy && type.occupancy.personSpaceAreaUnits) || DEFAULT_PERSON_SPACE;
      const { wFt, hFt } = machineWH_ft(m, type, scale);
      return {
        id: m.id, personSpace,
        paAngle: ((type.principalAxis && type.principalAxis.angle) || 0),
        opLocal: operatorLocalPolys(type, wFt, hFt, personSpace),
        hardLocal: hardLocalPolys(type),
      };
    }),
  };
  const src =
    pointInPolygon.toString() + '\n' + polysAABB.toString() + '\n' + worldPolys.toString() + '\n' + auCore.toString() + '\n' +
    'var DATA = ' + JSON.stringify(data) + ';\n' +
    'var du = stageDimsUnits(); var stageW = du.w, stageH = du.h;\n' +
    'var g = _egressBuildGrid(stageW, stageH); var dist = _egressBFS(g.grid, g.cols, g.rows);\n' +
    'var gd = { grid: g.grid, dist: dist, cols: g.cols, rows: g.rows, res: DATA.res };\n' +
    'var ms = [];\n' +
    'for (var i = 0; i < DATA.machines.length; i++) {\n' +
    '  var d = DATA.machines[i]; var z = state.zones[d.id]; if (!z) { ms.push({opPolys:[],hardPolys:[],personSpace:d.personSpace}); continue; }\n' +
    '  var cx = (z.x + z.w/2)/100*stageW, cy = (z.y + z.h/2)/100*stageH; var rot = (z.rotation||0) + d.paAngle;\n' +
    '  ms.push({ opPolys: worldPolys(d.opLocal, cx, cy, rot), hardPolys: worldPolys(d.hardLocal, cx, cy, rot), personSpace: d.personSpace });\n' +
    '}\n' +
    'var core = auCore(gd, ms, DATA.mode);\n' +
    'var users = 0; for (var j = 0; j < ms.length; j++) users += core.usableArea[j] / ms[j].personSpace;\n' +
    'var sf = 1 - users / (DATA.referenceCapacity || 1e-9); if (sf < 0) sf = 0; if (sf > 1) sf = 1;\n' +
    'return sf;\n';
  // eslint-disable-next-line no-new-func
  const evaluate = new Function('ctx', src);
  return {
    id: 'activeUsers', name: 'Active users (usable-capacity shortfall)', direction: 'minimize',
    needsEngine: false,
    provenance: 'design assumption (person-space 15 ft^2); reference = NFPA 101 occupant load 50 ft^2/person (sim_egress.js:21); reachability via engine egress BFS',
    evaluate,
  };
}

export default { computeActiveUsers, makeActiveUsersObjective, gridFromProject, auCore, operatorLocalPolys, hardLocalPolys, worldPolys, pointInPolygon };
