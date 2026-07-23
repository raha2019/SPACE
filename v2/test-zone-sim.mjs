/**
 * v2/test-zone-sim.mjs  --  v2 Phase G3 fixtures with KNOWN-CORRECT answers.
 *
 * Each fixture states its EXPECTED result (from semantics + construction) BEFORE
 * running. Semantics: v2/ZONE_SIM_SEMANTICS.md.
 *
 *   (a) single-zone MRDC (frozen)  -> per-zone == frozen pin BIT-FOR-BIT (regression anchor)
 *   (b) rectangle split by a SOLID wall, symmetric machines + exits -> A==B (ada,egress,noise)
 *   (c) same but interior DOORWAY, exit only in A -> zone B is REACHABLE (egress to the bridge)
 *   (d) a zone with NO door -> reachable:false, clean, excluded from aggregate
 *   (e) three vertical bands, loud source in the RIGHT band only -> no noise leak into other
 *       zones' denominators; aggregation sane
 *
 * If the MRDC anchor (a) fails, STOP.
 *
 * Usage:  node v2/test-zone-sim.mjs
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { detectZones } from './zone-detection.mjs';
import { evaluateProjectPerZone } from './zone-sim.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const results = [];
function check(name, pass, expected, computed) {
  results.push({ name, pass, expected, computed });
}
const eqE = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

/* ── (a) MRDC single-zone regression anchor (BIT-FOR-BIT) ─────────────────── */
function fixtureA() {
  const project = JSON.parse(readFileSync(join(ROOT, 'testcase/mrdc2323.v2.json'), 'utf8'));
  const pin = { ada: 0.13827363048035732, egress: 0.4275, noise: 0.40589569160997735 };
  const r = evaluateProjectPerZone(project, {});
  const z = r.zones[0].vec, a = r.aggregate;
  const zEq = z.ada === pin.ada && z.egress === pin.egress && z.noise === pin.noise;
  const aEq = a.ada === pin.ada && a.egress === pin.egress && a.noise === pin.noise;
  check('(a) MRDC per-zone == pin (bit-for-bit)', zEq && aEq,
    JSON.stringify(pin), 'zone=' + JSON.stringify(z) + ' agg=' + JSON.stringify(a));
  return zEq && aEq;
}

/* ── shared: build a split-rectangle project ──────────────────────────────── */
const SRC_TYPE = { src: { label: 'Noise src', dba_active: 95, schedule_prob: 1, w: 8, h: 8, cat: '' } };
const SCALE60x30 = { pxPerUnit: 9, unit: 'ft', widthUnits: 60, heightUnits: 30 };

