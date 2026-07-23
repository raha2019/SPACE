/**
 * v2/test-adjacency.mjs  --  v2 Phase N1 Task 3.
 *
 * Fixtures with EXPECTED results stated in advance. A defensible divergence is a
 * FINDING (reported), not a silently edited expectation. Fixture (g) is the STOP
 * gate: if a plainly-hazardous move does not raise the penalty, the metric is broken.
 *
 *  (a) two compatible machines far apart          -> objective 0
 *  (b) welder + table saw @10 ft (PROHIBITED 35)  -> penalty 35.714 / obj 0.7143; @40 ft -> 0
 *  (c) synergistic pair                            -> penalty DECREASES as they approach
 *  (d) user override PROHIBITED->NEUTRAL           -> penalty vanishes, override recorded/auditable
 *  (e) conflicting rules                           -> most-severe (PROHIBITED) wins
 *  (f) the diagnostic fixture                      -> finds the answer-key prohibited pairs (incl grind x laser)
 *  (g) MRDC sensitivity                            -> moving next to an incompatible machine RAISES penalty
 *
 * Usage:  node v2/test-adjacency.mjs
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { computeAdjacency, resolvePair, DEFAULTS } from './adjacency.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const LIB = JSON.parse(readFileSync(join(ROOT, 'v2/machine-library.json'), 'utf8')).machineTypes;
const results = [];
const check = (name, pass, expected, computed) => { results.push({ name, pass, expected: String(expected), computed: String(computed) }); };
const near = (a, b, e = 1e-3) => Math.abs(a - b) <= e;
// stage where 1% = 1 ft (widthUnits=heightUnits=100) so footprint math is transparent.
const mk = (types, machines, adjacency) => ({ schemaVersion: '2.2.0', room: { shape: 'rectangle', scale: { pxPerUnit: 1, unit: 'ft', widthUnits: 100, heightUnits: 100 } }, machineTypes: types, machines, adjacency });

/* ── (a) two compatible machines far apart -> 0 ──────────────────────────────── */
{
  const r = computeAdjacency(mk({ printer3d: LIB.printer3d, drillPress: LIB.drillPress },
    [{ id: 'p', type: 'printer3d', x: 5, y: 5 }, { id: 'd', type: 'drillPress', x: 85, y: 85 }]));
  check('(a) compatible pair far apart -> objective 0', r.objective === 0 && r.diagnostics.length === 0, '0', r.objective);
}

/* ── (b) welder + table saw: PROHIBITED 35 ft (NFPA 51B) ─────────────────────── */
{
  const T = { weldingStation: LIB.weldingStation, tableSaw: LIB.tableSaw };
  // weld w6h5 @ (10,10) -> x[10,16]; tsaw @ (26,10) -> x[26,32]; edge gap = 10 ft.
  const b10 = computeAdjacency(mk(T, [{ id: 'w', type: 'weldingStation', x: 10, y: 10 }, { id: 's', type: 'tableSaw', x: 26, y: 10 }]));
  // EXPECT penalty = weight10 * strict5 * (35-10)/35 = 50 * 25/35 = 35.7143 ; objective = 35.7143/50 = 0.7143.
  check('(b) welder+saw @10 ft: penalty 35.7143 (NFPA 51B, 35 ft)', near(b10.totalPenalty, 35.7143), '35.7143', b10.totalPenalty.toFixed(4));
  check('(b) welder+saw @10 ft: objective 0.7143', near(b10.objective, 0.71429), '0.71429', b10.objective.toFixed(5));
  check('(b) diagnostic: PROHIBITED, required 35, actual 10, provenance NFPA', b10.diagnostics[0] && b10.diagnostics[0].level === 'PROHIBITED' && b10.diagnostics[0].requiredSeparationFt === 35 && near(b10.diagnostics[0].actualSeparationFt, 10) && /NFPA 51B/.test(b10.diagnostics[0].provenance), 'PROHIBITED/35/10/NFPA', b10.diagnostics[0] && `${b10.diagnostics[0].level}/${b10.diagnostics[0].requiredSeparationFt}/${b10.diagnostics[0].actualSeparationFt}`);
  // move to 40 ft (>35) -> 0.
  const b40 = computeAdjacency(mk(T, [{ id: 'w', type: 'weldingStation', x: 10, y: 10 }, { id: 's', type: 'tableSaw', x: 56, y: 10 }]));
  check('(b) welder+saw @40 ft -> objective 0 (beyond required separation)', b40.objective === 0, '0', b40.objective);
}

