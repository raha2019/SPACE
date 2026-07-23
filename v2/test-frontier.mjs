/**
 * v2/test-frontier.mjs  --  v2 Phase O1 Task 5.
 *
 * Tests the n-objective presentation layer (v2/frontier.mjs):
 *   (A) synthetic small fronts with HAND-KNOWN knees / per-objective bests /
 *       parallel-coordinate normalization — fast and deterministic.
 *   (B) the REAL frozen MRDC 3-objective front: presentFront(...).kneeOrigin must
 *       match, bit-for-bit, the knee the current sim_mosa.js mosaOptimizeUI computes
 *       (Math.hypot(ada,egress,noise), first-wins). This is the "poster unchanged"
 *       guarantee. Also reports whether the generalized min-max knee agrees.
 *
 * Usage:  node v2/test-frontier.mjs
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { presentFront } from './frontier.mjs';
import { runGeneralizedMosa } from './mosa-driver.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SEED = '0x4D524443';

const results = [];
const check = (name, pass, detail) => { results.push({ name, pass, detail }); };

/* ── (A) synthetic hand-checked front ─────────────────────────────────────── */
// 3 objectives; vecs chosen so the knee is obvious by hand.
// Members (ada, egress, noise):
//   m0 = [0.10, 0.90, 0.50]  -> best ada
//   m1 = [0.90, 0.10, 0.50]  -> best egress
//   m2 = [0.50, 0.50, 0.10]  -> best noise
//   m3 = [0.40, 0.40, 0.40]  -> balanced (the min-max knee)
const synthFront = [
  { pos: {}, vec: [0.10, 0.90, 0.50] },
  { pos: {}, vec: [0.90, 0.10, 0.50] },
  { pos: {}, vec: [0.50, 0.50, 0.10] },
  { pos: {}, vec: [0.40, 0.40, 0.40] },
];
const P = presentFront(synthFront, ['ada', 'egress', 'noise']);

// ideal = [0.10,0.10,0.10], nadir = [0.90,0.90,0.50]
check('(A) ideal (per-objective min)', JSON.stringify(P.ideal) === JSON.stringify([0.10, 0.10, 0.10]), JSON.stringify(P.ideal));
check('(A) nadir (per-objective max)', JSON.stringify(P.nadir) === JSON.stringify([0.90, 0.90, 0.50]), JSON.stringify(P.nadir));

// per-objective best members
check('(A) best ada = m0', P.perObjectiveBest.ada.index === 0, 'idx=' + P.perObjectiveBest.ada.index);
check('(A) best egress = m1', P.perObjectiveBest.egress.index === 1, 'idx=' + P.perObjectiveBest.egress.index);
check('(A) best noise = m2', P.perObjectiveBest.noise.index === 2, 'idx=' + P.perObjectiveBest.noise.index);

// Hand min-max normalized distances (ranges = [0.8, 0.8, 0.4]):
//   m0=[.1,.9,.5] norm=[0,1,1]        -> sqrt(2)      = 1.4142
//   m1=[.9,.1,.5] norm=[1,0,1]        -> sqrt(2)      = 1.4142
//   m2=[.5,.5,.1] norm=[.5,.5,0]      -> sqrt(0.5)    = 0.70711   <- MIN-MAX KNEE
//   m3=[.4,.4,.4] norm=[.375,.375,.75]-> sqrt(0.84375)= 0.91856
// The tiny noise range (0.4) amplifies m3's noise deviation, so m2 (at the noise
// ideal) is the min-max knee, NOT the balanced m3. A clean demonstration that
// min-max normalization and raw distance can pick different members.
const m2normHand = Math.sqrt(0.5);
const m3normHand = Math.sqrt(((0.4 - 0.1) / 0.8) ** 2 + ((0.4 - 0.1) / 0.8) ** 2 + ((0.4 - 0.1) / 0.4) ** 2);
const normDists = P.parallelCoords.series.map(s => s.normDist);
const kneeByNorm = normDists.indexOf(Math.min(...normDists));
check('(A) min-max knee is m2 (at noise ideal)', P.knee.index === 2 && kneeByNorm === 2, 'kneeIdx=' + P.knee.index);
check('(A) m2 normDist matches hand calc sqrt(0.5)', Math.abs(P.parallelCoords.series[2].normDist - m2normHand) < 1e-12, `${P.parallelCoords.series[2].normDist} vs ${m2normHand}`);
check('(A) m3 normDist matches hand calc', Math.abs(P.parallelCoords.series[3].normDist - m3normHand) < 1e-12, `${P.parallelCoords.series[3].normDist} vs ${m3normHand}`);

