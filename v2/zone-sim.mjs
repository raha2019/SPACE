/**
 * v2/zone-sim.mjs  --  v2 Phase G3: per-zone simulation.
 *
 * Completes the geometry chain: V0 seam -> G1 zone-detection -> G2 blocker
 * translator -> G3 per-zone evaluation. For each detected zone, isolate it with
 * G2's region-as-wall blockers, assemble the project through the V0 seam, call the
 * UNMODIFIED evaluateLayout, and collect that zone's {ada, egress, noise} + area +
 * occupant load. Then aggregate to one building-level vector for MOSA.
 *
 * SEMANTICS are defined (and justified) in v2/ZONE_SIM_SEMANTICS.md. Summary:
 *   (a) ADA denominator  = Z's walkable cells (complement walled -> excluded).
 *   (b) Egress           = travel to the nearest egress door ON Z's boundary
 *                          (exit-to-outside OR interior-bridge) — "local egress".
 *   (c) Noise            = action cells within Z over the FULL-grid denominator,
 *                          complement filled with noise walls (cross-zone sources
 *                          over-attenuated — documented limitation).
 *   (d) Occupant load    = ceil(area_sf(Z) / 50).
 *   (e) Building result  = per-zone vectors + area-weighted-mean aggregate
 *                          (worst-zone provided as an alternative).
 *
 * ENGINE UNTOUCHED. Each zone is a fresh V0-seam vm run, so state cannot leak.
 *
 * Public API:
 *   evaluateZone(zone, project, opts?)          -> per-zone result
 *   evaluateProjectPerZone(project, opts?)      -> { zones:[...], aggregate, aggregateWorst, flags }
 */

import { detectZones, pointInRing, ringAreaUnits } from './zone-detection.mjs';
import { zoneToBlockers } from './zone-to-blocker.mjs';
import { evaluateBaseline } from './engine-adapter.mjs';

const OCCUPANT_LOAD_FACTOR = 50;    // NFPA_OCCUPANT_LOAD_FACTOR_MAKERSPACE (sim_egress.js:21)
const NOISE_WALL_STC = 35;          // sim_noise.js:51

/** Centre of a machine instance (stage-%), using its type w/h when not overridden. */
function machineCenter(m, types) {
  const t = (types && types[m.type]) || {};
  const w = m.w != null ? m.w : t.w, h = m.h != null ? m.h : t.h;
  const x = m.x != null ? m.x : 50, y = m.y != null ? m.y : 50;
  return { x: x + (w || 0) / 2, y: y + (h || 0) / 2, cat: t.cat };
}

/** Build a cat:"exit" egress-seed element at a door opening (pure egress seed,
 *  NOT a noise wall/door: cat "exit" + no subtype -> sim_noise ignores it). */
function exitSeedFromDoor(door, id, stage, thick = 1.0) {
  const x0 = Math.max(stage.x0, Math.min(door.from.x, door.to.x) - thick);
  const x1 = Math.min(stage.x1, Math.max(door.from.x, door.to.x) + thick);
  const y0 = Math.max(stage.y0, Math.min(door.from.y, door.to.y) - thick);
  const y1 = Math.min(stage.y1, Math.max(door.from.y, door.to.y) + thick);
  return {
    id, label: 'Egress seed (zone-sim)',
    elementClass: 'structural', cat: 'exit', blocksMovement: false,
    x: x0, y: y0, w: x1 - x0, h: y1 - y0,
  };
}

/**
 * evaluateZone — evaluate ONE zone in isolation through the unmodified engine.
 *
 * zone : { id?, polygonPct, boundaryDoors?: [ { id, from, to, role } ] }
 * project : the v2 project (machines, machineTypes, room.scale, optimization.seed)
 * opts : { seed, stage }
 *
 * Returns { zoneId, vec:{ada,egress,noise}, areaUnits, occupantLoad, reachable,
 *           egressSources, exact, warnings, note }.
 */
export function evaluateZone(zone, project, opts = {}) {
  const stage = Object.assign({ x0: 0, y0: 0, x1: 100, y1: 100 }, opts.stage || {});
  const seed = opts.seed != null ? opts.seed
    : (project.optimization && project.optimization.seed);
  const scale = project.room.scale;
  const types = project.machineTypes || {};
  const polygon = zone.polygonPct;

  // (G2) complement blockers that isolate this zone.
  const gen = zoneToBlockers({ polygonPct: polygon }, { stage, stc: NOISE_WALL_STC });
  if (!gen.exact) {
    return {
      zoneId: zone.id || 'zone', vec: null, areaUnits: ringAreaUnits(polygon, scale),
      occupantLoad: null, reachable: false, exact: false, warnings: gen.warnings,
      note: 'non-rectilinear zone — cannot isolate exactly (G2 limitation); skipped',
    };
  }

  // Egress seeds: cat:"exit" element per boundary door (exit-to-outside OR
  // interior-bridge, per semantic (b)). Machine exits (cat:"exit" inside Z) are
  // already in the project and seed the BFS on their own.
  const boundaryDoors = (zone.boundaryDoors || []).filter(d => d.from && d.to);
  const exitSeeds = boundaryDoors.map((d, i) => exitSeedFromDoor(d, `zs_exit_${i}`, stage));

  // Reachability: any boundary egress door, OR any cat:"exit" machine inside Z.
  const machineExitsInside = (project.machines || [])
    .map(m => machineCenter(m, types))
    .filter(c => c.cat === 'exit' && pointInRing({ x: c.x, y: c.y }, polygon)).length;
  const reachable = (boundaryDoors.length + machineExitsInside) > 0;

  // Per-zone project: floor = Z (occupant load + scope), complement blockers +
  // exit seeds, ALL machines kept (noise sources from other zones, attenuated).
  const perZ = JSON.parse(JSON.stringify(project));
  perZ.room.polygonPct = polygon.map(p => ({ x: p.x, y: p.y }));
  perZ.room.shape = 'polygon';
  perZ.room.structuralBlockers = gen.blockers.concat(exitSeeds);

  const out = evaluateBaseline(perZ, { seed });
  const vec = out.vec;
  const areaUnits = ringAreaUnits(polygon, scale);
  const occupantLoad = Math.ceil(areaUnits / OCCUPANT_LOAD_FACTOR);

  let note = '';
  if (!reachable) {
    note = 'NO egress door/exit inside this zone -> unreachable. Raw engine egress (~0.5: ' +
      'travelNorm=0 empty BFS + capNorm=1 zero exit capacity) is an artifact, not a real egress. ' +
      'Excluded from the building aggregate.';
  }

  return {
    zoneId: zone.id || 'zone', vec, areaUnits, occupantLoad, reachable,
    egressSources: { boundaryDoors: boundaryDoors.length, machineExitsInside },
    exact: true, warnings: gen.warnings, note,
  };
}

