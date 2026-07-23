/**
 * v2/test-zone-to-blocker.mjs  --  v2 Phase G2 exactness proof.
 *
 * For each zone, generate blockers, then verify over a DENSE stage grid (>10,000
 * points) that "inside a blocker" == "inside the stage AND outside the zone",
 * with ZERO mismatches. Any nonzero mismatch is a FAIL.
 *
 * Cases:
 *   (a) simple rectangle smaller than the stage
 *   (b) real MRDC 2323 L-zone from the frozen project  (+ equivalence to the frozen
 *       Phase 2d notch_mrdc2323 blocker over the same grid, 0 mismatches)
 *   (c) the two-room split fixture from G1 (each zone's complement separately)
 *
 * Usage:  node v2/test-zone-to-blocker.mjs
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { detectZones } from './zone-detection.mjs';
import { pointInRing } from './zone-detection.mjs';
import { zoneToBlockers, pointInAnyBlocker } from './zone-to-blocker.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const readJSON = rel => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));

const STEP = 0.7;            // stage-% grid step  -> ~143^2 = 20,449 points (>10,000)
const OFFSET = 0.35;        // half-step offset avoids landing on compression/edge lines

const results = [];
function record(name, mismatch, checked, extra) {
  results.push({ name, pass: mismatch === 0, mismatch, checked, extra: extra || '' });
}

/** Dense-grid exactness: inBlocker(p) must equal (inStage && !inZone). */
function gridExactness(name, zonePolygon, blockers, stage) {
  stage = stage || { x0: 0, y0: 0, x1: 100, y1: 100 };
  let checked = 0, mismatch = 0;
  const worst = [];
  for (let x = stage.x0 + OFFSET; x < stage.x1; x += STEP) {
    for (let y = stage.y0 + OFFSET; y < stage.y1; y += STEP) {
      const inStage = x >= stage.x0 && x <= stage.x1 && y >= stage.y0 && y <= stage.y1;
      const want = inStage && !pointInRing({ x, y }, zonePolygon);   // in complement
      const got = pointInAnyBlocker({ x, y }, blockers);
      checked++;
      if (got !== want) { mismatch++; if (worst.length < 8) worst.push({ x: +x.toFixed(2), y: +y.toFixed(2), got, want }); }
    }
  }
  record(name, mismatch, checked, mismatch ? JSON.stringify(worst) : '');
  return { checked, mismatch };
}

/* ── (a) simple rectangle smaller than the stage ─────────────────────────── */
function caseRectangle() {
  const stage = { x0: 0, y0: 0, x1: 100, y1: 100 };
  const zone = { polygonPct: [{ x: 20, y: 20 }, { x: 80, y: 20 }, { x: 80, y: 80 }, { x: 20, y: 80 }] };
  const r = zoneToBlockers(zone, { stage });
  console.log(`  (a) rectangle: exact=${r.exact}, ${r.blockers.length} blockers`);
  gridExactness('(a) rectangle complement', zone.polygonPct, r.blockers, stage);
}

/* ── (b) MRDC 2323 L-zone from the frozen project ────────────────────────── */
function caseMRDC() {
  const project = readJSON('testcase/mrdc2323.v2.json');
  // derive the L-zone from the frozen polygon (no doors -> no exit elements)
  const zone = { polygonPct: project.room.polygonPct.map(p => ({ x: p.x, y: p.y })) };
  const r = zoneToBlockers(zone, { stage: { x0: 0, y0: 0, x1: 100, y1: 100 } });
  console.log(`  (b) MRDC L: exact=${r.exact}, ${r.blockers.length} blocker(s)`);
  gridExactness('(b) MRDC L-zone complement', zone.polygonPct, r.blockers);

  // Equivalence to the frozen Phase 2d notch_mrdc2323 blocker over the same grid.
  const frozen = project.room.structuralBlockers[0];
  const inFrozen = (x, y) => x >= frozen.x && x <= frozen.x + frozen.w && y >= frozen.y && y <= frozen.y + frozen.h;
  let checked = 0, mismatch = 0;
  for (let x = OFFSET; x < 100; x += STEP) {
    for (let y = OFFSET; y < 100; y += STEP) {
      checked++;
      if (pointInAnyBlocker({ x, y }, r.blockers) !== inFrozen(x, y)) mismatch++;
    }
  }
  record('(b) MRDC translator == frozen notch blocker', mismatch, checked);
  // also confirm exact coordinate identity of the single rect
  const b = r.blockers[0];
  const coordIdentical = b && b.x === frozen.x && b.y === frozen.y && b.w === frozen.w && b.h === frozen.h;
  record('(b) MRDC blocker rect == frozen rect (bit-identical coords)', coordIdentical ? 0 : 1, 1,
    coordIdentical ? '' : `got ${JSON.stringify(b)}`);
}

