"use strict";
/* ==================================================================
   WALL / FLOOR PLAN DRAWING EDITOR
   A calibration-style modal over the floor plan where the user clicks
   to draw wall polylines; a closed contour defines a floor space.
   Replaces the old shape-based "Walls / Floor Space / Doors" builder.

   Output: structural elements (custom:true, elementClass:"structural")
   whose footprint is a `polygon` shape. Each carries the attributes the
   analysis layer reads: blocksMovement, wallType, stc, removable, zoneTag.
   Drawn elements also store `rawDraw` so the editor can reload them.

   Coordinates: everything is in stage percent (0..100), matching how the
   floor-plan image fills the stage (background-size:cover) and how zones
   are positioned. The editor canvas uses the stage's aspect ratio so a
   click's % maps 1:1 onto the stage.
   ================================================================== */

// Line types and their analysis defaults. STC = sound transmission class
// (insertion loss) used by the noise sim once analysis is wired up.
const WALL_TYPES = {
  wall:         { label:"Wall",              subtype:"wall",         wallType:"normal", blocks:true,  stc:35, removable:false, color:"#dde1eb" },
  sound:        { label:"Sound wall",        subtype:"wall",         wallType:"sound",  blocks:true,  stc:52, removable:false, color:"#6db1ff" },
  false:        { label:"False wall",        subtype:"wall",         wallType:"false",  blocks:true,  stc:30, removable:true,  color:"#e8a83b" },
  construction: { label:"Construction line", subtype:"construction", wallType:null,     blocks:false, stc:0,  removable:false, color:"#9aa0b5" },
  door:         { label:"Door",              subtype:"door",         wallType:null,     blocks:false, stc:20, removable:false, color:"#d8aa5a" },
};

const WALL_THICKNESS_PCT = 0.8;   // drawn wall thickness, % of stage
const WALL_SNAP_PCT      = 2;     // grid snap increment when snapping is on
const WALL_CLOSE_PCT     = 3.5;   // click within this of the first node closes the room

const WALL_DOOR_SIZE_PCT = 7;     // default door swing box size (% of stage)

let wallDrawState = null;
// {
//   mode: "draw" | "select",         draw lines/doors vs. select & move
//   type: "wall",                    current line type (draw mode)
//   doorTemplate: null | "quarter",  active door template (draw mode)
//   nodes: [{x,y}],                  vertices of the in-progress chain
//   segments: [{a,b,type,label}],    committed wall/line segments
//   doors: [{template,x,y,w,h,rotation,label}],  placed door symbols
//   rooms: [{points:[{x,y}],label,zoneTag}],
//   sel: null | {kind,index,end},    current selection (select mode)
//   snap: true,
// }

function _wdBlank(){
  return { mode:"draw", type:"wall", doorTemplate:null,
           nodes:[], segments:[], doors:[], rooms:[], sel:null, snap:true,
           doorSize: WALL_DOOR_SIZE_PCT,
           genAuto:true, genWallColor:"#000000", genBgColor:"#ffffff",
           genMinLen: 1.2 };   // min wall length to keep, % of stage width
}

function _wdHexToRgb(hex){
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex||"").trim());
  if(!m) return { r:0, g:0, b:0 };
  const n = parseInt(m[1], 16);
  return { r:(n>>16)&255, g:(n>>8)&255, b:n&255 };
}

/* Door size shown in real units when a scale is set, else % of stage. */
function _wdSizeUnit(){ return (typeof hasScale === "function" && hasScale()) ? state.scale.unit : "%"; }
function _wdSizeDisp(pct){ return (typeof hasScale === "function" && hasScale()) ? +pctToUnits(pct, "x").toFixed(2) : +(+pct).toFixed(1); }
function _wdSizeToPct(v){
  const n = parseFloat(v);
  if(!Number.isFinite(n) || n <= 0) return null;
  return (typeof hasScale === "function" && hasScale()) ? unitsToPct(n, "x") : n;
}

/* Load persisted per-type colors into WALL_TYPES (so the legend + new
   instances reflect the user's choices across sessions). */
function _wdLoadColors(){
  const saved = state.wallTypeColors;
  if(saved && typeof saved === "object"){
    for(const k in WALL_TYPES){ if(saved[k]) WALL_TYPES[k].color = saved[k]; }
  }
}
function _wdSaveColors(){
  state.wallTypeColors = state.wallTypeColors || {};
  for(const k in WALL_TYPES) state.wallTypeColors[k] = WALL_TYPES[k].color;
  if(typeof saveAppState === "function") saveAppState();
}

/* ---- open / close ---- */
function openWallDraw(){
  wallDrawState = _wdBlank();
  _wdLoadColors();                  // apply persisted type colors
  _wdLoadExisting();                // reconstruct previously-drawn elements
  const img = document.getElementById("wdImage");
  const wrap = document.getElementById("wdCanvasWrap");
  const dims = (typeof stageDimsPx === "function") ? stageDimsPx() : { w:1600, h:994 };
  // Use the imported floor plan if present; otherwise a blank dark canvas
  // that keeps the stage aspect. The image is shown whole (object-fit:
  // contain) and the SVG overlay is positioned to match it exactly.
  const fp = state.imports && state.imports.floorPlan;
  if(img){
    if(fp && fp.dataUrl){
      img.style.display = "";
      if(wrap) wrap.style.aspectRatio = "";       // image drives the size
      img.onload = () => { syncWallOverlay(); drawWallOverlay(); };
      img.src = fp.dataUrl;
    } else {
      img.style.display = "none";
      img.removeAttribute("src");
      if(wrap) wrap.style.aspectRatio = `${dims.w} / ${dims.h}`;
    }
  }
  // close any open Element Builder first
  const ebBackdrop = document.getElementById("elementBuilderBackdrop");
  if(ebBackdrop) ebBackdrop.classList.remove("open");
  document.getElementById("wallDrawBackdrop").classList.add("open");
  // Seed the default door-size control in the active unit.
  const dsz = document.getElementById("wdDoorSize");
  if(dsz) dsz.value = _wdSizeDisp(wallDrawState.doorSize);
  const dszU = document.getElementById("wdDoorSizeUnit");
  if(dszU) dszU.textContent = _wdSizeUnit();
  // Seed generator color controls.
  const gwc = document.getElementById("wdGenWallColor"); if(gwc) gwc.value = wallDrawState.genWallColor;
  const gbc = document.getElementById("wdGenBgColor");   if(gbc) gbc.value = wallDrawState.genBgColor;
  const gau = document.getElementById("wdGenAuto");       if(gau) gau.checked = wallDrawState.genAuto;
  const gml = document.getElementById("wdGenMinLen");      if(gml) gml.value = _wdSizeDisp(wallDrawState.genMinLen);
  const gmu = document.getElementById("wdGenMinUnit");     if(gmu) gmu.textContent = _wdSizeUnit();
  _wdSetMode("draw");
  _wdSetType(wallDrawState.type);
  renderWallLegend();
  drawWallOverlay();
  renderWallList();
  _wdStatus();
  // Re-sync once the modal has actually laid out (the canvas size isn't
  // known until then, especially for the blank-canvas / aspect-ratio case).
  requestAnimationFrame(()=>{ syncWallOverlay(); drawWallOverlay(); });
}

function closeWallDraw(){
  const bd = document.getElementById("wallDrawBackdrop");
  if(bd) bd.classList.remove("open");
  wallDrawState = null;
}

/* Rebuild editor segments/rooms from structural elements that carry a
   rawDraw record (i.e. were made in this editor). */
function _wdLoadExisting(){
  for(const d of (state.structuralElements || [])){
    const rd = d.rawDraw;
    if(!rd) continue;
    if(rd.kind === "segment" && rd.points && rd.points.length === 2){
      wallDrawState.segments.push({
        a:{...rd.points[0]}, b:{...rd.points[1]},
        type: rd.type || "wall", label: d.label || "",
      });
    } else if(rd.kind === "room" && rd.points && rd.points.length >= 3){
      wallDrawState.rooms.push({
        points: rd.points.map(p=>({...p})),
        label: d.label || "", zoneTag: d.zoneTag || "",
      });
    } else if(rd.kind === "door"){
      wallDrawState.doors.push({
        template: rd.template || "quarter",
        x: rd.x, y: rd.y, w: rd.w, h: rd.h, rotation: rd.rotation || 0,
        label: d.label || "",
      });
    }
  }
}

/* ---- geometry helpers ---- */
function _wdClampPct(v){ return Math.max(0, Math.min(100, v)); }

