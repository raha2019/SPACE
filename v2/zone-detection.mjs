/**
 * v2/zone-detection.mjs  --  v2 Phase G1: structural geometry -> zones.
 *
 * GEOMETRY ONLY. Pure, testable, no UI, no engine, no simulation. Given a set of
 * wall segments and door segments (doors are walls that carry walkThrough=true),
 * compute the enclosed zones by finding the closed loops (faces) of the wall graph.
 *
 * The room model (Phase G1):
 *   - a WALL is a segment between two endpoints (stage-% coordinates);
 *   - a DOOR is a permeable wall segment (walkThrough) that still bounds a zone
 *     for area purposes but is flagged as an opening;
 *   - a ZONE is a region enclosed by a closed loop of wall/door segments;
 *   - a FLOOR is the region bounded by a zone's closed loop (1:1 with a zone here).
 * Walls, doors, floors and zones are LINKED BY REFERENCE (ids), not free-floating.
 *
 * Coordinate convention (matches the rest of v2): stage percent 0..100. Real-unit
 * areas are derived via the project scale (widthUnits x heightUnits), which may be
 * anisotropic, so vertices are converted to real units BEFORE the shoelace.
 *
 * Public API:
 *   detectZones(geometry, scale, opts?) -> DetectionResult
 *   validateGeometry(result) -> { flags: [...] }   (also embedded in detectZones)
 *   applyCorrections(result, corrections, scale) -> DetectionResult   (merge/split/not-a-room)
 *   polygonToWalls(polygonPct, opts?) -> { walls, doors }   (derive walls from a room outline)
 *   formatReport(result) -> string
 *
 * DetectionResult = {
 *   nodes, edges,                       // the snapped planar graph
 *   zones: [ { id, boundary:[segId], doors:[doorId], polygonPct, areaUnits, isRoom } ],
 *   floors: [ { id, zoneId, loop:[segId] } ],
 *   doors:  [ { id, role, connectsZones:[zoneId], onWall } ],   // classified
 *   flags:  [ { level, code, message, ... } ],
 *   degenerate: { openContour, crossings, unattachedDoors, nested },
 *   outerFace,                          // the unbounded face's boundary (for reference)
 * }
 */

const DEFAULT_SNAP_TOL = 0.05;     // stage-% distance under which endpoints are one node
const GEO_EPS = 1e-9;

/* ─── small geometry helpers (all in stage-% unless noted) ─────────────────── */

function dist2(a, b) { const dx = a.x - b.x, dy = a.y - b.y; return dx * dx + dy * dy; }
function almostEq(a, b, tol) { return Math.abs(a - b) <= tol; }

/** Shoelace area of a ring (array of {x,y}) in the SAME units the points are in. Signed. */
function shoelaceSigned(ring) {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

/** Convert a stage-% ring to real units using an (anisotropic) scale, then shoelace |area|. */
function ringAreaUnits(ringPct, scale) {
  const ux = (scale && scale.widthUnits ? scale.widthUnits : 100) / 100;
  const uy = (scale && scale.heightUnits ? scale.heightUnits : 100) / 100;
  const ringU = ringPct.map(p => ({ x: p.x * ux, y: p.y * uy }));
  return Math.abs(shoelaceSigned(ringU));
}

/** Even-odd point-in-polygon test (ring in stage-%). Boundary points may read either way. */
function pointInRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].x, yi = ring[i].y, xj = ring[j].x, yj = ring[j].y;
    const hit = ((yi > pt.y) !== (yj > pt.y)) &&
                (pt.x < ((xj - xi) * (pt.y - yi)) / ((yj - yi) || GEO_EPS) + xi);
    if (hit) inside = !inside;
  }
  return inside;
}

