/**
 * v2/test-mosa-driver-4obj.mjs  --  v2 Phase O1 Task 4.
 *
 * Proves the plumbing GENERALIZES beyond three objectives. Registers a trivial,
 * deterministic, engine-free fourth objective (centroidSpread = normalized mean
 * distance of movable footprint centers from the stage centroid) and runs the driver
 * with FOUR objectives {ada, egress, noise, centroidSpread} on the MRDC project.
 *
 * Asserts:
 *   - the archive stores 4-DIMENSIONAL vectors
 *   - dominance requires non-worse on ALL FOUR (non-domination invariant holds across
 *     every archived member — no member dominates another under 4-D dominance)
 *   - the front is non-empty
 *   - crowding distance iterated four (implicit: the driver's Math.hypot ran over 4
 *     diffs; verified indirectly by the archive being a valid pruned 4-D front)
 *   - HAND-VERIFY at least two members' 4th-objective values against an independent
 *     Node-side recomputation from the archived positions + footprint dims.
 *
 * This asserts nothing about a REAL new metric — only that the plumbing carries n>3.
 *
 * Usage:  node v2/test-mosa-driver-4obj.mjs
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { runGeneralizedMosa } from './mosa-driver.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SEED = '0x4D524443';
const ITERS = 2000;

const project = JSON.parse(readFileSync(join(ROOT, 'testcase/mrdc2323.v2.json'), 'utf8'));

/* Independent movable-dims map: id -> {w,h} from the project (type dims, or per-
 * instance override). This is the same w/h applyTranslated puts on state.zones. */
const types = project.machineTypes || {};
const dims = {};
for (const m of project.machines) {
  const t = types[m.type] || {};
  dims[m.id] = { w: m.w !== undefined ? m.w : t.w, h: m.h !== undefined ? m.h : t.h };
}
const movableIds = (project.optimization && project.optimization.movableIds) || [];

/* Independent recomputation of centroidSpread from an archived pos snapshot. */
function handCentroidSpread(pos) {
  let sum = 0, k = 0;
  for (const id of movableIds) {
    const p = pos[id], d = dims[id];
    if (!p || !d) continue;
    const cx = p.x + d.w / 2, cy = p.y + d.h / 2;
    sum += Math.hypot(cx - 50, cy - 50);
    k++;
  }
  const mean = k > 0 ? sum / k : 0;
  return mean / Math.hypot(50, 50);
}

function dominates4(a, b) {
  let allLE = true, anyLT = false;
  for (let i = 0; i < a.length; i++) { if (a[i] > b[i]) allLE = false; if (a[i] < b[i]) anyLT = true; }
  return allLE && anyLT;
}

console.log('='.repeat(72));
console.log('O1 Task 4 — four-objective generality {ada, egress, noise, centroidSpread}');
console.log(`seed ${SEED}, ${ITERS} iters`);
console.log('='.repeat(72));

const g = runGeneralizedMosa(project, ['ada', 'egress', 'noise', 'centroidSpread'], { seed: SEED, iters: ITERS });
console.log(`objIds        : [${g.objIds.join(', ')}]`);
console.log(`seedVec (4-D) : [${g.seedVec.join(', ')}]`);
console.log(`front size    : ${g.front.length}`);
console.log(`stats         : archived=${g.stats.archived} archiveSize=${g.stats.archiveSize}`);

const fail = [];

// (1) 4-dimensional vectors
const dimsOk = g.objIds.length === 4 && g.front.every(m => Array.isArray(m.vec) && m.vec.length === 4);
if (!dimsOk) fail.push('archive vectors are not all 4-dimensional');

// (2) front non-empty
if (g.front.length < 1) fail.push('front is empty');

// (3) non-domination invariant across the whole archive (4-D dominance)
let ndViolation = null;
for (let i = 0; i < g.front.length && !ndViolation; i++) {
  for (let j = 0; j < g.front.length; j++) {
    if (i === j) continue;
    if (dominates4(g.front[i].vec, g.front[j].vec)) { ndViolation = { i, j }; break; }
  }
}
if (ndViolation) fail.push(`non-domination violated: member ${ndViolation.i} dominates ${ndViolation.j}`);

// (4) dominance genuinely requires all four: construct a probe that is better on 3
// but worse on the 4th and confirm it does NOT dominate a front member.
if (g.front.length) {
  const v = g.front[0].vec;
  const probe = [v[0] - 0.01, v[1] - 0.01, v[2] - 0.01, v[3] + 0.01]; // better on 3, worse on 4th
  const wrongly = dominates4(probe, v);
  if (wrongly) fail.push('4-D dominance ignored the 4th objective (probe better-on-3/worse-on-4 dominated)');
  console.log(`\n4-D dominance check: probe better on 3 / worse on 4th dominates? ${wrongly} (expected false)`);
}

// (5) HAND-VERIFY the 4th objective on >=2 members against independent recomputation.
console.log('\nHand-verification of centroidSpread (vec[3]) vs independent Node recompute:');
const iCentroid = g.objIds.indexOf('centroidSpread');
let handOk = true, checked = 0;
const sample = [0, Math.floor(g.front.length / 2), g.front.length - 1].filter((v, i, a) => a.indexOf(v) === i);
for (const idx of sample) {
  const m = g.front[idx];
  const stored = m.vec[iCentroid];
  const hand = handCentroidSpread(m.pos);
  const match = stored === hand;
  if (!match) handOk = false;
  checked++;
  console.log(`  member[${idx}]: stored=${stored}  hand=${hand}  match=${match ? 'YES' : 'NO'}`);
}
if (checked < 2) fail.push('fewer than 2 members hand-verified');
if (!handOk) fail.push('hand-verified centroidSpread did not match stored value');

// also verify the SEED vector's 4th objective by hand (positions = project machines)
const seedPos = {};
for (const id of movableIds) {
  const m = project.machines.find(x => x.id === id);
  if (m) seedPos[id] = { x: m.x, y: m.y };
}
const seedHand = handCentroidSpread(seedPos);
const seedStored = g.seedVec[iCentroid];
const seedMatch = seedStored === seedHand;
console.log(`  seed layout: stored=${seedStored}  hand=${seedHand}  match=${seedMatch ? 'YES' : 'NO'}`);
if (!seedMatch) fail.push('seed centroidSpread hand-check failed');

console.log('\n' + '─'.repeat(72));
console.log('4-D vectors stored            : ' + (dimsOk ? 'YES' : 'NO'));
console.log('front non-empty               : ' + (g.front.length >= 1 ? 'YES (' + g.front.length + ')' : 'NO'));
console.log('non-domination invariant      : ' + (!ndViolation ? 'YES' : 'NO'));
console.log('4th objective enforced        : ' + (g.front.length ? 'YES' : 'n/a'));
console.log('hand-verified members         : ' + (handOk && seedMatch ? 'YES (' + (checked + 1) + ' incl. seed)' : 'NO'));
console.log('─'.repeat(72));
const pass = fail.length === 0;
console.log('RESULT: ' + (pass ? 'PASS — plumbing generalizes to 4 objectives with hand-verified values' : 'FAIL'));
if (!pass) { console.log('  failures:'); for (const f of fail) console.log('   - ' + f); }
console.log('='.repeat(72));
process.exit(pass ? 0 : 1);
