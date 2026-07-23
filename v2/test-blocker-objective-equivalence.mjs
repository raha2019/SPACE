/**
 * v2/test-blocker-objective-equivalence.mjs  --  Phase G2 Task 3.
 *
 * Proves the generalized translator reproduces the hand-built Phase 2d result
 * THROUGH THE ACTUAL ENGINE (unmodified, in the V0 vm adapter), not just in a
 * geometry check. Runs evaluateLayout on the MRDC baseline two ways at the pinned
 * seed and asserts the {ada,egress,noise} vectors are bit-for-bit identical:
 *   (a) with the frozen notch_mrdc2323 blocker (the project as-shipped);
 *   (b) with the translator-generated blocker(s) replacing it.
 *
 * Usage:  node v2/test-blocker-objective-equivalence.mjs
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { evaluateBaseline } from './engine-adapter.mjs';
import { detectZones, polygonToWalls } from './zone-detection.mjs';
import { zoneToBlockers } from './zone-to-blocker.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SEED = '0x4D524443';

const frozenProject = JSON.parse(readFileSync(join(ROOT, 'testcase/mrdc2323.v2.json'), 'utf8'));

// (a) as-shipped: frozen notch_mrdc2323 blocker.
const resA = evaluateBaseline(frozenProject, { seed: SEED });

// (b) same project, but structuralBlockers replaced by translator output.
// Derive the L-zone from the frozen polygon (no doors -> no extra exit elements),
// generate the complement blockers, and swap them in.
const zone = detectZones(polygonToWalls(frozenProject.room.polygonPct, { idPrefix: 'm' }), frozenProject.room.scale).zones[0];
const gen = zoneToBlockers({ polygonPct: zone.polygonPct }, { stage: { x0: 0, y0: 0, x1: 100, y1: 100 } });

const projectB = JSON.parse(JSON.stringify(frozenProject));
projectB.room.structuralBlockers = gen.blockers;      // replace frozen notch with generated blockers
const resB = evaluateBaseline(projectB, { seed: SEED });

const a = resA.vec, b = resB.vec;
const eq = a.ada === b.ada && a.egress === b.egress && a.noise === b.noise;

console.log('='.repeat(66));
console.log('G2 Task 3 — objective equivalence through the UNMODIFIED engine');
console.log('='.repeat(66));
console.log('  translator blockers: ' + gen.blockers.length + ' (exact=' + gen.exact + ')');
console.log('  (a) frozen notch blocker : ada=' + a.ada + ' egress=' + a.egress + ' noise=' + a.noise);
console.log('  (b) translator blockers  : ada=' + b.ada + ' egress=' + b.egress + ' noise=' + b.noise);
console.log('  bit-for-bit identical    : ' + (eq ? 'YES' : 'NO'));
if (!eq) {
  console.log('  delta ada    : ' + (b.ada - a.ada));
  console.log('  delta egress : ' + (b.egress - a.egress));
  console.log('  delta noise  : ' + (b.noise - a.noise));
}
console.log('='.repeat(66));
console.log('RESULT: ' + (eq ? 'PASS — generalized translator == frozen Phase 2d result through the engine'
  : 'FAIL — vectors differ'));
console.log('='.repeat(66));
process.exit(eq ? 0 : 1);
