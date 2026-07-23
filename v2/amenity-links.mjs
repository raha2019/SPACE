/**
 * v2/amenity-links.mjs  --  v2 Phase L1: the amenity-linkage objective.
 *
 * Typed links from a machine to a required amenity (fire extinguisher, eyewash, fume
 * hood, flammables cabinet, dust collection, ...), each with a max distance or travel.
 * REUSES N1's edge-to-edge distance/penalty machinery (rectGap) for straight-line links
 * and A1's engine-grid reachability for PATH-BASED links: it calls the engine's own
 * _egressBuildGrid + _egressBFS via the V0 seam, reseeding the BFS from AMENITY cells
 * instead of exit cells — so "walking distance" is exactly what the egress sim means.
 * Model + justification: v2/AMENITY_LINKS.md.
 *
 * Precedence: user override > explicit link (library) > rule-derived > none.
 * Scoring only (N1/L1); hard-reject is R1.
 *
 * Public:
 *   computeAmenityLinks(project, opts)      -> { objective, totalPenalty, diagnostics, ... }
 *   makeAmenityLinksObjective(project,opts) -> a baked O1 objective (evaluate runs in the vm)
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { loadEngine } from './engine-adapter.mjs';
import { translateProject, applyTranslated } from './project-to-engine.mjs';
import { rotAABBft, rectGap } from './adjacency.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEFAULTS = JSON.parse(readFileSync(join(__dirname, 'amenity-link-defaults.json'), 'utf8'));
const EGRESS_RES_FT = 1.0;

/* ═══ shared pure helpers (also serialised into the vm) ═══════════════════════ */
/** Min reachable BFS distance over the walkable cells bordering a machine's ft AABB
 *  (the machine's own cells are obstacles). -1 => unreachable. */
export function travelAt(a, dist, cols, rows, res) {
  const c1 = Math.max(0, Math.floor(a.x1 / res) - 1), c2 = Math.min(cols - 1, Math.ceil(a.x2 / res) + 1);
  const r1 = Math.max(0, Math.floor(a.y1 / res) - 1), r2 = Math.min(rows - 1, Math.ceil(a.y2 / res) + 1);
  let best = -1;
  for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) { const dd = dist[r * cols + c]; if (dd >= 0 && (best < 0 || dd < best)) best = dd; }
  return best;
}
/** Bounded-linear penalty (reuses N1's form). unreachable => max (mm). */
export function linkPenalty(mm, D, actual, unreachable) {
  if (unreachable) return mm;
  if (actual <= D) return 0;
  return mm * Math.min(1, (actual - D) / D);
}
/** vm-only: build the wall grid via the engine, reset exit seeds to free, seed the
 *  BFS from the given amenity rects (stage-%), and run the engine BFS. Requires the
 *  engine globals _egressBuildGrid/_egressBFS (present in the V0 seam vm). */
export function _seedAndBFS(seeds, stageW, stageH) {
  const g = _egressBuildGrid(stageW, stageH);
  const grid = g.grid, cols = g.cols, rows = g.rows, res = 1.0;
  for (let i = 0; i < grid.length; i++) if (grid[i] === 2) grid[i] = 0;   // exits -> free (amenities seed here)
  for (let s = 0; s < seeds.length; s++) {
    const sr = seeds[s];
    let c1 = Math.max(0, Math.floor(sr.x / 100 * stageW / res)), c2 = Math.min(cols, Math.ceil((sr.x + sr.w) / 100 * stageW / res));
    let r1 = Math.max(0, Math.floor(sr.y / 100 * stageH / res)), r2 = Math.min(rows, Math.ceil((sr.y + sr.h) / 100 * stageH / res));
    if (c2 <= c1) c2 = c1 + 1; if (r2 <= r1) r2 = r1 + 1;
    for (let r = r1; r < r2; r++) for (let c = c1; c < c2; c++) if (r >= 0 && r < rows && c >= 0 && c < cols) grid[r * cols + c] = 2;
  }
  return { dist: _egressBFS(grid, cols, rows), cols: cols, rows: rows };
}