function _wdSnap(p){
  if(!wallDrawState.snap) return p;
  const s = WALL_SNAP_PCT;
  return { x: Math.round(p.x / s) * s, y: Math.round(p.y / s) * s };
}

function _wdDist(a, b){ return Math.hypot(a.x - b.x, a.y - b.y); }

// 4 corners of a thick line a→b (percent space).
function _wdThickQuad(a, b, t){
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len * (t / 2), ny = dx / len * (t / 2);
  return [
    { x:a.x + nx, y:a.y + ny },
    { x:b.x + nx, y:b.y + ny },
    { x:b.x - nx, y:b.y - ny },
    { x:a.x - nx, y:a.y - ny },
  ];
}

function _wdBBox(points){
  let x1=Infinity, y1=Infinity, x2=-Infinity, y2=-Infinity;
  for(const p of points){ x1=Math.min(x1,p.x); y1=Math.min(y1,p.y); x2=Math.max(x2,p.x); y2=Math.max(y2,p.y); }
  return { x1, y1, x2, y2, w:x2-x1, h:y2-y1 };
}

// Normalize absolute-% points to local 0..100 of their bounding box.
function _wdLocalize(points, bb){
  const w = bb.w || 1, h = bb.h || 1;
  return points.map(p=>({ x:(p.x-bb.x1)/w*100, y:(p.y-bb.y1)/h*100 }));
}

// Shoelace area in %² (used for floor area display).
function _wdPolyArea(points){
  let a = 0;
  for(let i=0;i<points.length;i++){
    const p = points[i], q = points[(i+1)%points.length];
    a += p.x*q.y - q.x*p.y;
  }
  return Math.abs(a)/2;
}

/* ---- overlay positioning ---- */
// Size/position the SVG overlay to exactly cover the rendered image (which
// is letterboxed via object-fit:contain). With no image, cover the wrap.
function syncWallOverlay(){
  const img  = document.getElementById("wdImage");
  const wrap = document.getElementById("wdCanvasWrap");
  const svg  = document.getElementById("wdOverlay");
  if(!wrap || !svg) return;
  const wr = wrap.getBoundingClientRect();
  let box = wr;
  if(img && img.style.display !== "none"){
    const ir = img.getBoundingClientRect();
    if(ir.width > 0 && ir.height > 0) box = ir;
  }
  // Absolute offsets are measured from the wrap's PADDING box (inside the
  // border), so subtract the border widths or the overlay drifts right/down
  // by the border thickness.
  const cs = getComputedStyle(wrap);
  const bl = parseFloat(cs.borderLeftWidth) || 0;
  const bt = parseFloat(cs.borderTopWidth) || 0;
  svg.style.left   = (box.left - wr.left - bl) + "px";
  svg.style.top    = (box.top  - wr.top  - bt) + "px";
  svg.style.width  = box.width  + "px";
  svg.style.height = box.height + "px";
  svg.style.right  = "auto";
  svg.style.bottom = "auto";
}

function _wdMetrics(){
  return document.getElementById("wdOverlay").getBoundingClientRect();
}

/* ---- interaction ---- */
// Convert a pointer event to a stage-percent point on the overlay.
function _wdEventPct(e){
  const r = _wdMetrics();
  if(!r.width || !r.height) return null;
  return { x: _wdClampPct((e.clientX - r.left) / r.width * 100),
           y: _wdClampPct((e.clientY - r.top)  / r.height * 100) };
}

function wallDrawCanvasClick(e){
  if(!wallDrawState) return;
  if(wallDrawState.mode === "select") return;   // select uses pointer handlers
  if(_wdDragging) return;                        // ignore the click that ends a drag
  let p = _wdEventPct(e);
  if(!p) return;

  // Door placement mode: drop the active door template at the click.
  if(wallDrawState.doorTemplate){
    p = _wdSnapPoint(p);
    const w = wallDrawState.doorSize || WALL_DOOR_SIZE_PCT, h = w;
    wallDrawState.doors.push({ template: wallDrawState.doorTemplate, x:p.x, y:p.y, w, h, rotation:0, label:"" });
    drawWallOverlay(); renderWallList(); _wdStatus();
    return;
  }

  // Line drawing: close the room if clicking near the first node of a 3+ chain.
  if(wallDrawState.nodes.length >= 3 && _wdDist(p, wallDrawState.nodes[0]) <= WALL_CLOSE_PCT){
    _wdCloseRoom();
    return;
  }
  p = _wdSnapPoint(p);
  const nodes = wallDrawState.nodes;
  if(nodes.length > 0){
    wallDrawState.segments.push({
      a: { ...nodes[nodes.length - 1] }, b: { ...p },
      type: wallDrawState.type, label: "",
    });
  }
  nodes.push(p);
  drawWallOverlay();
  renderWallList();
  _wdStatus();
}

/* ---- select mode: hit-testing + drag ---- */
let _wdDragging = false;
let _wdDragInfo = null;

// Distance from point p to segment a-b (percent units).
function _wdPointSegDist(p, a, b){
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx*dx + dy*dy;
  let t = len2 ? ((p.x-a.x)*dx + (p.y-a.y)*dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t*dx), p.y - (a.y + t*dy));
}
function _wdPointInPoly(p, pts){
  let inside = false;
  for(let i=0, j=pts.length-1; i<pts.length; j=i++){
    const xi=pts[i].x, yi=pts[i].y, xj=pts[j].x, yj=pts[j].y;
    if(((yi>p.y)!==(yj>p.y)) && (p.x < (xj-xi)*(p.y-yi)/(yj-yi)+xi)) inside = !inside;
  }
  return inside;
}

// Nearest point on segment a→b to p.
function _wdProjectOnSeg(p, a, b){
  const dx=b.x-a.x, dy=b.y-a.y, len2=dx*dx+dy*dy;
  let t = len2 ? ((p.x-a.x)*dx + (p.y-a.y)*dy)/len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return { x:a.x+t*dx, y:a.y+t*dy };
}

const WALL_ENDPOINT_SNAP_PCT = 3;   // snap radius to existing endpoints
const WALL_LINE_SNAP_PCT     = 2;   // snap radius onto a line body
const WALL_JOINT_EPS         = 0.6; // endpoints this close are treated as joined

/* Snap a point: prefer an existing endpoint/vertex, then a nearby line body,
   then fall back to the grid. excludeSet holds "segIndex:end" keys to ignore
   (the geometry currently being dragged). Returns p unchanged if snap is off. */
function _wdSnapPoint(p, excludeSet){
  if(!wallDrawState.snap) return { x:p.x, y:p.y };
  // 1) nearest endpoint / room vertex
  let best=null, bestD=WALL_ENDPOINT_SNAP_PCT;
  const consider = (pt)=>{ const d=_wdDist(p,pt); if(d<bestD){ bestD=d; best=pt; } };
  wallDrawState.segments.forEach((s,i)=>{
    if(!excludeSet || !excludeSet.has(i+":a")) consider(s.a);
    if(!excludeSet || !excludeSet.has(i+":b")) consider(s.b);
  });
  for(const room of wallDrawState.rooms) for(const pt of room.points) consider(pt);
  if(best) return { x:best.x, y:best.y };
  // 2) nearest line body (projected)
  let proj=null, projD=WALL_LINE_SNAP_PCT;
  wallDrawState.segments.forEach((s,i)=>{
    if(excludeSet && (excludeSet.has(i+":a") || excludeSet.has(i+":b"))) return;
    const pr=_wdProjectOnSeg(p, s.a, s.b);
    const d=_wdDist(p, pr); if(d<projD){ projD=d; proj=pr; }
  });
  if(proj) return { x:proj.x, y:proj.y };
  // 3) grid
  const g=WALL_SNAP_PCT;
  return { x:Math.round(p.x/g)*g, y:Math.round(p.y/g)*g };
}

/* All segment endpoints coincident with `point` (so a dragged junction keeps
   connected segments attached). Returns [{segIndex,end,ox,oy}]. */
function _wdCollectJoints(point){
  const out=[];
  wallDrawState.segments.forEach((s,i)=>{
    if(_wdDist(point, s.a) <= WALL_JOINT_EPS) out.push({ segIndex:i, end:"a", ox:s.a.x, oy:s.a.y });
    if(_wdDist(point, s.b) <= WALL_JOINT_EPS) out.push({ segIndex:i, end:"b", ox:s.b.x, oy:s.b.y });
  });
  return out;
}

