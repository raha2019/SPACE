/**
 * v2/run-diagnostic.mjs  --  live diagnostic against the v2 fixture.
 *
 * Loads testcase/diagnostic/diagnostic-plan.v2.json, runs the FULL v2 pipeline in
 * order, and checks every result against the fixture's answer key (meta.expectations).
 * Prints PASS/FAIL per expectation with expected-vs-computed. Does NOT stop on the
 * first failure — the point is a complete diagnostic picture.
 *
 * Pipeline: schema validation -> zone detection -> geometry validation -> blocker
 * translation -> per-zone simulation -> generalized MOSA (3 engine objectives) ->
 * frontier/knee presentation. Plus amenity-linkage and prohibited-adjacency checks
 * over the E1 attribute layer.
 *
 * Reads only. Touches no engine file, no frozen artifact.
 *
 * Usage:  node v2/run-diagnostic.mjs
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { detectZones, validateGeometry } from './zone-detection.mjs';
import { zoneToBlockers } from './zone-to-blocker.mjs';
import { evaluateProjectPerZone } from './zone-sim.mjs';
import { runGeneralizedMosa } from './mosa-driver.mjs';
import { presentFront } from './frontier.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const schema = JSON.parse(readFileSync(join(ROOT, 'schema/space-project.v2.json'), 'utf8'));
const project = JSON.parse(readFileSync(join(ROOT, 'testcase/diagnostic/diagnostic-plan.v2.json'), 'utf8'));
const EXP = project.meta.expectations;

const results = [];
const check = (name, pass, expected, computed) => { results.push({ name, pass, expected: String(expected), computed: String(computed) }); };
const setEq = (a, b) => a.length === b.length && [...a].sort((x, y) => x - y).every((v, i) => v === [...b].sort((x, y) => x - y)[i]);

/* ── mini JSON-Schema (draft 2020-12 subset) validator ─────────────────────── */
function resolveRef(ref) { let n = schema; for (const p of ref.replace(/^#\//, '').split('/')) n = n[p]; return n; }
function typeOf(v) { return v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v; }
function validate(node, val, path, errs) {
  if (!node) return;
  if (node.$ref) return validate(resolveRef(node.$ref), val, path, errs);
  if (node.const !== undefined && val !== node.const) errs.push(`${path}: const`);
  if (node.enum && !node.enum.includes(val)) errs.push(`${path}: enum ${JSON.stringify(val)}`);
  if (node.type) {
    const types = Array.isArray(node.type) ? node.type : [node.type];
    const t = typeOf(val);
    if (!types.some(tt => tt === t || (tt === 'number' && t === 'integer'))) { errs.push(`${path}: type ${t} not ${JSON.stringify(types)}`); return; }
  }
  if (typeof val === 'number') {
    if (node.minimum !== undefined && val < node.minimum) errs.push(`${path}: <min`);
    if (node.maximum !== undefined && val > node.maximum) errs.push(`${path}: >max`);
    if (node.exclusiveMinimum !== undefined && val <= node.exclusiveMinimum) errs.push(`${path}: <=exclMin`);
  }
  if (typeof val === 'string' && node.pattern && !new RegExp(node.pattern).test(val)) errs.push(`${path}: pattern`);
  if (Array.isArray(val)) {
    if (node.minItems !== undefined && val.length < node.minItems) errs.push(`${path}: minItems`);
    if (node.items) val.forEach((v, i) => validate(node.items, v, `${path}[${i}]`, errs));
  }
  if (val && typeof val === 'object' && !Array.isArray(val)) {
    if (node.required) for (const r of node.required) if (!(r in val)) errs.push(`${path}: missing "${r}"`);
    const props = node.properties || {};
    for (const k of Object.keys(val)) {
      if (props[k]) validate(props[k], val[k], `${path}.${k}`, errs);
      else if (node.additionalProperties === false) errs.push(`${path}.${k}: additionalProperties=false`);
      else if (node.additionalProperties && typeof node.additionalProperties === 'object') validate(node.additionalProperties, val[k], `${path}.${k}`, errs);
    }
  }
}

/* ── helpers: machine geometry in real units (ft) ──────────────────────────── */
const scale = project.room.scale;
const types = project.machineTypes;
function centerFt(m) {
  const t = types[m.type] || {};
  const w = m.w != null ? m.w : t.w, h = m.h != null ? m.h : t.h;
  const x = (m.x != null ? m.x : 50) + (w || 0) / 2;
  const y = (m.y != null ? m.y : 50) + (h || 0) / 2;
  return { x: x * scale.widthUnits / 100, y: y * scale.heightUnits / 100 };
}
const distFt = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

console.log('='.repeat(74));
console.log('SPACE/MOSA LIVE DIAGNOSTIC — v2 fixture: ' + project.meta.name);
console.log('='.repeat(74));

/* ── 1. schema validation ──────────────────────────────────────────────────── */
const schemaErrs = [];
validate(schema, project, '$', schemaErrs);
check('schema: fixture validates against space-project.v2.json (2.1.0)', schemaErrs.length === 0, '0 errors', schemaErrs.length ? schemaErrs.slice(0, 5).join(' | ') : '0 errors');

/* ── 2. zone detection ─────────────────────────────────────────────────────── */
const det = detectZones(project.structuralGeometry, scale);
const areas = det.zones.map(z => Math.round(z.areaUnits));
check('zones: count', det.zones.length === EXP.geometry.zoneCount, EXP.geometry.zoneCount, det.zones.length);
check('zones: areas (ft^2, as a set)', setEq(areas, EXP.geometry.zoneAreasFt2), JSON.stringify(EXP.geometry.zoneAreasFt2), JSON.stringify(areas));
check('zones: total room area (ft^2)', areas.reduce((a, b) => a + b, 0) === EXP.geometry.roomAreaFt2, EXP.geometry.roomAreaFt2, areas.reduce((a, b) => a + b, 0));
const unreachable = det.zones.filter(z => (z.doors || []).length === 0);
check('zones: exactly one unreachable (no door)', unreachable.length === 1, 1, unreachable.length);
check('zones: unreachable zone area (ft^2)', unreachable.length === 1 && Math.round(unreachable[0].areaUnits) === EXP.geometry.unreachableZoneAreaFt2, EXP.geometry.unreachableZoneAreaFt2, unreachable.length ? Math.round(unreachable[0].areaUnits) : 'n/a');
const roleCounts = {};
for (const d of det.doors) roleCounts[d.role] = (roleCounts[d.role] || 0) + 1;
check('doors: role counts', JSON.stringify(roleCounts) === JSON.stringify(EXP.geometry.doorRoles), JSON.stringify(EXP.geometry.doorRoles), JSON.stringify(roleCounts));

/* ── 3. geometry validation ────────────────────────────────────────────────── */
const gv = validateGeometry(det);
const noDoorFlag = (det.flags || []).some(f => f.code === 'zone-no-door');
check('geometry: validateGeometry flags the unreachable (no-door) zone', noDoorFlag, 'zone-no-door flag present', noDoorFlag ? 'present' : 'absent');

/* ── 4. blocker translation (each zone isolates exactly) ───────────────────── */
let allExact = true;
for (const z of det.zones) { const g = zoneToBlockers({ polygonPct: z.polygonPct }, {}); if (!g.exact) allExact = false; }
check('blockers: every zone translates to exact (rectilinear) wall blockers', allExact, 'all exact', allExact ? 'all exact' : 'a zone was non-exact');

/* ── 5. per-zone simulation ────────────────────────────────────────────────── */
const pz = evaluateProjectPerZone(project, {});
const reach = pz.zones.filter(z => z.reachable);
const unreach = pz.zones.filter(z => !z.reachable);
check('per-zone: unreachable zone excluded from aggregate', pz.flags.unreachableZones === 1 && pz.flags.reachableZones === 2, 'reachable=2 unreachable=1', `reachable=${pz.flags.reachableZones} unreachable=${pz.flags.unreachableZones}`);
check('per-zone: unreachable zone flagged reachable=false', unreach.length === 1 && unreach[0].reachable === false, 'one zone reachable=false', `${unreach.length} unreachable`);
const anyAda = reach.some(z => z.vec && z.vec.ada > 0);
check('per-zone: ADA non-compliance present in a reachable zone (deliberate pinch)', anyAda, 'ada > 0 in a reachable zone', reach.map(z => 'ada=' + z.vec.ada.toFixed(3)).join(', '));
const egressDefined = reach.every(z => z.vec && z.vec.egress >= 0 && z.vec.egress <= 1) && pz.aggregate && pz.aggregate.egress >= 0 && pz.aggregate.egress <= 1;
check('per-zone: reachable zones report egress in [0,1]; aggregate defined', egressDefined, 'egress in [0,1]', 'agg egress=' + (pz.aggregate ? pz.aggregate.egress.toFixed(4) : 'null'));

/* ── 6. amenity linkages ───────────────────────────────────────────────────── */
const amenities = project.machines.filter(m => (types[m.type] || {}).amenityProvides)
  .map(m => ({ id: m.id, provides: types[m.type].amenityProvides, c: centerFt(m) }));
function evalLink(machineId, link) {
  const m = project.machines.find(x => x.id === machineId);
  const cands = amenities.filter(a => a.provides === link.amenityType);
  if (!cands.length) return { status: 'UNSATISFIABLE', dist: null };
  const c = centerFt(m);
  const d = Math.min(...cands.map(a => distFt(c, a.c)));
  const max = link.maxDistanceUnits != null ? link.maxDistanceUnits : Infinity;
  return { status: d <= max ? 'SATISFIED' : 'VIOLATED', dist: d, max };
}
for (const exp of EXP.amenityLinks) {
  const m = project.machines.find(x => x.id === exp.machine);
  const link = ((types[m.type] || {}).amenityLinks || []).find(l => l.amenityType === exp.amenityType);
  const got = link ? evalLink(exp.machine, link) : { status: 'NO_LINK', dist: null };
  const ok = got.status === exp.status && (got.dist == null || Math.abs(got.dist - exp.distFt) < 0.5);
  check(`amenity: ${exp.machine} -> ${exp.amenityType}`, ok, `${exp.status} (~${exp.distFt} ft, max ${exp.maxFt})`, `${got.status} (${got.dist == null ? 'n/a' : got.dist.toFixed(1)} ft)`);
}
// informational: count UNSATISFIABLE library links (no amenity of that type placed)
let unsat = 0, allLinks = 0;
for (const m of project.machines) for (const l of ((types[m.type] || {}).amenityLinks || [])) { allLinks++; if (evalLink(m.id, l).status === 'UNSATISFIABLE') unsat++; }

/* ── 7. prohibited adjacencies (hazard incompatibility) ────────────────────── */
const INCOMPAT = [ // design-assumption hazard-separation matrix
  { a: ['sparkSource', 'hotWork'], b: ['flammable'], rule: 'ignition' },
  { a: ['sparkSource', 'hotWork'], b: ['dustProducing'], rule: 'sparkSource x dustProducing' },
  { a: ['dustProducing'], b: ['dustSensitive'], rule: 'dustProducing x dustSensitive' },
  { a: ['vibrationSource'], b: ['vibrationSensitive'], rule: 'vibration' },
];
const ADJ_FT = 10;
const equip = project.machines.filter(m => !(types[m.type] || {}).amenityProvides);
const has = (m, flag) => !!((types[m.type] || {}).hazards || {})[flag];
const foundAdj = [];
for (let i = 0; i < equip.length; i++) for (let j = i + 1; j < equip.length; j++) {
  const A = equip[i], B = equip[j];
  if (distFt(centerFt(A), centerFt(B)) > ADJ_FT) continue;
  for (const rule of INCOMPAT) {
    const ab = rule.a.some(f => has(A, f)) && rule.b.some(f => has(B, f));
    const ba = rule.a.some(f => has(B, f)) && rule.b.some(f => has(A, f));
    if (ab || ba) { foundAdj.push({ a: A.id, b: B.id, rule: rule.rule }); break; }
  }
}
const pairKey = (a, b) => [a, b].sort().join('~');
const foundSet = new Set(foundAdj.map(f => pairKey(f.a, f.b)));
const expSet = new Set(EXP.prohibitedAdjacencies.map(e => pairKey(e.a, e.b)));
check('adjacency: prohibited pairs == expected set', foundSet.size === expSet.size && [...expSet].every(k => foundSet.has(k)),
  [...expSet].join(', '), [...foundSet].join(', ') || 'none');
for (const e of EXP.prohibitedAdjacencies) {
  check(`adjacency: ${e.a} x ${e.b} (${e.rule})`, foundSet.has(pairKey(e.a, e.b)), 'prohibited (within ' + ADJ_FT + ' ft)', foundSet.has(pairKey(e.a, e.b)) ? 'flagged' : 'not flagged');
}

/* ── 8. generalized MOSA (3 engine objectives) + determinism ───────────────── */
const seed = project.optimization.seed, iters = project.optimization.iters;
const g1 = runGeneralizedMosa(project, ['ada', 'egress', 'noise'], { seed, iters });
const g2 = runGeneralizedMosa(project, ['ada', 'egress', 'noise'], { seed, iters });
const dom = (a, b) => { let le = true, lt = false; for (let i = 0; i < a.length; i++) { if (a[i] > b[i]) le = false; if (a[i] < b[i]) lt = true; } return le && lt; };
let nd = true; for (let i = 0; i < g1.front.length && nd; i++) for (let j = 0; j < g1.front.length; j++) if (i !== j && dom(g1.front[i].vec, g1.front[j].vec)) { nd = false; break; }
check('mosa: non-empty Pareto front', g1.front.length >= 1, '>= 1 member', g1.front.length + ' members');
check('mosa: front is mutually non-dominated', nd, 'no member dominates another', nd ? 'non-dominated' : 'domination found');
const key = f => f.map(m => m.vec.join(',')).sort().join('|');
check('mosa: deterministic across 2 runs at fixed seed', key(g1.front) === key(g2.front), 'identical fronts', key(g1.front) === key(g2.front) ? 'identical' : 'diverged');

/* ── 9. frontier / knee presentation ───────────────────────────────────────── */
const pr = presentFront(g1.front, g1.objIds);
const frontierOk = pr.knee && pr.kneeOrigin && pr.perObjectiveBest && Object.keys(pr.perObjectiveBest).length === 3;
check('frontier: knee, kneeOrigin, and per-objective best all defined', frontierOk, 'knee+kneeOrigin+3 per-objective bests', frontierOk ? `knee@${pr.knee.index}, bests=${Object.keys(pr.perObjectiveBest).join('/')}` : 'incomplete');

/* ── report ────────────────────────────────────────────────────────────────── */
console.log('');
let pass = 0, fail = 0;
for (const r of results) {
  console.log(`  [${r.pass ? 'PASS' : 'FAIL'}] ${r.name}`);
  if (!r.pass) { console.log(`         expected: ${r.expected}`); console.log(`         computed: ${r.computed}`); }
  r.pass ? pass++ : fail++;
}
console.log('');
console.log(`  amenity links: ${allLinks} total across machines; ${unsat} UNSATISFIABLE (no amenity of that type placed — informational, not a failure).`);
console.log(`  MOSA note: whole-stage MOSA does not see v2 structural doors (no cat:"exit" machines), so its seed egress is the unreachable artifact (${g1.seedVecObj.egress}); the per-zone sim is the egress-aware path.`);
console.log('');
console.log('='.repeat(74));
console.log(`DIAGNOSTIC: ${pass} PASS / ${fail} FAIL  (${results.length} checks)`);
console.log('='.repeat(74));
process.exit(fail === 0 ? 0 : 1);
