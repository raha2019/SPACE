/**
 * v2/mrdc-zone-blocker-consistency.mjs  --  Phase G1 Task 5 consistency check.
 *
 * The MRDC L-zone computed by v2/zone-detection.mjs must be geometrically
 * consistent with the Phase 2d notch blocker: they must exclude the SAME notch
 * region. Within the stage bounding box the notch is the ONLY area outside the
 * L-room, so for every stage point:  (inside the notch blocker)  ===  (NOT inside the zone).
 * Any mismatch is reported, not papered over.
 *
 * Usage:  node v2/mrdc-zone-blocker-consistency.mjs
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { detectZones, polygonToWalls, pointInRing } from './zone-detection.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const project = JSON.parse(readFileSync(join(ROOT, 'testcase/mrdc2323.v2.json'), 'utf8'));

const zone = detectZones(polygonToWalls(project.room.polygonPct, { idPrefix: 'm' }), project.room.scale).zones[0];
const blk = project.room.structuralBlockers[0];
const inBlocker = (x, y) => x >= blk.x && x <= blk.x + blk.w && y >= blk.y && y <= blk.y + blk.h;

const STEP = 1;              // stage-% grid step
const EDGE = 0.15;           // skip points within EDGE% of the notch edges (ambiguous boundary)
const nearEdge = (x, y) =>
  Math.abs(x - blk.x) < EDGE || Math.abs(y - blk.y) < EDGE;

let checked = 0, mismatch = 0;
const mismatches = [];
for (let x = 0.5; x < 100; x += STEP) {
  for (let y = 0.5; y < 100; y += STEP) {
    if (nearEdge(x, y)) continue;                       // exclude boundary-ambiguous cells
    const inZone = pointInRing({ x, y }, zone.polygonPct);
    const inBlk = inBlocker(x, y);
    checked++;
    if (inBlk === inZone) {                              // should be OPPOSITE everywhere
      mismatch++;
      if (mismatches.length < 12) mismatches.push({ x: +x.toFixed(2), y: +y.toFixed(2), inZone, inBlk });
    }
  }
}

console.log('='.repeat(64));
console.log('MRDC L-ZONE vs PHASE-2D NOTCH BLOCKER — consistency check');
console.log('='.repeat(64));
console.log('  detected zone area : ' + zone.areaUnits.toFixed(2) + ' sf');
console.log('  blocker rect (%)   : x[' + blk.x.toFixed(5) + ', ' + (blk.x + blk.w).toFixed(0) +
            '], y[' + blk.y.toFixed(5) + ', ' + (blk.y + blk.h).toFixed(0) + ']');
console.log('  grid points checked: ' + checked + ' (step ' + STEP + '%, edge band ' + EDGE + '% excluded)');
console.log('  mismatches         : ' + mismatch + '  (want 0: inBlocker must equal NOT-in-zone)');
if (mismatch) console.log('  first mismatches   : ' + JSON.stringify(mismatches));

console.log('  spot checks:');
for (const p of [[60, 80], [80, 90], [47.5, 83], [20, 20], [10, 90], [70, 30]]) {
  const iz = pointInRing({ x: p[0], y: p[1] }, zone.polygonPct);
  const ib = inBlocker(p[0], p[1]);
  console.log('    (' + p[0] + ', ' + p[1] + ')  inZone=' + iz + '  inBlocker=' + ib +
              '  ' + (iz !== ib ? 'consistent' : 'MISMATCH'));
}

const pass = mismatch === 0;
console.log('='.repeat(64));
console.log('CONSISTENCY: ' + (pass ? 'PASS — zone and blocker exclude the same notch region'
  : 'FAIL — discrepancy above'));
console.log('='.repeat(64));
process.exit(pass ? 0 : 1);