// Find what's under point p (priority: door > node > segment > room).
function _wdHitTest(p){
  const NODE_R = 2.5, SEG_R = 1.8;
  // door (by center proximity within its box)
  for(let i=wallDrawState.doors.length-1; i>=0; i--){
    const d = wallDrawState.doors[i];
    if(Math.abs(p.x-d.x) <= d.w/2+1 && Math.abs(p.y-d.y) <= d.h/2+1) return { kind:"door", index:i };
  }
  // segment endpoints
  for(let i=0;i<wallDrawState.segments.length;i++){
    const s = wallDrawState.segments[i];
    if(_wdDist(p, s.a) <= NODE_R) return { kind:"node", index:i, end:"a" };
    if(_wdDist(p, s.b) <= NODE_R) return { kind:"node", index:i, end:"b" };
  }
  // segment body
  for(let i=0;i<wallDrawState.segments.length;i++){
    const s = wallDrawState.segments[i];
    if(_wdPointSegDist(p, s.a, s.b) <= SEG_R) return { kind:"segment", index:i };
  }
  // room (inside polygon)
  for(let i=0;i<wallDrawState.rooms.length;i++){
    if(_wdPointInPoly(p, wallDrawState.rooms[i].points)) return { kind:"room", index:i };
  }
  return null;
}

function _wdSelectPointerDown(e){
  if(!wallDrawState) return;
  const mode = wallDrawState.mode;
  if(mode !== "select" && mode !== "connect") return;
  const p = _wdEventPct(e);
  if(!p) return;
  const hit = _wdHitTest(p);
  // Connect gesture: in Connect mode, or Ctrl/Cmd-click on a wall in Select mode.
  const connecting = (mode === "connect") || ((e.ctrlKey || e.metaKey) && hit);
  if(connecting){
    const segIdx = (hit && (hit.kind === "segment" || hit.kind === "node")) ? hit.index : null;
    if(segIdx != null){ _wdHandleConnect(segIdx); e.preventDefault(); return; }
    if(mode === "connect"){ wallDrawState.connectFirst = null; drawWallOverlay(); _wdStatus(); return; }
  }
  if(mode !== "select") return;   // connect-mode clicks handled above
  wallDrawState.sel = hit;
  if(hit){
    _wdDragging = true;
    _wdDragInfo = { start:p, hit, orig:_wdSnapshotSel(hit) };
    // Capture connected endpoints so chains stay joined while dragging.
    if(hit.kind === "node"){
      const s = wallDrawState.segments[hit.index];
      _wdDragInfo.joints = _wdCollectJoints(s[hit.end]);
    } else if(hit.kind === "segment"){
      const s = wallDrawState.segments[hit.index];
      const ja = _wdCollectJoints(s.a), jb = _wdCollectJoints(s.b);
      const seen = new Set();
      _wdDragInfo.joints = [...ja, ...jb].filter(j=>{
        const k = j.segIndex+":"+j.end; if(seen.has(k)) return false; seen.add(k); return true;
      });
    }
    const wrap = document.getElementById("wdCanvasWrap");
    try { wrap.setPointerCapture(e.pointerId); } catch(_){}
    e.preventDefault();
  }
  _wdSyncDeleteBtn();
  drawWallOverlay(); renderWallList(); _wdStatus();
}

/* ---- Connect two wall segments at their nearest ends ---- */
function _wdHandleConnect(idx){
  if(wallDrawState.connectFirst == null){
    wallDrawState.connectFirst = idx;
    drawWallOverlay(); renderWallList();
    _wdStatus("Connect: now click the second wall to join their nearest ends.");
    return;
  }
  if(wallDrawState.connectFirst === idx){
    wallDrawState.connectFirst = null;     // clicking the same one cancels
    drawWallOverlay(); renderWallList();
    _wdStatus("Connect: pick two walls to join their nearest ends.");
    return;
  }
  const ok = _wdJoinSegments(wallDrawState.connectFirst, idx);
  wallDrawState.connectFirst = null;
  drawWallOverlay(); renderWallList();
  _wdStatus(ok ? "Walls joined. Pick two more, or switch modes." : "Couldn't join those walls.");
}

// Intersection of the two infinite lines (p1→p2) and (p3→p4); null if parallel.
function _wdLineIntersect(p1, p2, p3, p4){
  const d = (p1.x-p2.x)*(p3.y-p4.y) - (p1.y-p2.y)*(p3.x-p4.x);
  if(Math.abs(d) < 1e-9) return null;
  const a = p1.x*p2.y - p1.y*p2.x;
  const b = p3.x*p4.y - p3.y*p4.x;
  return { x:(a*(p3.x-p4.x) - (p1.x-p2.x)*b)/d, y:(a*(p3.y-p4.y) - (p1.y-p2.y)*b)/d };
}

// Join segments i & j: move their nearest endpoints to a shared point — the
// intersection of their lines (a clean corner) if reasonable, else the
// midpoint of the two ends (collinear/parallel join).
function _wdJoinSegments(i, j){
  const A = wallDrawState.segments[i], B = wallDrawState.segments[j];
  if(!A || !B) return false;
  let best = null, bd = Infinity;
  for(const ea of ["a","b"]) for(const eb of ["a","b"]){
    const dd = _wdDist(A[ea], B[eb]);
    if(dd < bd){ bd = dd; best = [ea, eb]; }
  }
  const [ea, eb] = best;
  let target = null;
  const ix = _wdLineIntersect(A.a, A.b, B.a, B.b);
  if(ix){
    const MAX_EXT = 30;   // don't extend a wall absurdly far to meet
    if(_wdDist(ix, A[ea]) <= MAX_EXT && _wdDist(ix, B[eb]) <= MAX_EXT) target = ix;
  }
  if(!target) target = { x:(A[ea].x + B[eb].x)/2, y:(A[ea].y + B[eb].y)/2 };
  target = { x:_wdClampPct(target.x), y:_wdClampPct(target.y) };
  A[ea] = { ...target };
  B[eb] = { ...target };
  return true;
}

// Snapshot the geometry being dragged so move = orig + delta.
function _wdSnapshotSel(hit){
  if(hit.kind === "door"){ const d=wallDrawState.doors[hit.index]; return { x:d.x, y:d.y }; }
  if(hit.kind === "node"){ const s=wallDrawState.segments[hit.index]; return { x:s[hit.end].x, y:s[hit.end].y }; }
  if(hit.kind === "segment"){ const s=wallDrawState.segments[hit.index]; return { a:{...s.a}, b:{...s.b} }; }
  if(hit.kind === "room"){ return { points: wallDrawState.rooms[hit.index].points.map(p=>({...p})) }; }
  return null;
}

function _wdSelectPointerMove(e){
  if(!_wdDragging || !_wdDragInfo) return;
  const p = _wdEventPct(e);
  if(!p) return;
  let dx = p.x - _wdDragInfo.start.x, dy = p.y - _wdDragInfo.start.y;
  const { hit, orig, joints } = _wdDragInfo;

  if(hit.kind === "door"){
    const d = wallDrawState.doors[hit.index];
    const np = _wdSnapPoint({ x:orig.x+dx, y:orig.y+dy });
    d.x = _wdClampPct(np.x); d.y = _wdClampPct(np.y);
  } else if(hit.kind === "node" || hit.kind === "segment"){
    // Snap the primary point, derive the delta, then move every joined
    // endpoint by it so connected chains stay attached (no leftover stub).
    const prim = (hit.kind === "node") ? { x:orig.x, y:orig.y } : { x:orig.a.x, y:orig.a.y };
    const exclude = new Set((joints||[]).map(j=>j.segIndex+":"+j.end));
    const target = _wdSnapPoint({ x:prim.x+dx, y:prim.y+dy }, exclude);
    const ddx = target.x - prim.x, ddy = target.y - prim.y;
    for(const j of (joints||[])){
      const s = wallDrawState.segments[j.segIndex];
      s[j.end].x = _wdClampPct(j.ox + ddx);
      s[j.end].y = _wdClampPct(j.oy + ddy);
    }
  } else if(hit.kind === "room"){
    const room = wallDrawState.rooms[hit.index];
    room.points = orig.points.map(pt=>({ x:_wdClampPct(pt.x+dx), y:_wdClampPct(pt.y+dy) }));
  }
  drawWallOverlay();
}

function _wdSelectPointerUp(e){
  const wrap = document.getElementById("wdCanvasWrap");
  if(wrap && e){ try { wrap.releasePointerCapture(e.pointerId); } catch(_){} }
  if(!_wdDragging) return;
  _wdDragInfo = null;
  if(typeof saveAppState === "function") { /* geometry saved on Save Floor Plan */ }
  renderWallList();
  // swallow the click that follows this drag
  setTimeout(()=>{ _wdDragging = false; }, 0);
}

