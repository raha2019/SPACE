/**
 * v2/test-active-users.mjs  --  v2 Phase A1 Task 3.
 *
 * Fixtures with EXPECTED answers stated in advance (in the comments/`exp` fields).
 * If a computed result differs but is defensible, it is reported as a finding, not
 * silently accepted. Fixture (e) is the STOP gate: if the count does not drop when
 * the layout worsens, the metric is broken.
 *
 *  (a) one machine / one exit / operator footprint = N person-spaces -> exactly N users
 *  (b) two machines, 50% overlapping footprints -> even-split vs layer-priority differ as predicted
 *  (c) machine walled off from any exit -> ZERO usable despite clear footprint (reachability)
 *  (d) the diagnostic fixture -> zone C (sealed) contributes 0; hand-verify one machine
 *  (e) MRDC: move a machine to pinch a corridor -> the count DROPS
 *
 * Usage:  node v2/test-active-users.mjs
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { computeActiveUsers } from './active-users.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const results = [];
const check = (name, pass, expected, computed) => { results.push({ name, pass, expected: String(expected), computed: String(computed) }); };
const rect = (shape) => ({ shape, scale: { pxPerUnit: 10, unit: 'ft', widthUnits: 40, heightUnits: 40 } });

/* ── (a) one machine, operator footprint = 3 person-spaces (30 ft^2 / 10) ─────── */
{
  const proj = {
    schemaVersion: '2.1.0', room: rect('rectangle'),
    machineTypes: {
      saw: { label: 'Saw', w: 5, h: 5, occupancy: { operatorCount: 3, personSpaceAreaUnits: 10 }, operatorZonesFt: [{ offsetX: 0, offsetY: 6, w: 5, h: 6 }] },
      ex: { label: 'Exit', cat: 'exit', w: 5, h: 5, fixed: true },
    },
    machines: [{ id: 'm1', type: 'saw', x: 30, y: 10 }, { id: 'exit1', type: 'ex', x: 0, y: 45 }],
  };
  const r = computeActiveUsers(proj, { mode: 'even-split' });
  // EXPECT: usableArea 30 ft^2, usableUsers 3.0, no rejections.
  check('(a) one machine, footprint = 3 person-spaces -> 3.0 users', r.perMachine[0].usableUsers === 3, '3.0', r.perMachine[0].usableUsers);
}

/* ── (b) two machines, 50% overlapping footprints ────────────────────────────── */
{
  const proj = {
    schemaVersion: '2.1.0', room: rect('rectangle'),
    machineTypes: {
      saw: { label: 'S', w: 5, h: 5, occupancy: { operatorCount: 1, personSpaceAreaUnits: 10 }, operatorZonesFt: [{ offsetX: 0, offsetY: -9, w: 10, h: 2 }] },
      ex: { label: 'E', cat: 'exit', w: 5, h: 5, fixed: true },
    },
    // m1 op world x[10,20]y[10,12]; m2 op world x[15,25]y[10,12]; overlap x[15,20] = 50% of each (area 10 of 20).
    machines: [{ id: 'm1', type: 'saw', x: 35, y: 47.5 }, { id: 'm2', type: 'saw', x: 47.5, y: 47.5 }, { id: 'exit1', type: 'ex', x: 0, y: 0 }],
  };
  const es = computeActiveUsers(proj, { mode: 'even-split' });
  const lp = computeActiveUsers(proj, { mode: 'layer-priority' });
  // EXPECT even-split: each = exclusive(10) + half overlap(5) = 15 ft^2 -> 1.5 users; total 3.0.
  // EXPECT layer-priority: m2 (later in array = topmost) = 10 + 10 = 20 -> 2.0; m1 = 10 -> 1.0; total 3.0.
  check('(b) even-split: m1 = 1.5 users', es.perMachine[0].usableUsers === 1.5, '1.5', es.perMachine[0].usableUsers);
  check('(b) even-split: m2 = 1.5 users', es.perMachine[1].usableUsers === 1.5, '1.5', es.perMachine[1].usableUsers);
  check('(b) layer-priority: m1 = 1.0 (bottom)', lp.perMachine[0].usableUsers === 1.0, '1.0', lp.perMachine[0].usableUsers);
  check('(b) layer-priority: m2 = 2.0 (topmost claims full overlap)', lp.perMachine[1].usableUsers === 2.0, '2.0', lp.perMachine[1].usableUsers);
  check('(b) both modes share the same building total (union counted once)', es.buildingUsers === 3 && lp.buildingUsers === 3, 'both 3.0', `es=${es.buildingUsers} lp=${lp.buildingUsers}`);
  check('(b) the two modes differ per-machine (overlap accounting proven)', es.perMachine[1].usableUsers !== lp.perMachine[1].usableUsers, 'different splits', `es m2=${es.perMachine[1].usableUsers} lp m2=${lp.perMachine[1].usableUsers}`);
}

