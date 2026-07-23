/**
 * v2/project-to-engine.mjs  --  THE SEAM (translation half).
 *
 * Pure, environment-agnostic translation between a v2 project JSON
 * (schema/space-project.v2.json) and the input structures the UNMODIFIED
 * v1 engine expects. No Node built-ins, no DOM, no engine internals — this
 * file only translates data in and out. It is imported by:
 *   - v2/engine-adapter.mjs        (Node: runs the engine in a vm context)
 *   - v2/engine-adapter.browser.js (browser: applies to the live globals)
 *
 * Two exports:
 *   translateProject(project) -> engineInputs
 *       Reads the rich schema and extracts exactly the subset the current
 *       engine consumes: scale, the L/rect/polygon floor element, the ordered
 *       zone-definition list, per-zone position overrides, and the movable set.
 *       Forward-looking schema fields (per-machine footprint polygons, clearance
 *       zones, dust/spark/hot-work/wet flags, power, adjacency, rule modes) are
 *       intentionally NOT forwarded — the v1 engine does not read them yet.
 *       See V2_COUPLING.md for the backlog that will wire them in.
 *
 *   applyTranslated(state, ZONE_DEFS, engineInputs)
 *       Mutates the engine's own `state` object and `ZONE_DEFS` array into the
 *       exact setup the frozen v1 harness produces (tools/mosa_validate.mjs).
 *       This function is deliberately SELF-CONTAINED (references only its
 *       arguments and JS built-ins) so its .toString() can be injected into a
 *       Node vm — where `state`/`ZONE_DEFS` are lexically scoped constants —
 *       AND called directly against the browser's live globals. One code path,
 *       both environments.
 *
 * IMPORTANT (equivalence): applyTranslated mirrors the v1 harness setup
 * line-for-line, including the Phase 2c fix — the L-floor zone is RE-REGISTERED
 * in state.zones AFTER the tool-zone rebuild (the rebuild would otherwise drop
 * it, degenerating the analysis scope to the full bounding box).
 *
 * V1 (structural geometry forwarding): when a project carries structuralGeometry
 * (G1 walls/doors), translateProject materialises it into the SAME `blockers`
 * channel the Phase 2d notch uses — interior walls become cat:"wall" blockers and
 * exit-to-outside doors become cat:"exit" seeds — so the whole-stage engine grid
 * sees the full building natively. applyTranslated is UNCHANGED: the geometry
 * blockers flow through the existing Phase 2d blocker registration.
 *   PRECEDENCE: explicit room.structuralBlockers WIN. If a project carries both,
 *     geometry is NOT auto-materialised (prevents double-registering the same cells,
 *     which would double-count noise STC even if the walkable grid looked identical).
 *     The frozen MRDC uses only structuralBlockers, so its path is untouched.
 *   COMPOSITION: the whole building is forwarded (all zones' walls + all exit doors),
 *     not a single isolated zone — G3 owns per-zone isolation; whole-stage MOSA needs
 *     the full building. See v2/ZONE_TO_BLOCKER.md and SCHEMA.md.
 */

import { detectZones } from './zone-detection.mjs';

/* Default materialised-wall thickness (real units, ft). Matches the value A1's
 * active-users.mjs used, so the seam reproduces its grid bit-for-bit. */
const DEFAULT_WALL_THICKNESS_UNITS = 1.5;

/* ── structuralGeometry → engine blockers (walls + exit seeds), pure ──────────
 * Returns axis-aligned wall blockers for every wall SEGMENT and cat:"exit" seed
 * blockers for every exit-to-outside door. Rectilinear-only (G2 limitation):
 * diagonal walls are refused with a warning rather than silently approximated.
 * Door roles come from the door's authored `role`, or from G1 detection when a
 * door lacks one (Task 1a). */