function _wdDeleteSelected(){
  const sel = wallDrawState && wallDrawState.sel;
  if(!sel) return;
  if(sel.kind === "door") wallDrawState.doors.splice(sel.index, 1);
  else if(sel.kind === "segment" || sel.kind === "node") wallDrawState.segments.splice(sel.index, 1);
  else if(sel.kind === "room") wallDrawState.rooms.splice(sel.index, 1);
  wallDrawState.sel = null;
  _wdSyncDeleteBtn();
  drawWallOverlay(); renderWallList();
}

function _wdSyncDeleteBtn(){
  const btn = document.getElementById("wdDeleteSel");
  if(btn) btn.style.display = (wallDrawState.mode === "select" && wallDrawState.sel) ? "" : "none";
}

/* Walk connected segments from startIdx to find a closed loop; returns the
   ordered polygon vertices, or null if the segments don't enclose an area. */
function _wdFindLoopFrom(startIdx){
  const segs = wallDrawState.segments;
  const s0 = segs[startIdx];
  if(!s0) return null;
  const same = (a, b) => _wdDist(a, b) <= WALL_JOINT_EPS;
  const verts = [{ ...s0.a }];
  let curPt = { ...s0.b }, prev = startIdx, guard = 0;
  while(guard++ < segs.length + 2){
    if(same(curPt, s0.a)) return verts.length >= 3 ? verts : null;  // closed
    verts.push({ ...curPt });
    let ni = -1, np = null;
    for(let i = 0; i < segs.length; i++){
      if(i === prev) continue;
      if(same(segs[i].a, curPt)){ ni = i; np = segs[i].b; break; }
      if(same(segs[i].b, curPt)){ ni = i; np = segs[i].a; break; }
    }
    if(ni < 0) return null;     // open chain — no enclosure
    prev = ni; curPt = { ...np };
  }
  return null;
}

function _wdCloseRoom(){
  // Select mode: build a room from the loop of segments through the selection.
  if(wallDrawState.mode === "select"){
    const sel = wallDrawState.sel;
    if(!sel || (sel.kind !== "segment" && sel.kind !== "node")){
      _wdStatus("Select a wall that's part of an enclosed loop, then click Close room."); return;
    }
    const loop = _wdFindLoopFrom(sel.index);
    if(!loop){ _wdStatus("Those walls don't form a closed loop — connect the endpoints first."); return; }
    wallDrawState.rooms.push({
      points: loop, label: `Room ${wallDrawState.rooms.length + 1}`, zoneTag: "",
    });
    wallDrawState.sel = null;
    _wdSyncDeleteBtn();
    drawWallOverlay(); renderWallList();
    _wdStatus("Room created from the selected walls.");
    return;
  }
  const nodes = wallDrawState.nodes;
  if(nodes.length < 3){ _wdStatus("Need at least 3 points to close a room (or switch to Select and click a wall in a loop)."); return; }
  // closing wall segment back to the start (uses current type)
  wallDrawState.segments.push({
    a: { ...nodes[nodes.length - 1] }, b: { ...nodes[0] },
    type: wallDrawState.type, label: "",
  });
  wallDrawState.rooms.push({
    points: nodes.map(n=>({ ...n })),
    label: `Room ${wallDrawState.rooms.length + 1}`, zoneTag: "",
  });
  wallDrawState.nodes = [];
  drawWallOverlay();
  renderWallList();
  _wdStatus("Room closed. Start a new chain or save.");
}

function _wdNewChain(){
  wallDrawState.nodes = [];
  drawWallOverlay();
  _wdStatus("New chain — click to place the first point.");
}

function _wdUndo(){
  const nodes = wallDrawState.nodes;
  if(nodes.length === 0){
    // undo the most recent committed segment instead
    if(wallDrawState.segments.length) wallDrawState.segments.pop();
  } else {
    nodes.pop();
    if(nodes.length > 0 && wallDrawState.segments.length) wallDrawState.segments.pop();
  }
  drawWallOverlay();
  renderWallList();
  _wdStatus();
}

function _wdClearAll(){
  if(!confirm("Clear everything drawn in this session?")) return;
  wallDrawState.nodes = [];
  wallDrawState.segments = [];
  wallDrawState.rooms = [];
  drawWallOverlay();
  renderWallList();
  _wdStatus();
}

function _wdSetMode(mode){
  wallDrawState.mode = mode;
  if(mode !== "select") wallDrawState.sel = null;
  wallDrawState.connectFirst = null;        // reset any pending connect
  // Entering select/connect finalizes the in-progress chain (its segments are
  // already committed) so leftover vertex dots don't linger over moved geometry.
  if(mode === "select" || mode === "connect") wallDrawState.nodes = [];
  document.querySelectorAll("#wdModes [data-wmode]").forEach(b=>{
    b.classList.toggle("active", b.dataset.wmode === mode);
  });
  const wrap = document.getElementById("wdCanvasWrap");
  if(wrap){
    wrap.classList.toggle("wd-select-mode", mode === "select");
    wrap.classList.toggle("wd-connect-mode", mode === "connect");
  }
  _wdSyncDeleteBtn();
  drawWallOverlay();
  _wdStatus(mode === "connect" ? "Connect: click two walls to join their nearest ends." : undefined);
}

function _wdSetType(type){
  wallDrawState.type = type;
  wallDrawState.doorTemplate = null;        // leaving door-placement
  if(wallDrawState.mode !== "draw") _wdSetMode("draw");
  document.querySelectorAll("#wdTypes [data-wtype]").forEach(b=>{
    b.classList.toggle("active", b.dataset.wtype === type);
  });
  document.querySelectorAll("#wdDoors [data-door]").forEach(b=>b.classList.remove("active"));
  drawWallOverlay();
}

function _wdSetDoorTemplate(tid){
  wallDrawState.doorTemplate = tid;
  wallDrawState.nodes = [];                  // not mid-chain anymore
  if(wallDrawState.mode !== "draw") _wdSetMode("draw");
  document.querySelectorAll("#wdTypes [data-wtype]").forEach(b=>b.classList.remove("active"));
  document.querySelectorAll("#wdDoors [data-door]").forEach(b=>{
    b.classList.toggle("active", b.dataset.door === tid);
  });
  drawWallOverlay(); _wdStatus();
}

/* Color-editable key. Each row has a color input bound to WALL_TYPES. */
function renderWallLegend(){
  const el = document.getElementById("wdLegend");
  if(!el) return;
  const rows = [
    ["wall", "Wall · blocks"],
    ["sound", "Sound wall · blocks, high STC"],
    ["false", "False wall · blocks, removable"],
    ["construction", "Construction line · non-blocking divider"],
    ["door", "Door · passable"],
  ];
  el.innerHTML = rows.map(([k, lbl]) =>
    `<div class="wd-lg-row"><input type="color" class="wd-lg-color" data-wt="${k}" value="${WALL_TYPES[k].color}" title="Recolor ${WALL_TYPES[k].label}"><span>${lbl}</span></div>`
  ).join("");
  el.querySelectorAll(".wd-lg-color").forEach(inp=>{
    inp.addEventListener("input", ()=>{
      WALL_TYPES[inp.dataset.wt].color = inp.value;
      _wdSaveColors();
      drawWallOverlay(); renderWallList();
    });
  });
}

function _wdStatus(msg){
  const el = document.getElementById("wdStatus");
  if(!el) return;
  if(msg){ el.textContent = msg; return; }
  if(wallDrawState.mode === "select"){
    el.textContent = wallDrawState.sel
      ? `Selected ${wallDrawState.sel.kind}. Drag to move${wallDrawState.sel.kind==="node"?" the endpoint":""}, or Delete.`
      : "Select mode — click a wall, door, endpoint, or room to select and drag it.";
    return;
  }
  if(wallDrawState.doorTemplate){
    el.textContent = `Door: ${DOOR_TEMPLATES[wallDrawState.doorTemplate].label}. Click on the plan to drop it.`;
    return;
  }
  const n = wallDrawState.nodes.length;
  const t = WALL_TYPES[wallDrawState.type].label;
  el.textContent = n === 0
    ? `Drawing: ${t}. Click on the plan to place the first point.`
    : `Drawing: ${t}. ${n} point(s) in this chain — click to extend, or click the first point / "Close room" to enclose a floor.`;
}

