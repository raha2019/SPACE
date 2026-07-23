/**
 * v2/test-element-attributes.mjs  --  v2 Phase E1 Task 4.
 *
 * (a) every machine in v2/machine-library.json validates against the schema;
 * (b) every numeric attribute carries a non-empty provenance string; print the
 *     standard-cited vs design-assumption tally (a deliverable — where the tool guesses);
 * (c) a project with the new attributes round-trips through export/import and the V0 seam
 *     without loss;
 * (d) clearance zones rotate with their machine — a kickback cone at 0/90/180/270° is the
 *     exact rotation of its local geometry (one case hand-verified);
 * (e) INERTNESS: adding every E1 attribute to the frozen MRDC project changes NO objective
 *     value — evaluateLayout via the V0 seam with vs without the attributes is bit-for-bit
 *     identical. If this fails, STOP (inert data changed a result).
 *
 * Usage:  node v2/test-element-attributes.mjs
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { evaluateBaseline } from './engine-adapter.mjs';
import { translateProject } from './project-to-engine.mjs';
import { worldGeometry, localGeometry, rotate, exactCardinalRotate } from './clearance.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SEED = '0x4D524443';

const schema = JSON.parse(readFileSync(join(ROOT, 'schema/space-project.v2.json'), 'utf8'));
const library = JSON.parse(readFileSync(join(ROOT, 'v2/machine-library.json'), 'utf8'));

const results = [];
const check = (name, pass, detail = '') => { results.push({ name, pass, detail }); };

/* ── minimal JSON-Schema (draft 2020-12 subset) validator ─────────────────────
 * Supports: type (incl. array-of-type), enum, const, required, properties,
 * additionalProperties(bool), items, $ref, minimum/maximum/exclusiveMinimum,
 * minItems, pattern. Sufficient for this schema. */
function resolveRef(ref) {
  const parts = ref.replace(/^#\//, '').split('/');
  let node = schema;
  for (const p of parts) node = node[p.replace(/~1/g, '/').replace(/~0/g, '~')];
  return node;
}
function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}
function validate(node, val, path, errs) {
  if (!node) return;
  if (node.$ref) return validate(resolveRef(node.$ref), val, path, errs);
  if (node.const !== undefined && val !== node.const) errs.push(`${path}: const !== ${JSON.stringify(node.const)}`);
  if (node.enum && !node.enum.includes(val)) errs.push(`${path}: ${JSON.stringify(val)} not in enum`);
  if (node.type) {
    const types = Array.isArray(node.type) ? node.type : [node.type];
    const t = typeOf(val);
    const ok = types.some(tt => tt === t || (tt === 'number' && t === 'integer') || (tt === 'integer' && t === 'integer'));
    if (!ok) { errs.push(`${path}: type ${t} not in ${JSON.stringify(types)}`); return; }
  }
  if (typeof val === 'number') {
    if (node.minimum !== undefined && val < node.minimum) errs.push(`${path}: < minimum`);
    if (node.maximum !== undefined && val > node.maximum) errs.push(`${path}: > maximum`);
    if (node.exclusiveMinimum !== undefined && val <= node.exclusiveMinimum) errs.push(`${path}: <= exclusiveMinimum`);
  }
  if (typeof val === 'string' && node.pattern && !new RegExp(node.pattern).test(val)) errs.push(`${path}: pattern`);
  if (Array.isArray(val)) {
    if (node.minItems !== undefined && val.length < node.minItems) errs.push(`${path}: minItems`);
    if (node.items) val.forEach((v, i) => validate(node.items, v, `${path}[${i}]`, errs));
  }
  if (val && typeof val === 'object' && !Array.isArray(val)) {
    if (node.required) for (const r of node.required) if (!(r in val)) errs.push(`${path}: missing required "${r}"`);
    const props = node.properties || {};
    for (const k of Object.keys(val)) {
      if (props[k]) validate(props[k], val[k], `${path}.${k}`, errs);
      else if (node.additionalProperties === false) errs.push(`${path}.${k}: additionalProperties=false`);
      else if (node.additionalProperties && typeof node.additionalProperties === 'object')
        validate(node.additionalProperties, val[k], `${path}.${k}`, errs);
    }
  }
}

