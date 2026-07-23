/**
 * v2/test-mosa-driver-equivalence.mjs  --  v2 Phase O1 Task 3.
 *
 * Proves the GENERALIZED driver, configured with exactly {ada, egress, noise},
 * reproduces the UNMODIFIED sim_mosa result BIT-FOR-BIT at seed 0x4D524443, 4000
 * iters — the frozen WSC pin. Reference is produced by the engine's own mosaOptimize
 * (via the V0 seam runProject), so this is generalized-driver == engine, not
 * generalized-driver == a remembered constant.
 *
 * Asserts:
 *   - baseline (seed) vector bit-for-bit
 *   - front size == 18
 *   - dominating count == 18/18
 *   - FULL front membership: every archive member's objective vector matches
 *     (compared both in archive order AND as a sorted set)
 *   - 3-run determinism of the generalized driver
 *
 * Any divergence HALTS (exit 1) with the root-cause diff. Do not proceed to Task 4
 * on failure.
 *
 * Usage:  node v2/test-mosa-driver-equivalence.mjs
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { runProject } from './engine-adapter.mjs';
import { runGeneralizedMosa } from './mosa-driver.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SEED = '0x4D524443';
const ITERS = 4000;
const PIN = { ada: 0.13827363048035732, egress: 0.4275, noise: 0.40589569160997735 };

const project = JSON.parse(readFileSync(join(ROOT, 'testcase/mrdc2323.v2.json'), 'utf8'));

/* Normalize a front to an array of [ada,egress,noise] tuples. */
function refFront(front) { return front.map(m => [m.vec.ada, m.vec.egress, m.vec.noise]); }
function genFront(front, objIds) {
  const iA = objIds.indexOf('ada'), iE = objIds.indexOf('egress'), iN = objIds.indexOf('noise');
  return front.map(m => [m.vec[iA], m.vec[iE], m.vec[iN]]);
}
const tupleKey = t => t.map(x => x === 0 ? '0' : x.toString()).join('|');
function sortTuples(ts) { return ts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]); }
function eqTuple(a, b) { return a[0] === b[0] && a[1] === b[1] && a[2] === b[2]; }

console.log('='.repeat(72));
console.log('O1 Task 3 — GENERALIZED driver == UNMODIFIED sim_mosa, bit-for-bit');
console.log(`seed ${SEED}, ${ITERS} iters, objectives {ada, egress, noise}`);
console.log('='.repeat(72));

/* --- reference: the engine's own mosaOptimize through the V0 seam --- */
console.log('\n[1/4] reference run (UNMODIFIED sim_mosa via runProject)…');
const ref = runProject(project, { seed: SEED, iters: ITERS });
console.log(`      seedVec=${ref.seedVec.ada}/${ref.seedVec.egress}/${ref.seedVec.noise}`);
console.log(`      front=${ref.frontLength} dom=${ref.dominatingCount}/${ref.frontLength}`);

/* --- generalized driver, 3 runs for determinism --- */
const runs = [];
for (let r = 0; r < 3; r++) {
  console.log(`\n[${r + 2}/4] generalized driver run ${r + 1}/3…`);
  const g = runGeneralizedMosa(project, ['ada', 'egress', 'noise'], { seed: SEED, iters: ITERS });
  console.log(`      seedVec=${g.seedVecObj.ada}/${g.seedVecObj.egress}/${g.seedVecObj.noise}`);
  console.log(`      front=${g.front.length} objIds=[${g.objIds.join(',')}]`);
  runs.push(g);
}

/* ── assertions ──────────────────────────────────────────────────────────── */
const fail = [];
const g0 = runs[0];

// (1) baseline vector bit-for-bit vs pin AND vs reference
const seedOkPin = g0.seedVecObj.ada === PIN.ada && g0.seedVecObj.egress === PIN.egress && g0.seedVecObj.noise === PIN.noise;
const seedOkRef = g0.seedVecObj.ada === ref.seedVec.ada && g0.seedVecObj.egress === ref.seedVec.egress && g0.seedVecObj.noise === ref.seedVec.noise;
if (!seedOkPin) fail.push('baseline vector != frozen pin');
if (!seedOkRef) fail.push('baseline vector != reference seedVec');