/* ---- overlay rendering ---- */
function drawWallOverlay(){
  const svg = document.getElementById("wdOverlay");
  if(!svg || !wallDrawState) return;
  syncWallOverlay();   // keep the overlay aligned to the image before drawing
  let h = "";
  // reference grid
  for(let p = 10; p < 100; p += 10){
    h += `<line class="wd-grid" x1="${p}" y1="0" x2="${p}" y2="100"/>`;
    h += `<line class="wd-grid" x1="0" y1="${p}" x2="100" y2="${p}"/>`;
  }
  // closed rooms (filled polygons)
  for(const room of wallDrawState.rooms){
    const pts = room.points.map(p=>`${p.x},${p.y}`).join(" ");
    h += `<polygon class="wd-room" points="${pts}"/>`;
  }
  const sel = (wallDrawState.mode === "select") ? wallDrawState.sel : null;
  const cFirst = wallDrawState.connectFirst;
  // committed segments
  wallDrawState.segments.forEach((seg, i)=>{
    const selHere = sel && (sel.kind==="segment"||sel.kind==="node") && sel.index===i;
    const isSel = selHere || (cFirst === i);
    h += _wdSegSvg(seg, isSel);
    if(selHere){
      // endpoint handles (select mode only)
      h += `<circle class="wd-handle${sel.kind==="node"&&sel.end==="a"?" wd-handle-on":""}" cx="${seg.a.x}" cy="${seg.a.y}" r="1.6"/>`;
      h += `<circle class="wd-handle${sel.kind==="node"&&sel.end==="b"?" wd-handle-on":""}" cx="${seg.b.x}" cy="${seg.b.y}" r="1.6"/>`;
    }
  });
  // placed doors (swing symbols)
  wallDrawState.doors.forEach((d, i)=>{
    const isSel = sel && sel.kind==="door" && sel.index===i;
    h += _wdDoorSvg(d, isSel);
  });
  // re-outline selected room
  if(sel && sel.kind==="room"){
    const pts = wallDrawState.rooms[sel.index].points.map(p=>`${p.x},${p.y}`).join(" ");
    h += `<polygon class="wd-room wd-sel" points="${pts}"/>`;
  }
  // In-progress chain: only the vertex dots. The chain's lines are already
  // committed segments (rendered above) — drawing them again here is what
  // produced "ghost" lines once a committed segment was moved in select mode.
  const nodes = wallDrawState.nodes;
  for(const n of nodes){
    h += `<circle class="wd-node" cx="${n.x}" cy="${n.y}" r="1"/>`;
  }
  if(nodes.length){
    h += `<circle class="wd-node wd-node-start" cx="${nodes[0].x}" cy="${nodes[0].y}" r="1.4"/>`;
  }
  svg.innerHTML = h;
}

// Draw a placed door's swing symbol (template polygons mapped into its box).
function _wdDoorSvg(d, isSel){
  const tpl = DOOR_TEMPLATES[d.template] || DOOR_TEMPLATES.quarter;
  const col = WALL_TYPES.door.color;
  const cx = d.x, cy = d.y, w = d.w, h = d.h, rot = d.rotation || 0;
  let s = `<g transform="rotate(${rot} ${cx} ${cy})">`;
  for(const poly of tpl.shapes){
    const pts = poly.map(p=>`${cx - w/2 + (p.x/100)*w},${cy - h/2 + (p.y/100)*h}`).join(" ");
    s += `<polygon class="wd-door${isSel?" wd-sel":""}" points="${pts}" fill="${col}" stroke="${col}"/>`;
  }
  s += `</g>`;
  return s;
}

function _wdSegSvg(seg, isSel){
  const t = WALL_TYPES[seg.type] || WALL_TYPES.wall;
  const cls = "wd-seg wd-" + seg.type + (isSel ? " wd-sel" : "");
  const dash = (seg.type === "construction") ? ' stroke-dasharray="2 1.5"' : "";
  return `<line class="${cls}" x1="${seg.a.x}" y1="${seg.a.y}" x2="${seg.b.x}" y2="${seg.b.y}" stroke="${t.color}"${dash}/>`;
}

/* ---- side list (edit drawn pieces) ---- */
function renderWallList(){
  const list = document.getElementById("wdList");
  if(!list || !wallDrawState) return;
  const typeOptions = (sel) => Object.keys(WALL_TYPES)
    .map(k=>`<option value="${k}"${k===sel?" selected":""}>${WALL_TYPES[k].label}</option>`).join("");
  const SEL = (wallDrawState.mode === "select") ? wallDrawState.sel : null;
  const selCls = (kind, i) => {
    if(!SEL) return "";
    if(kind === "segment") return ((SEL.kind==="segment"||SEL.kind==="node") && SEL.index===i) ? " wd-row-sel" : "";
    return (SEL.kind===kind && SEL.index===i) ? " wd-row-sel" : "";
  };
  let h = "";
  if(wallDrawState.rooms.length){
    h += `<div class="wd-list-hdr">Rooms (${wallDrawState.rooms.length})</div>`;
    wallDrawState.rooms.forEach((room, i)=>{
      h += `<div class="wd-row${selCls("room",i)}" data-rk="room" data-ri="${i}">
        <span class="wd-row-ico" title="Floor space">⬡</span>
        <input class="wd-row-name" data-room="${i}" data-k="label" value="${_wdEsc(room.label)}" placeholder="Room name"/>
        <input class="wd-row-tag" data-room="${i}" data-k="zoneTag" value="${_wdEsc(room.zoneTag)}" placeholder="zone tag"/>
        <button class="wd-row-del" data-room="${i}" title="Delete room">×</button>
      </div>`;
    });
  }
  if(wallDrawState.doors.length){
    h += `<div class="wd-list-hdr">Doors (${wallDrawState.doors.length})</div>`;
    wallDrawState.doors.forEach((d, i)=>{
      h += `<div class="wd-row${selCls("door",i)}" data-rk="door" data-ri="${i}">
        <span class="wd-row-sw" style="background:${WALL_TYPES.door.color}"></span>
        <span class="wd-row-name" style="flex:1;font-size:11px;color:var(--text-dim)">${_wdEsc(DOOR_TEMPLATES[d.template]?DOOR_TEMPLATES[d.template].label:d.template)}</span>
        <input class="wd-row-size" type="number" data-door="${i}" value="${_wdSizeDisp(d.w)}" title="Size (${_wdSizeUnit()})" min="0.5" step="0.5"/>
        <input class="wd-row-rot" type="number" data-door="${i}" data-k="rotation" value="${Math.round(d.rotation||0)}" title="Rotation (deg)" step="15"/>
        <button class="wd-row-del" data-doordel="${i}" title="Delete door">×</button>
      </div>`;
    });
  }
  if(wallDrawState.segments.length){
    h += `<div class="wd-list-hdr">Walls / lines (${wallDrawState.segments.length})</div>`;
    wallDrawState.segments.forEach((seg, i)=>{
      h += `<div class="wd-row${selCls("segment",i)}" data-rk="segment" data-ri="${i}">
        <span class="wd-row-sw" style="background:${WALL_TYPES[seg.type].color}"></span>
        <select class="wd-row-type" data-seg="${i}">${typeOptions(seg.type)}</select>
        <input class="wd-row-name" data-seg="${i}" data-k="label" value="${_wdEsc(seg.label||"")}" placeholder="label (optional)"/>
        <button class="wd-row-del" data-seg="${i}" title="Delete">×</button>
      </div>`;
    });
  }
  if(!h) h = `<div class="wd-empty">Nothing drawn yet. Pick a type above and click on the plan.</div>`;
  list.innerHTML = h;

  list.querySelectorAll(".wd-row-type").forEach(sel=>{
    sel.addEventListener("change", ()=>{
      wallDrawState.segments[+sel.dataset.seg].type = sel.value;
      drawWallOverlay(); renderWallList();
    });
  });
  list.querySelectorAll("input[data-seg]").forEach(inp=>{
    inp.addEventListener("input", ()=>{ wallDrawState.segments[+inp.dataset.seg][inp.dataset.k] = inp.value; });
  });
  list.querySelectorAll("input[data-room]").forEach(inp=>{
    inp.addEventListener("input", ()=>{ wallDrawState.rooms[+inp.dataset.room][inp.dataset.k] = inp.value; });
  });
  list.querySelectorAll(".wd-row-del[data-seg]").forEach(b=>{
    b.addEventListener("click", ()=>{ wallDrawState.segments.splice(+b.dataset.seg,1); drawWallOverlay(); renderWallList(); });
  });
  list.querySelectorAll(".wd-row-del[data-room]").forEach(b=>{
    b.addEventListener("click", ()=>{ wallDrawState.rooms.splice(+b.dataset.room,1); drawWallOverlay(); renderWallList(); });
  });
  list.querySelectorAll(".wd-row-rot[data-door]").forEach(inp=>{
    inp.addEventListener("input", ()=>{ wallDrawState.doors[+inp.dataset.door].rotation = parseFloat(inp.value)||0; drawWallOverlay(); });
  });
  list.querySelectorAll(".wd-row-size[data-door]").forEach(inp=>{
    inp.addEventListener("input", ()=>{
      const pct = _wdSizeToPct(inp.value);
      if(pct == null) return;
      const d = wallDrawState.doors[+inp.dataset.door];
      d.w = pct; d.h = pct;
      drawWallOverlay();
    });
  });
  list.querySelectorAll(".wd-row-del[data-doordel]").forEach(b=>{
    b.addEventListener("click", ()=>{ wallDrawState.doors.splice(+b.dataset.doordel,1); drawWallOverlay(); renderWallList(); });
  });
  // Click a row (outside its inputs) to select + highlight that piece on the
  // canvas, switching to Select mode so it can be moved/deleted.
  list.querySelectorAll(".wd-row[data-rk]").forEach(row=>{
    row.addEventListener("click", (e)=>{
      if(e.target.closest("input,select,button")) return;
      if(wallDrawState.mode !== "select") _wdSetMode("select");
      wallDrawState.sel = { kind: row.dataset.rk, index: +row.dataset.ri };
      _wdSyncDeleteBtn();
      drawWallOverlay(); renderWallList(); _wdStatus();
    });
  });
}