/** Distance from point p to segment a-b (stage-%). */
function pointSegDist(p, a, b) {
  const vx = b.x - a.x, vy = b.y - a.y;
  const wx = p.x - a.x, wy = p.y - a.y;
  const len2 = vx * vx + vy * vy;
  let t = len2 > 0 ? (wx * vx + wy * vy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = a.x + t * vx, cy = a.y + t * vy;
  return Math.hypot(p.x - cx, p.y - cy);
}

function orient(a, b, c) { return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x); }
function onSeg(a, b, c) { // c collinear with a-b, is it within the segment box?
  return Math.min(a.x, b.x) - GEO_EPS <= c.x && c.x <= Math.max(a.x, b.x) + GEO_EPS &&
         Math.min(a.y, b.y) - GEO_EPS <= c.y && c.y <= Math.max(a.y, b.y) + GEO_EPS;
}
/** Proper segment intersection that is NOT merely a shared endpoint. Returns the point or null. */
function segInteriorIntersection(a, b, c, d, tol) {
  // Ignore intersections that occur at shared endpoints (those are legal junctions).
  const shared = (p, q) => dist2(p, q) <= tol * tol;
  const endpointsShared =
    shared(a, c) || shared(a, d) || shared(b, c) || shared(b, d);
  const o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
  if (((o1 > GEO_EPS) !== (o2 > GEO_EPS)) && ((o3 > GEO_EPS) !== (o4 > GEO_EPS))) {
    if (endpointsShared) return null;              // legal crossing at a shared node
    // compute intersection point
    const denom = (a.x - b.x) * (c.y - d.y) - (a.y - b.y) * (c.x - d.x);
    if (Math.abs(denom) < GEO_EPS) return null;
    const t = ((a.x - c.x) * (c.y - d.y) - (a.y - c.y) * (c.x - d.x)) / denom;
    return { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
  }
  // Collinear overlap or T-junction (endpoint of one lies on interior of the other).
  const tHit = (p, s, e) => Math.abs(orient(s, e, p)) < 1e-6 && onSeg(s, e, p) &&
                            !shared(p, s) && !shared(p, e);
  if (tHit(c, a, b)) return { x: c.x, y: c.y };
  if (tHit(d, a, b)) return { x: d.x, y: d.y };
  if (tHit(a, c, d)) return { x: a.x, y: a.y };
  if (tHit(b, c, d)) return { x: b.x, y: b.y };
  return null;
}

/* ─── graph construction (snap endpoints into shared nodes) ────────────────── */

function buildGraph(segments, snapTol) {
  const nodes = [];   // { id, x, y }
  const findOrAddNode = (p) => {
    for (const n of nodes) if (dist2(n, p) <= snapTol * snapTol) return n.id;
    const id = nodes.length;
    nodes.push({ id, x: p.x, y: p.y });
    return id;
  };
  const edges = [];   // { id, segId, isDoor, u, v }  (u,v node ids)
  for (const s of segments) {
    const u = findOrAddNode(s.from);
    const v = findOrAddNode(s.to);
    if (u === v) continue;                      // zero-length after snapping
    edges.push({ id: edges.length, segId: s.id, isDoor: !!s.isDoor, u, v, seg: s });
  }
  return { nodes, edges };
}

/* ─── planar face traversal (half-edge / DCEL) ─────────────────────────────── */

function angleAt(nodes, from, to) {
  return Math.atan2(nodes[to].y - nodes[from].y, nodes[to].x - nodes[from].x);
}

function traceFaces(graph) {
  const { nodes, edges } = graph;
  // Directed half-edges: 2 per undirected edge.
  const H = [];
  for (const e of edges) {
    H.push({ key: e.id * 2,     from: e.u, to: e.v, edge: e });
    H.push({ key: e.id * 2 + 1, from: e.v, to: e.u, edge: e });
  }
  for (const h of H) h.angle = angleAt(nodes, h.from, h.to);
  const twin = (h) => H[h.key % 2 === 0 ? h.key + 1 : h.key - 1];

  // Outgoing half-edges per node, sorted ascending by angle.
  const outByNode = nodes.map(() => []);
  for (const h of H) outByNode[h.from].push(h);
  for (const list of outByNode) list.sort((p, q) => p.angle - q.angle);

  // next(h): arrive at h.to via h; leave along the CLOCKWISE neighbour of twin(h)
  // among h.to's outgoing edges. Clockwise = the previous edge in ascending-angle
  // order (wrapping). This traces each face consistently.
  const nextOf = (h) => {
    const t = twin(h);                    // outgoing edge from h.to back to h.from
    const outs = outByNode[h.to];
    const idx = outs.indexOf(t);
    const nIdx = (idx - 1 + outs.length) % outs.length;
    return outs[nIdx];
  };

  const visited = new Set();
  const faces = [];
  for (const start of H) {
    if (visited.has(start.key)) continue;
    const loop = [];
    let h = start;
    let guard = 0;
    while (!visited.has(h.key)) {
      visited.add(h.key);
      loop.push(h);
      h = nextOf(h);
      if (++guard > H.length + 5) break;     // safety
    }
    faces.push(loop);
  }
  return { faces, twin, outByNode, H };
}

/* ─── zone extraction ──────────────────────────────────────────────────────── */

function faceRing(face, nodes) {
  return face.map(h => ({ x: nodes[h.from].x, y: nodes[h.from].y }));
}

/**
 * detectZones — main entry.
 * geometry = { walls:[{id,from,to,...}], doors:[{id,from,to,wall?,...}] }
 * scale    = { widthUnits, heightUnits, unit }
 * opts     = { snapTol }
 */
export function detectZones(geometry, scale, opts = {}) {
  const snapTol = opts.snapTol != null ? opts.snapTol : DEFAULT_SNAP_TOL;
  const walls = (geometry && geometry.walls) || [];
  const doors = (geometry && geometry.doors) || [];

  // Segments = walls + doors (doors are permeable edges).
  const segments = [];
  for (const w of walls) segments.push({ id: w.id, from: w.from, to: w.to, isDoor: false, ref: w });
  for (const d of doors) segments.push({ id: d.id, from: d.from, to: d.to, isDoor: true, ref: d });

  const flags = [];
  const degenerate = { openContour: [], crossings: [], unattachedDoors: [], nested: [] };

  // Degenerate: doors not attached to any wall (endpoints not near any wall/other segment node).
  for (const d of doors) {
    if (d.wall != null) {
      const w = walls.find(w => w.id === d.wall);
      if (!w) { degenerate.unattachedDoors.push(d.id); flags.push({ level: 'error', code: 'door-unlinked', message: `door "${d.id}" references missing wall "${d.wall}"`, door: d.id }); continue; }
    }
    // geometric check: each door endpoint must coincide with some segment endpoint OR lie on a wall.
    const attachedEnd = (p) => segments.some(s => (dist2(s.from, p) <= snapTol * snapTol || dist2(s.to, p) <= snapTol * snapTol) && s.id !== d.id)
      || walls.some(w => pointSegDist(p, w.from, w.to) <= snapTol);
    if (!attachedEnd(d.from) || !attachedEnd(d.to)) {
      degenerate.unattachedDoors.push(d.id);
      flags.push({ level: 'error', code: 'door-floating', message: `door "${d.id}" is not attached to any wall/segment`, door: d.id });
    }
  }

  // Degenerate: wall/door crossings that are not shared endpoints (illegal, must be split).
  for (let i = 0; i < segments.length; i++) {
    for (let j = i + 1; j < segments.length; j++) {
      const p = segInteriorIntersection(segments[i].from, segments[i].to, segments[j].from, segments[j].to, snapTol);
      if (p) {
        degenerate.crossings.push({ a: segments[i].id, b: segments[j].id, at: { x: +p.x.toFixed(4), y: +p.y.toFixed(4) } });
        flags.push({ level: 'error', code: 'wall-crossing', message: `segments "${segments[i].id}" and "${segments[j].id}" cross at (${p.x.toFixed(2)}, ${p.y.toFixed(2)}) — split them at the intersection`, a: segments[i].id, b: segments[j].id });
      }
    }
  }

  const graph = buildGraph(segments, snapTol);

  // Degenerate: open contour — any node with degree 1 (a dangling wall end).
  const degree = graph.nodes.map(() => 0);
  for (const e of graph.edges) { degree[e.u]++; degree[e.v]++; }
  for (const n of graph.nodes) {
    if (degree[n.id] === 1) {
      degenerate.openContour.push({ at: { x: +n.x.toFixed(4), y: +n.y.toFixed(4) } });
      flags.push({ level: 'error', code: 'open-contour', message: `dangling wall end at (${n.x.toFixed(2)}, ${n.y.toFixed(2)}) — walls do not close into a loop`, at: { x: n.x, y: n.y } });
    }
  }

  const { faces, twin } = traceFaces(graph);

  // Connected components of the node graph (so each component gets its OWN outer
  // face; two disconnected rooms both count, and a hole is a nested component).
  const comp = graph.nodes.map(() => -1);
  {
    const adj = graph.nodes.map(() => []);
    for (const e of graph.edges) { adj[e.u].push(e.v); adj[e.v].push(e.u); }
    let c = 0;
    for (const n of graph.nodes) {
      if (comp[n.id] !== -1) continue;
      const stack = [n.id]; comp[n.id] = c;
      while (stack.length) { const x = stack.pop(); for (const y of adj[x]) if (comp[y] === -1) { comp[y] = c; stack.push(y); } }
      c++;
    }
  }

  // Signed area of each traced ring. Faces that walk a dangling stub go
  // there-and-back and have ~0 area — drop them.
  const faceInfo = faces.map((face, idx) => {
    const ring = faceRing(face, graph.nodes);
    const signed = shoelaceSigned(ring);
    return { idx, face, ring, signed, absArea: Math.abs(signed), comp: face.length ? comp[face[0].from] : -1 };
  }).filter(f => f.absArea > 1e-6);

  // Per component, the largest-|area| face is that component's OUTER boundary.
  const outerByComp = new Map();
  for (const f of faceInfo) {
    const cur = outerByComp.get(f.comp);
    if (!cur || f.absArea > cur.absArea) outerByComp.set(f.comp, f);
  }
  const outerIdxSet = new Set([...outerByComp.values()].map(f => f.idx));
  // For door-vs-outside classification, treat ALL component outer faces as "outside".
  const outerIdx = outerByComp.size ? [...outerByComp.values()].reduce((a, b) => a.absArea >= b.absArea ? a : b).idx : -1;
  const outerFace = faceInfo.find(f => f.idx === outerIdx) || null;
  const boundedFaces = faceInfo.filter(f => !outerIdxSet.has(f.idx));

  // Build zones from bounded faces.
  const zones = [];
  let zi = 0;
  for (const f of boundedFaces) {
    const segIds = [];
    const doorIds = [];
    for (const h of f.face) {
      segIds.push(h.edge.segId);
      if (h.edge.isDoor) doorIds.push(h.edge.segId);
    }
    // Deduplicate boundary seg ids preserving order.
    const boundary = segIds.filter((s, i) => segIds.indexOf(s) === i);
    const doorList = doorIds.filter((s, i) => doorIds.indexOf(s) === i);
    zones.push({
      id: 'zone' + (zi++),
      boundary,
      doors: doorList,
      polygonPct: f.ring.map(p => ({ x: p.x, y: p.y })),
      areaUnits: ringAreaUnits(f.ring, scale),
      isRoom: true,
      _face: f,
    });
  }

  // Nested / overlapping loops: a bounded zone whose centroid lies inside another zone.
  for (let a = 0; a < zones.length; a++) {
    for (let b = 0; b < zones.length; b++) {
      if (a === b) continue;
      const c = centroid(zones[a].polygonPct);
      if (pointInRing(c, zones[b].polygonPct)) {
        degenerate.nested.push({ inner: zones[a].id, outer: zones[b].id });
        flags.push({ level: 'warn', code: 'nested-loop', message: `zone "${zones[a].id}" is nested inside "${zones[b].id}" (hole or overlapping loop)`, inner: zones[a].id, outer: zones[b].id });
      }
    }
  }

  // Classify doors: a door borders two faces (its two half-edges). If both faces are
  // bounded zones -> interior-bridge; if one is the outer face -> exit-to-outside.
  const zoneByFaceIdx = new Map();
  for (const z of zones) zoneByFaceIdx.set(z._face.idx, z.id);
  const doorRecords = doors.map(d => {
    const bordering = [];
    for (const f of faceInfo) {
      if (f.face.some(h => h.edge.segId === d.id)) bordering.push(f.idx);
    }
    const touchesOuter = bordering.some(i => outerIdxSet.has(i));
    const zoneSides = bordering.filter(i => !outerIdxSet.has(i)).map(i => zoneByFaceIdx.get(i)).filter(Boolean);
    const uniqZones = zoneSides.filter((s, i) => zoneSides.indexOf(s) === i);
    let role;
    if (touchesOuter && uniqZones.length >= 1) role = 'exit-to-outside';
    else if (uniqZones.length >= 2) role = 'interior-bridge';
    else if (uniqZones.length === 1) role = 'interior-bridge-oneside'; // door into a zone but other side not a detected room
    else role = 'unresolved';
    return { id: d.id, role, connectsZones: uniqZones, onWall: d.wall != null ? d.wall : null, declaredRole: d.role || null };
  });

  // Link zones -> their doors (already have zone.doors as seg ids; attach role).
  for (const z of zones) {
    z.doors = z.doors.map(did => {
      const rec = doorRecords.find(r => r.id === did);
      return rec ? did : did;
    });
    delete z._face;   // strip internal reference from the public object
  }

  // Floors: 1:1 with zones (a floor is the region bounded by the zone loop).
  const floors = zones.map(z => ({ id: 'floor_' + z.id, zoneId: z.id, loop: z.boundary.slice() }));

  const result = {
    nodes: graph.nodes,
    edges: graph.edges.map(e => ({ id: e.id, segId: e.segId, isDoor: e.isDoor, u: e.u, v: e.v })),
    zones,
    floors,
    doors: doorRecords,
    flags,
    degenerate,
    outerFace: outerFace ? outerFace.ring.map(p => ({ x: p.x, y: p.y })) : null,
    scale,
    _geometry: geometry,
  };

  // Run the structural validation pass and merge its flags.
  const v = validateGeometry(result);
  result.flags = result.flags.concat(v.flags);
  return result;
}

function centroid(ring) {
  let x = 0, y = 0;
  for (const p of ring) { x += p.x; y += p.y; }
  return { x: x / ring.length, y: y / ring.length };
}

/* ─── validation pass (Task 3) ─────────────────────────────────────────────── */

export function validateGeometry(result) {
  const flags = [];
  const walls = (result._geometry && result._geometry.walls) || [];
  const doors = (result._geometry && result._geometry.doors) || [];

  // Zones with no door -> unreachable (later defaults to zero).
  for (const z of result.zones) {
    if (!z.doors || z.doors.length === 0) {
      flags.push({ level: 'warn', code: 'zone-no-door', message: `zone "${z.id}" has no door — unreachable; sims should default it to zero later`, zone: z.id });
    }
  }
  // Doors not linked to a wall (no wall ref and not lying on any wall).
  for (const d of doors) {
    const rec = result.doors.find(r => r.id === d.id);
    if (rec && rec.role === 'unresolved') {
      flags.push({ level: 'warn', code: 'door-unresolved', message: `door "${d.id}" does not bound any detected zone`, door: d.id });
    }
  }
  // Walls not part of any zone boundary.
  const usedSegs = new Set();
  for (const z of result.zones) for (const s of z.boundary) usedSegs.add(s);
  for (const w of walls) {
    if (!usedSegs.has(w.id)) {
      flags.push({ level: 'info', code: 'wall-unused', message: `wall "${w.id}" is not part of any zone boundary (interior stub or outer-only)`, wall: w.id });
    }
  }
  // Area outside all zones: correctly "not-computed". Report the note (not an error).
  flags.push({ level: 'info', code: 'outside-not-computed', message: `area outside all detected zones is intentionally not-computed (${result.zones.length} zone(s) detected)` });

  return { flags };
}

/* ─── correction interface (Task 2e) ───────────────────────────────────────── */

/**
 * applyCorrections — apply user overrides to a detection result and return a NEW result.
 * corrections: array of
 *   { op: 'merge', zones: [idA, idB], id?: newId }
 *   { op: 'split', zone: id, line: { from:{x,y}, to:{x,y} }, ids?: [idA, idB] }
 *   { op: 'not-a-room', zone: id }
 */
export function applyCorrections(result, corrections, scale) {
  scale = scale || result.scale;
  let zones = result.zones.map(z => ({ ...z, polygonPct: z.polygonPct.map(p => ({ ...p })), boundary: z.boundary.slice(), doors: z.doors.slice() }));
  const applied = [];

  for (const c of corrections || []) {
    if (c.op === 'not-a-room') {
      const z = zones.find(z => z.id === c.zone);
      if (!z) { applied.push({ op: c.op, ok: false, why: `zone ${c.zone} not found` }); continue; }
      z.isRoom = false;
      applied.push({ op: c.op, ok: true, zone: c.zone });
    } else if (c.op === 'merge') {
      const [a, b] = c.zones;
      const za = zones.find(z => z.id === a), zb = zones.find(z => z.id === b);
      if (!za || !zb) { applied.push({ op: c.op, ok: false, why: `missing zone(s) ${a}/${b}` }); continue; }
      const merged = mergeAdjacentPolygons(za.polygonPct, zb.polygonPct);
      if (!merged) { applied.push({ op: c.op, ok: false, why: `zones ${a} and ${b} do not share an edge` }); continue; }
      const newZone = {
        id: c.id || (a + '+' + b),
        boundary: unique(za.boundary.concat(zb.boundary)),
        doors: unique(za.doors.concat(zb.doors)),
        polygonPct: merged,
        areaUnits: ringAreaUnits(merged, scale),
        isRoom: true,
      };
      zones = zones.filter(z => z.id !== a && z.id !== b);
      zones.push(newZone);
      applied.push({ op: c.op, ok: true, zones: [a, b], result: newZone.id, areaUnits: newZone.areaUnits });
    } else if (c.op === 'split') {
      const z = zones.find(z => z.id === c.zone);
      if (!z) { applied.push({ op: c.op, ok: false, why: `zone ${c.zone} not found` }); continue; }
      const parts = splitPolygonByLine(z.polygonPct, c.line);
      if (!parts) { applied.push({ op: c.op, ok: false, why: `split line does not cross zone ${c.zone} as a clean chord` }); continue; }
      const ids = c.ids || [z.id + 'a', z.id + 'b'];
      const newZones = parts.map((poly, i) => ({
        id: ids[i], boundary: z.boundary.slice(), doors: [], polygonPct: poly,
        areaUnits: ringAreaUnits(poly, scale), isRoom: true, splitFrom: z.id,
      }));
      zones = zones.filter(zz => zz.id !== c.zone).concat(newZones);
      applied.push({ op: c.op, ok: true, zone: c.zone, result: ids, areas: newZones.map(z => z.areaUnits) });
    } else {
      applied.push({ op: c.op, ok: false, why: `unknown op` });
    }
  }

  return { ...result, zones, floors: zones.map(z => ({ id: 'floor_' + z.id, zoneId: z.id, loop: z.boundary.slice() })), corrections: applied };
}

function unique(arr) { return arr.filter((v, i) => arr.indexOf(v) === i); }

/** Union two simple polygons that share exactly one edge (or a contiguous chain). */
function mergeAdjacentPolygons(ringA, ringB, tol = DEFAULT_SNAP_TOL) {
  // Find a shared edge (a directed edge in A whose reverse is in B).
  const edgeKey = (p, q) => `${p.x.toFixed(3)},${p.y.toFixed(3)}|${q.x.toFixed(3)},${q.y.toFixed(3)}`;
  const near = (p, q) => dist2(p, q) <= tol * tol;
  for (let i = 0; i < ringA.length; i++) {
    const a1 = ringA[i], a2 = ringA[(i + 1) % ringA.length];
    for (let j = 0; j < ringB.length; j++) {
      const b1 = ringB[j], b2 = ringB[(j + 1) % ringB.length];
      if (near(a1, b2) && near(a2, b1)) {
        // Shared edge a1-a2 == reverse of b1-b2. Stitch: walk A up to a1, then B from b2's next around back to b1.
        const out = [];
        for (let k = 0; k <= i; k++) out.push(ringA[k % ringA.length]);        // ... up to a1 (index i)
        // insert B ring starting after b1 (=index j+... ) skipping the shared edge
        for (let k = 1; k < ringB.length; k++) out.push(ringB[(j + 1 + k) % ringB.length]);
        // continue A after a2
        for (let k = i + 2; k < ringA.length; k++) out.push(ringA[k % ringA.length]);
        return out;
      }
    }
  }
  return null;
}

/** Split a simple polygon by a line segment that crosses it as a chord (2 boundary hits). */
function splitPolygonByLine(ring, line) {
  // Find boundary edges the line crosses; expect exactly 2 crossing points.
  const hits = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const p = lineSegIntersection(line.from, line.to, a, b);
    if (p) hits.push({ edgeIndex: i, point: p, t: segParam(a, b, p) });
  }
  if (hits.length !== 2) return null;
  hits.sort((h1, h2) => h1.edgeIndex - h2.edgeIndex || h1.t - h2.t);
  const [h0, h1] = hits;
  // Ring 1: from h0 point, along ring to h1 point.
  const poly1 = [h0.point];
  for (let k = h0.edgeIndex + 1; k <= h1.edgeIndex; k++) poly1.push(ring[k % ring.length]);
  poly1.push(h1.point);
  // Ring 2: from h1 point, along ring wrapping to h0 point.
  const poly2 = [h1.point];
  for (let k = h1.edgeIndex + 1; k <= h0.edgeIndex + ring.length; k++) poly2.push(ring[k % ring.length]);
  poly2.push(h0.point);
  if (poly1.length < 3 || poly2.length < 3) return null;
  return [poly1, poly2];
}

