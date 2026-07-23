/**
 * v2/test-amenity-links.mjs  --  v2 Phase L1 Task 3.
 *
 * Expected results stated in advance; defensible divergences are findings, not edits.
 * Fixtures (b) wall-defeats-eyewash and (f) sensitivity are STOP gates.
 *
 *  (a) welder + extinguisher within NFPA 10 travel -> satisfied; move beyond -> penalty (threshold)
 *  (b) eyewash 10 ft straight-line but WALLED OFF     -> VIOLATED on travel (proves path reachability)
 *  (c) nearest-instance satisfies                     -> near one satisfies; remove it -> penalty
 *  (d) user override of a link's distance             -> penalty changes + override recorded
 *  (e) the diagnostic fixture                          -> finds the satisfied + violated linkages; reconcile
 *  (f) MRDC sensitivity                                -> move amenity away -> penalty RISES
 *
 * Usage:  node v2/test-amenity-links.mjs
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { computeAmenityLinks } from './amenity-links.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const LIB = JSON.parse(readFileSync(join(ROOT, 'v2/machine-library.json'), 'utf8')).machineTypes;
const results = [];
const check = (name, pass, expected, computed) => { results.push({ name, pass, expected: String(expected), computed: String(computed) }); };
const FE = { label: 'Fire Ext', elementClass: 'amenity', cat: 'amenity', w: 1, h: 1, amenityProvides: 'fireExtinguisher' };
const EW = { label: 'Eyewash', elementClass: 'amenity', cat: 'amenity', w: 2, h: 2, amenityProvides: 'eyewash' };
const EX = { label: 'Exit', cat: 'exit', w: 3, h: 3, fixed: true };

/* ── (a) welder + fire extinguisher within NFPA 10 travel (threshold) ─────────── */
{
  // stage 100x100 ft. weld explicit link: fireExtinguisher <= 30 ft travel (path). Same-y clear line -> travel ~ x-gap.
  const T = { weldingStation: LIB.weldingStation, FE, EX };
  const mk = (feX) => ({ schemaVersion: '2.2.0', room: { shape: 'rectangle', scale: { pxPerUnit: 1, unit: 'ft', widthUnits: 100, heightUnits: 100 } }, machineTypes: T, machines: [{ id: 'w', type: 'weldingStation', x: 10, y: 10 }, { id: 'fe', type: 'FE', x: feX, y: 12 }, { id: 'x', type: 'EX', x: 0, y: 0 }] });
  // weld footprint right edge x=16 ft; fe @ x=44 -> gap 28 ft (<30, SATISFIED); fe @ x=52 -> gap 36 ft (>30, VIOLATED).
  const sat = computeAmenityLinks(mk(44)), vio = computeAmenityLinks(mk(52));
  const dSat = sat.diagnostics.find(d => d.amenityType === 'fireExtinguisher');
  const dVio = vio.diagnostics.find(d => d.amenityType === 'fireExtinguisher');
  check('(a) extinguisher within 30 ft travel -> SATISFIED (penalty 0)', sat.objective === 0 && !dSat, 'SATISFIED, obj 0', dSat ? dSat.status : 'SATISFIED');
  check('(a) extinguisher beyond 30 ft travel -> VIOLATED (penalty)', !!dVio && dVio.status === 'VIOLATED' && vio.objective > 0, 'VIOLATED', dVio ? `${dVio.status} travel=${dVio.actualFt}` : 'none');
  console.log(`  (a) hand-verify threshold: SAT travel=${(sat.diagnostics.find(d => d.amenityType === 'fireExtinguisher') || {}).actualFt || '<=30'} ; VIOLATED travel=${dVio.actualFt} (req 30)`);
}