/* ── (a) validate every library machine against #/$defs/machineType ─────────── */
const machineTypeDef = schema.$defs.machineType;
let allValid = true;
const validationErrs = {};
for (const [id, m] of Object.entries(library.machineTypes)) {
  const errs = [];
  validate(machineTypeDef, m, id, errs);
  if (errs.length) { allValid = false; validationErrs[id] = errs; }
}
check('(a) all library machines validate against schema #/$defs/machineType', allValid,
  allValid ? `${Object.keys(library.machineTypes).length} machines` : JSON.stringify(validationErrs).slice(0, 400));

/* ── (b) provenance on every numeric attribute + standard vs design-assumption tally ── */
const STD_TOKENS = ['OSHA', 'NFPA', 'ANSI', 'Z358', 'ADA', 'NIOSH', 'NEC', 'ACGIH'];
// Existing v1 rendering/scoring fields (retained, not E1 attributes) — excluded from the requirement.
const V1_RETAINED = new Set(['principalAxis', 'operatorFootprints', 'kickbackVectors', 'materialVectors']);
const isStd = s => STD_TOKENS.some(t => s.includes(t));
const isDA = s => /design assumption/i.test(s);

let tally = { standard: 0, designAssumption: 0, uncited: 0 };
let provenanceComplete = true;
const uncitedList = [];

function walkNumbers(node, path, onNum) {
  if (typeof node === 'number') { onNum(path, node); return; }
  if (Array.isArray(node)) { node.forEach((v, i) => walkNumbers(v, `${path}[${i}]`, onNum)); return; }
  if (node && typeof node === 'object') for (const k of Object.keys(node)) walkNumbers(node[k], path ? `${path}.${k}` : k, onNum);
}

for (const [id, m] of Object.entries(library.machineTypes)) {
  const provMap = m.provenance || {};
  walkNumbers(m, '', (path, _val) => {
    const seg = path.split('.')[0].replace(/\[\d+\]/g, '');
    if (seg === 'provenance') return;             // the provenance map itself
    if (V1_RETAINED.has(seg)) return;             // retained v1 model (documented exclusion)

    let prov = null;
    const cz = path.match(/^clearanceZones\[(\d+)\]/);
    const al = path.match(/^amenityLinks\[(\d+)\]/);
    if (cz) prov = (m.clearanceZones[+cz[1]] || {}).provenance;
    else if (al) prov = (m.amenityLinks[+al[1]] || {}).provenance;
    else prov = provMap[seg];

    if (!prov || !prov.trim()) { provenanceComplete = false; uncitedList.push(`${id}.${path}`); tally.uncited++; return; }
    if (isDA(prov)) tally.designAssumption++;
    else if (isStd(prov)) tally.standard++;
    else { tally.uncited++; uncitedList.push(`${id}.${path} (no token: "${prov}")`); provenanceComplete = false; }
  });
}
check('(b) every numeric attribute has a non-empty provenance string', provenanceComplete,
  provenanceComplete ? '' : `uncited: ${uncitedList.slice(0, 8).join('; ')}`);

/* ── (c) round-trip through export/import and the V0 seam without loss ──────── */
const baseProject = JSON.parse(readFileSync(join(ROOT, 'testcase/mrdc2323.v2.json'), 'utf8'));
const attrProject = JSON.parse(JSON.stringify(baseProject));
attrProject.schemaVersion = '2.1.0';
// Graft E1 attributes onto two real machine types from the library.
attrProject.machineTypes.wood = Object.assign({}, attrProject.machineTypes.wood, {
  hazards: library.machineTypes.tableSaw.hazards,
  clearanceZones: library.machineTypes.tableSaw.clearanceZones,
  ventilation: library.machineTypes.tableSaw.ventilation,
  power: library.machineTypes.tableSaw.power,
  amenityLinks: library.machineTypes.tableSaw.amenityLinks,
  occupancy: library.machineTypes.tableSaw.occupancy,
});
attrProject.machineTypes.welding = Object.assign({}, attrProject.machineTypes.welding, {
  hazards: library.machineTypes.weldingStation.hazards,
  clearanceZones: library.machineTypes.weldingStation.clearanceZones,
  ventilation: library.machineTypes.weldingStation.ventilation,
  utilities: library.machineTypes.weldingStation.utilities,
  amenityLinks: library.machineTypes.weldingStation.amenityLinks,
});

