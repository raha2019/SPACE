/**
 * tools/cross_seed_check.mjs  --  Cross-seed stability check for GATE 2.
 *
 * Runs mosaOptimize three times under different PRNG seeds (injected by
 * substituting HARNESS_SEED in the harness string) and records:
 *   • front size
 *   • members dominating baseline
 *   • knee point objectives
 *   • baseline seedVec (should be identical across seeds — evaluated before seeding)
 *   • canary status (0x4D524443 only — pinned baseline canary still fires)
 *
 * After all runs, confirms the 0x4D524443 canary still passes, then prints
 * a 3-seed comparison table and a GATE 2 verdict.
 *
 * Reads tools/mosa_validate.mjs verbatim and patches HARNESS_SEED only in
 * the HARNESS_BODY string (the `const HARNESS_SEED = 0x...` line), leaving
 * every other line of the harness untouched.
 *
 * Usage:  node tools/cross_seed_check.mjs [--iters N]
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { join, dirname }    from 'path';
import { fileURLToPath }    from 'url';
import { execFileSync }     from 'child_process';
import os                   from 'os';
import crypto               from 'crypto';

const __dirname   = dirname(fileURLToPath(import.meta.url));
const ROOT        = join(__dirname, '..');
const RESULTS_DIR = join(ROOT, 'results');
if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });

/* ─── CLI args ───────────────────────────────────────────────────────────── */
const _argv     = process.argv.slice(2);
const _itersIdx = _argv.indexOf('--iters');
const ITERS_ARG = _itersIdx !== -1 ? ['--iters', _argv[_itersIdx + 1]] : [];

/* ─── Seeds to test ─────────────────────────────────────────────────────── */
const SEEDS = [
  { label: '0x4D524443 (MRDC — canonical)', hex: '0x4D524443', int: 0x4D524443, isPinned: true  },
  { label: '0x0001',                         hex: '0x0001',     int: 0x0001,     isPinned: false },
  { label: '0xBEEF',                         hex: '0xBEEF',     int: 0xBEEF,     isPinned: false },
];

/* ─── Read harness source ────────────────────────────────────────────────  */
const harnessPath = join(__dirname, 'mosa_validate.mjs');
const harnessSource = readFileSync(harnessPath, 'utf8');