// Origin knee (raw hypot): m0=m1=sqrt(1.07)=1.0344; m2=sqrt(0.51)=0.7141;
// m3=sqrt(0.48)=0.6928. So origin knee = m3 — DIFFERENT member than the min-max knee.
check('(A) origin knee is m3', P.kneeOrigin.index === 3, 'idx=' + P.kneeOrigin.index);
check('(A) min-max and origin knees differ here', P.kneeAgrees === false, 'agrees=' + P.kneeAgrees);

// parallel-coords normalization sanity: m0 ada norm = (0.1-0.1)/0.8 = 0
check('(A) PC norm: m0.ada = 0', P.parallelCoords.series[0].values[0].norm === 0, String(P.parallelCoords.series[0].values[0].norm));
check('(A) PC axes carry min/max', P.parallelCoords.axes[2].min === 0.10 && P.parallelCoords.axes[2].max === 0.50, JSON.stringify(P.parallelCoords.axes[2]));

/* ── (B) real frozen MRDC front: kneeOrigin == sim_ui knee, bit-for-bit ──────── */
console.log('Generating the real frozen MRDC 3-objective front (4000 iters)…');
const project = JSON.parse(readFileSync(join(ROOT, 'testcase/mrdc2323.v2.json'), 'utf8'));
const g = runGeneralizedMosa(project, ['ada', 'egress', 'noise'], { seed: SEED, iters: 4000 });
const io = g.objIds, iA = io.indexOf('ada'), iE = io.indexOf('egress'), iN = io.indexOf('noise');

// Reconstruct the front as the driver returns it (array vecs) for presentFront,
// AND as {ada,egress,noise} for the sim_ui re-implementation.
const frontArr = g.front.map(m => ({ pos: m.pos, vec: [m.vec[iA], m.vec[iE], m.vec[iN]] }));
const frontObj = g.front.map(m => ({ vec: { ada: m.vec[iA], egress: m.vec[iE], noise: m.vec[iN] } }));

// sim_mosa.js mosaOptimizeUI knee (verbatim metric): min Math.hypot(ada,egress,noise), first-wins.
let uiKnee = frontObj[0], uiKneeIdx = 0, uiDist = Infinity;
for (let i = 0; i < frontObj.length; i++) {
  const d = Math.hypot(frontObj[i].vec.ada, frontObj[i].vec.egress, frontObj[i].vec.noise);
  if (d < uiDist) { uiDist = d; uiKnee = frontObj[i]; uiKneeIdx = i; }
}

const pres = presentFront(frontArr, ['ada', 'egress', 'noise']);
const ko = pres.kneeOrigin;
const posterMatch = ko.index === uiKneeIdx &&
  ko.vec[0] === uiKnee.vec.ada && ko.vec[1] === uiKnee.vec.egress && ko.vec[2] === uiKnee.vec.noise;
check('(B) kneeOrigin == sim_ui knee (poster unchanged, bit-for-bit)', posterMatch,
  `presentFront idx=${ko.index} vec=[${ko.vec}]  |  sim_ui idx=${uiKneeIdx} vec=[${uiKnee.vec.ada},${uiKnee.vec.egress},${uiKnee.vec.noise}]`);

console.log(`\n  front size: ${g.front.length}`);
console.log(`  sim_ui knee (raw hypot-to-origin): idx=${uiKneeIdx} vec=[${uiKnee.vec.ada}, ${uiKnee.vec.egress}, ${uiKnee.vec.noise}]`);
console.log(`  min-max knee (generalized)       : idx=${pres.knee.index} vec=[${pres.knee.vec}]`);
console.log(`  min-max knee agrees with origin? : ${pres.kneeAgrees ? 'YES (same member)' : 'no (different member — see note)'}`);
if (!pres.kneeAgrees) {
  console.log('    NOTE: min-max and raw-origin knees pick different members on this front. The poster uses');
  console.log('    kneeOrigin (unchanged). knee (min-max) is offered as the generalized n-D presentation knee.');
}

/* ── report ──────────────────────────────────────────────────────────────── */
console.log('\n' + '='.repeat(72));
for (const rr of results) console.log(`  [${rr.pass ? 'PASS' : 'FAIL'}] ${rr.name}${rr.pass ? '' : '  -> ' + rr.detail}`);
const pass = results.every(rr => rr.pass);
console.log('='.repeat(72));
console.log('RESULT: ' + (pass ? 'ALL FRONTIER CHECKS PASS' : 'FAILURES PRESENT'));
console.log('='.repeat(72));
process.exit(pass ? 0 : 1);
