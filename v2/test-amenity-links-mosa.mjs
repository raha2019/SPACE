/**
 * v2/test-amenity-links-mosa.mjs  --  v2 Phase L1 Task 4.
 *
 * Proves amenityLinks works as a first-class O1 MOSA objective. Runs MOSA on the
 * diagnostic fixture with SIX objectives {ada, egress, noise, activeUsers, adjacency,
 * amenityLinks} and asserts: 6-D vectors, non-domination, non-empty front, and >=1
 * member improving amenityLinks vs seed. Reports trade-offs — especially the two safety
 * objectives (adjacency pushes hazards APART, amenityLinks pulls machines TOWARD shared
 * amenities) and the capacity/ADA interactions from A1/N1.
 *
 * Usage:  node v2/test-amenity-links-mosa.mjs
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { makeActiveUsersObjective } from './active-users.mjs';
import { makeAdjacencyObjective } from './adjacency.mjs';
import { makeAmenityLinksObjective } from './amenity-links.mjs';
import { registerObjective } from './objectives.mjs';
import { runGeneralizedMosa } from './mosa-driver.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SEED = '0x5350414B', ITERS = 800;
const OBJS = ['ada', 'egress', 'noise', 'activeUsers', 'adjacency', 'amenityLinks'];

const diag = JSON.parse(readFileSync(join(ROOT, 'testcase/diagnostic/diagnostic-plan.v2.json'), 'utf8'));
registerObjective(makeActiveUsersObjective(diag, { mode: 'even-split' }));
registerObjective(makeAdjacencyObjective(diag));
registerObjective(makeAmenityLinksObjective(diag));

console.log('='.repeat(80));
console.log('L1 Task 4 — six-objective MOSA {ada, egress, noise, activeUsers, adjacency, amenityLinks}');
console.log(`seed ${SEED}, ${ITERS} iters`);
console.log('='.repeat(80));

const g = runGeneralizedMosa(diag, OBJS, { seed: SEED, iters: ITERS });
const idx = {}; OBJS.forEach(o => idx[o] = g.objIds.indexOf(o));
const iAL = idx.amenityLinks, iAdj = idx.adjacency, iAU = idx.activeUsers;
console.log(`objIds: [${g.objIds.join(', ')}] | front size: ${g.front.length}`);
console.log(`seedVec: [${g.seedVec.map(v => v.toFixed(4)).join(', ')}]`);

const results = [];
const check = (n, p, d = '') => { results.push({ n, p, d }); };
check('archive holds 6-dimensional vectors', g.objIds.length === 6 && g.front.every(m => m.vec.length === 6), `dim ${g.objIds.length}`);
check('front is non-empty', g.front.length >= 1, `${g.front.length}`);
const dom = (a, b) => { let le = true, lt = false; for (let i = 0; i < a.length; i++) { if (a[i] > b[i]) le = false; if (a[i] < b[i]) lt = true; } return le && lt; };
let nd = true, viol = null;
for (let i = 0; i < g.front.length && nd; i++) for (let j = 0; j < g.front.length; j++) if (i !== j && dom(g.front[i].vec, g.front[j].vec)) { nd = false; viol = [i, j]; break; }
check('non-domination invariant holds', nd, viol ? `member ${viol[0]} dominates ${viol[1]}` : 'ok');
const seedAL = g.seedVec[iAL];
const improvers = g.front.filter(m => m.vec[iAL] < seedAL - 1e-12);
check('at least one front member improves amenityLinks vs seed', improvers.length >= 1, `${improvers.length} below seed ${seedAL.toFixed(4)}`);

/* ── trade-off report ────────────────────────────────────────────────────────── */
const bestAL = g.front.reduce((b, m) => m.vec[iAL] < b.vec[iAL] ? m : b, g.front[0]);
console.log('\n  Pareto front (ada / egress / noise / activeUsers / adjacency / amenityLinks), sorted by amenityLinks:');
g.front.slice().sort((a, b) => a.vec[iAL] - b.vec[iAL]).forEach((m, k) => {
  console.log(`   ${String(k).padStart(2)}  [${m.vec.map(v => v.toFixed(4)).join(', ')}]${m === bestAL ? '  <- best amenity reach' : ''}`);
});
console.log('\n  Trade-offs (best-amenityLinks member vs seed):');
for (const o of OBJS) { const d = bestAL.vec[idx[o]] - g.seedVec[idx[o]]; console.log(`   ${o.padEnd(12)}: ${g.seedVec[idx[o]].toFixed(4)} -> ${bestAL.vec[idx[o]].toFixed(4)}  (${d < 0 ? 'better' : d > 0 ? 'WORSE' : 'same'} by ${Math.abs(d).toFixed(4)})`); }
function corr(xs, ys) {
  const n = xs.length, mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0; for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  return (sxx && syy) ? sxy / Math.sqrt(sxx * syy) : 0;
}
const al = g.front.map(m => m.vec[iAL]);
console.log('\n  Across-front correlation of amenityLinks-violation with:');
for (const o of OBJS) { if (o === 'amenityLinks') continue; const c = corr(al, g.front.map(m => m.vec[idx[o]])); const rd = Math.abs(c) < 0.2 ? 'weak / decoupled' : c > 0 ? 'better amenity reach => better ' + o + ' (aligned)' : 'better amenity reach => worse ' + o + ' (TENSION)'; console.log(`   ${o.padEnd(12)}: r = ${c.toFixed(3)}  (${rd})`); }
console.log('\n  Note: adjacency (push hazards apart) vs amenityLinks (pull machines to shared amenities) are the two safety objectives; their sign here is the scientific payload.');

console.log('\n' + '='.repeat(80));
let pass = 0, fail = 0;
for (const r of results) { console.log(`  [${r.p ? 'PASS' : 'FAIL'}] ${r.n}${r.p ? '' : '  -> ' + r.d}`); r.p ? pass++ : fail++; }
console.log('='.repeat(80));
console.log(`RESULT: ${pass} PASS / ${fail} FAIL`);
console.log('='.repeat(80));
process.exit(fail === 0 ? 0 : 1);