function _wdEsc(s){ return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }

/* ---- save: convert to structural elements ---- */
function saveWallDraw(){
  if(!wallDrawState) return;
  const taken = new Set(allZoneDefs().map(x=>x.id));
  const mkId = (base) => { let id = base, n = 2; while(taken.has(id)){ id = base + "_" + n; n++; } taken.add(id); return id; };

  const newDefs = [];
  const newZones = {};

  // rooms → floor polygons
  wallDrawState.rooms.forEach((room, i)=>{
    const bb = _wdBBox(room.points);
    if(bb.w <= 0 || bb.h <= 0) return;
    const id = mkId("struct_room_" + (i+1));
    const local = _wdLocalize(room.points, bb);
    newDefs.push({
      id, label: room.label || `Room ${i+1}`, short: (room.label||`Room ${i+1}`).slice(0,10),
      risk: 0, elementClass:"structural", subtype:"floor",
      blocksMovement:false, custom:true, fixed:true,
      w: bb.w, h: bb.h,
      shapes:[{ type:"polygon", points: local }],
      zoneTag: room.zoneTag || "",
      rawDraw:{ kind:"room", points: room.points.map(p=>({...p})), type:"floor" },
    });
    newZones[id] = { x:bb.x1, y:bb.y1, w:bb.w, h:bb.h, rotation:0, included:true, activeUse:false, locked:true };
  });

  // segments → walls / doors / construction lines (thick polygons)
  wallDrawState.segments.forEach((seg, i)=>{
    const cfg = WALL_TYPES[seg.type] || WALL_TYPES.wall;
    const quad = _wdThickQuad(seg.a, seg.b, WALL_THICKNESS_PCT);
    const bb = _wdBBox(quad);
    if(bb.w <= 0 && bb.h <= 0) return;
    const id = mkId("struct_" + cfg.subtype + "_" + (i+1));
    const local = _wdLocalize(quad, bb);
    const label = seg.label || (cfg.label + " " + (i+1));
    newDefs.push({
      id, label, short: label.slice(0,10),
      risk: 0, elementClass:"structural", subtype: cfg.subtype,
      wallType: cfg.wallType || undefined,
      blocksMovement: cfg.blocks,
      stc: cfg.stc,
      removable: cfg.removable || undefined,
      color: cfg.color,
      custom:true, fixed:true,
      w: bb.w, h: bb.h,
      shapes:[{ type:"polygon", points: local }],
      rawDraw:{ kind:"segment", points:[{...seg.a},{...seg.b}], type: seg.type },
    });
    newZones[id] = { x:bb.x1, y:bb.y1, w:bb.w, h:bb.h, rotation:0, included:true, activeUse:false, locked:true };
  });

  // placed doors → door elements (swing-arc polygon footprint)
  wallDrawState.doors.forEach((d, i)=>{
    const tpl = DOOR_TEMPLATES[d.template] || DOOR_TEMPLATES.quarter;
    const w = d.w, h = d.h;
    if(w <= 0 || h <= 0) return;
    const id = mkId("struct_door_" + (i+1));
    const label = d.label || (tpl.label + " " + (i+1));
    newDefs.push({
      id, label, short: label.slice(0,10), risk: 0,
      elementClass:"structural", subtype:"door",
      blocksMovement:false, doorTemplate: d.template, stc:20,
      color: WALL_TYPES.door.color,
      custom:true, fixed:true,
      w, h,
      shapes: tpl.shapes.map(poly => ({ type:"polygon", points: poly.map(p=>({...p})) })),
      rawDraw:{ kind:"door", template:d.template, x:d.x, y:d.y, w, h, rotation:d.rotation||0 },
    });
    newZones[id] = {
      x: clamp(d.x - w/2, 0, 100 - w), y: clamp(d.y - h/2, 0, 100 - h),
      w, h, rotation: d.rotation || 0, included:true, activeUse:false, locked:true,
    };
  });

  // Replace previously-drawn structural elements (those with rawDraw),
  // preserve any legacy shape-based structural elements untouched.
  const preserved = (state.structuralElements || []).filter(d=>!d.rawDraw);
  const removedIds = (state.structuralElements || []).filter(d=>d.rawDraw).map(d=>d.id);
  for(const rid of removedIds) delete state.zones[rid];
  state.structuralElements = preserved.concat(newDefs);
  Object.assign(state.zones, newZones);

  evaluate();
  render();
  if(typeof saveAppState === "function") saveAppState();
  closeWallDraw();
}

/* ==================================================================
   DOOR SWING TEMPLATES
   Pre-built door symbols (quarter / semicircle / double / sliding) that
   drop onto the layout as a movable door element, then get resized &
   rotated via the selection panel. Footprints are polygon shapes in the
   element's local 0..100 space (SVG y-down: 0 = top, 100 = bottom).
   ================================================================== */

// Sample an arc-wedge (pie slice) hinged at (hx,hy), radius r, from
// startDeg sweeping sweepDeg. Returns local-% polygon points.
function _doorWedge(hx, hy, r, startDeg, sweepDeg, samples){
  const pts = [{ x:hx, y:hy }];
  const n = samples || 14;
  for(let i = 0; i <= n; i++){
    const a = (startDeg + sweepDeg * (i / n)) * Math.PI / 180;
    pts.push({ x: hx + r * Math.cos(a), y: hy + r * Math.sin(a) });
  }
  return pts;
}

const DOOR_TEMPLATES = {
  quarter:    { label:"Door (90°)",   shapes:[ _doorWedge(0, 100, 100, -90, 90) ] },
  semicircle: { label:"Door (180°)",  shapes:[ _doorWedge(50, 100, 50, 180, 180) ] },
  double:     { label:"Double Door",  shapes:[ _doorWedge(0, 100, 50, -90, 90), _doorWedge(100, 100, 50, -90, -90) ] },
  sliding:    { label:"Sliding Door", shapes:[ [ {x:6,y:44},{x:94,y:44},{x:94,y:56},{x:6,y:56} ] ] },
};

function addDoorTemplate(tid){
  const tpl = DOOR_TEMPLATES[tid];
  if(!tpl) return;
  const taken = new Set(allZoneDefs().map(x=>x.id));
  let id = "door_" + tid, n = 2;
  while(taken.has(id)){ id = "door_" + tid + "_" + n; n++; }
  // Default footprint ~3.5 ft square (door + swing); falls back to % when
  // no scale is set. The user resizes from there.
  const w = (typeof hasScale === "function" && hasScale()) ? unitsToPct(3.5, "x") : 7;
  const h = (typeof hasScale === "function" && hasScale()) ? unitsToPct(3.5, "y") : 7;
  const def = {
    id, label: tpl.label, short: tpl.label.slice(0, 10), risk: 0,
    elementClass: "structural", subtype: "door",
    blocksMovement: false, doorTemplate: tid, stc: 20,
    custom: true, fixed: false,
    w, h,
    shapes: tpl.shapes.map(poly => ({ type:"polygon", points: poly.map(p=>({...p})) })),
  };
  state.structuralElements.push(def);
  state.zones[id] = {
    x: clamp(50 - w/2, 0, 100 - w), y: clamp(50 - h/2, 0, 100 - h),
    w, h, rotation: 0, included: true, activeUse: false, locked: false,
  };
  evaluate();
  render();
  if(typeof selectZone === "function") selectZone(id);  // open the selection panel
  if(typeof saveAppState === "function") saveAppState();
}