/* ═══ classification + geometry ═══════════════════════════════════════════════ */
function isEquipment(m, project) {
  const t = project.machineTypes[m.type] || {};
  if (t.amenityProvides) return false;
  if (t.elementClass === 'amenity' || t.elementClass === 'structural') return false;
  const cat = t.cat || '';
  return !['exit', 'corridor', 'open', 'wall', 'door', 'floor', 'amenity', 'fixed'].includes(cat);
}
function zoneOf(m, types) {
  const t = types[m.type] || {};
  return { x: m.x != null ? m.x : 50, y: m.y != null ? m.y : 50, w: m.w != null ? m.w : t.w, h: m.h != null ? m.h : t.h, rotation: m.rotation || 0 };
}
function amenityInstancesByType(project) {
  const scale = project.room.scale, stageW = scale.widthUnits, stageH = scale.heightUnits;
  const out = {};
  for (const m of project.machines) {
    const prov = (project.machineTypes[m.type] || {}).amenityProvides;
    if (!prov) continue;
    const z = zoneOf(m, project.machineTypes);
    (out[prov] = out[prov] || []).push({ id: m.id, rectPct: { x: z.x, y: z.y, w: z.w, h: z.h }, aabbFt: rotAABBft(z, stageW, stageH) });
  }
  return out;
}

/* ═══ precedence resolution: a machine's required links ═══════════════════════ */
function reqFt(entry, walkSpeed) {
  if (entry.maxDistanceUnits != null) return entry.maxDistanceUnits;
  if (entry.requiredDistanceUnits != null) return entry.requiredDistanceUnits;
  if (entry.maxTravelSeconds != null) return entry.maxTravelSeconds * walkSpeed;
  return null;
}
export function resolveLinks(project, machine, d) {
  const type = project.machineTypes[machine.type] || {};
  const ws = d.walkSpeedFtPerSec, byType = {};
  // 3. rule-derived
  for (const r of d.rules) {
    let fires = false;
    if (r.flags) fires = !!(type.hazards && r.flags.some(f => type.hazards[f]));
    if (r.ventFlag) fires = fires || !!(type.ventilation && type.ventilation[r.ventFlag] === true);
    if (fires) byType[r.amenityType] = { requiredFt: reqFt(r, ws), mode: r.mode, provenance: r.id + ': ' + r.provenance, source: 'rule-derived' };
  }
  // 2. explicit (library machine type's amenityLinks)
  for (const l of (type.amenityLinks || [])) {
    byType[l.amenityType] = { requiredFt: reqFt(l, ws), mode: l.mode || 'advisory', provenance: l.provenance || 'explicit link', source: 'explicit' };
  }
  // 1. user override (project.amenityLinks matching machine id or type)
  for (const o of (project.amenityLinks || [])) {
    if (o.machine !== machine.id && o.machine !== machine.type) continue;
    byType[o.amenityType] = { requiredFt: reqFt(o, ws), mode: o.mode || 'advisory', provenance: o.provenance || 'user override', source: 'user-override' };
  }
  return Object.keys(byType).map(at => {
    const e = byType[at];
    return { amenityType: at, requiredFt: e.requiredFt, mode: e.mode, mm: d.modeMultipliers[e.mode] || 1, provenance: e.provenance, source: e.source, pathBased: d.pathBasedTypes.includes(at) };
  });
}

/* ═══ path-based travel grid (Node: injects into the seam vm) ═════════════════ */
function travelDist(project, seeds, opts) {
  const t = translateProject(project);
  const injected = `
(${applyTranslated.toString()})(state, ZONE_DEFS, ${JSON.stringify(t)});
var __du = stageDimsUnits(); var __sw = __du.w, __sh = __du.h;
${_seedAndBFS.toString()}
var __r = _seedAndBFS(${JSON.stringify(seeds)}, __sw, __sh);
__adapterOut.value = { dist: Array.from(__r.dist), cols: __r.cols, rows: __r.rows, stageW: __sw, stageH: __sh, res: ${EGRESS_RES_FT} };
`;
  const out = loadEngine(opts.root).run(injected);
  if (!out) throw new Error('amenity-links: travel-grid injection produced no result');
  return out;
}

