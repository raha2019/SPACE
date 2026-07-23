/**
 * v2/test-zone-detection.mjs  --  v2 Phase G1 fixtures + runner.
 *
 * Proves v2/zone-detection.mjs on real cases:
 *   (a) simple rectangle with one exit door        -> 1 zone, correct area, 1 exit-to-outside door
 *   (b) real MRDC 2323 L-shape (frozen project)     -> 1 zone ~6,278 sf, notch outside the zone
 *   (c) two rooms split by an interior false wall   -> 2 zones, 1 interior-bridge door, per-zone areas
 *   (d) degenerate cases                            -> the specific flag, not a crash
 *
 * Reports pass/fail per fixture with computed vs expected areas.
 *
 * Usage:  node v2/test-zone-detection.mjs
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { detectZones, applyCorrections, polygonToWalls, formatReport, pointInRing } from './zone-detection.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const readJSON = rel => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));

const AREA_TOL = 0.5;        // real-units^2 absolute tolerance for computed vs expected

function approx(a, b, tol = AREA_TOL) { return Math.abs(a - b) <= tol; }
function hasFlag(result, code) { return result.flags.some(f => f.code === code); }
function nonInfoCodes(result) { return [...new Set(result.flags.filter(f => f.level !== 'info').map(f => f.code))]; }

const results = [];
function record(name, pass, detail) { results.push({ name, pass, detail }); }

/* ── (a) simple rectangle with one exit door ─────────────────────────────────
 * Stage 40 ft x 30 ft. Bottom wall carved wall|door|wall. Expect 1 zone = 1,200 sf,
 * exactly one exit-to-outside door. */
function fixtureRectangle() {
  const scale = { widthUnits: 40, heightUnits: 30, unit: 'ft' };
  const walls = [
    { id: 'top',   from: { x: 0, y: 0 },     to: { x: 100, y: 0 } },
    { id: 'right', from: { x: 100, y: 0 },   to: { x: 100, y: 100 } },
    { id: 'bot_a', from: { x: 100, y: 100 }, to: { x: 60, y: 100 } },
    { id: 'bot_b', from: { x: 40, y: 100 },  to: { x: 0, y: 100 } },
    { id: 'left',  from: { x: 0, y: 100 },   to: { x: 0, y: 0 } },
  ];
  const doors = [
    { id: 'exit', wall: 'bot_a', from: { x: 60, y: 100 }, to: { x: 40, y: 100 }, walkThrough: true, width: 3, role: 'exit-to-outside' },
  ];
  const res = detectZones({ walls, doors }, scale);
  const expectedArea = 40 * 30;   // 1200
  const z = res.zones[0];
  const exit = res.doors.find(d => d.id === 'exit');
  const pass = res.zones.length === 1 &&
    approx(z.areaUnits, expectedArea) &&
    res.doors.filter(d => d.role === 'exit-to-outside').length === 1 &&
    exit && exit.role === 'exit-to-outside';
  record('(a) rectangle + 1 exit door', pass,
    `zones=${res.zones.length} (exp 1)  area=${z ? z.areaUnits.toFixed(2) : '-'} (exp ${expectedArea})  ` +
    `exit door role=${exit ? exit.role : 'MISSING'}`);
  return res;
}

/* ── (b) real MRDC 2323 L-shape from the FROZEN project ──────────────────────
 * Walls derived from room.polygonPct; one exit door on the north wall (exitN).
 * Expect 1 zone ~6,278.76 sf, and the SE notch OUTSIDE the zone. */
