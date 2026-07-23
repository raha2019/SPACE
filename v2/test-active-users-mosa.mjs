/**
 * v2/test-active-users-mosa.mjs  --  v2 Phase A1 Task 4.
 *
 * Proves activeUsers works as a first-class O1 MOSA objective. Runs MOSA on the
 * diagnostic fixture with FOUR objectives {ada, egress, noise, activeUsers} and asserts:
 *   - the archive holds 4-dimensional vectors;
 *   - the non-domination invariant holds across every member;
 *   - the front is non-empty;
 *   - at least one front member IMPROVES active-users (lower shortfall) vs the seed.
 * Then reports the front and the trade-offs observed (does maximizing usable capacity
 * worsen noise / ADA?) — the scientifically interesting output.
 *
 * Usage:  node v2/test-active-users-mosa.mjs
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { makeActiveUsersObjective } from './active-users.mjs';
import { registerObjective } from './objectives.mjs';
import { runGeneralizedMosa } from './mosa-driver.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SEED = '0x5350414B', ITERS = 800;

const diag = JSON.parse(readFileSync(join(ROOT, 'testcase/diagnostic/diagnostic-plan.v2.json'), 'utf8'));
// V1: no caller-side materialisation — the seam auto-forwards structuralGeometry.
registerObjective(makeActiveUsersObjective(diag, { mode: 'even-split' }));

console.log('='.repeat(74));
console.log('A1 Task 4 — four-objective MOSA {ada, egress, noise, activeUsers} on the diagnostic');
console.log(`seed ${SEED}, ${ITERS} iters`);
console.log('='.repeat(74));

const g = runGeneralizedMosa(diag, ['ada', 'egress', 'noise', 'activeUsers'], { seed: SEED, iters: ITERS });
const iAU = g.objIds.indexOf('activeUsers');
console.log(`objIds: [${g.objIds.join(', ')}] | front size: ${g.front.length}`);
console.log(`seedVec: [${g.seedVec.map(v => v.toFixed(4)).join(', ')}]  (activeUsers shortfall = ${g.seedVec[iAU].toFixed(4)})`);

const results = [];
const check = (n, p, d = '') => { results.push({ n, p, d }); };

// (1) 4-D vectors
check('archive holds 4-dimensional vectors', g.objIds.length === 4 && g.front.every(m => m.vec.length === 4), `${g.front.length} members, dim ${g.objIds.length}`);
// (2) non-empty
check('front is non-empty', g.front.length >= 1, `${g.front.length}`);
// (3) non-domination
const dom = (a, b) => { let le = true, lt = false; for (let i = 0; i < a.length; i++) { if (a[i] > b[i]) le = false; if (a[i] < b[i]) lt = true; } return le && lt; };
let nd = true, viol = null;
for (let i = 0; i < g.front.length && nd; i++) for (let j = 0; j < g.front.length; j++) if (i !== j && dom(g.front[i].vec, g.front[j].vec)) { nd = false; viol = [i, j]; break; }
check('non-domination invariant holds', nd, viol ? `member ${viol[0]} dominates ${viol[1]}` : 'no member dominates another');
// (4) at least one member improves activeUsers vs seed
const seedAU = g.seedVec[iAU];
const improvers = g.front.filter(m => m.vec[iAU] < seedAU - 1e-12);
check('at least one front member improves active-users vs seed', improvers.length >= 1, `${improvers.length} members with shortfall < ${seedAU.toFixed(4)}`);

/* ── trade-off report ────────────────────────────────────────────────────────── */
const lbl = ['ada', 'egress', 'noise', 'activeUsers'];
const bestAU = g.front.reduce((b, m) => m.vec[iAU] < b.vec[iAU] ? m : b, g.front[0]);
console.log('\n  Pareto front (ada / egress / noise / activeUsers-shortfall):');
g.front.slice().sort((a, b) => a.vec[iAU] - b.vec[iAU]).forEach((m, k) => {
  console.log(`   ${String(k).padStart(2)}  [${m.vec.map(v => v.toFixed(4)).join(', ')}]${m === bestAU ? '   <- best usable capacity' : ''}`);
});

console.log('\n  Trade-offs (best-usable-capacity member vs seed):');
const iA = g.objIds.indexOf('ada'), iE = g.objIds.indexOf('egress'), iN = g.objIds.indexOf('noise');
const d = (i) => (bestAU.vec[i] - g.seedVec[i]);
console.log(`   activeUsers shortfall: ${g.seedVec[iAU].toFixed(4)} -> ${bestAU.vec[iAU].toFixed(4)}  (${d(iAU) <= 0 ? 'IMPROVED' : 'worse'} by ${Math.abs(d(iAU)).toFixed(4)})`);
for (const [nm, i] of [['ada', iA], ['egress', iE], ['noise', iN]]) {
  console.log(`   ${nm.padEnd(12)}: ${g.seedVec[i].toFixed(4)} -> ${bestAU.vec[i].toFixed(4)}  (${d(i) < 0 ? 'better' : d(i) > 0 ? 'WORSE' : 'same'} by ${Math.abs(d(i)).toFixed(4)})`);
}
// correlation across the front: does lower activeUsers-shortfall track higher noise?
function corr(xs, ys) {
  const n = xs.length, mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0; for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  return (sxx && syy) ? sxy / Math.sqrt(sxx * syy) : 0;
}
const au = g.front.map(m => m.vec[iAU]);
console.log('\n  Across-front correlation of activeUsers-shortfall with:');
for (const [nm, i] of [['ada', iA], ['egress', iE], ['noise', iN]]) {
  const c = corr(au, g.front.map(m => m.vec[i]));
  console.log(`   ${nm.padEnd(12)}: r = ${c.toFixed(3)}  (${Math.abs(c) < 0.2 ? 'weak' : c > 0 ? 'shortfall down => ' + nm + ' down (aligned)' : 'shortfall down => ' + nm + ' up (TENSION)'})`);
}

console.log('\n' + '='.repeat(74));
let pass = 0, fail = 0;
for (const r of results) { console.log(`  [${r.p ? 'PASS' : 'FAIL'}] ${r.n}${r.p ? '' : '  -> ' + r.d}`); r.p ? pass++ : fail++; }
console.log('='.repeat(74));
console.log(`RESULT: ${pass} PASS / ${fail} FAIL`);
console.log('='.repeat(74));
process.exit(fail === 0 ? 0 : 1);