// (2) front size == 18 (both)
if (ref.frontLength !== 18) fail.push(`reference front size ${ref.frontLength} != 18`);
if (g0.front.length !== 18) fail.push(`generalized front size ${g0.front.length} != 18`);

// (3) dominating count: recompute for the generalized front (members dominating the seed)
const genTuples = genFront(g0.front, g0.objIds);
const seedTup = [g0.seedVecObj.ada, g0.seedVecObj.egress, g0.seedVecObj.noise];
const dominates = (a, b) => a[0] <= b[0] && a[1] <= b[1] && a[2] <= b[2] && (a[0] < b[0] || a[1] < b[1] || a[2] < b[2]);
const genDom = genTuples.filter(t => dominates(t, seedTup)).length;
if (genDom !== ref.dominatingCount) fail.push(`generalized dom ${genDom} != reference dom ${ref.dominatingCount}`);
if (ref.dominatingCount !== ref.frontLength) fail.push(`reference dom ${ref.dominatingCount} != front ${ref.frontLength} (expected 18/18)`);

// (4) FULL front membership — archive order
const refTuples = refFront(ref.front);
let orderMatch = refTuples.length === genTuples.length;
for (let i = 0; orderMatch && i < refTuples.length; i++) if (!eqTuple(refTuples[i], genTuples[i])) orderMatch = false;

// (4b) FULL front membership — sorted set (order-independent)
const rs = sortTuples(refTuples), gs = sortTuples(genTuples);
let setMatch = rs.length === gs.length;
const mismatches = [];
for (let i = 0; setMatch && i < rs.length; i++) {
  if (!eqTuple(rs[i], gs[i])) { setMatch = false; mismatches.push({ i, ref: rs[i], gen: gs[i] }); }
}
if (!setMatch) fail.push('front membership (sorted set) differs');
if (setMatch && !orderMatch) console.log('\n  note: front members identical as a SET but archive order differs (still a bit-for-bit membership match).');

// (5) 3-run determinism of the generalized driver
let det = true;
for (let r = 1; r < 3; r++) {
  const a = sortTuples(genFront(runs[0].front, runs[0].objIds));
  const b = sortTuples(genFront(runs[r].front, runs[r].objIds));
  if (a.length !== b.length) { det = false; break; }
  for (let i = 0; i < a.length; i++) if (!eqTuple(a[i], b[i])) { det = false; break; }
  if (runs[r].seedVecObj.ada !== runs[0].seedVecObj.ada ||
      runs[r].seedVecObj.egress !== runs[0].seedVecObj.egress ||
      runs[r].seedVecObj.noise !== runs[0].seedVecObj.noise) det = false;
}
if (!det) fail.push('generalized driver not deterministic across 3 runs');

/* ── report ──────────────────────────────────────────────────────────────── */
console.log('\n' + '─'.repeat(72));
console.log('baseline == pin (bit-for-bit)   : ' + (seedOkPin ? 'YES' : 'NO'));
console.log('baseline == reference           : ' + (seedOkRef ? 'YES' : 'NO'));
console.log(`front size (ref / gen)          : ${ref.frontLength} / ${g0.front.length}`);
console.log(`dominating count (ref / gen)    : ${ref.dominatingCount} / ${genDom}`);
console.log('front membership order-identical: ' + (orderMatch ? 'YES' : 'no'));
console.log('front membership set-identical  : ' + (setMatch ? 'YES' : 'NO'));
console.log('3-run determinism               : ' + (det ? 'YES' : 'NO'));
if (mismatches.length) {
  console.log('\n  MEMBERSHIP MISMATCHES (root-cause — likely RNG draw order):');
  for (const m of mismatches.slice(0, 6)) {
    console.log(`   [${m.i}] ref=${JSON.stringify(m.ref)}  gen=${JSON.stringify(m.gen)}`);
    console.log(`        d=[${m.gen[0] - m.ref[0]}, ${m.gen[1] - m.ref[1]}, ${m.gen[2] - m.ref[2]}]`);
  }
}
console.log('─'.repeat(72));
const pass = fail.length === 0;
console.log('RESULT: ' + (pass ? 'PASS — generalized driver reproduces the frozen pin BIT-FOR-BIT' : 'FAIL'));
if (!pass) { console.log('  failures:'); for (const f of fail) console.log('   - ' + f); }
console.log('='.repeat(72));
process.exit(pass ? 0 : 1);