/* ── (c) two-room split fixture from G1 (each zone's complement separately) ─ */
function caseTwoRoom() {
  const scale = { widthUnits: 50, heightUnits: 30, unit: 'ft' };
  const walls = [
    { id: 'top_l', from: { x: 0, y: 0 }, to: { x: 50, y: 0 } },
    { id: 'top_r', from: { x: 50, y: 0 }, to: { x: 100, y: 0 } },
    { id: 'right', from: { x: 100, y: 0 }, to: { x: 100, y: 100 } },
    { id: 'bot_r', from: { x: 100, y: 100 }, to: { x: 85, y: 100 } },
    { id: 'bot_r2', from: { x: 70, y: 100 }, to: { x: 50, y: 100 } },
    { id: 'bot_l', from: { x: 50, y: 100 }, to: { x: 0, y: 100 } },
    { id: 'left', from: { x: 0, y: 100 }, to: { x: 0, y: 0 } },
    { id: 'int_top', from: { x: 50, y: 0 }, to: { x: 50, y: 40 } },
    { id: 'int_bot', from: { x: 50, y: 60 }, to: { x: 50, y: 100 } },
  ];
  const doors = [
    { id: 'exit', wall: 'bot_r', from: { x: 85, y: 100 }, to: { x: 70, y: 100 }, walkThrough: true, role: 'exit-to-outside' },
    { id: 'inner', wall: 'int_top', from: { x: 50, y: 40 }, to: { x: 50, y: 60 }, walkThrough: true, role: 'interior-bridge' },
  ];
  const res = detectZones({ walls, doors }, scale);
  console.log(`  (c) two-room: ${res.zones.length} zones detected`);
  for (const z of res.zones) {
    const r = zoneToBlockers({ polygonPct: z.polygonPct }, { stage: { x0: 0, y0: 0, x1: 100, y1: 100 } });
    gridExactness(`(c) two-room ${z.id} complement`, z.polygonPct, r.blockers);
  }
}

/* ── exit-emission smoke check (Task 1c) ─────────────────────────────────── */
function caseExitEmission() {
  const stage = { x0: 0, y0: 0, x1: 100, y1: 100 };
  const zone = { polygonPct: [{ x: 20, y: 20 }, { x: 80, y: 20 }, { x: 80, y: 80 }, { x: 20, y: 80 }] };
  const exits = [{ id: 'exitS', from: { x: 40, y: 80 }, to: { x: 60, y: 80 } }];
  const r = zoneToBlockers(zone, { stage, exits });
  const e = r.exits[0];
  const ok = r.exits.length === 1 && e.cat === 'exit' && e.walkThrough === true &&
    e.x <= 40 && e.x + e.w >= 60 && Math.abs(e.y + e.h / 2 - 80) < 2;
  record('(d) exit emission: cat="exit" seed at door', ok ? 0 : 1, 1,
    `exit=${JSON.stringify(e)}`);
}

/* ── non-rectilinear refusal check (honest limitation) ───────────────────── */
function caseDiagonalRefusal() {
  const zone = { polygonPct: [{ x: 10, y: 10 }, { x: 90, y: 30 }, { x: 60, y: 90 }, { x: 10, y: 70 }] }; // diagonal edges
  const r = zoneToBlockers(zone);
  const ok = r.exact === false && r.blockers.length === 0 && r.warnings.some(w => w.code === 'non-rectilinear-zone');
  record('(e) diagonal zone refused (not silently approximated)', ok ? 0 : 1, 1,
    `exact=${r.exact} blockers=${r.blockers.length} warn=${r.warnings.map(w => w.code)}`);
}

/* ── run ─────────────────────────────────────────────────────────────────── */
console.log('='.repeat(70));
console.log('v2 Phase G2 — ZONE-TO-BLOCKER EXACTNESS');
console.log('='.repeat(70));
caseRectangle();
caseMRDC();
caseTwoRoom();
caseExitEmission();
caseDiagonalRefusal();

console.log('');
for (const r of results) {
  console.log(`  [${r.pass ? 'PASS' : 'FAIL'}] ${r.name} — mismatches=${r.mismatch}` +
    (r.checked > 1 ? ` / ${r.checked} pts` : '') + (r.extra ? `  ${r.extra}` : ''));
}

const allPass = results.every(r => r.pass);
console.log('');
console.log('='.repeat(70));
console.log('RESULT: ' + (allPass ? 'ALL EXACTNESS CHECKS PASS (0 mismatches)' : 'FAILURES PRESENT'));
console.log('='.repeat(70));
process.exit(allPass ? 0 : 1);