/* ── (b) SOLID interior wall, symmetric ──────────────────────────────────── */
function fixtureB() {
  const walls = [
    { id: 'top_l', from: { x: 0, y: 0 }, to: { x: 50, y: 0 } },
    { id: 'top_r', from: { x: 50, y: 0 }, to: { x: 100, y: 0 } },
    { id: 'right_a', from: { x: 100, y: 0 }, to: { x: 100, y: 45 } },
    { id: 'right_b', from: { x: 100, y: 55 }, to: { x: 100, y: 100 } },
    { id: 'bot_r', from: { x: 100, y: 100 }, to: { x: 50, y: 100 } },
    { id: 'bot_l', from: { x: 50, y: 100 }, to: { x: 0, y: 100 } },
    { id: 'left_a', from: { x: 0, y: 100 }, to: { x: 0, y: 55 } },
    { id: 'left_b', from: { x: 0, y: 45 }, to: { x: 0, y: 0 } },
    { id: 'int', from: { x: 50, y: 0 }, to: { x: 50, y: 100 } },            // SOLID
  ];
  const doors = [
    { id: 'exitR', wall: 'right_a', from: { x: 100, y: 45 }, to: { x: 100, y: 55 }, role: 'exit-to-outside' },
    { id: 'exitL', wall: 'left_a', from: { x: 0, y: 55 }, to: { x: 0, y: 45 }, role: 'exit-to-outside' },
  ];
  const geometry = { walls, doors };
  const project = {
    schemaVersion: '2.0.0', room: { shape: 'rectangle', scale: SCALE60x30 },
    machineTypes: SRC_TYPE,
    machines: [
      { id: 'leftSrc', type: 'src', x: 20, y: 46 },   // center (24,50) — mirror of (76,50)
      { id: 'rightSrc', type: 'src', x: 72, y: 46 },  // center (76,50)
    ],
    optimization: { seed: '0x4D524443' },
    structuralGeometry: geometry,
  };
  const result = detectZones(geometry, SCALE60x30);
  const r = evaluateProjectPerZone(project, { detection: { result, geometry } });
  const zs = r.zones.filter(z => z.reachable);
  const nz = r.zones.length;
  if (nz !== 2) { check('(b) two zones detected', false, '2 zones', nz + ' zones'); return; }
  const [A, B] = r.zones;
  const adaEq = eqE(A.vec.ada, B.vec.ada), egEq = eqE(A.vec.egress, B.vec.egress), nEq = eqE(A.vec.noise, B.vec.noise);
  check('(b) symmetric split: A.ada == B.ada', adaEq, 'equal', `${A.vec.ada} vs ${B.vec.ada}`);
  check('(b) symmetric split: A.egress == B.egress', egEq, 'equal', `${A.vec.egress} vs ${B.vec.egress}`);
  check('(b) symmetric split: A.noise == B.noise (schedule_prob=1 => deterministic)', nEq, 'equal', `${A.vec.noise} vs ${B.vec.noise}`);
  check('(b) both zones reachable via own exterior exit', zs.length === 2, '2 reachable', zs.length + ' reachable');
}

/* ── (c) interior DOORWAY, exit only in A -> B reachable via bridge ───────── */
function fixtureC() {
  const walls = [
    { id: 'top_l', from: { x: 0, y: 0 }, to: { x: 50, y: 0 } },
    { id: 'top_r', from: { x: 50, y: 0 }, to: { x: 100, y: 0 } },
    { id: 'right', from: { x: 100, y: 0 }, to: { x: 100, y: 100 } },        // SOLID (no exit in B)
    { id: 'bot_r', from: { x: 100, y: 100 }, to: { x: 50, y: 100 } },
    { id: 'bot_l', from: { x: 50, y: 100 }, to: { x: 0, y: 100 } },
    { id: 'left_a', from: { x: 0, y: 100 }, to: { x: 0, y: 55 } },
    { id: 'left_b', from: { x: 0, y: 45 }, to: { x: 0, y: 0 } },
    { id: 'int_top', from: { x: 50, y: 0 }, to: { x: 50, y: 40 } },
    { id: 'int_bot', from: { x: 50, y: 60 }, to: { x: 50, y: 100 } },
  ];
  const doors = [
    { id: 'exitL', wall: 'left_a', from: { x: 0, y: 55 }, to: { x: 0, y: 45 }, role: 'exit-to-outside' },
    { id: 'bridge', wall: 'int_top', from: { x: 50, y: 40 }, to: { x: 50, y: 60 }, role: 'interior-bridge' },
  ];
  const geometry = { walls, doors };
  const project = {
    schemaVersion: '2.0.0', room: { shape: 'rectangle', scale: SCALE60x30 },
    machineTypes: SRC_TYPE,
    machines: [{ id: 'leftSrc', type: 'src', x: 20, y: 46 }, { id: 'rightSrc', type: 'src', x: 72, y: 46 }],
    optimization: { seed: '0x4D524443' }, structuralGeometry: geometry,
  };
  const result = detectZones(geometry, SCALE60x30);
  const r = evaluateProjectPerZone(project, { detection: { result, geometry } });
  // Identify which zone has the exterior exit (A) vs only the bridge (B).
  // A zone is "bridge-only" if none of its boundary doors is exit-to-outside.
  const withRole = z => {
    const drecs = (result.zones.find(rz => rz.id === z.zoneId).doors || []).map(did => (result.doors.find(d => d.id === did) || {}).role);
    return { hasExterior: drecs.includes('exit-to-outside'), hasBridge: drecs.includes('interior-bridge') };
  };
  const bridgeOnly = r.zones.find(z => { const w = withRole(z); return !w.hasExterior && w.hasBridge; });
  const withExit = r.zones.find(z => withRole(z).hasExterior);
  // EXPECTED (Task 1(b) semantic (i)): zone B (bridge-only) is REACHABLE via the bridge door.
  check('(c) zone B (bridge-only) is REACHABLE via the bridge', !!bridgeOnly && bridgeOnly.reachable,
    'reachable=true (travel to bridge door)', bridgeOnly ? `reachable=${bridgeOnly.reachable} boundaryDoors=${bridgeOnly.egressSources.boundaryDoors}` : 'no bridge-only zone found');
  check('(c) zone A (with exterior exit) is reachable', !!withExit && withExit.reachable,
    'reachable=true', withExit ? `reachable=${withExit.reachable}` : 'none');
  check('(c) two zones detected', r.zones.length === 2, '2', String(r.zones.length));
}