/* ── (c) synergistic pair -> penalty DECREASES as they approach ──────────────── */
{
  const T = { tableSaw: LIB.tableSaw, assemblyTable: LIB.assemblyTable };  // explicit SYNERGISTIC default
  const at = (dxFt) => computeAdjacency(mk(T, [{ id: 't', type: 'tableSaw', x: 10, y: 10 }, { id: 'a', type: 'assemblyTable', x: 10 + 6 + dxFt, y: 10 }]));
  const far = at(35), mid = at(15), nearP = at(2);   // edge gaps 35, 15, 2 ft
  // EXPECT: SYN penalty = 1 * (d-5)/30 ; far(35)->1.0, mid(15)->0.333, near(2)->0. Sign: DECREASES as closer.
  check('(c) synergy: penalty DECREASES as machines approach (far>mid>near)', far.totalPenalty > mid.totalPenalty && mid.totalPenalty > nearP.totalPenalty, 'far>mid>near', `${far.totalPenalty.toFixed(3)}>${mid.totalPenalty.toFixed(3)}>${nearP.totalPenalty.toFixed(3)}`);
  check('(c) synergy rewarded: adjacent (<=5 ft) -> penalty 0', nearP.totalPenalty === 0, '0', nearP.totalPenalty);
}

/* ── (d) user override PROHIBITED -> NEUTRAL: penalty vanishes, override audited ─ */
{
  const T = { weldingStation: LIB.weldingStation, tableSaw: LIB.tableSaw };
  const machines = [{ id: 'w', type: 'weldingStation', x: 10, y: 10 }, { id: 's', type: 'tableSaw', x: 26, y: 10 }];
  const ov = [{ a: 'weldingStation', b: 'tableSaw', level: 'NEUTRAL', provenance: 'user: 1-hr fire-rated wall between them' }];
  const r = computeAdjacency(mk(T, machines, ov));
  // EXPECT: default PROHIBITED (penalty 35.7) is overridden to NEUTRAL -> penalty 0, objective 0.
  check('(d) override to NEUTRAL -> objective 0 (was 0.7143 by default)', r.objective === 0 && r.totalPenalty === 0, '0', r.objective);
  const rec = r.overridesApplied.find(o => o.level === 'NEUTRAL');
  check('(d) override is auditable (recorded with provenance)', !!rec && /fire-rated wall/.test(rec.provenance), 'recorded w/ provenance', rec ? rec.provenance : 'NOT RECORDED');
}

/* ── (e) conflicting rules -> most severe wins ──────────────────────────────── */
{
  // sander (dustProducing) x electronicsBench (dustSensitive AND hotWork):
  //   R1 hotWork x dustProducing -> PROHIBITED 35 ; R7 dustProducing x dustSensitive -> DISCOURAGED 10.
  //   EXPECT resolved = PROHIBITED, separation 35 (most severe + most conservative), fired includes R1.
  const rel = resolvePair({ id: 's', type: 'sander' }, { id: 'e', type: 'electronicsBench' },
    { sander: LIB.sander, electronicsBench: LIB.electronicsBench }, [], DEFAULTS);
  check('(e) conflicting rules: PROHIBITED wins over DISCOURAGED', rel.level === 'PROHIBITED', 'PROHIBITED', rel.level);
  check('(e) conflicting rules: most-conservative separation (35 ft, not 10)', rel.requiredSeparationUnits === 35, '35', rel.requiredSeparationUnits);
  check('(e) conflicting rules: fired rule is R1 (hotWork x dustProducing)', (rel.firedRules || []).includes('R1'), 'R1', JSON.stringify(rel.firedRules));
}

