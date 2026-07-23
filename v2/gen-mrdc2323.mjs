/**
 * v2/gen-mrdc2323.mjs  --  build testcase/mrdc2323.v2.json from the authoritative
 * frozen v1 source files, so every value is a byte-exact copy (no transcription).
 *
 *   testcase/hub/default-elements.json      -> machineTypes (engine fields verbatim)
 *   testcase/hub/default-configuration.json -> machine instance positions
 *   testcase/hub/mrdc2323-scale.json        -> room polygon + scale + floor element
 *
 * Usage:  node v2/gen-mrdc2323.mjs   (writes testcase/mrdc2323.v2.json)
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ENGINE_DEF_FIELDS } from './project-to-engine.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const readJSON = rel => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));

const elementBundle = readJSON('testcase/hub/default-elements.json');
const configBundle  = readJSON('testcase/hub/default-configuration.json');
const scaleFile     = readJSON('testcase/hub/mrdc2323-scale.json');

const ELEMENT_DEFS = elementBundle.elementDefs;      // 21, in order
const CONFIG_ZONES = configBundle.zones;
const floorDef     = scaleFile.floorDef;
const notchBlocker = scaleFile.notchBlockerDef;      // Phase 2d SE-notch wall

/* machineTypes: engine fields verbatim, keyed by element id (type == id here,
 * since each v1 element is a singleton). */
const machineTypes = {};
for (const def of ELEMENT_DEFS) {
  const type = {};
  for (const k of ENGINE_DEF_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(def, k)) type[k] = def[k];
  }
  machineTypes[def.id] = type;
}

/* machines: one instance per element, in the SAME order as ELEMENT_DEFS (order
 * flows through to ZONE_DEFS / allZoneDefs). Position + optional w/h overrides
 * come from default-configuration.json. */
const machines = ELEMENT_DEFS.map(def => {
  const cfg = CONFIG_ZONES[def.id] || {};
  const m = { id: def.id, type: def.id };
  if (cfg.x !== undefined) m.x = cfg.x;
  if (cfg.y !== undefined) m.y = cfg.y;
  if (cfg.w !== undefined) m.w = cfg.w;
  if (cfg.h !== undefined) m.h = cfg.h;
  if (cfg.rotation !== undefined) m.rotation = cfg.rotation;
  return m;
});

/* movable set: exactly the 14 ids the frozen harness passes to mosaOptimize. */
const movableIds = [
  'craftland', 'xr', 'asm1', 'asm2', 'bike', 'storage',
  'electronics', 'print3d', 'laser', 'cnc', 'metal', 'wood',
  'welding', 'waterjet',
];

const project = {
  schemaVersion: '2.0.0',
  meta: {
    id: 'mrdc2323',
    name: 'Georgia Tech Invention Studio — MRDC 2323 (frozen v1 pin)',
    provenance: {
      generatedFrom: [
        'testcase/hub/default-elements.json',
        'testcase/hub/default-configuration.json',
        'testcase/hub/mrdc2323-scale.json',
      ],
      generator: 'v2/gen-mrdc2323.mjs',
      note: 'Byte-exact expression of the frozen MRDC 2323 configuration in the v2 schema. '
          + 'Equivalence to tools/baseline-mrdc2323.json is asserted by v2/equivalence-test.mjs.',
      source_drawing: scaleFile.provenance && scaleFile.provenance.source_drawing,
    },
  },
  room: {
    shape: 'polygon',
    scale: {
      pxPerUnit: scaleFile.pxPerUnit,
      unit: scaleFile.unit,
      widthUnits: scaleFile.check_width_ft,
      heightUnits: scaleFile.check_height_ft,
    },
    stage: {
      widthPx: scaleFile.stageWidthPx,
      heightPx: scaleFile.stageHeightPx,
    },
    floorId: floorDef.id,
    floorLabel: floorDef.label,
    // Engine-native normalized stage-% outline (0..100). Passed through verbatim
    // to the structural floor element's shapes[0].points, so the L-polygon scope
    // is bit-identical to the frozen run.
    polygonPct: floorDef.shapes[0].points.map(p => ({ x: p.x, y: p.y })),
    // Documentation only (not consumed by the translator): the same outline in feet.
    verticesUnits: scaleFile.polygon_vertices_ft,
    // Phase 2d: structural wall filling the excluded SE notch, so the ADA/egress/noise
    // objective grids treat those cells as blocked/attenuated (not usable floor).
    structuralBlockers: [
      {
        id: notchBlocker.id,
        label: notchBlocker.label,
        elementClass: notchBlocker.elementClass,
        subtype: notchBlocker.subtype,
        cat: notchBlocker.cat,
        blocksMovement: notchBlocker.blocksMovement,
        x: notchBlocker.x, y: notchBlocker.y, w: notchBlocker.w, h: notchBlocker.h,
      },
    ],
    notes: {
      coordinateSystem: 'polygonPct is normalized stage percent (0..100). verticesUnits is feet (documentation).',
      shoelaceAreaSf: scaleFile.check_polygon_area_sf_shoelace_exact,
      seNotch: 'x > 40.994% AND y > 54.853% (== x > 39.6 ft, y > 48.6 ft) is excluded; structuralBlockers[0] fills it.',
    },
  },
  machineTypes,
  machines,
  optimization: {
    movableIds,
    seed: '0x4D524443',
    iters: 4000,
    // Forward-looking: the MOSA optimizer uses randomized-weight SA (samples the
    // 3-simplex per iteration) and does NOT consume these weights. Retained for a
    // future weighted-scalar report and for the eventual weight-driven objective.
    objectiveWeights: { ada: 1 / 3, egress: 1 / 3, noise: 1 / 3 },
  },
  // Forward-looking sections (schema-valid, not yet consumed by the v1 engine).
  adjacency: [],
  ruleModes: { adjacency: 'advisory', clearance: 'advisory' },
};

const outPath = join(ROOT, 'testcase/mrdc2323.v2.json');
writeFileSync(outPath, JSON.stringify(project, null, 2) + '\n', 'utf8');
console.log('Wrote ' + outPath);
console.log('  machineTypes: ' + Object.keys(machineTypes).length);
console.log('  machines:     ' + machines.length);
console.log('  movableIds:   ' + movableIds.length);
console.log('  room.polygonPct vertices: ' + project.room.polygonPct.length);