/* ─── Run harness with a patched seed ─────────────────────────────────── */
function runWithSeed(seedHex) {
  // Substitute only the HARNESS_SEED constant line inside the HARNESS_BODY string.
  // The line looks like:    const HARNESS_SEED = 0x4D524443;
  // (with optional surrounding whitespace / comment)
  const patched = harnessSource.replace(
    /const HARNESS_SEED\s*=\s*0x[0-9A-Fa-f]+;/,
    `const HARNESS_SEED = ${seedHex};`
  );

  // Write to a uniquely-named temp file inside tools/ so __dirname resolves
  // to the same directory as mosa_validate.mjs, keeping ROOT correct.
  const tmp = join(__dirname, `_seed_tmp_${crypto.randomBytes(4).toString('hex')}.mjs`);
  writeFileSync(tmp, patched, 'utf8');

  let stdout = '', stderr = '', exitCode = 0;
  try {
    stdout = execFileSync(process.execPath, [tmp, ...ITERS_ARG], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 600_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    stdout   = err.stdout   || '';
    stderr   = err.stderr   || '';
    exitCode = err.status   ?? 1;
  }

  // Clean up temp file.
  try { unlinkSync(tmp); } catch (_) {}

  return { stdout, stderr, exitCode };
}

/* ─── Parse harness stdout ───────────────────────────────────────────────  */
function parseOutput(text) {
  const get = (re) => { const m = text.match(re); return m ? m[1].trim() : null; };

  const archiveSize    = get(/Archive size\s*:\s*(\d+)/);
  const dominating     = get(/Points that dominate baseline\s*:\s*(\d+)\s*\/\s*(\d+)/);
  const dominatingFull = (() => { const m = text.match(/Points that dominate baseline\s*:\s*(\d+)\s*\/\s*(\d+)/); return m ? { dom: +m[1], total: +m[2] } : null; })();

  const baselineAda    = get(/ADA violation fraction\s*:\s*([\d.]+)%/);
  const baselineEgress = get(/Egress objective\s*:\s*([\d.]+)%/);
  const baselineNoise  = get(/Noise objective\s*:\s*([\d.]+)%/);

  // Knee point: the two-column lines "LABEL : XX.XX% -> YY.YY%"
  const kneeAda    = (() => { const m = text.match(/ADA\s+:\s*([\d.]+)%\s*->\s*([\d.]+)%/);    return m ? { from: +m[1], to: +m[2] } : null; })();
  const kneeEgress = (() => { const m = text.match(/Egress\s+:\s*([\d.]+)%\s*->\s*([\d.]+)%/); return m ? { from: +m[1], to: +m[2] } : null; })();
  const kneeNoise  = (() => { const m = text.match(/Noise\s+:\s*([\d.]+)%\s*->\s*([\d.]+)%/);  return m ? { from: +m[1], to: +m[2] } : null; })();

  const bestAda    = get(/ADA\s+:\s*([\d.]+)% reduction/);
  const bestEgress = get(/Egress\s+:\s*([\d.]+)% reduction/);
  const bestNoise  = get(/Noise\s+:\s*([\d.]+)% reduction/);

  const iters      = get(/Iterations\s+:\s*(\d+)/);
  const accepted   = get(/Accepted\s+:\s*(\d+)/);
  const infeasible = get(/Infeasible\s+:\s*(\d+)/);

  const canaryPass  = /Canary: PASS/.test(text);
  const canaryFail  = /REGRESSION \[canary\]/.test(text);
  const archiveFail = /FAIL: archive/.test(text);

  return {
    archiveSize:    archiveSize    ? +archiveSize   : null,
    dominating:     dominatingFull,
    baselineAda:    baselineAda    ? +baselineAda   : null,
    baselineEgress: baselineEgress ? +baselineEgress : null,
    baselineNoise:  baselineNoise  ? +baselineNoise  : null,
    kneeAda, kneeEgress, kneeNoise,
    bestAda:    bestAda    ? +bestAda    : null,
    bestEgress: bestEgress ? +bestEgress : null,
    bestNoise:  bestNoise  ? +bestNoise  : null,
    iters:       iters       ? +iters      : null,
    accepted:    accepted    ? +accepted   : null,
    infeasible:  infeasible  ? +infeasible : null,
    canaryPass,
    canaryFail,
    archiveFail,
  };
}

/* ─── Run all seeds ──────────────────────────────────────────────────────  */
console.log('GATE 2 — Cross-seed stability check');
console.log('Seeds: 0x4D524443 (canonical), 0x0001, 0xBEEF');
console.log('');

const seedResults = [];
for (const s of SEEDS) {
  process.stdout.write(`  Running seed ${s.hex} … `);
  const { stdout, stderr, exitCode } = runWithSeed(s.hex);
  const parsed = parseOutput(stdout);
  seedResults.push({ ...s, parsed, exitCode, stdout, stderr });
  const dom = parsed.dominating ? `${parsed.dominating.dom}/${parsed.dominating.total}` : '?/?';
  console.log(`front=${parsed.archiveSize ?? '?'}  dominating=${dom}  noise↓=${parsed.bestNoise ?? '?'}%  exitCode=${exitCode}`);
}
console.log('');

/* ─── Bit-for-bit check (canonical seed, two runs) ───────────────────────
   We already have one run of the canonical seed in seedResults[0].stdout.
   Do a second run and compare the full stdout strings.                      */
process.stdout.write('  Bit-for-bit check: running 0x4D524443 a second time … ');
const { stdout: run2 } = runWithSeed('0x4D524443');
const bitForBitIdentical = (seedResults[0].stdout === run2);
console.log(bitForBitIdentical ? 'IDENTICAL' : 'DIFFERS');
if (!bitForBitIdentical) {
  // Show first diff line.
  const linesA = seedResults[0].stdout.split('\n');
  const linesB = run2.split('\n');
  for (let i = 0; i < Math.max(linesA.length, linesB.length); i++) {
    if (linesA[i] !== linesB[i]) {
      console.log(`  First diff at line ${i + 1}:`);
      console.log(`    A: ${linesA[i]}`);
      console.log(`    B: ${linesB[i]}`);
      break;
    }
  }
}
console.log('');

/* ─── Canary check: canonical seed must still pass ───────────────────────  */
const canonicalResult = seedResults.find(s => s.isPinned);
const canaryStillPasses = canonicalResult && canonicalResult.parsed.canaryPass;
console.log(`  Canary (0x4D524443): ${canaryStillPasses ? 'PASS' : 'FAIL'}`);
console.log('');

/* ─── 3-seed table ───────────────────────────────────────────────────────  */
console.log('3-SEED COMPARISON TABLE');
console.log('─'.repeat(100));
const header = [
  'Seed'.padEnd(28),
  'Front'.padStart(5),
  'Dom/Total'.padStart(9),
  'Dom%'.padStart(5),
  'Baseline ada%'.padStart(13),
  'Baseline eg%'.padStart(12),
  'Baseline noise%'.padStart(15),
  'Knee ada%'.padStart(9),
  'Knee eg%'.padStart(8),
  'Knee noise%'.padStart(11),
  'BestNoise↓%'.padStart(11),
];
console.log(header.join('  '));
console.log('─'.repeat(100));

for (const s of seedResults) {
  const p = s.parsed;
  const frontStr   = (p.archiveSize ?? '?').toString().padStart(5);
  const domStr     = p.dominating ? `${p.dominating.dom}/${p.dominating.total}`.padStart(9) : '    ?/?';
  const domPct     = p.dominating && p.dominating.total > 0
    ? ((p.dominating.dom / p.dominating.total) * 100).toFixed(0) + '%'
    : '?%';
  const bAda   = p.baselineAda    != null ? p.baselineAda.toFixed(2)    + '%' : '?';
  const bEg    = p.baselineEgress != null ? p.baselineEgress.toFixed(2) + '%' : '?';
  const bNoise = p.baselineNoise  != null ? p.baselineNoise.toFixed(2)  + '%' : '?';
  const kA     = p.kneeAda    ? p.kneeAda.to.toFixed(2)    + '%' : '?';
  const kE     = p.kneeEgress ? p.kneeEgress.to.toFixed(2) + '%' : '?';
  const kN     = p.kneeNoise  ? p.kneeNoise.to.toFixed(2)  + '%' : '?';
  const bn     = p.bestNoise  != null ? p.bestNoise.toFixed(1) + '%' : '?';

  const row = [
    s.hex.padEnd(28),
    frontStr,
    domStr,
    domPct.padStart(5),
    bAda.padStart(13),
    bEg.padStart(12),
    bNoise.padStart(15),
    kA.padStart(9),
    kE.padStart(8),
    kN.padStart(11),
    bn.padStart(11),
  ];
  console.log(row.join('  '));
}
console.log('─'.repeat(100));
console.log('');

/* ─── Qualitative story checks ───────────────────────────────────────────  */
console.log('QUALITATIVE STORY CHECKS (expected: sane front size, majority dom, large noise↓, near-flat egress):');
const storyChecks = [];
for (const s of seedResults) {
  const p = s.parsed;
  const frontOk   = p.archiveSize != null && p.archiveSize >= 3 && p.archiveSize <= 30;
  const domOk     = p.dominating && p.dominating.total > 0 && (p.dominating.dom / p.dominating.total) >= 0.5;
  const noiseOk   = p.bestNoise  != null && p.bestNoise >= 5;
  const egressFlat = p.bestEgress != null ? p.bestEgress < 5.0 : true;
  const allOk = frontOk && domOk && noiseOk;
  storyChecks.push({ seed: s.hex, frontOk, domOk, noiseOk, egressFlat, allOk });
  const icon = allOk ? '✓' : '✗';
  console.log(`  ${icon}  ${s.hex}: front=${frontOk?'ok':'!!'} dom=${domOk?'ok':'!!'} noise↓=${noiseOk?'ok':'!!'} egressFlat=${egressFlat?'ok':'note'}`);
}
const allStoryPass = storyChecks.every(c => c.allOk);
console.log('');

/* ─── Gate verdict ────────────────────────────────────────────────────────  */
const gate2Pass = bitForBitIdentical && canaryStillPasses && allStoryPass;
console.log('='.repeat(62));
console.log('GATE 2 RESULT: ' + (gate2Pass ? '✓ PASS' : '✗ FAIL'));
console.log('='.repeat(62));
console.log(`  Bit-for-bit determinism (0x4D524443 × 2): ${bitForBitIdentical ? 'PASS' : 'FAIL'}`);
console.log(`  Canary (pinned baseline):                  ${canaryStillPasses  ? 'PASS' : 'FAIL'}`);
console.log(`  Qualitative story (all 3 seeds):           ${allStoryPass       ? 'PASS' : 'FAIL'}`);
console.log('='.repeat(62));

/* ─── Persist results ─────────────────────────────────────────────────────  */
const output = {
  gate: 'GATE 2',
  pass: gate2Pass,
  bitForBitIdentical,
  canaryStillPasses,
  allStoryPass,
  seeds: seedResults.map(s => ({
    seed:   s.hex,
    label:  s.label,
    exitCode: s.exitCode,
    parsed: s.parsed,
  })),
  storyChecks,
};
writeFileSync(join(RESULTS_DIR, 'gate2.json'), JSON.stringify(output, null, 2), 'utf8');

process.exit(gate2Pass ? 0 : 1);