/* ── (f) the diagnostic fixture: find the answer-key prohibited pairs ─────────── */
{
  const diag = JSON.parse(readFileSync(join(ROOT, 'testcase/diagnostic/diagnostic-plan.v2.json'), 'utf8'));
  const r = computeAdjacency(diag);
  const key = diag.meta.expectations.prohibitedAdjacencies.map(p => [p.a, p.b].sort().join('~'));
  const found = r.diagnostics.map(dg => [dg.a, dg.b].sort().join('~'));
  const foundSet = new Set(found);
  const keyFound = key.every(k => foundSet.has(k));
  check('(f) diagnostic: all answer-key prohibited pairs found (incl grind x laser)', keyFound, key.join(', '), found.join(', ') || 'none');
  const gl = r.diagnostics.find(dg => [dg.a, dg.b].sort().join('~') === 'grind~laser');
  check('(f) grind x laser is PROHIBITED with provenance', gl && gl.level === 'PROHIBITED' && /NFPA/.test(gl.provenance), 'PROHIBITED + NFPA', gl ? gl.level : 'NOT FOUND');
  // reconcile: report every violation + note extras beyond the key (findings, not failures)
  console.log('\n  (f) diagnostic adjacency — objective ' + r.objective.toFixed(4) + ', ' + r.diagnostics.length + ' violations:');
  for (const dg of r.diagnostics) console.log(`      ${dg.a} x ${dg.b} [${dg.types.join('/')}] ${dg.level} req ${dg.requiredSeparationFt}ft act ${dg.actualSeparationFt}ft pen ${dg.penalty} (${dg.firedRules || dg.source})`);
  const extras = found.filter(f => !key.includes(f));
  console.log('  (f) reconcile vs answer key: ' + (extras.length ? 'EXTRA violations beyond the key (findings): ' + extras.join(', ') : 'no extras'));
  const se = r.diagnostics.find(dg => [dg.a, dg.b].sort().join('~') === 'elec~sander');
  if (se) console.log('  (f) FINDING: sander x elec — key labels it "dust x dustSensitive" (DISCOURAGED); N1 escalates to ' + se.level + ' via ' + (se.firedRules || []).join(',') + ' (hotWork x dustProducing) — most-severe-wins, defensible.');
}

/* ── (g) MRDC sensitivity (STOP gate): move next to an incompatible machine -> RISE ─ */
let sensitivityOk = false;
{
  const mrdc = JSON.parse(readFileSync(join(ROOT, 'testcase/mrdc2323.v2.json'), 'utf8'));
  // MRDC types predate E1 (no hazard flags) -> add flags to a COPY so a hazard exists to detect.
  const base = JSON.parse(JSON.stringify(mrdc));
  base.machineTypes.welding = Object.assign({}, base.machineTypes.welding, { hazards: { sparkSource: true, hotWork: true } });
  base.machineTypes.wood = Object.assign({}, base.machineTypes.wood, { hazards: { dustProducing: true } });
  const before = computeAdjacency(base);
  const moved = JSON.parse(JSON.stringify(base));
  const w = moved.machines.find(m => m.id === 'welding'), wd = moved.machines.find(m => m.id === 'wood');
  w.x = wd.x; w.y = wd.y;   // move welding onto the wood room (max hazard)
  const after = computeAdjacency(moved);
  sensitivityOk = after.totalPenalty > before.totalPenalty;
  check('(g) MRDC: moving welder next to wood RAISES adjacency penalty', sensitivityOk, `> ${before.totalPenalty.toFixed(3)}`, after.totalPenalty.toFixed(3));
  console.log(`\n  (g) MRDC (welding+wood hazards added): penalty ${before.totalPenalty.toFixed(3)} -> ${after.totalPenalty.toFixed(3)} (obj ${before.objective.toFixed(3)} -> ${after.objective.toFixed(3)})`);
}

/* ── report ──────────────────────────────────────────────────────────────────── */
console.log('\n' + '='.repeat(74));
console.log('v2 Phase N1 — TOOL-ADJACENCY FIXTURES');
console.log('='.repeat(74));
let pass = 0, fail = 0;
for (const r of results) {
  console.log(`  [${r.pass ? 'PASS' : 'FAIL'}] ${r.name}`);
  if (!r.pass) { console.log(`         expected: ${r.expected}`); console.log(`         computed: ${r.computed}`); }
  r.pass ? pass++ : fail++;
}
console.log('='.repeat(74));
if (!sensitivityOk) console.log('STOP: sensitivity fixture (g) FAILED — the metric did not respond to a hazardous move.');
console.log(`RESULT: ${pass} PASS / ${fail} FAIL`);
console.log('='.repeat(74));
process.exit(fail === 0 ? 0 : 1);