function structuralGeometryToBlockers(sg, scaleIn, opts) {
  const tFt = (opts && opts.wallThicknessUnits) || DEFAULT_WALL_THICKNESS_UNITS;
  const wUnits = scaleIn.widthUnits, hUnits = scaleIn.heightUnits;
  const tx = tFt / wUnits * 100, ty = tFt / hUnits * 100;   // thickness in stage-%

  // Resolve door roles: authored wins; run G1 detection to fill any that are missing.
  const roleById = {};
  for (const d of (sg.doors || [])) if (d.role) roleById[d.id] = d.role;
  const warnings = [];
  const missingRole = (sg.doors || []).some(d => !d.role);
  if (missingRole && !sg.zones) {
    try {
      const det = detectZones(sg, scaleIn);
      for (const dr of (det.doors || [])) if (!roleById[dr.id]) roleById[dr.id] = dr.role;
    } catch (e) { warnings.push('zone detection failed while classifying doors: ' + e.message); }
  }

  const blockers = [];
  let wi = 0;
  for (const w of (sg.walls || [])) {
    const f = w.from, t = w.to;
    let rect = null;
    if (Math.abs(f.y - t.y) < 1e-6) rect = { x: Math.min(f.x, t.x), y: f.y - ty / 2, w: Math.abs(t.x - f.x), h: ty };
    else if (Math.abs(f.x - t.x) < 1e-6) rect = { x: f.x - tx / 2, y: Math.min(f.y, t.y), w: tx, h: Math.abs(t.y - f.y) };
    else { warnings.push('diagonal wall "' + (w.id || wi) + '" skipped (rectilinear-only, inherited G2 limitation)'); continue; }
    blockers.push({
      id: 'wallblk_' + (wi++), label: 'Wall ' + (w.id || wi),
      elementClass: 'structural', subtype: 'wall', cat: 'wall', blocksMovement: true,
      x: rect.x, y: rect.y, w: rect.w, h: rect.h,
    });
  }
  let di = 0;
  for (const d of (sg.doors || [])) {
    const role = roleById[d.id] || d.role;
    if (role !== 'exit-to-outside') continue;                 // interior-bridge doors are gaps (no seed)
    const x1 = Math.max(0, Math.min(d.from.x, d.to.x) - tx), x2 = Math.min(100, Math.max(d.from.x, d.to.x) + tx);
    const y1 = Math.max(0, Math.min(d.from.y, d.to.y) - ty), y2 = Math.min(100, Math.max(d.from.y, d.to.y) + ty);
    blockers.push({
      id: 'exitblk_' + (di++), label: 'Exit ' + (d.id || di),
      elementClass: 'structural', subtype: 'door', cat: 'exit', blocksMovement: false,
      x: x1, y: y1, w: x2 - x1, h: y2 - y1,
    });
  }
  return { blockers, warnings };
}

/* Engine-relevant fields on a machine/element definition. This is exactly the
 * key set of testcase/hub/default-elements.json elementDefs. Fields are copied
 * only when present, preserving presence/absence so, e.g., a zone with no
 * dba_active is treated as a non-emitter by sim_noise (identical to v1). */
export const ENGINE_DEF_FIELDS = [
  'label', 'short', 'risk', 'fixed', 'cat', 'beginner', 'w', 'h', 'dba_active',
  // Generic structural/behavioral fields the engine honours when present
  // (absent on the MRDC tool set, so no effect on the frozen pin):
  'elementClass', 'subtype', 'blocksMovement', 'schedule_prob', 'variableAttrs',
  'operatorFootprints', 'operatorFootprint', 'principalAxis',
];

/* ── Room outline → normalized stage-% polygon points ────────────────────────
 * The engine works in normalized stage coordinates (0..100 % of the stage box).
 * A structural floor element carries its outline as shapes[0].points in that
 * same 0..100 space (mapped 1:1 when the floor zone is the full stage). */