function fixtureMRDC() {
  const project = readJSON('testcase/mrdc2323.v2.json');
  const poly = project.room.polygonPct;
  const scale = project.room.scale;
  // Derive the wall loop from the frozen L-polygon; carve an exit door on the
  // north edge (edge 0, y=0) near exitN (x≈91.5%).
  const geo = polygonToWalls(poly, {
    idPrefix: 'mrdc',
    doorEdges: [{ edgeIndex: 0, id: 'exitN', t0: 0.88, t1: 0.95, role: 'exit-to-outside', width: 3 }],
  });
  const res = detectZones(geo, scale);
  const expectedArea = 6278.76;   // pinned MRDC L-polygon area (sf)
  const z = res.zones[0];
  // Notch consistency: the SE notch must be OUTSIDE the zone; the left arm INSIDE.
  const notchPt = { x: 60, y: 80 }, interiorPt = { x: 20, y: 20 };
  const notchOutside = z && !pointInRing(notchPt, z.polygonPct);
  const interiorInside = z && pointInRing(interiorPt, z.polygonPct);
  const pass = res.zones.length === 1 && approx(z.areaUnits, expectedArea, 1.0) && notchOutside && interiorInside;
  record('(b) MRDC 2323 L-shape (frozen)', pass,
    `zones=${res.zones.length} (exp 1)  area=${z ? z.areaUnits.toFixed(2) : '-'} sf (exp ~${expectedArea})  ` +
    `notch(60,80) outside=${notchOutside}  interior(20,20) inside=${interiorInside}`);
  return res;
}

/* ── (c) two rooms split by an interior false wall with a connecting doorway ──
 * Stage 50 ft x 30 ft -> 1,500 sf total, 750 each. Interior wall at x=50 carved
 * wall|door|wall; bottom-right wall carved for an exit door. */
function fixtureTwoRoom() {
  const scale = { widthUnits: 50, heightUnits: 30, unit: 'ft' };
  const walls = [
    { id: 'top_l', from: { x: 0, y: 0 },     to: { x: 50, y: 0 } },
    { id: 'top_r', from: { x: 50, y: 0 },    to: { x: 100, y: 0 } },
    { id: 'right', from: { x: 100, y: 0 },   to: { x: 100, y: 100 } },
    { id: 'bot_r', from: { x: 100, y: 100 }, to: { x: 85, y: 100 } },
    { id: 'bot_r2', from: { x: 70, y: 100 }, to: { x: 50, y: 100 } },
    { id: 'bot_l', from: { x: 50, y: 100 },  to: { x: 0, y: 100 } },
    { id: 'left',  from: { x: 0, y: 100 },   to: { x: 0, y: 0 } },
    { id: 'int_top', from: { x: 50, y: 0 },  to: { x: 50, y: 40 } },
    { id: 'int_bot', from: { x: 50, y: 60 }, to: { x: 50, y: 100 } },
  ];
  const doors = [
    { id: 'exit', wall: 'bot_r', from: { x: 85, y: 100 }, to: { x: 70, y: 100 }, walkThrough: true, role: 'exit-to-outside' },
    { id: 'inner', wall: 'int_top', from: { x: 50, y: 40 }, to: { x: 50, y: 60 }, walkThrough: true, role: 'interior-bridge' },
  ];
  const res = detectZones({ walls, doors }, scale);
  const areas = res.zones.map(z => z.areaUnits).sort((a, b) => a - b);
  const inner = res.doors.find(d => d.id === 'inner');
  const exit = res.doors.find(d => d.id === 'exit');
  const pass = res.zones.length === 2 &&
    approx(areas[0], 750) && approx(areas[1], 750) &&
    inner && inner.role === 'interior-bridge' && inner.connectsZones.length === 2 &&
    exit && exit.role === 'exit-to-outside';
  record('(c) two rooms + interior false wall', pass,
    `zones=${res.zones.length} (exp 2)  areas=[${areas.map(a => a.toFixed(1)).join(', ')}] (exp 750,750)  ` +
    `inner=${inner ? inner.role + '/' + inner.connectsZones.length + 'z' : 'MISSING'}  exit=${exit ? exit.role : 'MISSING'}`);
  return res;
}