/* ==================================================================
   AUTO-GENERATE WALLS + FLOOR FROM A B/W FLOOR-PLAN IMAGE
   Polarity is auto-detected (dark bg→light walls, or light bg→dark walls).
   Walls are extracted as medial centerlines of thin runs; the floor is the
   outer contour of the enclosed building footprint, simplified.
   Coordinates come out in stage %, matching how the image fills the stage.
   ================================================================== */
function _wdGenerateFromImage(){
  const fp = state.imports && state.imports.floorPlan;
  if(!fp || !fp.dataUrl){
    _wdStatus("Load a floor-plan image first (Import Project → Floor Plan, or Import Floor Plan)."); return;
  }
  if((wallDrawState.segments.length || wallDrawState.rooms.length) &&
     !confirm("Replace the current walls/rooms with auto-generated ones?")) return;
  _wdStatus("Analyzing image…");
  const img = new Image();
  img.onload = () => { try { _wdGenRun(img); } catch(e){ console.warn("[gen]", e); _wdStatus("Generation failed: " + e.message); } };
  img.onerror = () => _wdStatus("Couldn't load the image for generation.");
  img.src = fp.dataUrl;
}

function _wdGenRun(img){
  // 1) Rasterize at a capped resolution (higher = captures smaller walls).
  const GW = 360;
  const GH = Math.max(1, Math.round(img.height * (GW / img.width)));
  const cv = document.createElement("canvas"); cv.width = GW; cv.height = GH;
  const ctx = cv.getContext("2d");
  ctx.drawImage(img, 0, 0, GW, GH);
  const px = ctx.getImageData(0, 0, GW, GH).data;

  // 2) Classify each pixel as wall vs background.
  const wall = new Uint8Array(GW * GH);
  if(wallDrawState.genAuto === false){
    // Explicit colors: a pixel is a wall if it's nearer the wall color than
    // the background color (eliminates polarity-detection error).
    const wc = _wdHexToRgb(wallDrawState.genWallColor);
    const bg = _wdHexToRgb(wallDrawState.genBgColor);
    for(let i = 0; i < GW * GH; i++){
      const r=px[i*4], g=px[i*4+1], b=px[i*4+2];
      const dW=(r-wc.r)**2+(g-wc.g)**2+(b-wc.b)**2;
      const dB=(r-bg.r)**2+(g-bg.g)**2+(b-bg.b)**2;
      wall[i] = dW < dB ? 1 : 0;
    }
  } else {
    // Auto: background is the dominant tone, walls are the other.
    let sum = 0; const bright = new Float32Array(GW*GH);
    for(let i = 0; i < GW * GH; i++){
      const v = (0.299*px[i*4] + 0.587*px[i*4+1] + 0.114*px[i*4+2]) / 255;
      bright[i] = v; sum += v;
    }
    const wallsAreBright = (sum / (GW * GH)) < 0.5;
    for(let i = 0; i < GW * GH; i++){
      wall[i] = (wallsAreBright ? bright[i] > 0.5 : bright[i] < 0.5) ? 1 : 0;
    }
  }
  const at = (c, r) => (c<0||r<0||c>=GW||r>=GH) ? 0 : wall[r*GW + c];

  // 3) Run lengths through each wall cell (horizontal & vertical). The center
  //    arrays store the FRACTIONAL run center so segments aren't biased half a
  //    cell to one side (which read as a slight rightward/downward shift).
  const TH = Math.max(3, Math.round(Math.min(GW, GH) * 0.05));    // max wall thickness in cells
  // Min wall length in cells, from the user-set genMinLen (% of width).
  const minLenPct = Number.isFinite(wallDrawState.genMinLen) ? wallDrawState.genMinLen : 1.2;
  const MINLEN = Math.max(3, Math.round(GW * minLenPct / 100));   // min wall length in cells
  const GAP = 3;                                                  // bridge small gaps along a wall
  const hLen = new Int16Array(GW*GH), vLen = new Int16Array(GW*GH);
  const hCtr = new Uint8Array(GW*GH), vCtr = new Uint8Array(GW*GH);
  const hCtrX = new Float32Array(GW*GH), vCtrY = new Float32Array(GW*GH);
  for(let r=0;r<GH;r++){ let c=0; while(c<GW){ if(!at(c,r)){c++;continue;} let s=c; while(c<GW&&at(c,r))c++; const L=c-s, mid=s+(L>>1); for(let k=s;k<c;k++) hLen[r*GW+k]=L; hCtr[r*GW+mid]=1; hCtrX[r*GW+mid]=(s + c - 1)/2; } }
  for(let c=0;c<GW;c++){ let r=0; while(r<GH){ if(!at(c,r)){r++;continue;} let s=r; while(r<GH&&at(c,r))r++; const L=r-s, mid=s+(L>>1); for(let k=s;k<r;k++) vLen[k*GW+c]=L; vCtr[mid*GW+c]=1; vCtrY[mid*GW+c]=(s + r - 1)/2; } }

  // 4) Centerline cells: horizontal walls are thin vertically (vLen≤TH) at
  //    their vertical center; vertical walls thin horizontally at their center.
  const segs = [];
  const toPctF = (xf, yf) => ({ x: (xf + 0.5) / GW * 100, y: (yf + 0.5) / GH * 100 });
  // horizontal segments — scan each row, group centerline columns
  for(let r=0;r<GH;r++){
    let c=0;
    while(c<GW){
      const isH = at(c,r) && vLen[r*GW+c] && vLen[r*GW+c] <= TH && vCtr[r*GW+c];
      if(!isH){ c++; continue; }
      let s=c, gap=0, last=c, ySum=0, yN=0;
      while(c<GW){
        const ok = at(c,r) && vLen[r*GW+c] && vLen[r*GW+c] <= TH && vCtr[r*GW+c];
        if(ok){ last=c; gap=0; ySum+=vCtrY[r*GW+c]; yN++; c++; }
        else { if(++gap>GAP) break; c++; }
      }
      if(last - s >= MINLEN){ const yf = yN?ySum/yN:r; const a=toPctF(s,yf), b=toPctF(last,yf); segs.push({a,b,type:"wall",label:""}); }
    }
  }
  // vertical segments — scan each column, group centerline rows
  for(let c=0;c<GW;c++){
    let r=0;
    while(r<GH){
      const isV = at(c,r) && hLen[r*GW+c] && hLen[r*GW+c] <= TH && hCtr[r*GW+c];
      if(!isV){ r++; continue; }
      let s=r, gap=0, last=r, xSum=0, xN=0;
      while(r<GH){
        const ok = at(c,r) && hLen[r*GW+c] && hLen[r*GW+c] <= TH && hCtr[r*GW+c];
        if(ok){ last=r; gap=0; xSum+=hCtrX[r*GW+c]; xN++; r++; }
        else { if(++gap>GAP) break; r++; }
      }
      if(last - s >= MINLEN){ const xf = xN?xSum/xN:c; const a=toPctF(xf,s), b=toPctF(xf,last); segs.push({a,b,type:"wall",label:""}); }
    }
  }

  // 5) Connect corners: snap each wall's endpoints to the crossing wall's
  //    line so perpendicular walls actually meet (and Close-room loops close).
  const segIsH = s => Math.abs(s.a.y - s.b.y) < 0.6;
  const segIsV = s => Math.abs(s.a.x - s.b.x) < 0.6;
  const uniqLines = arr => { arr.sort((a,b)=>a-b); const o=[]; for(const v of arr){ if(!o.length || Math.abs(o[o.length-1]-v) > 0.4) o.push(v); } return o; };
  const xLines = uniqLines(segs.filter(segIsV).map(s=>(s.a.x+s.b.x)/2));
  const yLines = uniqLines(segs.filter(segIsH).map(s=>(s.a.y+s.b.y)/2));
  const tolX = (TH/GW*100)*2, tolY = (TH/GH*100)*2;
  const snapLine = (v, lines, tol)=>{ let best=v, bd=tol; for(const L of lines){ const d=Math.abs(L-v); if(d<bd){bd=d;best=L;} } return best; };
  for(const s of segs){
    if(segIsH(s)){ s.a.x = snapLine(s.a.x, xLines, tolX); s.b.x = snapLine(s.b.x, xLines, tolX); }
    else if(segIsV(s)){ s.a.y = snapLine(s.a.y, yLines, tolY); s.b.y = snapLine(s.b.y, yLines, tolY); }
  }

  // 6) Floor(s) = the ENCLOSED INTERIOR just inside the walls (one per room),
  //    NOT the building footprint. Flood non-wall from the border = "outside";
  //    non-wall cells that aren't outside are interior floor.
  const outside = new Uint8Array(GW*GH);
  const stack = [];
  for(let c=0;c<GW;c++){ if(!at(c,0)){stack.push(c);} if(!at(c,GH-1)){stack.push((GH-1)*GW+c);} }
  for(let r=0;r<GH;r++){ if(!at(0,r)){stack.push(r*GW);} if(!at(GW-1,r)){stack.push(r*GW+GW-1);} }
  while(stack.length){
    const i = stack.pop(); if(outside[i]) continue; outside[i]=1;
    const c=i%GW, r=(i/GW)|0;
    if(c>0 && !wall[i-1] && !outside[i-1]) stack.push(i-1);
    if(c<GW-1 && !wall[i+1] && !outside[i+1]) stack.push(i+1);
    if(r>0 && !wall[i-GW] && !outside[i-GW]) stack.push(i-GW);
    if(r<GH-1 && !wall[i+GW] && !outside[i+GW]) stack.push(i+GW);
  }
  const inside = new Uint8Array(GW*GH);
  for(let i=0;i<GW*GH;i++) inside[i] = (!wall[i] && !outside[i]) ? 1 : 0;
  const rooms = [];
  for(const contour of _wdTraceContours(inside, GW, GH, GW*GH*0.004)){
    const simp = _wdSimplify(contour, Math.max(1.2, GW*0.01));
    if(simp.length >= 3) rooms.push({ points: simp.map(p=>toPctF(p.x, p.y)), label:`Room ${rooms.length+1}`, zoneTag:"" });
  }

  if(!segs.length && !rooms.length){ _wdStatus("No walls detected. Is the image black-on-white (or white-on-black) line work?"); return; }

  // 6) Commit (cap segment count defensively).
  wallDrawState.segments = segs.slice(0, 4000);
  wallDrawState.rooms = rooms;
  wallDrawState.nodes = [];
  wallDrawState.sel = null;
  _wdSetMode("select");
  drawWallOverlay(); renderWallList(); _wdSyncDeleteBtn();
  _wdStatus(`Generated ${wallDrawState.segments.length} wall segment(s)` + (rooms.length?` and a floor outline`:``) + `. Review, tidy up, then Save.`);
}