/* ── (d) zone with NO door -> unreachable, clean ─────────────────────────── */
function fixtureD() {
  const walls = [
    { id: 'w0', from: { x: 20, y: 20 }, to: { x: 80, y: 20 } },
    { id: 'w1', from: { x: 80, y: 20 }, to: { x: 80, y: 80 } },
    { id: 'w2', from: { x: 80, y: 80 }, to: { x: 20, y: 80 } },
    { id: 'w3', from: { x: 20, y: 80 }, to: { x: 20, y: 20 } },
  ];
  const geometry = { walls, doors: [] };
  const project = {
    schemaVersion: '2.0.0', room: { shape: 'rectangle', scale: SCALE60x30 },
    machineTypes: SRC_TYPE, machines: [{ id: 's', type: 'src', x: 45, y: 46 }],
    optimization: { seed: '0x4D524443' }, structuralGeometry: geometry,
  };
  const result = detectZones(geometry, SCALE60x30);
  let crashed = false, r = null;
  try { r = evaluateProjectPerZone(project, { detection: { result, geometry } }); } catch (e) { crashed = true; }
  const z = r && r.zones[0];
  const ok = !crashed && z && z.reachable === false && z.vec != null &&
    r.aggregate === null && r.flags.unreachableZones === 1;
  check('(d) no-door zone: reachable=false, no crash, excluded from aggregate', ok,
    'reachable=false, aggregate=null, unreachableZones=1',
    crashed ? 'CRASHED' : `reachable=${z && z.reachable} aggregate=${r.aggregate} unreachable=${r.flags.unreachableZones}`);
}