const exported = JSON.stringify(attrProject);
const reimported = JSON.parse(exported);
const roundTripLossless = JSON.stringify(reimported) === exported &&
  JSON.stringify(reimported.machineTypes.wood.clearanceZones) === JSON.stringify(attrProject.machineTypes.wood.clearanceZones) &&
  reimported.machineTypes.welding.hazards.sparkSource === true;
check('(c1) export/import round-trip is lossless (attributes preserved)', roundTripLossless);

// Through the V0 seam: translateProject must not mutate the project, and the attributes
// must still be present afterward (the seam intentionally does not forward them).
const before = JSON.stringify(attrProject);
const t = translateProject(attrProject);
const after = JSON.stringify(attrProject);
const seamNoMutate = before === after && !!attrProject.machineTypes.wood.clearanceZones && !!attrProject.machineTypes.welding.amenityLinks;
// And confirm the seam did NOT forward the E1 fields into the engine defs (proof of inertness path).
const woodDef = t.elementDefs.find(d => d.id === 'wood') || {};
const seamDropsE1 = !('hazards' in woodDef) && !('clearanceZones' in woodDef) && !('ventilation' in woodDef) &&
  !('amenityLinks' in woodDef) && !('occupancy' in woodDef) && !('utilities' in woodDef);
check('(c2) V0 seam does not mutate the project and drops E1 fields (no loss upstream, none forwarded)', seamNoMutate && seamDropsE1,
  `noMutate=${seamNoMutate} dropsE1=${seamDropsE1}`);

/* ── (d) clearance zones rotate with the machine (kickback cone at 0/90/180/270) ── */
const cone = library.machineTypes.tableSaw.clearanceZones.find(z => z.type === 'kickbackCone');
const machineAt = deg => ({ x: 20, y: 30, w: 6, h: 5, rotation: deg });
const paAngle = library.machineTypes.tableSaw.principalAxis.angle; // 0

// The machine-local cone geometry (independent of machine rotation).
const base = localGeometry(cone, paAngle);
const TOL = 1e-9;   // Math.cos(90°)=6.12e-17 etc.; trig rotation vs EXACT cardinal rotation.
let rotationOk = true;
const rotDetail = [];
for (const deg of [0, 90, 180, 270]) {
  const wr = worldGeometry(cone, machineAt(deg), paAngle);
  // "world geometry is the rotation of the local geometry": each world offset must equal
  // the EXACT cardinal rotation of the corresponding local-frame point.
  for (let i = 0; i < wr.offsets.length; i++) {
    const expected = exactCardinalRotate(base[i], deg);
    const got = wr.offsets[i];
    if (Math.abs(got.x - expected.x) > TOL || Math.abs(got.y - expected.y) > TOL) {
      rotationOk = false; rotDetail.push(`deg${deg}[${i}] got ${JSON.stringify(got)} exp ${JSON.stringify(expected)}`);
    }
  }
}
check('(d) kickback cone world geometry == exact rotation of local geometry at 0/90/180/270', rotationOk, rotDetail.slice(0, 4).join(' | '));

// Hand-verification: the cone apex+edges are the base points; at 90° each maps (x,y)->(-y,x).
// Concretely, a base-frame point (10,0) rotated 90° lands at exactly (0,10) [exact cardinal],
// and the trig rotation agrees to ~1e-15 (Math.cos(90°)=6.12e-17, Math.sin(90°)=1).
const handExact = exactCardinalRotate({ x: 10, y: 0 }, 90);          // (0, 10) exactly
const handTrig = rotate({ x: 10, y: 0 }, 90);                        // (6.12e-16, 10)
const handOk = handExact.x === 0 && handExact.y === 10 &&
  Math.abs(handTrig.x - 0) < TOL && Math.abs(handTrig.y - 10) < TOL;