/**
 * evaluateProjectPerZone — evaluate every zone and aggregate.
 *
 * Zones come from (in priority order):
 *   opts.detection = { result, geometry }  (a G1 detectZones result + its input geometry), OR
 *   project.structuralGeometry             (detected internally), OR
 *   project.room.polygonPct                (single zone = the room outline; MRDC anchor).
 *
 * Returns { zones:[perZoneResult…], aggregate, aggregateWorst, flags:{…} }.
 * Aggregate = area-weighted mean over REACHABLE zones (semantic (e)).
 */
export function evaluateProjectPerZone(project, opts = {}) {
  const stage = Object.assign({ x0: 0, y0: 0, x1: 100, y1: 100 }, opts.stage || {});
  const seed = opts.seed != null ? opts.seed
    : (project.optimization && project.optimization.seed);

  // Resolve the zone list + per-zone boundary doors.
  let zones = [];
  if (opts.detection && opts.detection.result) {
    const { result, geometry } = opts.detection;
    const doorGeom = new Map();
    for (const d of ((geometry && geometry.doors) || [])) doorGeom.set(d.id, d);
    zones = result.zones.map(z => ({
      id: z.id,
      polygonPct: z.polygonPct,
      boundaryDoors: (z.doors || []).map(did => {
        const g = doorGeom.get(did);
        const rec = (result.doors || []).find(r => r.id === did);
        return g ? { id: did, from: g.from, to: g.to, role: rec ? rec.role : null } : null;
      }).filter(Boolean),
    }));
  } else if (project.structuralGeometry && Array.isArray(project.structuralGeometry.walls)) {
    const geometry = project.structuralGeometry;
    const result = detectZones(geometry, project.room.scale);
    return evaluateProjectPerZone(project, { ...opts, detection: { result, geometry } });
  } else {
    // Single zone = the room outline (the MRDC regression anchor path).
    zones = [{ id: 'zone0', polygonPct: project.room.polygonPct, boundaryDoors: [] }];
  }

  const perZone = zones.map(z => evaluateZone(z, project, { seed, stage }));

  // Aggregate over reachable, exact zones (area-weighted mean).
  const usable = perZone.filter(z => z.reachable && z.vec);
  const aggregate = weightedMean(usable);
  const aggregateWorst = worst(usable);

  return {
    zones: perZone,
    aggregate,
    aggregateWorst,
    flags: {
      totalZones: perZone.length,
      reachableZones: usable.length,
      unreachableZones: perZone.filter(z => !z.reachable).length,
      nonRectilinearZones: perZone.filter(z => z.exact === false).length,
      aggregationRule: 'area-weighted mean over reachable zones',
    },
  };
}

function weightedMean(zoneResults) {
  if (!zoneResults.length) return null;
  // A single zone's aggregate IS its vector, by definition — return it directly so
  // the aggregate reduces EXACTLY (bit-for-bit) to the one-zone vector (the frozen
  // regression anchor). The multiply-then-divide below would otherwise introduce a
  // 1-ULP rounding error (e.g. 0.4275 -> 0.42750000000000005).
  if (zoneResults.length === 1) {
    const v = zoneResults[0].vec;
    return { ada: v.ada, egress: v.egress, noise: v.noise };
  }
  let W = 0, ada = 0, egress = 0, noise = 0;
  for (const z of zoneResults) {
    const w = z.areaUnits > 0 ? z.areaUnits : 1;
    W += w; ada += z.vec.ada * w; egress += z.vec.egress * w; noise += z.vec.noise * w;
  }
  return { ada: ada / W, egress: egress / W, noise: noise / W };
}

function worst(zoneResults) {
  if (!zoneResults.length) return null;
  return {
    ada: Math.max(...zoneResults.map(z => z.vec.ada)),
    egress: Math.max(...zoneResults.map(z => z.vec.egress)),
    noise: Math.max(...zoneResults.map(z => z.vec.noise)),
  };
}

export default { evaluateZone, evaluateProjectPerZone };
