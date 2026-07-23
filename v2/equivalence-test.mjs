/**
 * v2/equivalence-test.mjs  --  V0 ACCEPTANCE TEST.
 *
 * Drives the full MRDC 2323 validation through the v2 seam (schema -> adapter ->
 * UNMODIFIED engine) and asserts it reproduces the frozen v1 pin bit-for-bit:
 *   - baseline (seed) vector exactly equals tools/baseline-mrdc2323.json baselineVec
 *   - front size and domination count match the pin
 *   - three runs are bit-for-bit identical (determinism)
 *
 * Usage:
 *   node v2/equivalence-test.mjs                 (seed + iters from the project: 0x4D524443, 4000)
 *   node v2/equivalence-test.mjs --iters 50      (fast seedVec-only sanity; front size will differ)
 *   node v2/equivalence-test.mjs --runs 3
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { runProject } from './engine-adapter.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const readJSON = rel => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));

const argv = process.argv.slice(2);
const iterArg = argv.indexOf('--iters');
const runsArg = argv.indexOf('--runs');
const itersOverride = iterArg >= 0 ? parseInt(argv[iterArg + 1], 10) : undefined;
const RUNS = runsArg >= 0 ? parseInt(argv[runsArg + 1], 10) : 3;

const project = readJSON('testcase/mrdc2323.v2.json');
const pin = readJSON('tools/baseline-mrdc2323.json');

const iters = itersOverride != null ? itersOverride : project.optimization.iters;
const seed = project.optimization.seed;
const fullRun = iters === pin.iters;   // only a full 4000-iter run can match front_length

console.log('='.repeat(64));
console.log('V0 EQUIVALENCE TEST — v2 seam vs frozen pin');
console.log('='.repeat(64));
console.log(`Project : testcase/mrdc2323.v2.json`);
console.log(`Pin     : tools/baseline-mrdc2323.json  (front ${pin.front_length}, ${pin.front_dominating})`);
console.log(`Seed    : ${seed}   Iters: ${iters}   Runs: ${RUNS}`);
console.log('');

/* Canonical stringify of a run's observable result (order-stable). */
function fingerprint(r) {
  return JSON.stringify({
    seedVec: r.seedVec,
    frontLength: r.frontLength,
    dominatingCount: r.dominatingCount,
    front: r.front.map(p => p.vec),
  });
}

const results = [];
for (let i = 0; i < RUNS; i++) {
  const t0 = process.hrtime.bigint();
  const r = runProject(project, { iters, seed });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  results.push(r);
  console.log(`Run ${i + 1}/${RUNS}: seedVec=${r.seedVec.ada}/${r.seedVec.egress}/${r.seedVec.noise} `
    + `front=${r.frontLength} dom=${r.dominatingCount}/${r.frontLength}  (${ms.toFixed(0)} ms)`);
}
console.log('');

/* ── Determinism: all runs bit-for-bit identical ─────────────────────────── */
const fps = results.map(fingerprint);
const deterministic = fps.every(f => f === fps[0]);
console.log(`[determinism] ${RUNS} runs bit-for-bit identical: ${deterministic ? 'PASS' : 'FAIL'}`);
if (!deterministic) {
  for (let i = 1; i < fps.length; i++) {
    if (fps[i] !== fps[0]) console.log(`  run ${i + 1} differs from run 1`);
  }
}

/* ── Pin match ───────────────────────────────────────────────────────────── */
const r0 = results[0];
const bv = pin.baselineVec;
const adaEq = r0.seedVec.ada === bv.ada;
const egEq  = r0.seedVec.egress === bv.egress;
const nsEq  = r0.seedVec.noise === bv.noise;
const vecEq = adaEq && egEq && nsEq;

console.log('');
console.log('[pin match] baseline (seed) vector — exact IEEE-754 equality:');
console.log(`  ada    : adapter=${r0.seedVec.ada}  pin=${bv.ada}  ${adaEq ? 'MATCH' : 'DIFFER'}`);
console.log(`  egress : adapter=${r0.seedVec.egress}  pin=${bv.egress}  ${egEq ? 'MATCH' : 'DIFFER'}`);
console.log(`  noise  : adapter=${r0.seedVec.noise}  pin=${bv.noise}  ${nsEq ? 'MATCH' : 'DIFFER'}`);

let frontEq = true, domEq = true;
if (fullRun) {
  frontEq = r0.frontLength === pin.front_length;
  const pinDom = parseInt(String(pin.front_dominating).split('/')[0], 10);
  domEq = r0.dominatingCount === pinDom;
  console.log('');
  console.log('[pin match] front:');
  console.log(`  front size      : adapter=${r0.frontLength}  pin=${pin.front_length}  ${frontEq ? 'MATCH' : 'DIFFER'}`);
  console.log(`  dominating count: adapter=${r0.dominatingCount}  pin=${pinDom}  ${domEq ? 'MATCH' : 'DIFFER'}`);
} else {
  console.log('');
  console.log(`[pin match] front size/domination skipped — needs a full ${pin.iters}-iter run `
    + `(ran ${iters}). seedVec is iteration-independent and is checked above.`);
}

const pass = deterministic && vecEq && frontEq && domEq;
console.log('');
console.log('='.repeat(64));
console.log('V0 EQUIVALENCE: ' + (pass ? 'PASS — seam reproduces the frozen pin bit-for-bit'
  : 'FAIL — see diffs above'));
console.log('='.repeat(64));
process.exit(pass ? 0 : 1);