function roomPolygonPct(room) {
  if (room.shape === 'polygon') {
    if (!Array.isArray(room.polygonPct) || room.polygonPct.length < 3) {
      throw new Error('room.shape="polygon" requires room.polygonPct (>=3 points)');
    }
    return room.polygonPct.map(p => ({ x: p.x, y: p.y }));
  }
  if (room.shape === 'rectangle') {
    return [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
  }
  if (room.shape === 'preset') {
    // Preset L / T shapes parameterized by notch fractions in [0,100].
    // These serialize to the identical polygon form as an explicit polygon.
    const n = room.presetParams || {};
    if (room.preset === 'L') {
      // Rectangle with a notch removed from the SE corner.
      const nx = n.notchX != null ? n.notchX : 60; // notch left edge (%)
      const ny = n.notchY != null ? n.notchY : 55; // notch top edge (%)
      return [
        { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: ny },
        { x: nx, y: ny }, { x: nx, y: 100 }, { x: 0, y: 100 },
      ];
    }
    if (room.preset === 'T') {
      const sx = n.stemX0 != null ? n.stemX0 : 33; // stem left (%)
      const ex = n.stemX1 != null ? n.stemX1 : 67; // stem right (%)
      const by = n.barY != null ? n.barY : 45;     // bar bottom (%)
      return [
        { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: by },
        { x: ex, y: by }, { x: ex, y: 100 }, { x: sx, y: 100 },
        { x: sx, y: by }, { x: 0, y: by },
      ];
    }
    throw new Error('room.preset must be "L" or "T" when room.shape="preset"');
  }
  throw new Error('room.shape must be "rectangle" | "preset" | "polygon"');
}

/* ── Schema → engine inputs (pure) ─────────────────────────────────────────── */
export function translateProject(project, opts) {
  if (!project || typeof project !== 'object') throw new Error('project must be an object');
  const room = project.room || {};
  const scaleIn = room.scale || {};
  const stageIn = room.stage || {};

  // Stage pixel dimensions: prefer explicit stage.{widthPx,heightPx}; otherwise
  // derive from pxPerUnit * real dimensions (kept explicit for the frozen pin so
  // no float rounding sneaks in).
  const stageWidthPx = stageIn.widthPx != null
    ? stageIn.widthPx : scaleIn.pxPerUnit * scaleIn.widthUnits;
  const stageHeightPx = stageIn.heightPx != null
    ? stageIn.heightPx : scaleIn.pxPerUnit * scaleIn.heightUnits;

  const scale = {
    pxPerUnit:     scaleIn.pxPerUnit,
    unit:          scaleIn.unit,
    stageWidthPx,
    stageHeightPx,
  };

  // Structural floor element carrying the room outline polygon.
  const floorDef = {
    id:           room.floorId || 'floor',
    label:        room.floorLabel || 'Floor Boundary',
    elementClass: 'structural',
    subtype:      'floor',
    w: 100, h: 100,
    shapes: [{ type: 'polygon', points: roomPolygonPct(room) }],
  };

  // Machine-type library (shared attributes) + instances (ids + positions).
  const types = project.machineTypes || {};
  const machines = project.machines || [];

  const elementDefs = [];
  const configZones = {};
  for (const m of machines) {
    const type = types[m.type];
    if (!type) throw new Error(`machine "${m.id}" references unknown type "${m.type}"`);
    // Build the engine definition: id from the instance, engine fields from type.
    const def = { id: m.id };
    for (const k of ENGINE_DEF_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(type, k)) def[k] = type[k];
    }
    elementDefs.push(def);
    // Position overrides live on the instance (x/y required; w/h/rotation optional).
    const cfg = {};
    if (m.x !== undefined) cfg.x = m.x;
    if (m.y !== undefined) cfg.y = m.y;
    if (m.w !== undefined) cfg.w = m.w;
    if (m.h !== undefined) cfg.h = m.h;
    if (m.rotation !== undefined) cfg.rotation = m.rotation;
    configZones[m.id] = cfg;
  }

  // Phase 2d: additional structural blockers (e.g. the SE-notch wall). These are
  // structural elements beyond the floor that the objective grids treat as walls.
  // Each carries its own zone rectangle (x/y/w/h in stage %).
  const blockers = (Array.isArray(room.structuralBlockers) ? room.structuralBlockers : [])
    .map(b => ({
      id: b.id,
      label: b.label,
      elementClass: b.elementClass || 'structural',
      subtype: b.subtype,
      cat: b.cat,
      blocksMovement: b.blocksMovement,
      x: b.x, y: b.y, w: b.w, h: b.h,
      rotation: b.rotation !== undefined ? b.rotation : 0,
    }));

  // V1: forward structural geometry (walls + exit doors) into the SAME blocker
  // channel — but ONLY when explicit structuralBlockers are absent (precedence),
  // so a project carrying both cannot double-register the same cells. structuralGeometry
  // lives at the project top level (schema) — accept room.structuralGeometry too.
  const sg = project.structuralGeometry || room.structuralGeometry || null;
  let geometryWarnings = [];
  if (sg && Array.isArray(sg.walls) && sg.walls.length) {
    if (blockers.length > 0) {
      geometryWarnings.push('structuralBlockers present; structuralGeometry NOT auto-materialised (precedence: explicit blockers win). Merge into one representation if both regions are needed.');
    } else {
      const gen = structuralGeometryToBlockers(sg, scaleIn, opts);
      for (const b of gen.blockers) blockers.push(b);
      geometryWarnings = gen.warnings;
    }
  }

  const opt = project.optimization || {};
  return {
    scale,
    floorDef,
    blockers,
    elementDefs,
    configZones,
    movableIds: Array.isArray(opt.movableIds) ? opt.movableIds.slice() : [],
    weights: opt.objectiveWeights || null,
    meta: project.meta || null,
    geometryWarnings,
  };
}