function segParam(a, b, p) {
  const vx = b.x - a.x, vy = b.y - a.y, len2 = vx * vx + vy * vy;
  return len2 > 0 ? ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2 : 0;
}
/** Intersection of an infinite-ish line (p1-p2 extended) with segment a-b, if within a-b. */
function lineSegIntersection(p1, p2, a, b) {
  const r = { x: p2.x - p1.x, y: p2.y - p1.y };
  const s = { x: b.x - a.x, y: b.y - a.y };
  const denom = r.x * s.y - r.y * s.x;
  if (Math.abs(denom) < GEO_EPS) return null;
  const t = ((a.x - p1.x) * s.y - (a.y - p1.y) * s.x) / denom;   // along p1-p2 line (chord seg)
  const u = ((a.x - p1.x) * r.y - (a.y - p1.y) * r.x) / denom;   // along a-b
  if (u < -GEO_EPS || u > 1 + GEO_EPS) return null;
  if (t < -GEO_EPS || t > 1 + GEO_EPS) return null;               // chord within the given line seg
  return { x: a.x + u * s.x, y: a.y + u * s.y };
}

/* ─── derive a wall loop from a room outline polygon (Task 4b: MRDC) ────────── */

/**
 * polygonToWalls — turn a closed polygon (stage-% points) into a loop of wall
 * segments (and optionally mark some edges as doors). opts.doorEdges is a list of
 * { edgeIndex, from?, to?, id?, role? } to carve a door into an edge.
 */