/* Moore-neighbor boundary trace of every connected component (4-conn) in
   `mask` whose area ≥ minSize. Returns an array of contours (one per region),
   so each enclosed room becomes its own floor polygon. */
function _wdTraceContours(mask, W, H, minSize){
  const lbl = new Int32Array(W*H); let cur=0; const sizes=[0];
  for(let i=0;i<W*H;i++){
    if(!mask[i]||lbl[i]) continue;
    cur++; let sz=0; const st=[i];
    while(st.length){ const j=st.pop(); if(lbl[j]||!mask[j]) continue; lbl[j]=cur; sz++;
      const c=j%W,r=(j/W)|0;
      if(c>0)st.push(j-1); if(c<W-1)st.push(j+1); if(r>0)st.push(j-W); if(r<H-1)st.push(j+W);
    }
    sizes[cur]=sz;
  }
  const dirs=[[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1],[0,-1],[1,-1]];
  const out=[];
  for(let id=1; id<=cur; id++){
    if(sizes[id] < minSize) continue;
    const inC = (c,r) => (c<0||r<0||c>=W||r>=H) ? false : lbl[r*W+c]===id;
    let start=null;
    for(let r=0;r<H&&!start;r++) for(let c=0;c<W;c++){ if(lbl[r*W+c]===id){start={x:c,y:r};break;} }
    if(!start) continue;
    const pts=[]; let cx=start.x, cy=start.y, b=4, guard=0;
    do{
      pts.push({x:cx,y:cy});
      let found=false;
      for(let k=0;k<8;k++){
        const d=(b+1+k)%8, nx=cx+dirs[d][0], ny=cy+dirs[d][1];
        if(inC(nx,ny)){ b=(d+4)%8; cx=nx; cy=ny; found=true; break; }
      }
      if(!found) break;
    } while((cx!==start.x||cy!==start.y) && guard++ < W*H*4);
    if(pts.length>=3) out.push(pts);
  }
  return out;
}

/* Douglas–Peucker polyline simplification (closed polygon). */
function _wdSimplify(pts, eps){
  if(pts.length < 3) return pts;
  const d2 = (p,a,b)=>{ const dx=b.x-a.x, dy=b.y-a.y; const L=dx*dx+dy*dy;
    if(!L) return (p.x-a.x)**2+(p.y-a.y)**2;
    let t=((p.x-a.x)*dx+(p.y-a.y)*dy)/L; t=Math.max(0,Math.min(1,t));
    const px=a.x+t*dx, py=a.y+t*dy; return (p.x-px)**2+(p.y-py)**2; };
  const dp = (s,e,out)=>{ let idx=-1, max=0;
    for(let i=s+1;i<e;i++){ const dd=d2(pts[i],pts[s],pts[e]); if(dd>max){max=dd;idx=i;} }
    if(max>eps*eps){ dp(s,idx,out); out.push(pts[idx]); dp(idx,e,out); } };
  const out=[pts[0]]; dp(0, pts.length-1, out); out.push(pts[pts.length-1]);
  return out;
}

/* ---- wiring ---- */
function wireWallDraw(){
  const bd = document.getElementById("wallDrawBackdrop");
  if(!bd) return;
  document.getElementById("wdClose").addEventListener("click", closeWallDraw);
  document.getElementById("wdCancel").addEventListener("click", closeWallDraw);
  bd.addEventListener("click", (e)=>{ if(e.target.id === "wallDrawBackdrop") closeWallDraw(); });
  const wrap = document.getElementById("wdCanvasWrap");
  wrap.addEventListener("click", wallDrawCanvasClick);
  // Select-mode drag handlers (no-ops unless mode === "select").
  wrap.addEventListener("pointerdown", _wdSelectPointerDown);
  wrap.addEventListener("pointermove", _wdSelectPointerMove);
  wrap.addEventListener("pointerup", _wdSelectPointerUp);
  document.querySelectorAll("#wdModes [data-wmode]").forEach(b=>{
    b.addEventListener("click", ()=>_wdSetMode(b.dataset.wmode));
  });
  document.querySelectorAll("#wdTypes [data-wtype]").forEach(b=>{
    b.addEventListener("click", ()=>{ _wdSetType(b.dataset.wtype); _wdStatus(); });
  });
  document.querySelectorAll("#wdDoors [data-door]").forEach(b=>{
    b.addEventListener("click", ()=>_wdSetDoorTemplate(b.dataset.door));
  });
  const dsz = document.getElementById("wdDoorSize");
  if(dsz) dsz.addEventListener("input", ()=>{
    const pct = _wdSizeToPct(dsz.value);
    if(pct != null) wallDrawState.doorSize = pct;
  });
  document.getElementById("wdDeleteSel").addEventListener("click", _wdDeleteSelected);
  const gen = document.getElementById("wdGenerate");
  if(gen) gen.addEventListener("click", _wdGenerateFromImage);
  // Generator color controls. Picking a color implies "use these exact
  // colors" (auto-detect off); the Auto checkbox re-enables brightness detect.
  const gwc = document.getElementById("wdGenWallColor");
  const gbc = document.getElementById("wdGenBgColor");
  const gau = document.getElementById("wdGenAuto");
  if(gwc) gwc.addEventListener("input", ()=>{ wallDrawState.genWallColor = gwc.value; wallDrawState.genAuto = false; if(gau) gau.checked = false; });
  if(gbc) gbc.addEventListener("input", ()=>{ wallDrawState.genBgColor = gbc.value; wallDrawState.genAuto = false; if(gau) gau.checked = false; });
  if(gau) gau.addEventListener("change", ()=>{ wallDrawState.genAuto = gau.checked; });
  const gml = document.getElementById("wdGenMinLen");
  if(gml) gml.addEventListener("input", ()=>{ const v = _wdSizeToPct(gml.value); if(v != null) wallDrawState.genMinLen = v; });
  document.getElementById("wdCloseRoom").addEventListener("click", _wdCloseRoom);
  document.getElementById("wdNewChain").addEventListener("click", _wdNewChain);
  document.getElementById("wdUndo").addEventListener("click", _wdUndo);
  document.getElementById("wdClear").addEventListener("click", _wdClearAll);
  const snap = document.getElementById("wdSnap");
  if(snap) snap.addEventListener("change", ()=>{ wallDrawState.snap = snap.checked; });
  document.getElementById("wdSave").addEventListener("click", saveWallDraw);
  window.addEventListener("resize", ()=>{ if(wallDrawState) drawWallOverlay(); });
}