/* ── (d) degenerate cases: expect the SPECIFIC flag, not a crash ─────────────*/
function fixtureDegenerate() {
  const scale = { widthUnits: 100, heightUnits: 100, unit: 'ft' };
  const cases = [];

  const safe = (name, fn, wantCode) => {
    let crashed = false, res = null, err = null;
    try { res = fn(); } catch (e) { crashed = true; err = e.message; }
    const flagged = res ? hasFlag(res, wantCode) : false;
    const pass = !crashed && flagged;
    cases.push({ name, wantCode, crashed, flagged, codes: res ? nonInfoCodes(res) : [], err });
    record('(d) degenerate: ' + name, pass,
      crashed ? `CRASHED: ${err}` : `flag "${wantCode}" present=${flagged}  (flags: ${nonInfoCodes(res).join(', ') || 'none'})`);
    return res;
  };

  // open contour: 3 walls of a square (one side missing)
  safe('open contour', () => detectZones({ walls: [
    { id: 'a', from: { x: 0, y: 0 }, to: { x: 100, y: 0 } },
    { id: 'b', from: { x: 100, y: 0 }, to: { x: 100, y: 100 } },
    { id: 'c', from: { x: 100, y: 100 }, to: { x: 0, y: 100 } },
  ], doors: [] }, scale), 'open-contour');

  // wall crossing another wall (an X)
  safe('wall crossing wall', () => detectZones({ walls: [
    { id: 'a', from: { x: 0, y: 0 }, to: { x: 100, y: 100 } },
    { id: 'b', from: { x: 0, y: 100 }, to: { x: 100, y: 0 } },
  ], doors: [] }, scale), 'wall-crossing');

  // door not attached to any wall
  safe('door not on a wall', () => detectZones({
    walls: polygonToWalls([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }], { idPrefix: 'r' }).walls,
    doors: [{ id: 'fd', from: { x: 40, y: 40 }, to: { x: 60, y: 40 }, walkThrough: true }],
  }, scale), 'door-floating');

  // nested / overlapping loops (a rectangle hole inside a rectangle)
  safe('nested loops', () => detectZones({
    walls: polygonToWalls([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }], { idPrefix: 'o' }).walls
      .concat(polygonToWalls([{ x: 30, y: 30 }, { x: 70, y: 30 }, { x: 70, y: 70 }, { x: 30, y: 70 }], { idPrefix: 'i' }).walls),
    doors: [],
  }, scale), 'nested-loop');

  return cases;
}

/* ── correction interface smoke test (Task 2e) ─────────────────────────────── */
function fixtureCorrections() {
  const scale = { widthUnits: 100, heightUnits: 100, unit: 'ft' };
  const base = detectZones(polygonToWalls([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }], { idPrefix: 'q' }), scale);
  const split = applyCorrections(base, [{ op: 'split', zone: 'zone0', line: { from: { x: 50, y: -5 }, to: { x: 50, y: 105 } }, ids: ['zL', 'zR'] }], scale);
  const merged = applyCorrections(split, [{ op: 'merge', zones: ['zL', 'zR'], id: 'zM' }], scale);
  const notRoom = applyCorrections(base, [{ op: 'not-a-room', zone: 'zone0' }], scale);
  const splitOk = split.zones.length === 2 && approx(split.zones[0].areaUnits, 5000) && approx(split.zones[1].areaUnits, 5000);
  const mergeOk = merged.zones.length === 1 && approx(merged.zones[0].areaUnits, 10000);
  const notRoomOk = notRoom.zones[0].isRoom === false;
  record('(e) corrections merge/split/not-a-room', splitOk && mergeOk && notRoomOk,
    `split=${split.zones.map(z => z.areaUnits.toFixed(0)).join('+')}  merge=${merged.zones.map(z => z.areaUnits.toFixed(0))}  not-a-room isRoom=${notRoom.zones[0].isRoom}`);
}

/* ── run all + report ──────────────────────────────────────────────────────── */
console.log('='.repeat(70));
console.log('v2 Phase G1 — ZONE DETECTION FIXTURES');
console.log('='.repeat(70));

const rectRes = fixtureRectangle();
const mrdcRes = fixtureMRDC();
const twoRes = fixtureTwoRoom();
fixtureDegenerate();
fixtureCorrections();

console.log('');
for (const r of results) {
  console.log(`  [${r.pass ? 'PASS' : 'FAIL'}] ${r.name}`);
  console.log(`         ${r.detail}`);
}

console.log('');
console.log('  Detailed report — fixture (a) rectangle:');
console.log(formatReport(rectRes).split('\n').map(l => '    ' + l).join('\n'));
console.log('');
console.log('  Detailed report — fixture (c) two-room split:');
console.log(formatReport(twoRes).split('\n').map(l => '    ' + l).join('\n'));

const allPass = results.every(r => r.pass);
console.log('');
console.log('='.repeat(70));
console.log('RESULT: ' + (allPass ? 'ALL FIXTURES PASS' : 'FAILURES PRESENT'));
console.log('='.repeat(70));
process.exit(allPass ? 0 : 1);