export function polygonToWalls(polygonPct, opts = {}) {
  const prefix = opts.idPrefix || 'w';
  const walls = [];
  const doors = [];
  const n = polygonPct.length;
  const doorByEdge = new Map();
  for (const d of (opts.doorEdges || [])) doorByEdge.set(d.edgeIndex, d);

  for (let i = 0; i < n; i++) {
    const a = polygonPct[i], b = polygonPct[(i + 1) % n];
    const dd = doorByEdge.get(i);
    if (!dd) {
      walls.push({ id: `${prefix}${i}`, from: { x: a.x, y: a.y }, to: { x: b.x, y: b.y }, thickness: opts.thickness || 0.5, blocksMovement: true });
    } else {
      // Carve edge i into wall | door | wall using door's from/to fraction along the edge.
      const t0 = dd.t0 != null ? dd.t0 : 0.4;
      const t1 = dd.t1 != null ? dd.t1 : 0.6;
      const lerp = (t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      const p0 = lerp(t0), p1 = lerp(t1);
      walls.push({ id: `${prefix}${i}_a`, from: { x: a.x, y: a.y }, to: p0, thickness: opts.thickness || 0.5, blocksMovement: true });
      doors.push({ id: dd.id || `door${i}`, from: p0, to: p1, wall: `${prefix}${i}_a`, walkThrough: true, width: dd.width, role: dd.role || 'exit-to-outside' });
      walls.push({ id: `${prefix}${i}_b`, from: p1, to: { x: b.x, y: b.y }, thickness: opts.thickness || 0.5, blocksMovement: true });
    }
  }
  return { walls, doors };
}

/* ─── report formatter (Task 3) ────────────────────────────────────────────── */

export function formatReport(result, opts = {}) {
  const unit = (result.scale && result.scale.unit) || 'units';
  const lines = [];
  lines.push('ZONE DETECTION REPORT');
  lines.push('  nodes: ' + result.nodes.length + '  edges: ' + result.edges.length +
             '  zones: ' + result.zones.length + '  doors: ' + result.doors.length);
  lines.push('');
  lines.push('  ZONES:');
  for (const z of result.zones) {
    const doorRoles = (z.doors || []).map(did => {
      const r = result.doors.find(d => d.id === did);
      return did + (r ? '(' + r.role + ')' : '');
    });
    lines.push('    ' + z.id + (z.isRoom === false ? ' [not-a-room]' : '') +
      '  area=' + z.areaUnits.toFixed(2) + ' ' + unit + '^2' +
      '  boundary=[' + z.boundary.join(',') + ']' +
      '  doors=[' + doorRoles.join(',') + ']');
  }
  lines.push('');
  lines.push('  DOORS:');
  for (const d of result.doors) {
    lines.push('    ' + d.id + '  role=' + d.role + '  connects=[' + d.connectsZones.join(',') + ']' +
      (d.onWall ? '  onWall=' + d.onWall : ''));
  }
  const byLevel = { error: [], warn: [], info: [] };
  for (const f of result.flags) (byLevel[f.level] || byLevel.info).push(f);
  lines.push('');
  lines.push('  FLAGS:  ' + byLevel.error.length + ' error, ' + byLevel.warn.length + ' warn, ' + byLevel.info.length + ' info');
  for (const lvl of ['error', 'warn', 'info']) {
    for (const f of byLevel[lvl]) lines.push('    [' + lvl + '] ' + f.code + ': ' + f.message);
  }
  return lines.join('\n');
}

/* Exposed geometry helpers (useful for tests and consistency checks). */
export { pointInRing, ringAreaUnits };

export default { detectZones, validateGeometry, applyCorrections, polygonToWalls, formatReport, pointInRing, ringAreaUnits };