/* ── Engine inputs → live engine state (SELF-CONTAINED; injectable) ──────────
 * Mirrors tools/mosa_validate.mjs state setup EXACTLY, including the Phase 2c
 * floor re-registration. Uses only its arguments + JS built-ins so it survives
 * Function.prototype.toString() injection into a vm context. */
export function applyTranslated(state, ZONE_DEFS, t) {
  // Scale
  state.scale = {
    pxPerUnit:     t.scale.pxPerUnit,
    unit:          t.scale.unit,
    stageWidthPx:  t.scale.stageWidthPx,
    stageHeightPx: t.scale.stageHeightPx,
  };

  // Structural floor (L-polygon) + any structural blockers (e.g. the SE-notch
  // wall) + analysis-scope defaults (whole floor room). The blocker defs are
  // appended so allZoneDefs()/the objective grids see them as walls.
  var _blockers = t.blockers || [];
  var _structural = [t.floorDef];
  for (var _b = 0; _b < _blockers.length; _b++) {
    _structural.push({
      id: _blockers[_b].id, label: _blockers[_b].label,
      elementClass: _blockers[_b].elementClass, subtype: _blockers[_b].subtype,
      cat: _blockers[_b].cat, blocksMovement: _blockers[_b].blocksMovement,
      w: _blockers[_b].w, h: _blockers[_b].h,
    });
  }
  state.customElements     = [];
  state.structuralElements = _structural;
  state.amenityElements    = [];
  state.activeUse          = false;
  state.analysisRooms      = null;

  // Rebuild ZONE_DEFS (tool/element definitions) in order.
  ZONE_DEFS.length = 0;
  for (var _i = 0; _i < t.elementDefs.length; _i++) {
    ZONE_DEFS.push(Object.assign({}, t.elementDefs[_i]));
  }

  // Rebuild state.zones from position overrides (type w/h as fallback).
  state.zones = {};
  for (var _j = 0; _j < ZONE_DEFS.length; _j++) {
    var def = ZONE_DEFS[_j];
    var cfg = t.configZones[def.id] || {};
    state.zones[def.id] = {
      x:        cfg.x        !== undefined ? cfg.x        : 50,
      y:        cfg.y        !== undefined ? cfg.y        : 50,
      w:        cfg.w        !== undefined ? cfg.w        : def.w,
      h:        cfg.h        !== undefined ? cfg.h        : def.h,
      rotation: cfg.rotation !== undefined ? cfg.rotation : 0,
      included:  true,
      activeUse: false,
      locked:    !!def.fixed,
    };
  }

  // Phase 2c fix: RE-REGISTER the floor room AFTER the rebuild above, or it is
  // dropped and getAnalysisRooms() degenerates to the full bounding box.
  state.zones[t.floorDef.id] = {
    x: 0, y: 0, w: 100, h: 100,
    included: true, activeUse: false, locked: false,
  };

  // Phase 2d: register each structural blocker's zone (its notch rectangle).
  for (var _bz = 0; _bz < _blockers.length; _bz++) {
    var _blk = _blockers[_bz];
    state.zones[_blk.id] = {
      x: _blk.x, y: _blk.y, w: _blk.w, h: _blk.h,
      rotation: _blk.rotation || 0,
      included: true, activeUse: false, locked: true,
    };
  }

  return state;
}

/* Browser convenience: expose on globalThis so a classic (non-module) script
 * can reach these after `<script type="module" src="v2/project-to-engine.mjs">`.
 * Harmless under Node/ESM. */
if (typeof globalThis !== 'undefined') {
  globalThis.SPACE_V2 = Object.assign(globalThis.SPACE_V2 || {}, {
    translateProject, applyTranslated, ENGINE_DEF_FIELDS,
  });
}