/* ── (b) wall defeats a 10-ft eyewash -> VIOLATED on travel (STOP gate) ───────── */
let bOk = false;
{
  const T = { waterjet: LIB.waterjet, EW, EX };
  const p = {
    schemaVersion: '2.2.0', room: { shape: 'rectangle', scale: { pxPerUnit: 1, unit: 'ft', widthUnits: 60, heightUnits: 40 } }, machineTypes: T,
    machines: [{ id: 'wj', type: 'waterjet', x: 5, y: 45 }, { id: 'ew', type: 'EW', x: 23.3, y: 47.5 }, { id: 'exL', type: 'EX', x: 2, y: 2 }, { id: 'exR', type: 'EX', x: 90, y: 2 }],
    structuralGeometry: { snapTol: 0.05, walls: [{ id: 'w', from: { x: 16.67, y: 0 }, to: { x: 16.67, y: 100 } }], doors: [] },
  };
  const r = computeAmenityLinks(p);
  const ew = r.diagnostics.find(d => d.amenityType === 'eyewash');
  // straight-line is ~7 ft (<55) so a straight-line metric would SATISFY. Path-based must VIOLATE.
  bOk = !!ew && /UNREACHABLE|VIOLATED/.test(ew.status);
  check('(b) eyewash 10 ft straight-line but WALLED OFF -> VIOLATED on travel', bOk, 'VIOLATED/UNREACHABLE', ew ? ew.status : 'SATISFIED (path reuse broken!)');
}

/* ── (c) nearest-instance satisfies ──────────────────────────────────────────── */
{
  const T = { weldingStation: LIB.weldingStation, FE, EX };
  const withNear = { schemaVersion: '2.2.0', room: { shape: 'rectangle', scale: { pxPerUnit: 1, unit: 'ft', widthUnits: 100, heightUnits: 100 } }, machineTypes: T,
    machines: [{ id: 'w', type: 'weldingStation', x: 10, y: 10 }, { id: 'feNear', type: 'FE', x: 30, y: 12 }, { id: 'feFar', type: 'FE', x: 90, y: 90 }, { id: 'x', type: 'EX', x: 0, y: 0 }] };
  const rNear = computeAmenityLinks(withNear);
  check('(c) two extinguishers -> satisfied by the NEAR one (obj 0)', rNear.objective === 0, '0', rNear.objective);
  const noNear = JSON.parse(JSON.stringify(withNear)); noNear.machines = noNear.machines.filter(m => m.id !== 'feNear');
  const rFar = computeAmenityLinks(noNear);
  check('(c) remove the near one -> penalty appears (only far remains)', rFar.objective > 0, '>0', rFar.objective.toFixed(4));
}

/* ── (d) user override of a link's distance requirement ──────────────────────── */
{
  const T = { weldingStation: LIB.weldingStation, FE, EX };
  const machines = [{ id: 'w', type: 'weldingStation', x: 10, y: 10 }, { id: 'fe', type: 'FE', x: 52, y: 12 }, { id: 'x', type: 'EX', x: 0, y: 0 }];
  const room = { shape: 'rectangle', scale: { pxPerUnit: 1, unit: 'ft', widthUnits: 100, heightUnits: 100 } };
  const base = computeAmenityLinks({ schemaVersion: '2.2.0', room, machineTypes: T, machines });   // default 30 ft -> travel ~36 VIOLATED
  // override to 50 ft -> travel ~36 now SATISFIED
  const ov = [{ machine: 'w', amenityType: 'fireExtinguisher', maxDistanceUnits: 50, provenance: 'user: portable extinguisher rating allows 50 ft here' }];
  const over = computeAmenityLinks({ schemaVersion: '2.2.0', room, machineTypes: T, machines, amenityLinks: ov });
  check('(d) override relaxing 30->50 ft flips VIOLATED to SATISFIED', base.objective > 0 && over.objective === 0, 'base>0, override=0', `base=${base.objective.toFixed(3)} over=${over.objective}`);
  const rec = over.overridesApplied.find(o => o.amenityType === 'fireExtinguisher');
  check('(d) override recorded with provenance (auditable)', !!rec && /portable extinguisher/.test(rec.provenance), 'recorded w/ provenance', rec ? rec.provenance : 'NOT RECORDED');
}

