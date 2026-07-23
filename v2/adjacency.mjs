/**
 * v2/adjacency.mjs  --  v2 Phase N1: the tool-adjacency objective.
 *
 * "Can these two machines sit next to each other?" Built-in defaults from safety
 * standards (rule-derived from E1 hazard flags + explicit SLP workflow pairs), with
 * per-pair user override. Pure geometry — machine positions + types + hazard flags —
 * so the objective needs NO engine call. Model + justification: v2/ADJACENCY.md.
 *
 * Precedence: user override > explicit default pair > rule-derived > NEUTRAL.
 * Conflicting rules: most-severe level wins, most-conservative (max) separation.
 * Distance: EDGE-TO-EDGE between rotation-aware footprints, real units (ft).
 * Scoring only (N1); hard-reject is R1.
 *
 * Public:
 *   computeAdjacency(project, opts)      -> { objective, totalPenalty, reference, diagnostics, ... }
 *   makeAdjacencyObjective(project,opts) -> a baked O1 objective (evaluate runs in the vm)
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEFAULTS = JSON.parse(readFileSync(join(__dirname, 'adjacency-defaults.json'), 'utf8'));
const SEVERITY = { PROHIBITED: 3, DISCOURAGED: 2, SYNERGISTIC: 1, NEUTRAL: 0 };

/* ═══ shared geometry (also serialised into the vm for the objective) ═════════ */
/** Rotation-aware footprint AABB in real units (ft), from a zone {x,y,w,h,rotation} in stage-%. */
export function rotAABBft(z, stageW, stageH) {
  const a = (z.rotation || 0) * Math.PI / 180;
  const c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
  const ew = z.w * c + z.h * s, eh = z.w * s + z.h * c;        // envelope in %
  const cx = z.x + z.w / 2, cy = z.y + z.h / 2;                // centre %
  return {
    x1: (cx - ew / 2) / 100 * stageW, x2: (cx + ew / 2) / 100 * stageW,
    y1: (cy - eh / 2) / 100 * stageH, y2: (cy + eh / 2) / 100 * stageH,
  };
}
/** Edge-to-edge (nearest-point) distance between two axis-aligned ft rects; 0 if they overlap. */
export function rectGap(a, b) {
  const dx = Math.max(0, a.x1 - b.x2, b.x1 - a.x2);
  const dy = Math.max(0, a.y1 - b.y2, b.y1 - a.y2);
  return Math.sqrt(dx * dx + dy * dy);
}
/** Penalty for one resolved pair at a given edge-to-edge distance (ft). */
export function pairPenalty(p, dist) {
  const base = p.weight * p.modeMult;
  if (base === 0) return 0;
  if (p.isSynergy) return base * Math.min(1, Math.max(0, (dist - p.D_ideal) / p.D_span)); // too-far
  if (p.D_req <= 0) return 0;
  return base * Math.max(0, (p.D_req - dist)) / p.D_req;                                   // too-close
}

/* ═══ machine classification + geometry ═══════════════════════════════════════ */
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
const hasFlag = (haz, flags) => !!haz && flags.some(f => haz[f]);
function ruleFires(rule, hazA, hazB) {
  return (hasFlag(hazA, rule.aFlags) && hasFlag(hazB, rule.bFlags)) ||
         (hasFlag(hazB, rule.aFlags) && hasFlag(hazA, rule.bFlags));
}
function matchPair(entry, aKey, bKey) {
  return (entry.a === aKey && entry.b === bKey) || (!entry.directed && entry.a === bKey && entry.b === aKey);
}
function defaultMode(level, d) { return (d.defaultMode && d.defaultMode[level]) || 'advisory'; }
function defaultSep(level, d) { return (d.defaultRequiredSeparationUnits && d.defaultRequiredSeparationUnits[level]) || 0; }

/* ═══ precedence resolution for one instance pair ═════════════════════════════ */
export function resolvePair(mi, mj, types, overrides, d) {
  const hazI = (types[mi.type] || {}).hazards, hazJ = (types[mj.type] || {}).hazards;
  // 1. user override (by instance-id pair or type pair)
  const ov = (overrides || []).find(o => matchPair(o, mi.id, mj.id) || matchPair(o, mi.type, mj.type));
  if (ov) return {
    level: ov.level, mode: ov.mode || defaultMode(ov.level, d),
    requiredSeparationUnits: ov.requiredSeparationUnits != null ? ov.requiredSeparationUnits : defaultSep(ov.level, d),
    provenance: ov.provenance || 'user override', source: 'user-override',
  };
  // 2. explicit default pair (by type pair)
  const ex = (d.pairs || []).find(p => matchPair(p, mi.type, mj.type));
  if (ex) return {
    level: ex.level, mode: ex.mode || defaultMode(ex.level, d),
    requiredSeparationUnits: ex.requiredSeparationUnits != null ? ex.requiredSeparationUnits : defaultSep(ex.level, d),
    provenance: ex.provenance, source: 'explicit-default',
  };
  // 3. rule-derived (most-severe level wins; most-conservative separation)
  const fired = (d.rules || []).filter(r => ruleFires(r, hazI, hazJ));
  if (fired.length) {
    const maxSev = Math.max(...fired.map(r => SEVERITY[r.level]));
    const winners = fired.filter(r => SEVERITY[r.level] === maxSev);
    const D = Math.max(...winners.map(r => r.requiredSeparationUnits != null ? r.requiredSeparationUnits : defaultSep(r.level, d)));
    return {
      level: winners[0].level, mode: winners[0].mode || defaultMode(winners[0].level, d),
      requiredSeparationUnits: D, source: 'rule-derived', firedRules: winners.map(r => r.id),
      provenance: winners.map(r => r.id + ': ' + r.provenance).join('  |  '),
    };
  }
  // 4. neutral
  return { level: 'NEUTRAL', mode: 'advisory', requiredSeparationUnits: 0, provenance: 'none (NEUTRAL default)', source: 'neutral' };
}

