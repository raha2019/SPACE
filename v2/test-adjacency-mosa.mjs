/**
 * v2/test-adjacency-mosa.mjs  --  v2 Phase N1 Task 4.
 *
 * Proves adjacency works as a first-class O1 MOSA objective. Runs MOSA on the
 * diagnostic fixture with FIVE objectives {ada, egress, noise, activeUsers, adjacency}
 * and asserts: 5-D vectors, non-domination invariant, non-empty front, and >=1 front
 * member improving adjacency vs seed. Reports trade-offs — in particular whether
 * separating hazardous machines (lower adjacency) costs active-users or ADA, alongside
 * A1's r ~ -0.90 capacity-vs-ADA finding.
 *
 * Usage:  node v2/test-adjacency-mosa.mjs
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { makeActiveUsersObjective } from './active-users.mjs';
import { makeAdjacencyObjective } from './adjacency.mjs';
import { registerObjective } from './objectives.mjs';
import { runGeneralizedMosa } from './mosa-driver.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SEED = '0x5350414B', ITERS = 800;
const OBJS = ['ada', 'egress', 'noise', 'activeUsers', 'adjacency'];

const diag = JSON.parse(readFileSync(join(ROOT, 'testcase/diagnostic/diagnostic-plan.v2.json'), 'utf8'));
registerObjective(makeActiveUsersObjective(diag, { mode: 'even-split' }));
registerObjective(makeAdjacencyObjective(diag));

console.log('='.repeat(78));
console.log('N1 Task 4 — five-objective MOSA {ada, egress, noise, activeUsers, adjacency}');
console.log(`seed ${SEED}, ${ITERS} iters (structuralGeometry forwarded natively via V1 seam)`);
console.log('='.repeat(78));

const g = runGeneralizedMosa(diag, OBJS, { seed: SEED, iters: ITERS });
const iAdj = g.objIds.indexOf('adjacency'), iAU = g.objIds.indexOf('activeUsers'), iA = g.objIds.indexOf('ada');
console.log(`objIds: [${g.objIds.join(', ')}] | front size: ${g.front.length}`);
console.log(`seedVec: [${g.seedVec.map(v => v.toFixed(4)).join(', ')}]`);

const results = [];
const check = (n, p, d = '') => { results.push({ n, p, d }); };
check('archive holds 5-dimensional vectors', g.objIds.length === 5 && g.front.every(m => m.vec.length === 5), `dim ${g.objIds.length}`);
check('front is non-empty', g.front.length >= 1, `${g.front.length}`);
const dom = (a, b) => { let le = true, lt = false; for (let i = 0; i < a.length; i++) { if (a[i] > b[i]) le = false; if (a[i] < b[i]) lt = true; } return le && lt; };
let nd = true, viol = null;
for (let i = 0; i < g.front.length && nd; i++) for (let j = 0; j < g.front.length; j++) if (i !== j && dom(g.front[i].vec, g.front[j].vec)) { nd = false; viol = [i, j]; break; }
check('non-domination invariant holds', nd, viol ? `member ${viol[0]} dominates ${viol[1]}` : 'ok');
const seedAdj = g.seedVec[iAdj];
const improvers = g.front.filter(m => m.vec[iAdj] < seedAdj - 1e-12);
check('at least one front member improves adjacency vs seed', improvers.length >= 1, `${improvers.length} members below seed ${seedAdj.toFixed(4)}`);

/* ── trade-off report ────────────────────────────────────────────────────────── */
const bestAdj = g.front.reduce((b, m) => m.vec[iAdj] < b.vec[iAdj] ? m : b, g.front[0]);
console.log('\n  Pareto front (ada / egress / noise / activeUsers / adjacency), sorted by adjacency:');
g.front.slice().sort((a, b) => a.vec[iAdj] - b.vec[iAdj]).forEach((m, k) => {
  console.log(`   ${String(k).padStart(2)}  [${m.vec.map(v => v.toFixed(4)).join(', ')}]${m === bestAdj ? '  <- best (safest) adjacency' : ''}`);
});
console.log('\n  Trade-offs (best-adjacency member vs seed):');
const dlt = i => bestAdj.vec[i] - g.seedVec[i];
for (const [nm, i] of [['adjacency', iAdj], ['activeUsers', iAU], ['ada', iA], ['egress', g.objIds.indexOf('egress')], ['noise', g.objIds.indexOf('noise')]]) {
  const d = dlt(i);
  console.log(`   ${nm.padEnd(12)}: ${g.seedVec[i].toFixed(4)} -> ${bestAdj.vec[i].toFixed(4)}  (${d < 0 ? 'better' : d > 0 ? 'WORSE' : 'same'} by ${Math.abs(d).toFixed(4)})`);
}
function corr(xs, ys) {
  const n = xs.length, mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0; for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  return (sxx && syy) ? sxy / Math.sqrt(sxx * syy) : 0;
}
const adj = g.front.map(m => m.vec[iAdj]);
console.log('\n  Across-front correlation of adjacency-violation with:');
for (const [nm, i] of [['activeUsers', iAU], ['ada', iA], ['egress', g.objIds.indexOf('egress')], ['noise', g.objIds.indexOf('noise')]]) {
  const c = corr(adj, g.front.map(m => m.vec[i]));
  const rd = Math.abs(c) < 0.2 ? 'weak / decoupled' : c > 0 ? 'safer adjacency => lower ' + nm + ' (aligned)' : 'safer adjacency => higher ' + nm + ' (TENSION — separation consumes ' + nm + ')';
  console.log(`   ${nm.padEnd(12)}: r = ${c.toFixed(3)}  (${rd})`);
}

console.log('\n' + '='.repeat(78));
let pass = 0, fail = 0;
for (const r of results) { console.log(`  [${r.p ? 'PASS' : 'FAIL'}] ${r.n}${r.p ? '' : '  -> ' + r.d}`); r.p ? pass++ : fail++; }
console.log('='.repeat(78));
console.log(`RESULT: ${pass} PASS / ${fail} FAIL`);
console.log('='.repeat(78));
process.exit(fail === 0 ? 0 : 1);