check('(d) hand-verify: local (10,0) rotated 90° == (0,10) [exact], trig agrees to 1e-9', handOk,
  `exact=(${handExact.x},${handExact.y}) trig=(${handTrig.x},${handTrig.y})`);

/* ── (e) INERTNESS: E1 attributes change NO objective value (bit-for-bit) ────── */
// Populate EVERY E1 group on EVERY machineType of the frozen project, then compare.
const inertProject = JSON.parse(JSON.stringify(baseProject));
inertProject.schemaVersion = '2.1.0';
for (const k of Object.keys(inertProject.machineTypes)) {
  inertProject.machineTypes[k] = Object.assign({}, inertProject.machineTypes[k], {
    hazards: { dustProducing: true, sparkSource: true, hotWork: true, wetProcess: true, flammable: true, vibrationSource: true, vibrationSensitive: true },
    clearanceZones: library.machineTypes.tableSaw.clearanceZones,
    ventilation: { localExhaustRequired: true, cfm: 500, requiresExteriorWallOrDuct: true },
    power: { volts: 240, amps: 30, phase: 3 },
    utilities: { compressedAir: true, waterSupply: true, floorDrain: true },
    amenityLinks: library.machineTypes.weldingStation.amenityLinks,
    occupancy: { operatorCount: 3, personSpaceAreaUnits: 20, footprintsMayOverlap: true },
  });
}
const plain = evaluateBaseline(baseProject, { seed: SEED }).vec;
const withAttr = evaluateBaseline(inertProject, { seed: SEED }).vec;
const PIN = { ada: 0.13827363048035732, egress: 0.4275, noise: 0.40589569160997735 };
const inert = plain.ada === withAttr.ada && plain.egress === withAttr.egress && plain.noise === withAttr.noise;
const plainIsPin = plain.ada === PIN.ada && plain.egress === PIN.egress && plain.noise === PIN.noise;
check('(e) INERTNESS: E1 attributes change NO objective value (bit-for-bit)', inert && plainIsPin,
  `plain=${JSON.stringify(plain)} withAttr=${JSON.stringify(withAttr)}`);

/* ── report ──────────────────────────────────────────────────────────────── */
console.log('='.repeat(72));
console.log('v2 Phase E1 — ELEMENT ATTRIBUTE LAYER');
console.log('='.repeat(72));
for (const r of results) {
  console.log(`  [${r.pass ? 'PASS' : 'FAIL'}] ${r.name}`);
  if (r.detail && !r.pass) console.log(`         ${r.detail}`);
}

console.log('\n  Provenance tally (numeric values across ' + Object.keys(library.machineTypes).length + ' library machines):');
const total = tally.standard + tally.designAssumption + tally.uncited;
console.log('  ┌──────────────────────────────┬───────┬────────┐');
console.log('  │ provenance class             │ count │  share │');
console.log('  ├──────────────────────────────┼───────┼────────┤');
const row = (label, n) => `  │ ${label.padEnd(28)} │ ${String(n).padStart(5)} │ ${(total ? (100 * n / total).toFixed(1) : '0.0').padStart(5)}% │`;
console.log(row('standard-cited (OSHA/NFPA/…)', tally.standard));
console.log(row('design assumption', tally.designAssumption));
console.log(row('uncited (must be 0)', tally.uncited));
console.log('  ├──────────────────────────────┼───────┼────────┤');
console.log(row('total numeric values', total));
console.log('  └──────────────────────────────┴───────┴────────┘');

const pass = results.every(r => r.pass);
console.log('\n' + '='.repeat(72));
if (!inert || !plainIsPin) {
  console.log('STOP: INERTNESS PROOF FAILED — adding data changed an objective value.');
}
console.log('RESULT: ' + (pass ? 'ALL E1 CHECKS PASS' : 'FAILURES PRESENT'));
console.log('='.repeat(72));
process.exit(pass ? 0 : 1);