/* ═══ PUBLIC: standalone metric ═══════════════════════════════════════════════ */
export function computeAmenityLinks(project, opts = {}) {
  const d = opts.defaults || DEFAULTS;
  const includeUnsat = !!opts.includeUnsatisfiable;
  const scale = project.room.scale, stageW = scale.widthUnits, stageH = scale.heightUnits;
  const machines = project.machines.filter(m => isEquipment(m, project));
  const amByType = amenityInstancesByType(project);

  const links = [];
  for (const m of machines) for (const l of resolveLinks(project, m, d)) links.push({ ...l, machineId: m.id, machineType: m.type });

  // path-based travel grids (one BFS per placed amenity type)
  const pathTypes = [...new Set(links.filter(l => l.pathBased && amByType[l.amenityType]).map(l => l.amenityType))];
  const distByType = {};
  for (const at of pathTypes) distByType[at] = travelDist(project, amByType[at].map(a => a.rectPct), opts);

  const mAABB = {}; for (const m of machines) mAABB[m.id] = rotAABBft(zoneOf(m, project.machineTypes), stageW, stageH);

  let total = 0, reference = 0;
  const diagnostics = [], unsatisfiable = [], overridesApplied = [], noRequirement = [];
  for (const l of links) {
    if (l.source === 'user-override') overridesApplied.push({ machine: l.machineId, amenityType: l.amenityType, requiredFt: l.requiredFt, provenance: l.provenance });
    if (l.requiredFt == null) { noRequirement.push({ machine: l.machineId, amenityType: l.amenityType, provenance: l.provenance }); continue; }
    const instances = amByType[l.amenityType];
    if (!instances || !instances.length) {
      unsatisfiable.push({ machine: l.machineId, amenityType: l.amenityType, mode: l.mode, provenance: l.provenance });
      if (!includeUnsat) continue;
      reference += l.mm; total += l.mm;
      diagnostics.push({ machine: l.machineId, amenityType: l.amenityType, requiredFt: l.requiredFt, actualFt: null, distanceMode: l.pathBased ? 'travel' : 'straight-line', status: 'UNSATISFIABLE (no amenity placed)', mode: l.mode, source: l.source, penalty: +l.mm.toFixed(4), provenance: l.provenance });
      continue;
    }
    let actual = Infinity, unreachable = false;
    if (l.pathBased) {
      const g = distByType[l.amenityType];
      const tv = travelAt(mAABB[l.machineId], g.dist, g.cols, g.rows, g.res);
      if (tv < 0) unreachable = true; else actual = tv;
    } else {
      for (const a of instances) { const gap = rectGap(mAABB[l.machineId], a.aabbFt); if (gap < actual) actual = gap; }
    }
    reference += l.mm;
    const pen = linkPenalty(l.mm, l.requiredFt, actual, unreachable);
    total += pen;
    const status = unreachable ? 'UNREACHABLE (walled off)' : (actual <= l.requiredFt ? 'SATISFIED' : 'VIOLATED');
    if (status !== 'SATISFIED' || pen > 1e-12) diagnostics.push({
      machine: l.machineId, amenityType: l.amenityType, requiredFt: l.requiredFt, actualFt: unreachable ? null : +actual.toFixed(3),
      distanceMode: l.pathBased ? 'travel' : 'straight-line', status, mode: l.mode, source: l.source, penalty: +pen.toFixed(4), provenance: l.provenance,
    });
  }
  const objective = reference > 0 ? Math.max(0, Math.min(1, total / reference)) : 0;
  diagnostics.sort((a, b) => b.penalty - a.penalty);
  return { objective, totalPenalty: total, reference, scoredLinks: reference > 0 ? undefined : 0, diagnostics, unsatisfiable, overridesApplied, noRequirement };
}

