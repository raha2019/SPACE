/**
 * v2/clearance.mjs  --  v2 Phase E1: clearance-zone geometry (rotation-aware).
 *
 * Pure geometry for the first-class directional clearance model in
 * v2/ELEMENT_ATTRIBUTES.md (d). NO objective consumes this yet — it is a tested
 * library for a later phase, and it must reproduce scoring.js's rotation convention
 * exactly so a clearance zone and its retained kickbackVector stay consistent.
 *
 * Rotation convention (identical to scoring.js _scRiskZoneCenters / _scVectorConflicts):
 *   worldOffset = ( x·cosθ − y·sinθ , x·sinθ + y·cosθ ),  θ in degrees, stage-y down.
 * A zone's total base-frame angle is principalAxis.angle + orientation.angleDeg; the
 * machine's own rotation then rotates the whole zone about the footprint CENTER.
 *
 * Distances/params are in REAL units (room.scale.unit). World placement mixes those
 * offsets with the machine's stage-% center only for a real objective (which will
 * convert via scale); the rotation proof below is unit-agnostic.
 */

const D2R = Math.PI / 180;

/** Rotate a point by `deg` about the origin (scoring.js convention; stage-y down). */
export function rotate(pt, deg) {
  const a = deg * D2R, c = Math.cos(a), s = Math.sin(a);
  return { x: pt.x * c - pt.y * s, y: pt.x * s + pt.y * c };
}

/** The zone's template as a polygon in its OWN direction frame (pointing +x). */
export function templatePolygon(zone) {
  const g = zone.geometry || {};
  if (g.kind === 'polygon') return (g.points || []).map(p => ({ x: p.x, y: p.y }));
  const p = g.params || {};
  if (g.template === 'cone') {
    const apex = { x: p.apexOffsetUnits || 0, y: 0 };
    const L = p.lengthUnits || 0, sp = (p.spreadDeg || 0) * D2R;
    return [
      apex,
      { x: apex.x + L * Math.cos(sp),  y: apex.y + L * Math.sin(sp) },
      { x: apex.x + L * Math.cos(-sp), y: apex.y + L * Math.sin(-sp) },
    ];
  }
  if (g.template === 'rect') {
    const off = p.offsetUnits || 0, al = p.alongUnits || 0, ac = p.acrossUnits || 0;
    return [
      { x: off,      y: -ac / 2 },
      { x: off + al, y: -ac / 2 },
      { x: off + al, y:  ac / 2 },
      { x: off,      y:  ac / 2 },
    ];
  }
  return [];
}

/** Machine-BASE-frame geometry: template rotated by principalAxis + orientation
 *  (i.e. the geometry before the machine's own rotation is applied). */
export function localGeometry(zone, principalAxisAngle = 0) {
  const zoneAngle = (principalAxisAngle || 0) + ((zone.orientation && zone.orientation.angleDeg) || 0);
  return templatePolygon(zone).map(pt => rotate(pt, zoneAngle));
}

/** World geometry: base-frame geometry rotated by machine.rotation about the
 *  footprint center, then translated to that center (stage-% center + unit offsets).
 *  Returns { center, offsets, points }: `offsets[i]` is the rotated offset from the
 *  center (no center round-trip, so it is the exact rotation of the base geometry),
 *  `points[i]` = center + offsets[i]. */
export function worldGeometry(zone, machine, principalAxisAngle = 0) {
  const cx = machine.x + (machine.w || 0) / 2;
  const cy = machine.y + (machine.h || 0) / 2;
  const rot = machine.rotation || 0;
  const base = localGeometry(zone, principalAxisAngle);
  const offsets = base.map(pt => rotate(pt, rot));
  const points = offsets.map(o => ({ x: cx + o.x, y: cy + o.y }));
  return { center: { x: cx, y: cy }, offsets, points };
}

/** Exact rotation for cardinal angles (0/90/180/270) using integer cos/sin {0,±1},
 *  independent of Math.cos/sin — the reference the rotation test checks against. */
export function exactCardinalRotate(pt, deg) {
  const d = ((deg % 360) + 360) % 360;
  switch (d) {
    case 0:   return { x: pt.x,  y: pt.y };
    case 90:  return { x: -pt.y, y: pt.x };   // cos90=0, sin90=1: (x·0−y·1, x·1+y·0)
    case 180: return { x: -pt.x, y: -pt.y };
    case 270: return { x: pt.y,  y: -pt.x };
    default: throw new Error('exactCardinalRotate: not a cardinal angle: ' + deg);
  }
}

export default { rotate, templatePolygon, localGeometry, worldGeometry, exactCardinalRotate };