/* ── (e) three vertical bands, loud source only in the RIGHT band ─────────── */
function fixtureE() {
  const walls = [
    // top split at 33 and 67
    { id: 't0', from: { x: 0, y: 0 }, to: { x: 33, y: 0 } },
    { id: 't1', from: { x: 33, y: 0 }, to: { x: 67, y: 0 } },
    { id: 't2', from: { x: 67, y: 0 }, to: { x: 100, y: 0 } },
    { id: 'r', from: { x: 100, y: 0 }, to: { x: 100, y: 100 } },
    { id: 'b2', from: { x: 100, y: 100 }, to: { x: 67, y: 100 } },
    { id: 'b1', from: { x: 67, y: 100 }, to: { x: 33, y: 100 } },
    { id: 'b0', from: { x: 33, y: 100 }, to: { x: 0, y: 100 } },
    // left wall carved with an exterior exit for the LEFT band
    { id: 'l_a', from: { x: 0, y: 100 }, to: { x: 0, y: 55 } },
    { id: 'l_b', from: { x: 0, y: 45 }, to: { x: 0, y: 0 } },
    // interior wall at x=33, carved with a bridge (y 45-55)
    { id: 'i33_top', from: { x: 33, y: 0 }, to: { x: 33, y: 45 } },
    { id: 'i33_bot', from: { x: 33, y: 55 }, to: { x: 33, y: 100 } },
    // interior wall at x=67, carved with a bridge (y 45-55)
    { id: 'i67_top', from: { x: 67, y: 0 }, to: { x: 67, y: 45 } },
    { id: 'i67_bot', from: { x: 67, y: 55 }, to: { x: 67, y: 100 } },
  ];
  const doors = [
    { id: 'exitL', wall: 'l_a', from: { x: 0, y: 55 }, to: { x: 0, y: 45 }, role: 'exit-to-outside' },
    { id: 'br33', wall: 'i33_top', from: { x: 33, y: 45 }, to: { x: 33, y: 55 }, role: 'interior-bridge' },
    { id: 'br67', wall: 'i67_top', from: { x: 67, y: 45 }, to: { x: 67, y: 55 }, role: 'interior-bridge' },
  ];
  const geometry = { walls, doors };
  const project = {
    schemaVersion: '2.0.0', room: { shape: 'rectangle', scale: SCALE60x30 },
    machineTypes: SRC_TYPE,
    machines: [{ id: 'rightSrc', type: 'src', x: 80, y: 46 }],   // source ONLY in the right band
    optimization: { seed: '0x4D524443' }, structuralGeometry: geometry,
  };
  const result = detectZones(geometry, SCALE60x30);
  const r = evaluateProjectPerZone(project, { detection: { result, geometry } });
  check('(e) three zones detected', r.zones.length === 3, '3', String(r.zones.length));
  // Which zone contains the source (center 84,50 -> right band x>67)?
  const rightBand = r.zones.find(z => z.vec && z.vec.noise > 0 && zoneContains(result, z.zoneId, 84, 50));
  const others = r.zones.filter(z => z.vec && z !== rightBand);
  const noLeak = rightBand && others.every(z => rightBand.vec.noise > z.vec.noise + 1e-12);
  check('(e) no noise leak: source-band noise > other bands (isolation holds)', !!noLeak,
    'right.noise > middle.noise and > left.noise',
    rightBand ? `right=${rightBand.vec.noise} others=[${others.map(z => z.vec.noise).join(', ')}]` : 'right band not found');
  check('(e) aggregate present (reachable zones aggregated)', r.aggregate != null && r.flags.reachableZones >= 1,
    'aggregate != null', `agg=${JSON.stringify(r.aggregate)} reachable=${r.flags.reachableZones}`);
}
function zoneContains(result, zoneId, x, y) {
  const z = result.zones.find(rz => rz.id === zoneId);
  if (!z) return false;
  // even-odd
  const ring = z.polygonPct; let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].x, yi = ring[i].y, xj = ring[j].x, yj = ring[j].y;
    if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-9) + xi)) inside = !inside;
  }
  return inside;
}

/* ── run (anchor first; STOP if it fails) ───────────────────────────────── */
console.log('='.repeat(72));
console.log('v2 Phase G3 — PER-ZONE SIMULATION FIXTURES');
console.log('='.repeat(72));

const anchorOk = fixtureA();
if (!anchorOk) {
  console.log('\n  [FAIL] (a) MRDC regression anchor did NOT reproduce the pin bit-for-bit.');
  console.log('  ' + JSON.stringify(results[0]));
  console.log('\nSTOP: anchor failed; not running other fixtures.');
  process.exit(1);
}
fixtureB();
fixtureC();
fixtureD();
fixtureE();

console.log('');
for (const r of results) {
  console.log(`  [${r.pass ? 'PASS' : 'FAIL'}] ${r.name}`);
  console.log(`         expected: ${r.expected}`);
  console.log(`         computed: ${r.computed}`);
}
const allPass = results.every(r => r.pass);
console.log('');
console.log('='.repeat(72));
console.log('RESULT: ' + (allPass ? 'ALL FIXTURES PASS' : 'FAILURES PRESENT (see above)'));
console.log('='.repeat(72));
process.exit(allPass ? 0 : 1);
