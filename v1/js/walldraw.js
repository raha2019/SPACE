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

let wallDrawState = null;
// {
//   type: "wall",                    current drawing type
//   nodes: [{x,y}],                  vertices of the in-progress chain
//   segments: [{a,b,type,label}],    committed wall/door segments
//   rooms: [{points:[{x,y}],label,zoneTag}],
//   snap: true,
//   nextId: 1,
// }

function _wdBlank(){
  return { type:"wall", nodes:[], segments:[], rooms:[], snap:true, nextId:1 };
}

/* ---- open / close ---- */
function openWallDraw(){
  wallDrawState = _wdBlank();
  _wdLoadExisting();                // reconstruct previously-drawn elements
  const img = document.getElementById("wdImage");
  const wrap = document.getElementById("wdCanvasWrap");
  // Match the canvas aspect to the stage so % maps 1:1.
  const dims = (typeof stageDimsPx === "function") ? stageDimsPx() : { w:1600, h:994 };
  if(wrap) wrap.style.aspectRatio = `${dims.w} / ${dims.h}`;
  // Use the imported floor plan if present; otherwise a blank dark canvas.
  const fp = state.imports && state.imports.floorPlan;
  if(img){
    if(fp && fp.dataUrl){ img.style.display = ""; img.src = fp.dataUrl; }
    else { img.style.display = "none"; img.removeAttribute("src"); }
  }
  // close any open Element Builder first
  const ebBackdrop = document.getElementById("elementBuilderBackdrop");
  if(ebBackdrop) ebBackdrop.classList.remove("open");
  document.getElementById("wallDrawBackdrop").classList.add("open");
  _wdSetType(wallDrawState.type);
  drawWallOverlay();
  renderWallList();
  _wdStatus();
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

/* ---- overlay positioning (covers the rendered image / wrap) ---- */
function _wdMetrics(){
  const ov = document.getElementById("wdOverlay");
  const r = ov.getBoundingClientRect();
  return r;
}

/* ---- interaction ---- */
function wallDrawCanvasClick(e){
  if(!wallDrawState) return;
  const r = _wdMetrics();
  if(!r.width || !r.height) return;
  let p = { x: _wdClampPct((e.clientX - r.left) / r.width * 100),
            y: _wdClampPct((e.clientY - r.top)  / r.height * 100) };

  // Close the room if clicking near the first node of a 3+ node chain.
  if(wallDrawState.nodes.length >= 3 && _wdDist(p, wallDrawState.nodes[0]) <= WALL_CLOSE_PCT){
    _wdCloseRoom();
    return;
  }
  p = _wdSnap(p);
  const nodes = wallDrawState.nodes;
  if(nodes.length > 0){
    // commit a segment from the previous node to this one
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

function _wdCloseRoom(){
  const nodes = wallDrawState.nodes;
  if(nodes.length < 3){ _wdStatus("Need at least 3 points to close a room."); return; }
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

function _wdSetType(type){
  wallDrawState.type = type;
  document.querySelectorAll("#wdTypes [data-wtype]").forEach(b=>{
    b.classList.toggle("active", b.dataset.wtype === type);
  });
}

function _wdStatus(msg){
  const el = document.getElementById("wdStatus");
  if(!el) return;
  if(msg){ el.textContent = msg; return; }
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
  // committed segments
  for(const seg of wallDrawState.segments){
    h += _wdSegSvg(seg);
  }
  // in-progress chain
  const nodes = wallDrawState.nodes;
  for(let i = 1; i < nodes.length; i++){
    h += _wdSegSvg({ a:nodes[i-1], b:nodes[i], type:wallDrawState.type });
  }
  // nodes
  for(const n of nodes){
    h += `<circle class="wd-node" cx="${n.x}" cy="${n.y}" r="1"/>`;
  }
  if(nodes.length){
    h += `<circle class="wd-node wd-node-start" cx="${nodes[0].x}" cy="${nodes[0].y}" r="1.4"/>`;
  }
  svg.innerHTML = h;
}

function _wdSegSvg(seg){
  const t = WALL_TYPES[seg.type] || WALL_TYPES.wall;
  const cls = "wd-seg wd-" + seg.type;
  const dash = (seg.type === "construction") ? ' stroke-dasharray="2 1.5"' : "";
  return `<line class="${cls}" x1="${seg.a.x}" y1="${seg.a.y}" x2="${seg.b.x}" y2="${seg.b.y}" stroke="${t.color}"${dash}/>`;
}

/* ---- side list (edit drawn pieces) ---- */
function renderWallList(){
  const list = document.getElementById("wdList");
  if(!list || !wallDrawState) return;
  const typeOptions = (sel) => Object.keys(WALL_TYPES)
    .map(k=>`<option value="${k}"${k===sel?" selected":""}>${WALL_TYPES[k].label}</option>`).join("");
  let h = "";
  if(wallDrawState.rooms.length){
    h += `<div class="wd-list-hdr">Rooms (${wallDrawState.rooms.length})</div>`;
    wallDrawState.rooms.forEach((room, i)=>{
      h += `<div class="wd-row">
        <span class="wd-row-ico" title="Floor space">⬡</span>
        <input class="wd-row-name" data-room="${i}" data-k="label" value="${_wdEsc(room.label)}" placeholder="Room name"/>
        <input class="wd-row-tag" data-room="${i}" data-k="zoneTag" value="${_wdEsc(room.zoneTag)}" placeholder="zone tag"/>
        <button class="wd-row-del" data-room="${i}" title="Delete room">×</button>
      </div>`;
    });
  }
  if(wallDrawState.segments.length){
    h += `<div class="wd-list-hdr">Walls / lines (${wallDrawState.segments.length})</div>`;
    wallDrawState.segments.forEach((seg, i)=>{
      h += `<div class="wd-row">
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
      custom:true, fixed:true,
      w: bb.w, h: bb.h,
      shapes:[{ type:"polygon", points: local }],
      rawDraw:{ kind:"segment", points:[{...seg.a},{...seg.b}], type: seg.type },
    });
    newZones[id] = { x:bb.x1, y:bb.y1, w:bb.w, h:bb.h, rotation:0, included:true, activeUse:false, locked:true };
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

/* ---- wiring ---- */
function wireWallDraw(){
  const bd = document.getElementById("wallDrawBackdrop");
  if(!bd) return;
  document.getElementById("wdClose").addEventListener("click", closeWallDraw);
  document.getElementById("wdCancel").addEventListener("click", closeWallDraw);
  bd.addEventListener("click", (e)=>{ if(e.target.id === "wallDrawBackdrop") closeWallDraw(); });
  document.getElementById("wdCanvasWrap").addEventListener("click", wallDrawCanvasClick);
  document.querySelectorAll("#wdTypes [data-wtype]").forEach(b=>{
    b.addEventListener("click", ()=>{ _wdSetType(b.dataset.wtype); _wdStatus(); });
  });
  document.getElementById("wdCloseRoom").addEventListener("click", _wdCloseRoom);
  document.getElementById("wdNewChain").addEventListener("click", _wdNewChain);
  document.getElementById("wdUndo").addEventListener("click", _wdUndo);
  document.getElementById("wdClear").addEventListener("click", _wdClearAll);
  const snap = document.getElementById("wdSnap");
  if(snap) snap.addEventListener("change", ()=>{ wallDrawState.snap = snap.checked; });
  document.getElementById("wdSave").addEventListener("click", saveWallDraw);
  window.addEventListener("resize", ()=>{ if(wallDrawState) drawWallOverlay(); });
}