/* ═══ PUBLIC: baked O1 objective (evaluate runs in the vm; per-candidate travel BFS) ═ */
export function makeAmenityLinksObjective(project, opts = {}) {
  const d = opts.defaults || DEFAULTS;
  const scale = project.room.scale;
  const machines = project.machines.filter(m => isEquipment(m, project));
  const amByType = amenityInstancesByType(project);
  const idsByType = {}; for (const at in amByType) idsByType[at] = amByType[at].map(a => a.id);

  const links = [];
  for (const m of machines) for (const l of resolveLinks(project, m, d)) {
    if (l.requiredFt == null) continue;                 // no numeric requirement -> informational, unscored
    if (!amByType[l.amenityType]) continue;             // unsatisfiable -> excluded (matches standalone default)
    links.push({ machineId: m.id, amenityType: l.amenityType, requiredFt: l.requiredFt, mm: l.mm, pathBased: l.pathBased });
  }
  const reference = links.reduce((a, l) => a + l.mm, 0);
  const pathTypes = [...new Set(links.filter(l => l.pathBased).map(l => l.amenityType))];
  const straightTypes = [...new Set(links.filter(l => !l.pathBased).map(l => l.amenityType))];
  const data = { stageW: scale.widthUnits, stageH: scale.heightUnits, reference, links, idsByType, pathTypes, straightTypes };

  const src =
    rotAABBft.toString() + '\n' + rectGap.toString() + '\n' + travelAt.toString() + '\n' + linkPenalty.toString() + '\n' + _seedAndBFS.toString() + '\n' +
    'var DATA = ' + JSON.stringify(data) + ';\n' +
    'if (!DATA.reference) return 0;\n' +
    'var sw = DATA.stageW, sh = DATA.stageH;\n' +
    'var distCache = {};\n' +
    'for (var pt = 0; pt < DATA.pathTypes.length; pt++) {\n' +
    '  var at = DATA.pathTypes[pt]; var seeds = [];\n' +
    '  var ids = DATA.idsByType[at] || [];\n' +
    '  for (var s = 0; s < ids.length; s++) { var z = state.zones[ids[s]]; if (z) seeds.push({ x: z.x, y: z.y, w: z.w, h: z.h }); }\n' +
    '  distCache[at] = _seedAndBFS(seeds, sw, sh);\n' +
    '}\n' +
    'var amAABB = {};\n' +
    'for (var stz = 0; stz < DATA.straightTypes.length; stz++) {\n' +
    '  var t2 = DATA.straightTypes[stz]; var arr = []; var ids2 = DATA.idsByType[t2] || [];\n' +
    '  for (var q = 0; q < ids2.length; q++) { var z2 = state.zones[ids2[q]]; if (z2) arr.push(rotAABBft(z2, sw, sh)); }\n' +
    '  amAABB[t2] = arr;\n' +
    '}\n' +
    'var total = 0;\n' +
    'for (var k = 0; k < DATA.links.length; k++) {\n' +
    '  var L = DATA.links[k]; var mz = state.zones[L.machineId]; if (!mz) continue;\n' +
    '  var maabb = rotAABBft(mz, sw, sh); var actual = Infinity, unreach = false;\n' +
    '  if (L.pathBased) { var g = distCache[L.amenityType]; var tv = travelAt(maabb, g.dist, g.cols, g.rows, 1.0); if (tv < 0) unreach = true; else actual = tv; }\n' +
    '  else { var aabbs = amAABB[L.amenityType] || []; for (var z3 = 0; z3 < aabbs.length; z3++) { var gp = rectGap(maabb, aabbs[z3]); if (gp < actual) actual = gp; } }\n' +
    '  total += linkPenalty(L.mm, L.requiredFt, actual, unreach);\n' +
    '}\n' +
    'var v = total / DATA.reference; if (v < 0) v = 0; if (v > 1) v = 1; return v;\n';
  // eslint-disable-next-line no-new-func
  const evaluate = new Function('ctx', src);
  return {
    id: 'amenityLinks', name: 'Amenity linkage (required-amenity reach)', direction: 'minimize',
    needsEngine: false,
    provenance: 'rule-derived from E1 hazard/ventilation flags + explicit library links + user overrides; standards NFPA 10 (extinguisher travel), ANSI Z358.1 (eyewash travel), NFPA 30/664/OSHA 1910.94; path-based travel reuses the engine egress grid; distances w/o a standard = design assumption',
    evaluate,
  };
}

export default { computeAmenityLinks, makeAmenityLinksObjective, resolveLinks, travelAt, linkPenalty, DEFAULTS };