/* ═══ resolve every equipment instance pair into penalty metadata ═════════════ */
function resolvedPairs(project, d) {
  const types = project.machineTypes, overrides = project.adjacency || [];
  const machines = project.machines.filter(m => isEquipment(m, project));
  const out = [], overridesApplied = [];
  for (let i = 0; i < machines.length; i++) for (let j = i + 1; j < machines.length; j++) {
    const rel = resolvePair(machines[i], machines[j], types, overrides, d);
    // Record every user override for auditability — even one that NEUTRALISES the pair.
    if (rel.source === 'user-override') {
      overridesApplied.push({ a: machines[i].id, b: machines[j].id, types: [machines[i].type, machines[j].type], level: rel.level, provenance: rel.provenance });
    }
    if (rel.level === 'NEUTRAL') continue;
    const weight = d.levelWeights[rel.level], modeMult = d.modeMultipliers[rel.mode] || 1;
    out.push({
      idA: machines[i].id, idB: machines[j].id, typeA: machines[i].type, typeB: machines[j].type,
      level: rel.level, mode: rel.mode, weight, modeMult, source: rel.source, provenance: rel.provenance,
      firedRules: rel.firedRules || null,
      isSynergy: rel.level === 'SYNERGISTIC',
      D_req: rel.requiredSeparationUnits, D_ideal: d.synergy.idealUnits, D_span: d.synergy.spanUnits,
    });
  }
  return { machines, pairs: out, overridesApplied };
}

/* ═══ PUBLIC: standalone metric ═══════════════════════════════════════════════ */
export function computeAdjacency(project, opts = {}) {
  const d = opts.defaults || DEFAULTS;
  const scale = project.room.scale, stageW = scale.widthUnits, stageH = scale.heightUnits;
  const { machines, pairs, overridesApplied } = resolvedPairs(project, d);
  const zById = {}; for (const m of machines) zById[m.id] = zoneOf(m, project.machineTypes);

  let totalPenalty = 0, reference = 0;
  const diagnostics = [];
  for (const p of pairs) {
    reference += p.weight * p.modeMult;
    const dist = rectGap(rotAABBft(zById[p.idA], stageW, stageH), rotAABBft(zById[p.idB], stageW, stageH));
    const pen = pairPenalty(p, dist);
    totalPenalty += pen;
    if (pen > 1e-12) diagnostics.push({
      a: p.idA, b: p.idB, types: [p.typeA, p.typeB], level: p.level, mode: p.mode, source: p.source,
      kind: p.isSynergy ? 'too-far (synergy unmet)' : 'too-close (separation violated)',
      requiredSeparationFt: p.isSynergy ? p.D_ideal : p.D_req, actualSeparationFt: +dist.toFixed(3),
      penalty: +pen.toFixed(4), provenance: p.provenance, firedRules: p.firedRules,
    });
  }
  const objective = reference > 0 ? Math.max(0, Math.min(1, totalPenalty / reference)) : 0;
  diagnostics.sort((a, b) => b.penalty - a.penalty);
  return { objective, totalPenalty, reference, nonNeutralPairs: pairs.length, diagnostics, overridesApplied };
}

/* ═══ PUBLIC: baked O1 objective (evaluate runs in the vm; reads state.zones) ══ */
export function makeAdjacencyObjective(project, opts = {}) {
  const d = opts.defaults || DEFAULTS;
  const scale = project.room.scale;
  const { pairs } = resolvedPairs(project, d);
  const reference = pairs.reduce((a, p) => a + p.weight * p.modeMult, 0);
  const data = {
    stageW: scale.widthUnits, stageH: scale.heightUnits, reference,
    pairs: pairs.map(p => ({ idA: p.idA, idB: p.idB, weight: p.weight, modeMult: p.modeMult, isSynergy: p.isSynergy, D_req: p.D_req, D_ideal: p.D_ideal, D_span: p.D_span })),
  };
  const src =
    rotAABBft.toString() + '\n' + rectGap.toString() + '\n' + pairPenalty.toString() + '\n' +
    'var DATA = ' + JSON.stringify(data) + ';\n' +
    'if (!DATA.reference) return 0;\n' +
    'var total = 0;\n' +
    'for (var k = 0; k < DATA.pairs.length; k++) {\n' +
    '  var p = DATA.pairs[k]; var za = state.zones[p.idA], zb = state.zones[p.idB];\n' +
    '  if (!za || !zb) continue;\n' +
    '  var dist = rectGap(rotAABBft(za, DATA.stageW, DATA.stageH), rotAABBft(zb, DATA.stageW, DATA.stageH));\n' +
    '  total += pairPenalty(p, dist);\n' +
    '}\n' +
    'var v = total / DATA.reference; if (v < 0) v = 0; if (v > 1) v = 1; return v;\n';
  // eslint-disable-next-line no-new-func
  const evaluate = new Function('ctx', src);
  return {
    id: 'adjacency', name: 'Tool-adjacency violation (hazard/workflow)', direction: 'minimize',
    needsEngine: false,
    provenance: 'rule-derived from E1 hazard flags (NFPA 51B/33, OSHA 1910.252/.107/.303, NFPA 664/30) + SLP workflow pairs + user overrides; weights = design assumption (see v2/adjacency-defaults.json + ADJACENCY.md)',
    evaluate,
  };
}

export default { computeAdjacency, makeAdjacencyObjective, resolvePair, rotAABBft, rectGap, pairPenalty, DEFAULTS };