/* ── (e) the diagnostic fixture ──────────────────────────────────────────────── */
{
  const diag = JSON.parse(readFileSync(join(ROOT, 'testcase/diagnostic/diagnostic-plan.v2.json'), 'utf8'));
  const r = computeAmenityLinks(diag);
  const byPair = {}; for (const d of r.diagnostics) byPair[d.machine + '->' + d.amenityType] = d;
  // answer key: grind->eyewash VIOLATED (~59 ft straight, travel longer); weld->fireExt SATISFIED (~8 ft straight).
  const grindEye = byPair['grind->eyewash'];
  const weldFire = r.diagnostics.find(d => d.machine === 'weld' && d.amenityType === 'fireExtinguisher');
  check('(e) diagnostic: grind->eyewash is VIOLATED/UNREACHABLE (answer-key violated link)', !!grindEye && /VIOLATED|UNREACHABLE/.test(grindEye.status), 'VIOLATED', grindEye ? grindEye.status : 'not found');
  check('(e) diagnostic: weld->fireExtinguisher is SATISFIED (answer-key satisfied link)', !weldFire, 'SATISFIED (no violation diag)', weldFire ? weldFire.status : 'SATISFIED');
  console.log(`\n  (e) diagnostic amenity-links — objective ${r.objective.toFixed(4)} ; ${r.diagnostics.length} violation(s):`);
  for (const d of r.diagnostics) console.log(`      ${d.machine} -> ${d.amenityType} [${d.distanceMode}] ${d.status} req ${d.requiredFt}ft act ${d.actualFt}ft pen ${d.penalty} (${d.source})`);
  console.log('  (e) UNSATISFIABLE (no such amenity placed — provisioning gap, excluded): ' + (r.unsatisfiable.map(u => u.machine + '->' + u.amenityType).join(', ') || 'none'));
  console.log('  (e) FINDING vs key: L1 uses PATH-BASED travel for fire-ext/eyewash (key used straight-line); it also reports the missing fume-hood/flammables/dust-collection amenities as UNSATISFIABLE provisioning gaps the key did not enumerate.');
}

/* ── (f) MRDC sensitivity (STOP gate): move amenity away -> penalty RISES ─────── */
let fOk = false;
{
  const mrdc = JSON.parse(readFileSync(join(ROOT, 'testcase/mrdc2323.v2.json'), 'utf8'));
  const base = JSON.parse(JSON.stringify(mrdc));
  // MRDC predates E1 -> give 'welding' a fire-extinguisher link and place an extinguisher (on a COPY).
  base.machineTypes.welding = Object.assign({}, base.machineTypes.welding, { amenityLinks: [{ amenityType: 'fireExtinguisher', maxDistanceUnits: 30, mode: 'strict', provenance: 'NFPA 10' }] });
  base.machineTypes.fireExt = { label: 'Fire Ext', elementClass: 'amenity', cat: 'amenity', w: 2, h: 2, amenityProvides: 'fireExtinguisher' };
  const wld = base.machines.find(m => m.id === 'welding');
  base.machines = base.machines.concat([{ id: 'feA', type: 'fireExt', x: wld.x + 3, y: wld.y }]);   // extinguisher right next to welding
  const before = computeAmenityLinks(base);
  const moved = JSON.parse(JSON.stringify(base));
  // welding is at (16,4) (top); move the extinguisher to the far BOTTOM of the L (genuinely distant + reachable).
  const fe = moved.machines.find(m => m.id === 'feA'); fe.x = 10; fe.y = 88;
  const after = computeAmenityLinks(moved);
  fOk = after.totalPenalty > before.totalPenalty;
  check('(f) MRDC: moving the extinguisher away from the welder RAISES the penalty', fOk, `> ${before.totalPenalty.toFixed(3)}`, after.totalPenalty.toFixed(3));
  console.log(`\n  (f) MRDC: penalty ${before.totalPenalty.toFixed(3)} -> ${after.totalPenalty.toFixed(3)} (obj ${before.objective.toFixed(3)} -> ${after.objective.toFixed(3)})`);
}

/* ── report ──────────────────────────────────────────────────────────────────── */
console.log('\n' + '='.repeat(76));
console.log('v2 Phase L1 — AMENITY-LINKAGE FIXTURES');
console.log('='.repeat(76));
let pass = 0, fail = 0;
for (const r of results) { console.log(`  [${r.pass ? 'PASS' : 'FAIL'}] ${r.name}`); if (!r.pass) { console.log(`         expected: ${r.expected}`); console.log(`         computed: ${r.computed}`); } r.pass ? pass++ : fail++; }
console.log('='.repeat(76));
if (!bOk) console.log('STOP: fixture (b) FAILED — path-based reachability not working (a wall did not defeat the link).');
if (!fOk) console.log('STOP: fixture (f) FAILED — the metric did not respond to moving an amenity away.');
console.log(`RESULT: ${pass} PASS / ${fail} FAIL`);
console.log('='.repeat(76));
process.exit(fail === 0 ? 0 : 1);