/* ── (c) machine walled off from any exit -> ZERO ────────────────────────────── */
{
  const proj = {
    schemaVersion: '2.1.0', room: rect('rectangle'),
    machineTypes: {
      saw: { label: 'S', w: 5, h: 5, occupancy: { operatorCount: 2, personSpaceAreaUnits: 10 }, operatorZonesFt: [{ offsetX: 0, offsetY: 5, w: 5, h: 4 }] },
      ex: { label: 'E', cat: 'exit', w: 5, h: 5, fixed: true },
    },
    machines: [{ id: 'm1', type: 'saw', x: 27.5, y: 27.5 }, { id: 'exit1', type: 'ex', x: 82.5, y: 82.5 }],
    // sealed box (no door) around m1's operator footprint; exit outside the box.
    structuralGeometry: {
      snapTol: 0.05, doors: [], walls: [
        { id: 't', from: { x: 12.5, y: 12.5 }, to: { x: 50, y: 12.5 } }, { id: 'r', from: { x: 50, y: 12.5 }, to: { x: 50, y: 50 } },
        { id: 'b', from: { x: 50, y: 50 }, to: { x: 12.5, y: 50 } }, { id: 'l', from: { x: 12.5, y: 50 }, to: { x: 12.5, y: 12.5 } },
      ],
    },
  };
  const r = computeActiveUsers(proj, { mode: 'even-split' });
  const m = r.perMachine[0];
  // EXPECT: geometrically-clear footprint but unreachable -> usableUsers 0, unreachable rejections > 0.
  check('(c) walled-off machine -> ZERO usable users (reachability matters)', m.usableUsers === 0, '0', m.usableUsers);
  check('(c) rejection reason is UNREACHABLE (not blocked)', m.rejected.unreachable > 0 && m.rejected.blocked === 0, 'unreachable>0, blocked=0', JSON.stringify(m.rejected));
}

/* ── (d) diagnostic fixture: zone C = 0; hand-verify one machine ──────────────── */
{
  const diag = JSON.parse(readFileSync(join(ROOT, 'testcase/diagnostic/diagnostic-plan.v2.json'), 'utf8'));
  const r = computeActiveUsers(diag, { mode: 'even-split' });
  const zC = r.perZone.find(z => !z.hasExit);
  check('(d) diagnostic: sealed zone C (no exit) contributes 0', zC && zC.usableUsers === 0, '0', zC ? zC.usableUsers : 'n/a');
  const zA = r.perZone.find(z => z.id !== zC.id && z.machines.includes('p3d'));
  const zB = r.perZone.find(z => z.machines.includes('wjet'));
  check('(d) diagnostic: zone A and zone B both have usable capacity', zA.usableUsers > 0 && zB.usableUsers > 0, 'A>0 and B>0', `A=${zA.usableUsers.toFixed(2)} B=${zB.usableUsers.toFixed(2)}`);
  // HAND-VERIFY wjet (synthesised op region; no overlap/hard/block per the run):
  //   occ {count 1, personSpace 20}; w=6% (3.6 ft), h=5% (2 ft) on 60x40 ft.
  //   synth area 20 ft^2, width=3.6, depth=20/3.6=5.5556; local rect centre (0, 1+2.7778)=(0,3.7778).
  //   wjet at x70,y30 -> centre ft (43.8, 13); op rect x[42,45.6], y[14,19.556].
  //   grid-cell centres inside: x{42.5,43.5,44.5,45.5}=4, y{14.5..19.5}=6 -> 24 cells -> 24/20 = 1.2 users.
  const wjet = r.perMachine.find(m => m.id === 'wjet');
  check('(d) HAND-VERIFY wjet: 24 usable cells / 20 ft^2 person-space = 1.2 users', wjet.usableArea === 24 && wjet.usableUsers === 1.2, 'usableArea=24, users=1.2', `usableArea=${wjet.usableArea}, users=${wjet.usableUsers}`);
  console.log(`\n  (d) diagnostic: zoneA=${zA.usableUsers.toFixed(3)} zoneB=${zB.usableUsers.toFixed(3)} zoneC=0 | building=${r.buildingUsers.toFixed(3)} headcount=${r.buildingHeadcount} shortfall=${r.shortfall.toFixed(4)}`);
}

/* ── (e) MRDC sensitivity: pinch a corridor -> count DROPS (STOP gate) ────────── */
let sensitivityOk = false;
{
  const mrdc = JSON.parse(readFileSync(join(ROOT, 'testcase/mrdc2323.v2.json'), 'utf8'));
  const base = computeActiveUsers(mrdc, { mode: 'even-split' });
  const moved = JSON.parse(JSON.stringify(mrdc));
  const w = moved.machines.find(m => m.id === 'wood');   // move 'wood' into the central cluster/corridor
  w.x = 50; w.y = 50;
  const after = computeActiveUsers(moved, { mode: 'even-split' });
  sensitivityOk = after.buildingUsers < base.buildingUsers;
  // EXPECT: a layout change that plainly reduces usable space DROPS the count.
  check('(e) MRDC: pinching move DROPS active-users', sensitivityOk, `< ${base.buildingUsers.toFixed(3)}`, after.buildingUsers.toFixed(3));
  console.log(`  (e) MRDC baseline=${base.buildingUsers.toFixed(3)} -> after wood->(50,50)=${after.buildingUsers.toFixed(3)}  (delta ${(after.buildingUsers - base.buildingUsers).toFixed(3)})`);
}

/* ── report ──────────────────────────────────────────────────────────────────── */
console.log('\n' + '='.repeat(74));
console.log('v2 Phase A1 — ACTIVE-USERS METRIC FIXTURES');
console.log('='.repeat(74));
let pass = 0, fail = 0;
for (const r of results) {
  console.log(`  [${r.pass ? 'PASS' : 'FAIL'}] ${r.name}`);
  if (!r.pass) { console.log(`         expected: ${r.expected}`); console.log(`         computed: ${r.computed}`); }
  r.pass ? pass++ : fail++;
}
console.log('='.repeat(74));
if (!sensitivityOk) console.log('STOP: sensitivity fixture (e) FAILED — the metric did not respond to a worsening layout.');
console.log(`RESULT: ${pass} PASS / ${fail} FAIL`);
console.log('='.repeat(74));
process.exit(fail === 0 ? 0 : 1);
