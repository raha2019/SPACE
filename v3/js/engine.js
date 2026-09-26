"use strict";
/* ==================================================================
   SPACE LAYOUT ENGINE  (v3 re-platform — Phase 1)
   A feet-native, node-graph SVG editor promoted from the standalone
   "SmartDraw" builder. Everything lives in ONE coordinate space (feet):
     • walls / rooms / openings   — shared node graph
     • element instances (tools / amenities) — FREE movable objects
   Namespaced module: all internals live in this IIFE; DOM ids are
   prefixed "eng-" and queried through the mount root, so nothing
   collides with the existing app. Shares the app's element library
   (allZoneDefs / state.*Elements) and persists to state.engineModel.

   Exposed API (window.Engine):
     mount(rootEl)      build chrome + wire events into rootEl
     render()           redraw
     setTool(name)      select|wall|curve|room|door|window|pan
     place(defId)       enter "drop this element" mode
     getModel()/setModel(m)   feet model in/out
     resetView()        recenter/zoom
   ================================================================== */
(function(){

const PPF = 24;                         // paper px per foot at zoom 1
let uid = 1;
const nid=()=>"en"+(uid++), wI=()=>"ew"+(uid++), oI=()=>"eo"+(uid++), rI=()=>"er"+(uid++), eI=()=>"el"+(uid++);

// ---- feet model ----
const M = {
  nodes:{}, walls:[], openings:[], rooms:[], elements:[],
  tool:"select", sel:null, selSet:[],
  zoom:1, panX:80, panY:80,
  grid:true, snap:true, gridFt:1, unit:"ft",
  wallThick:0.5, doorW:3, windowW:3, doorStyle:"single",
  draft:null, curve:null, placingDefId:null,
  cursor:null, hoverSnap:null, drag:null, simOverlay:null,
  hist:[], future:[],
};

let root=null, svg=null, world=null, propsEl=null, hintEl=null, stCur=null, stLen=null, stHint=null;
let _mounted=false;

// ============================ geometry ============================
const dist=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
const lerp=(a,b,t)=>({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t});
function screenToFt(cx,cy){ const r=svg.getBoundingClientRect();
  return { x:((cx-r.left)-M.panX)/(M.zoom*PPF), y:((cy-r.top)-M.panY)/(M.zoom*PPF) }; }
const pxOf=n=>({x:n.x*PPF,y:n.y*PPF});
const tolFt=()=>9/(M.zoom*PPF);
function pointSeg(p,a,b){ const dx=b.x-a.x,dy=b.y-a.y,L2=dx*dx+dy*dy||1e-9;
  let t=((p.x-a.x)*dx+(p.y-a.y)*dy)/L2; t=Math.max(0,Math.min(1,t));
  return { t, d:Math.hypot(p.x-(a.x+dx*t),p.y-(a.y+dy*t)) }; }
function snap(pt){
  if(M.snap){
    let best=null,bd=tolFt()*1.6;
    for(const id in M.nodes){ const d=dist(pt,M.nodes[id]); if(d<bd){bd=d;best=id;} }
    if(best) return { x:M.nodes[best].x, y:M.nodes[best].y, node:best };
    const g=M.gridFt; return { x:Math.round(pt.x/g)*g, y:Math.round(pt.y/g)*g };
  }
  return { x:pt.x, y:pt.y };
}
function esc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}

// ============================ units ============================
function dim(feet){
  if(M.unit==="m") return (feet*0.3048).toFixed(2)+" m";
  const ti=Math.round(feet*12), ft=Math.floor(ti/12), inch=ti%12;
  return inch? `${ft}'-${inch}"` : `${ft}'`;
}
function areaTxt(sqft){ return M.unit==="m" ? (sqft*0.092903).toFixed(1)+" m²" : Math.round(sqft)+" sq ft"; }

// ============================ history ============================
function snapshot(){ return JSON.stringify({nodes:M.nodes,walls:M.walls,openings:M.openings,rooms:M.rooms,elements:M.elements,uid}); }
function restore(s){ const o=JSON.parse(s); M.nodes=o.nodes;M.walls=o.walls;M.openings=o.openings;M.rooms=o.rooms;M.elements=o.elements||[];uid=o.uid; M.sel=null;M.selSet=[]; }
let _commitTimer=false;
function commit(){ M.hist.push(snapshot()); if(M.hist.length>100)M.hist.shift(); M.future.length=0; syncUndo(); }
function commitOnce(){ if(!_commitTimer){commit();_commitTimer=true;setTimeout(()=>_commitTimer=false,400);} }
function undo(){ if(!M.hist.length)return; M.future.push(snapshot()); restore(M.hist.pop()); render(); persist(); syncUndo(); }
function redo(){ if(!M.future.length)return; M.hist.push(snapshot()); restore(M.future.pop()); render(); persist(); syncUndo(); }
function syncUndo(){ const u=q("undoBtn"),r=q("redoBtn"); if(u)u.disabled=!M.hist.length; if(r)r.disabled=!M.future.length; }

// ============================ model ops ============================
function addNodeAt(pt){ if(pt.node) return pt.node; const id=nid(); M.nodes[id]={x:+pt.x.toFixed(3),y:+pt.y.toFixed(3)}; return id; }
function addWall(aId,bId){ if(aId===bId)return null;
  if(M.walls.some(w=>(w.a===aId&&w.b===bId)||(w.a===bId&&w.b===aId)))return null;
  const w={id:wI(),a:aId,b:bId,thick:M.wallThick}; M.walls.push(w); return w; }
function wallNodes(w){ return [M.nodes[w.a],M.nodes[w.b]]; }
function wallLenFt(w){ const [a,b]=wallNodes(w); return dist(a,b); }
function polyArea(ids){ let a=0; for(let i=0;i<ids.length;i++){const p=M.nodes[ids[i]],q=M.nodes[ids[(i+1)%ids.length]]; a+=p.x*q.y-q.x*p.y;} return Math.abs(a)/2; }
function centroid(ids){ let x=0,y=0; ids.forEach(i=>{x+=M.nodes[i].x;y+=M.nodes[i].y;}); return {x:x/ids.length,y:y/ids.length}; }
function pruneNodes(){ const used=new Set(); M.walls.forEach(w=>{used.add(w.a);used.add(w.b);}); M.rooms.forEach(r=>r.nodes.forEach(id=>used.add(id)));
  for(const id in M.nodes) if(!used.has(id)) delete M.nodes[id]; }
function deleteSel(){
  const set = M.selSet.length ? M.selSet.slice() : (M.sel?[M.sel]:[]);
  if(!set.length) return; commit();
  const nodeIds=new Set(),wallIds=new Set(),openIds=new Set(),roomIds=new Set(),elIds=new Set();
  const bucket={node:nodeIds,wall:wallIds,opening:openIds,room:roomIds,element:elIds};
  set.forEach(s=>{ if(bucket[s.kind]) bucket[s.kind].add(s.id); });
  M.walls    = M.walls.filter(w=>!wallIds.has(w.id) && !nodeIds.has(w.a) && !nodeIds.has(w.b));
  M.rooms    = M.rooms.filter(r=>!roomIds.has(r.id) && !r.nodes.some(id=>nodeIds.has(id)));
  M.openings = M.openings.filter(o=>!openIds.has(o.id) && M.walls.some(w=>w.id===o.wall));
  M.elements = M.elements.filter(e=>!elIds.has(e.id));
  nodeIds.forEach(id=>delete M.nodes[id]);
  pruneNodes(); M.sel=null; M.selSet=[]; render(); persist();
}

// selection helpers
function isSel(kind,id){ return (M.sel&&M.sel.kind===kind&&M.sel.id===id) || M.selSet.some(s=>s.kind===kind&&s.id===id); }
function setSel(sel){ M.sel=sel||null; M.selSet=sel?[sel]:[]; }
function selectedNodeIds(){ const set=new Set(); for(const s of M.selSet){
  if(s.kind==="node") set.add(s.id);
  else if(s.kind==="wall"){ const w=M.walls.find(x=>x.id===s.id); if(w){set.add(w.a);set.add(w.b);} }
  else if(s.kind==="room"){ const r=M.rooms.find(x=>x.id===s.id); if(r)r.nodes.forEach(id=>set.add(id)); } }
  return set; }
function selectedElements(){ return M.selSet.filter(s=>s.kind==="element").map(s=>M.elements.find(e=>e.id===s.id)).filter(Boolean); }
function marqueeSelect(x1,y1,x2,y2){ const inR=p=>p&&p.x>=x1&&p.x<=x2&&p.y>=y1&&p.y<=y2; const out=[];
  for(const id in M.nodes) if(inR(M.nodes[id])) out.push({kind:"node",id});
  for(const w of M.walls){ const[a,b]=wallNodes(w); if(inR(a)&&inR(b)) out.push({kind:"wall",id:w.id}); }
  for(const o of M.openings){ const c=openingCenterFt(o); if(inR(c)) out.push({kind:"opening",id:o.id}); }
  for(const r of M.rooms){ if(r.nodes.every(id=>M.nodes[id]) && inR(centroid(r.nodes))) out.push({kind:"room",id:r.id}); }
  for(const e of M.elements){ if(inR({x:e.x,y:e.y})) out.push({kind:"element",id:e.id}); }
  return out; }

// ============================ element library / instances ============================
function libDefs(){
  // tools + amenities from the app's shared library (structural is the node graph)
  if(typeof allZoneDefs==="function"){
    return allZoneDefs().filter(d=>d && d.elementClass!=="structural");
  }
  const out=[];
  if(typeof state!=="undefined"){
    (state.customElements||[]).forEach(d=>out.push(d));
    (state.amenityElements||[]).forEach(d=>out.push(d));
  }
  return out;
}
function defOf(id){
  if(typeof allZoneDefs==="function"){ const d=allZoneDefs().find(x=>x.id===id); if(d)return d; }
  const pools=[state.customElements,state.amenityElements,state.structuralElements,(typeof ZONE_DEFS!=="undefined"?ZONE_DEFS:[])];
  for(const p of pools){ if(!p)continue; const d=p.find(x=>x.id===id); if(d)return d; }
  return null;
}
function _toFtVal(v,unit){ if(!Number.isFinite(v))return null; return unit==="m"? v/0.3048 : v; }
function defaultSizeFt(def){
  let w=_toFtVal(def&&def.wReal, (def&&def.realUnit)||"ft");
  let h=_toFtVal(def&&def.hReal, (def&&def.realUnit)||"ft");
  if(!(w>0)) w=4; if(!(h>0)) h=3;
  return { w:+w.toFixed(2), h:+h.toFixed(2) };
}
function placeElementAt(defId, ptFt){
  const def=defOf(defId); if(!def) return null;
  const sz=defaultSizeFt(def);
  const inst={ id:eI(), defId, cls:def.elementClass||"tool",
    x:+ptFt.x.toFixed(3), y:+ptFt.y.toFixed(3), w:sz.w, h:sz.h, rot:0, activeUse:false };
  commit(); M.elements.push(inst); return inst;
}
// point-in-rotated-rect test for an element instance (feet)
function _ptInInst(p,e){
  const ang=-(e.rot||0)*Math.PI/180, dx=p.x-e.x, dy=p.y-e.y;
  const lx=dx*Math.cos(ang)-dy*Math.sin(ang), ly=dx*Math.sin(ang)+dy*Math.cos(ang);
  return Math.abs(lx)<=e.w/2 && Math.abs(ly)<=e.h/2;
}
function hitElement(pt){ for(let i=M.elements.length-1;i>=0;i--){ if(_ptInInst(pt,M.elements[i])) return M.elements[i].id; } return null; }

// ============================ hit testing (walls/rooms/openings) ============================
function hitNode(pt){ let best=null,bd=tolFt()*1.5; for(const id in M.nodes){const d=dist(pt,M.nodes[id]); if(d<bd){bd=d;best=id;}} return best; }
function hitOpening(pt){ let best=null,bd=tolFt()*2; for(const o of M.openings){const c=openingCenterFt(o); if(!c)continue; const d=dist(pt,c); if(d<bd){bd=d;best=o.id;}} return best; }
function hitWall(pt){ let best=null,bd=tolFt()+M.wallThick/2; for(const w of M.walls){const [a,b]=wallNodes(w); const r=pointSeg(pt,a,b); if(r.d<Math.max(bd,w.thick/2+tolFt())){bd=r.d;best=w.id;}} return best; }
function hitRoom(pt){ for(let i=M.rooms.length-1;i>=0;i--){ const r=M.rooms[i]; if(!r.nodes.every(id=>M.nodes[id]))continue;
  const c=centroid(r.nodes); if(dist(pt,c)<Math.max(1.8,tolFt()*8) && pointInPoly(pt,r.nodes.map(id=>M.nodes[id]))) return r.id; } return null; }
function pointInPoly(p,pts){ let inside=false; for(let i=0,j=pts.length-1;i<pts.length;j=i++){const xi=pts[i].x,yi=pts[i].y,xj=pts[j].x,yj=pts[j].y; if(((yi>p.y)!==(yj>p.y))&&(p.x<(xj-xi)*(p.y-yi)/((yj-yi)||1e-9)+xi)) inside=!inside;} return inside; }
function openingCenterFt(o){ const w=M.walls.find(x=>x.id===o.wall); if(!w)return null; const [a,b]=wallNodes(w); return lerp(a,b,o.t); }

// ============================ rendering ============================
function render(){
  if(!svg) return;
  const W=svg.clientWidth, H=svg.clientHeight;
  M.walls=M.walls.filter(w=>M.nodes[w.a]&&M.nodes[w.b]);
  M.rooms=M.rooms.filter(r=>r.nodes.length>=3 && r.nodes.every(id=>M.nodes[id]));
  M.openings=M.openings.filter(o=>M.walls.some(w=>w.id===o.wall));
  world.setAttribute("transform",`translate(${M.panX} ${M.panY}) scale(${M.zoom})`);
  let out="";
  out+=`<rect x="-100000" y="-100000" width="200000" height="200000" fill="var(--paper)"/>`;
  if(M.grid){
    const g=M.gridFt*PPF;
    const x0=Math.floor((-M.panX/M.zoom)/g)-1, x1=Math.ceil((W-M.panX)/M.zoom/g)+1;
    const y0=Math.floor((-M.panY/M.zoom)/g)-1, y1=Math.ceil((H-M.panY)/M.zoom/g)+1;
    const sw=1/M.zoom, swM=1.4/M.zoom;
    for(let i=x0;i<=x1;i++){ const major=i%5===0; out+=`<line x1="${i*g}" y1="${y0*g}" x2="${i*g}" y2="${y1*g}" stroke="${major?'var(--grid-maj)':'var(--grid-min)'}" stroke-width="${major?swM:sw}"/>`; }
    for(let j=y0;j<=y1;j++){ const major=j%5===0; out+=`<line x1="${x0*g}" y1="${j*g}" x2="${x1*g}" y2="${j*g}" stroke="${major?'var(--grid-maj)':'var(--grid-min)'}" stroke-width="${major?swM:sw}"/>`; }
  }
  // rooms
  for(const r of M.rooms){ const pts=r.nodes.map(id=>pxOf(M.nodes[id])).map(p=>`${p.x},${p.y}`).join(" ");
    const c=pxOf(centroid(r.nodes)); const area=polyArea(r.nodes); const on=isSel("room",r.id);
    out+=`<polygon points="${pts}" fill="${on?'rgba(47,123,255,.10)':'rgba(47,123,255,.05)'}" stroke="none"/>`;
    out+=`<text x="${c.x}" y="${c.y}" text-anchor="middle" font-family="var(--sans)" font-weight="600" fill="#5a6478" font-size="${12/M.zoom}">${esc(r.name)}</text>`;
    out+=`<text x="${c.x}" y="${c.y+14/M.zoom}" text-anchor="middle" font-family="var(--mono)" fill="#8b95a8" font-size="${10/M.zoom}">${areaTxt(area)}</text>`; }
  // elements (below walls so walls read on top)
  for(const e of M.elements) out+=elementSvg(e);
  // walls
  for(const w of M.walls){ const [a,b]=wallNodes(w),pa=pxOf(a),pb=pxOf(b),t=w.thick*PPF;
    out+=`<line x1="${pa.x}" y1="${pa.y}" x2="${pb.x}" y2="${pb.y}" stroke="var(--ink)" stroke-width="${t+2/M.zoom}" stroke-linecap="round"/>`; }
  for(const w of M.walls){ const [a,b]=wallNodes(w),pa=pxOf(a),pb=pxOf(b),t=w.thick*PPF; const on=isSel("wall",w.id);
    out+=`<line x1="${pa.x}" y1="${pa.y}" x2="${pb.x}" y2="${pb.y}" stroke="${on?'var(--sel)':'#c9d2e0'}" stroke-width="${t}" stroke-linecap="round"/>`; }
  for(const o of M.openings) out+=openingSvg(o);
  for(const w of M.walls) out+=dimSvg(w);
  if(M.draft&&M.draft.pts.length) out+=draftSvg();
  if(M.curve) out+=curvePreviewSvg();
  // room rect / marquee previews
  if(M.drag&&M.drag.kind==="roomrect"&&M.drag.cur){ const a=M.drag.start,b=M.drag.cur;
    out+=`<rect x="${Math.min(a.x,b.x)*PPF}" y="${Math.min(a.y,b.y)*PPF}" width="${Math.abs(a.x-b.x)*PPF}" height="${Math.abs(a.y-b.y)*PPF}" fill="rgba(47,123,255,.08)" stroke="var(--sel)" stroke-width="${1.5/M.zoom}" stroke-dasharray="${6/M.zoom} ${4/M.zoom}"/>`; }
  if(M.drag&&M.drag.kind==="marquee"&&M.drag.cur){ const a=M.drag.start,b=M.drag.cur;
    out+=`<rect x="${Math.min(a.x,b.x)*PPF}" y="${Math.min(a.y,b.y)*PPF}" width="${Math.abs(a.x-b.x)*PPF}" height="${Math.abs(a.y-b.y)*PPF}" fill="rgba(47,123,255,.06)" stroke="var(--sel)" stroke-width="${1/M.zoom}" stroke-dasharray="${4/M.zoom} ${3/M.zoom}"/>`; }
  // node handles
  const showHandles = M.tool==="select";
  for(const id in M.nodes){ const p=pxOf(M.nodes[id]); const on=isSel("node",id);
    if(showHandles||on) out+=`<circle cx="${p.x}" cy="${p.y}" r="${(on?5:3.2)/M.zoom}" fill="${on?'var(--sel)':'#fff'}" stroke="var(--sel)" stroke-width="${1.4/M.zoom}"/>`; }
  if(M.hoverSnap){ const p=pxOf(M.hoverSnap); out+=`<circle cx="${p.x}" cy="${p.y}" r="${5/M.zoom}" fill="none" stroke="var(--accent)" stroke-width="${1.4/M.zoom}"/>`; }
  world.innerHTML=out;
  paintOverlay();
  renderProps(); renderHint();
}
/* Sim heatmap overlay — painted on a canvas aligned to the SVG viewport so it
   pans/zooms with the drawing (repainted every render). ov = {cols,rows,res,
   x0,y0,cells:[rgba|null]} in feet. */
function paintOverlay(){
  const cv=q("overlay"); if(!cv) return;
  const box=cv.parentElement.getBoundingClientRect();
  const cw=Math.max(1,Math.round(box.width)), ch=Math.max(1,Math.round(box.height));
  if(cv.width!==cw||cv.height!==ch){ cv.width=cw; cv.height=ch; }
  const ctx=cv.getContext("2d"); ctx.clearRect(0,0,cw,ch);
  const ov=M.simOverlay; if(!ov) return;
  const s=PPF*M.zoom, rx=(ov.resX||ov.res), ry=(ov.resY||ov.res);
  const pxW=rx*s+1, pxH=ry*s+1;
  for(let r=0;r<ov.rows;r++){ for(let c=0;c<ov.cols;c++){ const col=ov.cells[r*ov.cols+c]; if(!col) continue;
    const sx=M.panX+(ov.x0+c*rx)*s, sy=M.panY+(ov.y0+r*ry)*s;
    ctx.fillStyle=col; ctx.fillRect(sx,sy,pxW,pxH); } }
}
function setOverlay(ov){ M.simOverlay=ov; paintOverlay(); }
function clearOverlay(){ M.simOverlay=null; const cv=q("overlay"); if(cv){ const ctx=cv.getContext("2d"); ctx.clearRect(0,0,cv.width,cv.height); } }
function setSimOut(html){ const o=q("simOut"); if(o) o.innerHTML=html; }
function elementSvg(inst){
  const def=defOf(inst.defId); const on=isSel("element",inst.id);
  const cxp=inst.x*PPF, cyp=inst.y*PPF, wp=inst.w*PPF, hp=inst.h*PPF, rot=inst.rot||0;
  const fill = on?'rgba(47,123,255,.20)':'rgba(120,140,170,.16)';
  const stroke = on?'var(--sel)':(def&&def.color?def.color:'#7c8aa8');
  let s=`<g transform="rotate(${rot} ${cxp} ${cyp})">`;
  const sh=def&&def.shapes&&def.shapes[0];
  if(sh&&sh.type==="polygon"&&Array.isArray(sh.points)){
    const pts=sh.points.map(p=>`${(inst.x-inst.w/2+p.x/100*inst.w)*PPF},${(inst.y-inst.h/2+p.y/100*inst.h)*PPF}`).join(" ");
    s+=`<polygon points="${pts}" fill="${fill}" stroke="${stroke}" stroke-width="${1.6/M.zoom}"/>`;
  } else if(sh&&sh.type==="ellipse"){
    s+=`<ellipse cx="${cxp}" cy="${cyp}" rx="${wp/2}" ry="${hp/2}" fill="${fill}" stroke="${stroke}" stroke-width="${1.6/M.zoom}"/>`;
  } else {
    s+=`<rect x="${cxp-wp/2}" y="${cyp-hp/2}" width="${wp}" height="${hp}" rx="${2.5/M.zoom}" fill="${fill}" stroke="${stroke}" stroke-width="${1.6/M.zoom}"/>`;
  }
  s+=`</g>`;
  const label=def?(def.short||def.label||inst.defId):inst.defId;
  s+=`<text x="${cxp}" y="${cyp+3/M.zoom}" text-anchor="middle" font-family="var(--sans)" font-size="${10.5/M.zoom}" fill="#3a4658" font-weight="600" pointer-events="none">${esc(label)}</text>`;
  if(on){ s+=`<circle cx="${cxp}" cy="${cyp}" r="${4/M.zoom}" fill="none" stroke="var(--sel)" stroke-width="${1.2/M.zoom}"/>`; }
  return s;
}
function dimSvg(w){ const [a,b]=wallNodes(w); const L=dist(a,b); if(L<0.4)return"";
  const pa=pxOf(a),pb=pxOf(b); const mx=(pa.x+pb.x)/2,my=(pa.y+pb.y)/2;
  let nx=-(pb.y-pa.y),ny=(pb.x-pa.x); const nl=Math.hypot(nx,ny)||1; nx/=nl;ny/=nl;
  const off=(w.thick*PPF/2)+11/M.zoom; const tx=mx+nx*off,ty=my+ny*off;
  let ang=Math.atan2(pb.y-pa.y,pb.x-pa.x)*180/Math.PI; if(ang>90||ang<-90)ang+=180;
  return `<text x="${tx}" y="${ty}" text-anchor="middle" transform="rotate(${ang} ${tx} ${ty})" font-family="var(--mono)" font-size="${10.5/M.zoom}" fill="#7a8496">${dim(L)}</text>`; }
function openingSvg(o){ const w=M.walls.find(x=>x.id===o.wall); if(!w)return"";
  const [a,b]=wallNodes(w); const dir={x:b.x-a.x,y:b.y-a.y}; const L=Math.hypot(dir.x,dir.y)||1; dir.x/=L;dir.y/=L;
  const perp={x:-dir.y,y:dir.x}; const c=lerp(a,b,o.t); const cp=pxOf(c); const half=(o.w/2)*PPF; const th=w.thick*PPF; const on=isSel("opening",o.id);
  const g1={x:cp.x-dir.x*half,y:cp.y-dir.y*half}, g2={x:cp.x+dir.x*half,y:cp.y+dir.y*half};
  let s=`<polygon points="${g1.x-perp.x*th/2},${g1.y-perp.y*th/2} ${g2.x-perp.x*th/2},${g2.y-perp.y*th/2} ${g2.x+perp.x*th/2},${g2.y+perp.y*th/2} ${g1.x+perp.x*th/2},${g1.y+perp.y*th/2}" fill="var(--paper)"/>`;
  const jamb=p=>`<line x1="${p.x-perp.x*th/2}" y1="${p.y-perp.y*th/2}" x2="${p.x+perp.x*th/2}" y2="${p.y+perp.y*th/2}" stroke="var(--ink)" stroke-width="${1/M.zoom}"/>`;
  if(o.kind==="door"){
    const style=o.style||"single", side=o.side||1, col=on?"var(--sel)":"var(--door)";
    const arc=(hx,hy,tx,ty,cx,cy,sweep)=>`<path d="M ${tx} ${ty} A ${Math.hypot(tx-hx,ty-hy)} ${Math.hypot(tx-hx,ty-hy)} 0 0 ${sweep} ${cx} ${cy}" fill="none" stroke="${col}" stroke-width="${1.3/M.zoom}" opacity=".8"/>`;
    const leaf=(hx,hy,tx,ty)=>`<line x1="${hx}" y1="${hy}" x2="${tx}" y2="${ty}" stroke="${col}" stroke-width="${2.2/M.zoom}"/>`;
    if(style==="sliding"){ const off=Math.max(2/M.zoom,th*0.55)*side, pw=Math.max(2.6/M.zoom,th*0.5);
      const P=(p,k)=>({x:p.x+perp.x*off*k,y:p.y+perp.y*off*k});
      const midA={x:cp.x+dir.x*half*0.1,y:cp.y+dir.y*half*0.1}, midB={x:cp.x-dir.x*half*0.1,y:cp.y-dir.y*half*0.1};
      const a1=P(g1,1),a2=P(midA,1),b1=P(midB,1.9),b2=P(g2,1.9);
      s+=`<line x1="${a1.x}" y1="${a1.y}" x2="${a2.x}" y2="${a2.y}" stroke="${col}" stroke-width="${pw}"/>`;
      s+=`<line x1="${b1.x}" y1="${b1.y}" x2="${b2.x}" y2="${b2.y}" stroke="${col}" stroke-width="${pw}"/>`;
    } else if(style==="double"){ const t1={x:g1.x+perp.x*side*half,y:g1.y+perp.y*side*half}, t2={x:g2.x+perp.x*side*half,y:g2.y+perp.y*side*half};
      s+=arc(g1.x,g1.y,t1.x,t1.y,cp.x,cp.y,side>0?1:0)+leaf(g1.x,g1.y,t1.x,t1.y);
      s+=arc(g2.x,g2.y,t2.x,t2.y,cp.x,cp.y,side>0?0:1)+leaf(g2.x,g2.y,t2.x,t2.y);
    } else { const hingeAtA=o.hinge!==1, hinge=hingeAtA?g1:g2, closed=hingeAtA?g2:g1, wpx=o.w*PPF;
      const tip={x:hinge.x+perp.x*side*wpx,y:hinge.y+perp.y*side*wpx};
      s+=arc(hinge.x,hinge.y,tip.x,tip.y,closed.x,closed.y,hingeAtA?(side>0?1:0):(side>0?0:1))+leaf(hinge.x,hinge.y,tip.x,tip.y); }
    s+=jamb(g1)+jamb(g2);
  } else { const col=on?"var(--sel)":"var(--window)";
    s+=`<line x1="${g1.x}" y1="${g1.y}" x2="${g2.x}" y2="${g2.y}" stroke="${col}" stroke-width="${Math.max(2/M.zoom,th*0.5)}"/>`;
    s+=`<line x1="${g1.x}" y1="${g1.y}" x2="${g2.x}" y2="${g2.y}" stroke="#eaf6f8" stroke-width="${Math.max(0.8/M.zoom,th*0.16)}"/>`; }
  if(on){ s+=`<circle cx="${cp.x}" cy="${cp.y}" r="${5/M.zoom}" fill="none" stroke="var(--sel)" stroke-width="${1.4/M.zoom}"/>`; }
  return s; }
function draftSvg(){ const pts=M.draft.pts.slice(); if(M.cursor) pts.push(M.cursor);
  let s=""; const t=M.wallThick*PPF;
  for(let i=1;i<pts.length;i++){ const pa=pxOf(pts[i-1]),pb=pxOf(pts[i]);
    s+=`<line x1="${pa.x}" y1="${pa.y}" x2="${pb.x}" y2="${pb.y}" stroke="var(--sel)" stroke-width="${t}" stroke-linecap="round" opacity=".5"/>`;
    const L=dist(pts[i-1],pts[i]); if(L>0.4){const mx=(pa.x+pb.x)/2,my=(pa.y+pb.y)/2; s+=`<text x="${mx}" y="${my-6/M.zoom}" text-anchor="middle" font-family="var(--mono)" font-size="${10.5/M.zoom}" fill="var(--sel)">${dim(L)}</text>`;} }
  for(const p of M.draft.pts){const q=pxOf(p); s+=`<circle cx="${q.x}" cy="${q.y}" r="${3.4/M.zoom}" fill="#fff" stroke="var(--sel)" stroke-width="${1.4/M.zoom}"/>`;}
  if(M.draft.pts.length){const q=pxOf(M.draft.pts[0]); s+=`<circle cx="${q.x}" cy="${q.y}" r="${5.5/M.zoom}" fill="none" stroke="var(--good)" stroke-width="${1.6/M.zoom}"/>`;}
  return s; }
function curvePreviewSvg(){ const a=M.curve.a, t=M.wallThick*PPF; let s="";
  const dot=(p,col,r)=>{const q=pxOf(p); return `<circle cx="${q.x}" cy="${q.y}" r="${(r||3.4)/M.zoom}" fill="#fff" stroke="${col}" stroke-width="${1.4/M.zoom}"/>`;};
  if(!M.curve.m){ if(M.cursor){ const pa=pxOf(a),pb=pxOf(M.cursor); s+=`<line x1="${pa.x}" y1="${pa.y}" x2="${pb.x}" y2="${pb.y}" stroke="var(--sel)" stroke-width="${1.5/M.zoom}" stroke-dasharray="${5/M.zoom} ${4/M.zoom}" opacity=".6"/>`; } s+=dot(a,"var(--good)",5.5); }
  else { const b=M.cursor||M.curve.m; const px=curveSamples(a,M.curve.m,b,16).map(p=>pxOf(p)); const d="M "+px.map(p=>`${p.x} ${p.y}`).join(" L ");
    s+=`<path d="${d}" fill="none" stroke="var(--sel)" stroke-width="${t}" stroke-linecap="round" opacity=".5"/>`; s+=dot(a,"var(--good)",5.5)+dot(M.curve.m,"var(--accent)",4.5); }
  return s; }

// ============================ properties + palette ============================
function renderProps(){
  if(!propsEl) return; let h="";
  if(M.selSet.length>1){
    const cnt={}; M.selSet.forEach(s=>cnt[s.kind]=(cnt[s.kind]||0)+1);
    h+=`<h3>${M.selSet.length} items selected</h3><div class="sub">${Object.entries(cnt).map(([k,n])=>`${n} ${k}${n>1?"s":""}`).join(" · ")} — drag any to move the group.</div>`;
    h+=delBtn(); propsEl.innerHTML=h; wireProps(); return;
  }
  if(!M.sel){
    h+=`<h3>Elements</h3><div class="sub">Click a machine/amenity below, then click on the plan to place it. Drag to move; rotate in its panel.</div>`;
    h+=paletteHtml();
    h+=`<h3 style="margin-top:14px">Drawing</h3>`;
    h+=field("Wall thickness ("+ulbl()+")","wallThick",valLen(M.wallThick));
    h+=`<div class="pf"><label>Door / window width (${ulbl()})</label><div class="row"><input type="number" id="eng-pDoorW" step="0.25" value="${valLen(M.doorW)}"><input type="number" id="eng-pWinW" step="0.25" value="${valLen(M.windowW)}"></div></div>`;
    propsEl.innerHTML=h; wireProps(); return;
  }
  const {kind,id}=M.sel;
  if(kind==="element"){ const e=M.elements.find(x=>x.id===id); const def=defOf(e.defId);
    h+=`<h3>${esc(def?(def.label||def.short):"Element")}</h3><div class="sub">${esc((def&&def.elementClass)||"tool")} · drag to move</div>`;
    h+=`<div class="pf"><label>Size (${ulbl()})</label><div class="row"><input type="number" id="eng-eW" step="0.25" min="0.5" value="${valLen(e.w)}"><input type="number" id="eng-eH" step="0.25" min="0.5" value="${valLen(e.h)}"></div></div>`;
    h+=`<div class="pf"><label>Rotation</label><div class="row"><input type="number" id="eng-eRot" step="15" value="${Math.round(e.rot||0)}"><button class="fpb-btn" id="eng-eRotL">⟲ 15°</button><button class="fpb-btn" id="eng-eRotR">⟳ 15°</button></div></div>`;
    h+=readRow("Position",`${dim(e.x)}, ${dim(e.y)}`);
    if(def && (Number.isFinite(def.dba_active)||(def.variableAttrs&&Number.isFinite(def.variableAttrs.noiseDb)))) h+=readRow("Operating noise", (def.dba_active||def.variableAttrs.noiseDb)+" dBA");
    if(def && Number.isFinite(def.risk)) h+=readRow("Risk", String(def.risk));
    h+=delBtn();
  } else if(kind==="wall"){ const w=M.walls.find(x=>x.id===id);
    h+=`<h3>Wall</h3><div class="sub">Shared corners; drag either to reshape.</div>`; h+=readRow("Length",dim(wallLenFt(w)));
    h+=field("Thickness ("+ulbl()+")","wThick",valLen(w.thick)); h+=delBtn();
  } else if(kind==="node"){ const n=M.nodes[id];
    h+=`<h3>Corner</h3><div class="sub">Junction of ${M.walls.filter(w=>w.a===id||w.b===id).length} wall(s).</div>`;
    h+=`<div class="pf"><label>Position (${ulbl()})</label><div class="row"><input type="number" id="eng-nX" step="0.25" value="${valLen(n.x)}"><input type="number" id="eng-nY" step="0.25" value="${valLen(n.y)}"></div></div>`; h+=delBtn();
  } else if(kind==="opening"){ const o=M.openings.find(x=>x.id===id);
    h+=`<h3>${o.kind==="door"?"Door":"Window"}</h3><div class="sub">Slides along its wall.</div>`;
    h+=`<div class="pf"><label>Width (${ulbl()})</label><input type="number" id="eng-oW" step="0.25" min="0.5" value="${valLen(o.w)}"></div>`;
    if(o.kind==="door"){ const st=o.style||"single";
      h+=`<div class="pf"><label>Type</label><div class="fpb-seg" id="eng-doorStyleSeg" style="width:100%"><button data-style="single" class="${st==="single"?"on":""}" style="flex:1">Single</button><button data-style="double" class="${st==="double"?"on":""}" style="flex:1">Double</button><button data-style="sliding" class="${st==="sliding"?"on":""}" style="flex:1">Sliding</button></div></div>`;
      if(st!=="sliding") h+=`<div class="btn-row"><button class="fpb-btn" id="eng-flipHinge">⇄ Flip hinge</button><button class="fpb-btn" id="eng-flipSwing">⤢ Flip swing</button></div>`;
      h+=`<label class="fpb-chk" style="margin:8px 0 2px;display:flex;gap:6px;align-items:center"><input type="checkbox" id="eng-oExit" ${o.exit?"checked":""}> Egress exit (seeds travel-distance)</label>`;
    }
    h+=delBtn();
  } else if(kind==="room"){ const r=M.rooms.find(x=>x.id===id);
    h+=`<h3>Room</h3><div class="sub">${areaTxt(polyArea(r.nodes))} · ${r.nodes.length} corners</div>`;
    h+=`<div class="pf"><label>Name</label><input type="text" id="eng-rName" value="${esc(r.name)}" style="font-family:var(--sans)"></div>`; h+=delBtn();
  }
  propsEl.innerHTML=h; wireProps();
}
function paletteHtml(){
  const defs=libDefs();
  if(!defs.length) return `<div class="sub" style="color:var(--mute)">No tools/amenities in the library yet. Import an elements bundle to populate it.</div>`;
  const groups={tool:[],amenity:[],other:[]};
  defs.forEach(d=>{ const g=d.elementClass==="amenity"?"amenity":(d.elementClass&&d.elementClass!=="tool"?"other":"tool"); groups[g].push(d); });
  let h=`<div class="eng-pal">`;
  const chip=d=>`<button class="eng-chip${M.placingDefId===d.id?" on":""}" data-place="${esc(d.id)}" title="${esc(d.label||d.id)}"><span class="eng-sw" style="background:${d.color||'#8b95a8'}"></span>${esc(d.short||d.label||d.id)}</button>`;
  if(groups.tool.length)   h+=`<div class="eng-pal-h">Tools</div>`+groups.tool.map(chip).join("");
  if(groups.amenity.length)h+=`<div class="eng-pal-h">Safety / Amenity</div>`+groups.amenity.map(chip).join("");
  if(groups.other.length)  h+=`<div class="eng-pal-h">Other</div>`+groups.other.map(chip).join("");
  h+=`</div>`;
  return h;
}
const ulbl=()=>M.unit==="m"?"m":"ft";
const valLen=ft=>M.unit==="m"?(ft*0.3048).toFixed(2):(+ft.toFixed(2));
const toUnitFt=v=>{v=parseFloat(v); if(!isFinite(v))return null; return M.unit==="m"?v/0.3048:v;};
function field(label,key,val){ return `<div class="pf"><label>${label}</label><input type="number" step="0.25" id="eng-pf_${key}" value="${val}"></div>`; }
function readRow(k,v){ return `<div class="pf-read"><span>${k}</span><b>${v}</b></div>`; }
function delBtn(){ return `<div class="btn-row"><button class="fpb-btn danger" id="eng-delSel">Delete</button></div>`; }
function wireProps(){
  const on=(id,ev,fn)=>{const e=q(id); if(e)e.addEventListener(ev,fn);};
  on("delSel","click",deleteSel);
  on("pf_wallThick","input",e=>{const v=toUnitFt(e.target.value); if(v)M.wallThick=v;});
  on("pDoorW","input",e=>{const v=toUnitFt(e.target.value); if(v)M.doorW=v;});
  on("pWinW","input",e=>{const v=toUnitFt(e.target.value); if(v)M.windowW=v;});
  on("pf_wThick","input",e=>{const v=toUnitFt(e.target.value); if(v){commitOnce();M.walls.find(w=>w.id===M.sel.id).thick=v;render();persist();}});
  on("oW","input",e=>{const v=toUnitFt(e.target.value); if(v){commitOnce();M.openings.find(o=>o.id===M.sel.id).w=v;render();persist();}});
  on("nX","input",e=>{const v=toUnitFt(e.target.value); if(v!=null){commitOnce();M.nodes[M.sel.id].x=v;render();persist();}});
  on("nY","input",e=>{const v=toUnitFt(e.target.value); if(v!=null){commitOnce();M.nodes[M.sel.id].y=v;render();persist();}});
  on("rName","input",e=>{M.rooms.find(r=>r.id===M.sel.id).name=e.target.value;persist();});
  on("oExit","change",e=>{const o=M.openings.find(o=>o.id===M.sel.id); if(o){o.exit=e.target.checked; render(); persist();}});
  on("flipHinge","click",()=>{commit();const o=M.openings.find(o=>o.id===M.sel.id);o.hinge=o.hinge===1?0:1;render();persist();});
  on("flipSwing","click",()=>{commit();const o=M.openings.find(o=>o.id===M.sel.id);o.side=(o.side||1)*-1;render();persist();});
  const seg=q("doorStyleSeg"); if(seg) seg.addEventListener("click",ev=>{const b=ev.target.closest("button"); if(!b)return; commit(); const o=M.openings.find(o=>o.id===M.sel.id); o.style=b.dataset.style; M.doorStyle=o.style; render();persist();});
  // element edits
  const eEdit=(prop,ev)=>{const el=q(prop); if(el)el.addEventListener(ev||"input",()=>{ const e=M.elements.find(x=>x.id===M.sel.id); if(!e)return;
    if(prop==="eW"){const v=toUnitFt(q("eW").value); if(v>0){commitOnce();e.w=v;}}
    if(prop==="eH"){const v=toUnitFt(q("eH").value); if(v>0){commitOnce();e.h=v;}}
    if(prop==="eRot"){const v=parseFloat(q("eRot").value)||0;commitOnce();e.rot=v;}
    render();persist(); }); };
  eEdit("eW"); eEdit("eH"); eEdit("eRot");
  on("eRotL","click",()=>{const e=M.elements.find(x=>x.id===M.sel.id); if(e){commit();e.rot=((e.rot||0)-15)%360;render();persist();}});
  on("eRotR","click",()=>{const e=M.elements.find(x=>x.id===M.sel.id); if(e){commit();e.rot=((e.rot||0)+15)%360;render();persist();}});
  // palette chips
  if(propsEl) propsEl.querySelectorAll(".eng-chip").forEach(btn=>btn.addEventListener("click",()=>{
    const idv=btn.dataset.place; M.placingDefId = (M.placingDefId===idv)?null:idv; M.tool="select"; syncTool(); render();
    flash(M.placingDefId?`Placing <b>${esc((defOf(idv)||{}).label||idv)}</b> — click on the plan. Esc to stop.`:undefined);
  }));
}

// ============================ hint / status ============================
function renderHint(){ if(!hintEl)return;
  const H={select:M.placingDefId?"Click on the plan to place · Esc to stop placing":"Click to select · drag to move · Delete to remove · Ctrl-drag to pan",
    wall:"Click to drop wall corners · click the green start dot to close a room · double-click / Esc to finish",
    curve:"Click start · a point to bend through · then the end · Esc to cancel",
    room:"Drag to draw a rectangular room", door:"Click on a wall to drop a door", window:"Click on a wall to drop a window", pan:"Drag to pan · scroll to zoom"};
  const empty=!M.walls.length&&!M.elements.length&&!M.draft;
  if(empty && M.tool==="select" && !M.placingDefId){ hintEl.style.display="block"; hintEl.innerHTML=`Pick a tool on the left, or an element on the right, and start building.`; }
  else { hintEl.style.display = "none"; }
  if(stHint) stHint.textContent=H[M.tool]||"";
}
function setStatus(ft){ if(stCur) stCur.textContent = ft? `${dim(ft.x)}, ${dim(ft.y)}` : "—"; }
function flash(msg){ if(!hintEl)return; if(!msg){renderHint();return;} hintEl.style.display="block"; hintEl.innerHTML=msg; }

// ============================ pointer interaction ============================
let space=false;
function onDown(e){
  svg.setPointerCapture&&svg.setPointerCapture(e.pointerId);
  const ft=screenToFt(e.clientX,e.clientY);
  const panning = e.button===1 || space || (e.ctrlKey&&e.button===0) || M.tool==="pan";
  if(panning){ M.drag={kind:"pan",sx:e.clientX,sy:e.clientY,px:M.panX,py:M.panY}; return; }
  // placing an element from the palette
  if(M.placingDefId && e.button===0){ const sp=snap(ft); const inst=placeElementAt(M.placingDefId,{x:sp.x,y:sp.y});
    if(inst){ setSel({kind:"element",id:inst.id}); render(); persist(); } return; }
  if(M.tool==="wall"){ wallClick(ft); return; }
  if(M.tool==="curve"){ curveClick(ft); return; }
  if(M.tool==="room"){ const sp=snap(ft); M.drag={kind:"roomrect",start:sp,cur:sp}; return; }
  if(M.tool==="door"||M.tool==="window"){ placeOpening(ft,M.tool); return; }
  // select tool
  const grab=(()=>{ const el=hitElement(ft); if(el)return{kind:"element",id:el}; const n=hitNode(ft); if(n)return{kind:"node",id:n};
    const o=hitOpening(ft); if(o)return{kind:"opening",id:o}; const w=hitWall(ft); if(w)return{kind:"wall",id:w}; const r=hitRoom(ft); if(r)return{kind:"room",id:r}; return null; })();
  if(M.selSet.length>1 && grab && isSel(grab.kind,grab.id)){ M.drag={kind:"multimove",last:ft}; return; }
  if(grab && grab.kind==="element"){ setSel(grab); M.drag={kind:"element",id:grab.id,last:ft}; render(); return; }
  if(grab && grab.kind==="node"){ setSel(grab); M.drag={kind:"node",id:grab.id}; render(); return; }
  if(grab && grab.kind==="opening"){ setSel(grab); M.drag={kind:"opening",id:grab.id}; render(); return; }
  if(grab && grab.kind==="wall"){ setSel(grab); M.drag={kind:"wall",id:grab.id,last:ft}; render(); return; }
  if(grab && grab.kind==="room"){ setSel(grab); render(); return; }
  setSel(null); M.drag={kind:"marquee",start:{x:ft.x,y:ft.y},cur:{x:ft.x,y:ft.y}}; render();
}
function onMove(e){
  const ft=screenToFt(e.clientX,e.clientY); M.cursor=null; setStatus(ft);
  if(M.drag){
    if(M.drag.kind==="pan"){ M.panX=M.drag.px+(e.clientX-M.drag.sx); M.panY=M.drag.py+(e.clientY-M.drag.sy); render(); return; }
    if(M.drag.kind==="marquee"){ M.drag.cur={x:ft.x,y:ft.y}; render(); return; }
    if(M.drag.kind==="multimove"){ if(!M.drag.moved){commit();M.drag.moved=true;} const dx=ft.x-M.drag.last.x,dy=ft.y-M.drag.last.y;
      selectedNodeIds().forEach(id=>{M.nodes[id].x+=dx;M.nodes[id].y+=dy;}); selectedElements().forEach(el=>{el.x+=dx;el.y+=dy;}); M.drag.last=ft; render(); return; }
    if(M.drag.kind==="element"){ if(!M.drag.moved){commit();M.drag.moved=true;} const e2=M.elements.find(x=>x.id===M.drag.id);
      const sp=M.snap?snap(ft):{x:ft.x,y:ft.y}; e2.x=sp.x; e2.y=sp.y; M.drag.last=ft; render(); return; }
    if(M.drag.kind==="roomrect"){ M.drag.cur=snap(ft); render(); return; }
    if(M.drag.kind==="node"){ if(!M.drag.moved){commit();M.drag.moved=true;} const sp=snap(ft); M.nodes[M.drag.id].x=sp.x;M.nodes[M.drag.id].y=sp.y; render(); return; }
    if(M.drag.kind==="opening"){ if(!M.drag.moved){commit();M.drag.moved=true;} const o=M.openings.find(o=>o.id===M.drag.id); const w=M.walls.find(x=>x.id===o.wall); const [a,b]=wallNodes(w); o.t=Math.max(0.05,Math.min(0.95,pointSeg(ft,a,b).t)); render(); return; }
    if(M.drag.kind==="wall"){ if(!M.drag.moved){commit();M.drag.moved=true;} const dx=ft.x-M.drag.last.x,dy=ft.y-M.drag.last.y; const w=M.walls.find(x=>x.id===M.drag.id); [w.a,w.b].forEach(id=>{M.nodes[id].x+=dx;M.nodes[id].y+=dy;}); M.drag.last=ft; render(); return; }
  }
  if(M.tool==="wall"||M.tool==="room"||M.tool==="curve"){ const sp=snap(ft); M.hoverSnap={x:sp.x,y:sp.y};
    if(M.tool==="wall"&&M.draft){M.cursor={x:sp.x,y:sp.y}; if(e.shiftKey&&M.draft.pts.length){const last=M.draft.pts[M.draft.pts.length-1]; if(Math.abs(sp.x-last.x)>Math.abs(sp.y-last.y))M.cursor.y=last.y; else M.cursor.x=last.x;}}
    else if(M.tool==="curve"){M.cursor={x:sp.x,y:sp.y};}
    render(); if(M.draft&&M.draft.pts.length&&stLen) stLen.textContent=dim(dist(M.draft.pts[M.draft.pts.length-1],M.cursor||sp));
  } else { if(M.hoverSnap){M.hoverSnap=null;render();} if(stLen)stLen.textContent="—"; }
}
function onUp(e){
  if(M.drag&&M.drag.kind==="roomrect"&&M.drag.cur){ finishRoomRect(M.drag.start,M.drag.cur); }
  else if(M.drag&&M.drag.kind==="marquee"){ const a=M.drag.start,b=M.drag.cur||a;
    const x1=Math.min(a.x,b.x),y1=Math.min(a.y,b.y),x2=Math.max(a.x,b.x),y2=Math.max(a.y,b.y);
    if(x2-x1<0.3&&y2-y1<0.3){ setSel(null); } else { M.selSet=marqueeSelect(x1,y1,x2,y2); M.sel=M.selSet.length===1?M.selSet[0]:null; }
    M.drag=null; render(); return; }
  if(M.drag && M.drag.moved) persist();
  M.drag=null;
}
function wallClick(ft){ const sp=snap(ft); if(!M.draft) M.draft={pts:[],nodes:[]};
  if(M.draft.pts.length>=3 && dist(sp,M.draft.pts[0])<tolFt()*1.8){ finishWall(true); return; }
  let pt={x:sp.x,y:sp.y,node:sp.node}; if(M.cursor&&M.draft.pts.length){ pt={x:M.cursor.x,y:M.cursor.y}; const nn=hitNode(pt); if(nn)pt.node=nn; }
  M.draft.pts.push(pt); M.draft.nodes.push(pt.node||null); render(); }
function finishWall(close){ if(!M.draft||M.draft.pts.length<2){ M.draft=null; render(); return; }
  commit(); const ids=M.draft.pts.map(p=>addNodeAt(p)); for(let i=1;i<ids.length;i++) addWall(ids[i-1],ids[i]);
  if(close){ addWall(ids[ids.length-1],ids[0]); if(polyArea(ids)>1) M.rooms.push({id:rI(),nodes:ids.slice(),name:"Room "+(M.rooms.length+1)}); }
  M.draft=null; M.tool="select"; syncTool(); render(); persist(); }
function finishRoomRect(a,b){ if(Math.abs(a.x-b.x)<0.5||Math.abs(a.y-b.y)<0.5){ M.drag=null; render(); return; }
  commit(); const x1=Math.min(a.x,b.x),y1=Math.min(a.y,b.y),x2=Math.max(a.x,b.x),y2=Math.max(a.y,b.y);
  const c=[{x:x1,y:y1},{x:x2,y:y1},{x:x2,y:y2},{x:x1,y:y2}].map(p=>addNodeAt(snap(p)));
  for(let i=0;i<4;i++) addWall(c[i],c[(i+1)%4]); M.rooms.push({id:rI(),nodes:c,name:"Room "+(M.rooms.length+1)});
  M.tool="select"; syncTool(); render(); persist(); }
function placeOpening(ft,kind){ const wId=hitWall(ft); if(!wId){ flash("Click directly on a wall to place a "+kind+"."); return; }
  commit(); const w=M.walls.find(x=>x.id===wId); const [a,b]=wallNodes(w); const t=Math.max(0.1,Math.min(0.9,pointSeg(ft,a,b).t));
  const o={id:oI(),wall:wId,t,w:kind==="door"?M.doorW:M.windowW,kind,side:1,hinge:0,style:kind==="door"?(M.doorStyle||"single"):undefined};
  M.openings.push(o); setSel({kind:"opening",id:o.id}); M.tool="select"; syncTool(); render(); persist(); }
function curveClick(ft){ const sp=snap(ft);
  if(!M.curve){ M.curve={a:{x:sp.x,y:sp.y,node:sp.node}}; render(); return; }
  if(!M.curve.m){ M.curve.m={x:sp.x,y:sp.y}; render(); return; }
  finishCurve(M.curve.a,M.curve.m,{x:sp.x,y:sp.y,node:sp.node}); M.curve=null; }
function curveSamples(a,m,b,N){ const cx=2*m.x-0.5*(a.x+b.x),cy=2*m.y-0.5*(a.y+b.y); const out=[];
  for(let i=0;i<=N;i++){ const t=i/N,u=1-t; out.push({x:u*u*a.x+2*u*t*cx+t*t*b.x,y:u*u*a.y+2*u*t*cy+t*t*b.y}); } return out; }
function finishCurve(a,m,b){ const N=14, pts=curveSamples(a,m,b,N); commit();
  const ids=pts.map((p,i)=>{ if(i===0&&a.node)return a.node; if(i===N&&b.node)return b.node; return addNodeAt({x:p.x,y:p.y}); });
  for(let i=1;i<ids.length;i++) addWall(ids[i-1],ids[i]); M.tool="select"; syncTool(); render(); persist(); }

// ============================ chrome / mount ============================
function q(id){ return root? root.querySelector("#eng-"+id) : null; }
const RAIL=[["select","Select","M5 3l6 15 2-6 6-2z",true],["wall","Wall","M4 18h16M4 18V8m16 10V6M4 8l8-3 8 1",false],
  ["curve","Curve","M4 19C4 9 20 9 20 19",false],["room","Room","",false],["door","Door","M6 20V4h8v16M14 8a8 8 0 0 1 6 6",false],
  ["window","Window","",false],["pan","Pan","M9 11V5a1.5 1.5 0 0 1 3 0v6",false]];
function buildChrome(){
  injectCss();
  root.classList.add("eng-root");
  root.innerHTML=`
    <div class="eng-top">
      <div class="fpb-brand"><span class="logo"></span>Layout <small>feet · engine</small></div>
      <div class="spacer"></div>
      <div class="fpb-ctl" title="Grid square size">Grid <input id="eng-gridSize" type="number" min="0.25" step="0.25" value="1"> <span class="k" id="eng-unitLbl">ft</span></div>
      <div class="fpb-seg" id="eng-unitSeg"><button data-unit="ft" class="on">ft-in</button><button data-unit="m">m</button></div>
      <label class="fpb-chk"><input type="checkbox" id="eng-snapChk" checked> Snap</label>
      <label class="fpb-chk"><input type="checkbox" id="eng-gridChk" checked> Grid</label>
      <div class="fpb-seg"><button id="eng-zoomOut">–</button><button id="eng-zoomReset" style="min-width:52px">100%</button><button id="eng-zoomIn">+</button></div>
      <button class="fpb-btn icon" id="eng-undoBtn" title="Undo">↶</button>
      <button class="fpb-btn icon" id="eng-redoBtn" title="Redo">↷</button>
    </div>
    <div class="eng-rail" id="eng-rail">${RAIL.map(([t,lbl,path,on])=>`<button class="tool${on?" on":""}" data-tool="${t}" title="${lbl}"><svg viewBox="0 0 24 24">${t==="room"?'<rect x="4" y="5" width="16" height="14" rx="1"/>':t==="window"?'<rect x="4" y="8" width="16" height="8"/><path d="M12 8v8M4 12h16"/>':`<path d="${path}" fill="none"/>`}</svg>${lbl}</button>`).join("")}</div>
    <div class="eng-canvas"><svg id="eng-paper"><g id="eng-world"></g></svg>
      <canvas id="eng-overlay"></canvas>
      <div class="fpb-hint" id="eng-hint"></div>
      <div class="eng-sim" id="eng-sim">
        <div class="eng-sim-btns">
          <button data-sim="ada" title="ADA clearance / corridor widths">ADA</button>
          <button data-sim="egress" title="Egress travel distance to exits">Egress</button>
          <button data-sim="noise" title="Noise (dBA) with wall STC">Noise</button>
          <button data-sim="fire" title="Fire hazard vs. extinguisher coverage">Fire</button>
          <button data-sim="fumes" title="Fumes / odor dispersion">Fumes</button>
          <button data-sim="rules" title="Safety &amp; adjacency rule checks">✓ Rules</button>
          <button data-sim="clear" class="ghost" title="Clear the overlay">Clear</button>
        </div>
        <div class="eng-sim-out" id="eng-simOut">Draw a layout &amp; place elements, then run a simulation.</div>
      </div>
    </div>
    <div class="fpb-props" id="eng-props"></div>
    <div class="fpb-status"><span><span class="k">Cursor</span> <b id="eng-stCur">—</b></span><span><span class="k">Length</span> <b id="eng-stLen">—</b></span><span class="spacer" style="flex:1"></span><span id="eng-stHint" class="k"></span></div>`;
  svg=q("paper"); world=q("world"); propsEl=q("props"); hintEl=q("hint"); stCur=q("stCur"); stLen=q("stLen"); stHint=q("stHint");
  // events
  svg.addEventListener("pointerdown",onDown);
  svg.addEventListener("pointermove",onMove);
  svg.addEventListener("pointerup",onUp);
  svg.addEventListener("dblclick",()=>{ if(M.tool==="wall") finishWall(); });
  svg.addEventListener("wheel",e=>{ e.preventDefault(); const r=svg.getBoundingClientRect(); const mx=e.clientX-r.left,my=e.clientY-r.top;
    const f=e.deltaY<0?1.12:1/1.12; const nz=Math.max(0.2,Math.min(6,M.zoom*f)); M.panX=mx-(mx-M.panX)*(nz/M.zoom); M.panY=my-(my-M.panY)*(nz/M.zoom); M.zoom=nz; zoomLbl(); render(); },{passive:false});
  q("rail").addEventListener("click",e=>{ const t=e.target.closest(".tool"); if(!t)return; M.tool=t.dataset.tool; M.placingDefId=null; if(M.tool!=="wall")M.draft=null; if(M.tool!=="curve")M.curve=null; syncTool(); render(); });
  q("zoomIn").onclick=()=>{M.zoom=Math.min(6,M.zoom*1.15);zoomLbl();render();};
  q("zoomOut").onclick=()=>{M.zoom=Math.max(.2,M.zoom/1.15);zoomLbl();render();};
  q("zoomReset").onclick=()=>{M.zoom=1;M.panX=80;M.panY=80;zoomLbl();render();};
  q("snapChk").onchange=e=>M.snap=e.target.checked;
  q("gridChk").onchange=e=>{M.grid=e.target.checked;render();};
  q("gridSize").onchange=e=>{const v=parseFloat(e.target.value); if(v>0){M.gridFt=M.unit==="m"?v/0.3048:v;render();}};
  q("unitSeg").addEventListener("click",e=>{const b=e.target.closest("button");if(!b)return;M.unit=b.dataset.unit;
    q("unitSeg").querySelectorAll("button").forEach(x=>x.classList.toggle("on",x===b)); q("unitLbl").textContent=M.unit;
    q("gridSize").value=M.unit==="m"?(M.gridFt*0.3048).toFixed(2):+M.gridFt.toFixed(2); render();});
  q("undoBtn").onclick=undo; q("redoBtn").onclick=redo;
  // simulation bar
  const simBtns=q("sim") && q("sim").querySelector(".eng-sim-btns");
  if(simBtns) simBtns.addEventListener("click",e=>{ const b=e.target.closest("button"); if(!b)return; const k=b.dataset.sim;
    if(k==="rules"){ if(window.EngineRules && EngineRules.toggle) EngineRules.toggle(); return; }
    if(k==="clear"){ clearOverlay(); simBtns.querySelectorAll("button[data-sim]:not([data-sim=rules])").forEach(x=>x.classList.remove("on")); setSimOut("Overlay cleared. Run a simulation to see results."); return; }
    simBtns.querySelectorAll("button").forEach(x=>x.classList.toggle("on",x===b));
    if(window.EngineSim && typeof window.EngineSim.run==="function") window.EngineSim.run(k);
    else setSimOut("<span class='bad'>Simulation module not loaded.</span>"); });
  new ResizeObserver(()=>render()).observe(svg);
}
function syncTool(){ if(!root)return; root.querySelectorAll(".tool").forEach(t=>t.classList.toggle("on",t.dataset.tool===M.tool));
  svg.style.cursor = M.placingDefId?"copy":(M.tool==="pan"?"grab":(M.tool==="select"?"default":"crosshair")); }
function zoomLbl(){ const z=q("zoomReset"); if(z)z.textContent=Math.round(M.zoom*100)+"%"; }

function onKey(e){
  if(!_mounted) return;
  if(e.target && e.target.matches && e.target.matches("input,select,textarea")) return;
  if(!root || !root.isConnected || root.offsetParent===null) return;   // only when visible
  if(e.type==="keyup"){ if(e.key===" "){space=false;syncTool();} else if((e.key==="Control"||e.key==="Meta")&&!space){syncTool();} return; }
  if(e.key===" "){space=true;svg.style.cursor="grab";}
  else if(e.key==="Control"||e.key==="Meta"){ if(!M.drag) svg.style.cursor="grab"; }
  else if(e.key==="Escape"){ if(M.placingDefId){M.placingDefId=null;} else if(M.curve){M.curve=null;} else if(M.draft){finishWall();} M.sel=null;M.selSet=[];render(); }
  else if(e.key==="Delete"||e.key==="Backspace"){ deleteSel(); }
  else if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="z"){ e.preventDefault(); e.shiftKey?redo():undo(); }
  else if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="y"){ e.preventDefault(); redo(); }
  else if(!e.ctrlKey&&!e.metaKey){ const m={v:"select",w:"wall",c:"curve",r:"room",d:"door",n:"window",h:"pan"}[e.key.toLowerCase()]; if(m){M.tool=m;M.placingDefId=null;if(m!=="wall")M.draft=null;if(m!=="curve")M.curve=null;syncTool();render();} }
}

// ============================ persistence ============================
function persist(){
  if(typeof state==="undefined") return;
  state.engineModel = { nodes:M.nodes, walls:M.walls, openings:M.openings, rooms:M.rooms, elements:M.elements,
    gridFt:M.gridFt, unit:M.unit, uid };
  if(typeof saveAppState==="function") saveAppState();
}
function loadFromState(){
  if(typeof state==="undefined" || !state.engineModel) return false;
  const m=state.engineModel;
  M.nodes=m.nodes||{}; M.walls=m.walls||[]; M.openings=m.openings||[]; M.rooms=m.rooms||[]; M.elements=m.elements||[];
  if(m.gridFt)M.gridFt=m.gridFt; if(m.unit)M.unit=m.unit; if(m.uid)uid=m.uid;
  return true;
}

function injectCss(){
  if(document.getElementById("eng-css")) return;
  const css=`
  .eng-root{position:absolute;inset:0;display:grid;grid-template-columns:56px 1fr 264px;grid-template-rows:44px 1fr 28px;
    grid-template-areas:"top top top" "rail canvas props" "rail status status";
    --chrome:#12161f;--panel:#1a2030;--panel-2:#222a3b;--line:#2f3a4f;--text:#e7ecf5;--dim:#9aa6bd;--mute:#6c7890;
    --accent:#4f9dff;--accent-2:#6fb0ff;--paper:#ffffff;--ink:#33404f;--grid-min:#e9edf3;--grid-maj:#d3dbe8;
    --door:#e0913a;--window:#2fa9bd;--sel:#2f7bff;--good:#39b57a;--bad:#e5545c;
    --mono:ui-monospace,Consolas,monospace;--sans:ui-sans-serif,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;
    background:var(--chrome);color:var(--text);font-family:var(--sans);font-size:13px;user-select:none;z-index:1}
  .eng-root *,.eng-root *::before,.eng-root *::after{box-sizing:border-box}
  .eng-top{grid-area:top;display:flex;align-items:center;gap:12px;padding:0 12px;background:linear-gradient(180deg,#171d29,#12161f);border-bottom:1px solid var(--line)}
  .eng-root .fpb-brand{display:flex;align-items:center;gap:9px;font-weight:650}
  .eng-root .fpb-brand .logo{width:18px;height:18px;border:2px solid var(--accent);border-radius:4px}
  .eng-root .fpb-brand small{color:var(--mute);font-weight:500;font-size:11px}
  .eng-root .spacer{flex:1}
  .eng-root .fpb-ctl{display:flex;align-items:center;gap:6px;color:var(--dim);font-size:12px}
  .eng-root .fpb-ctl input{width:52px;background:var(--panel-2);color:var(--text);border:1px solid var(--line);border-radius:5px;padding:4px 6px;font:12px var(--mono)}
  .eng-root .fpb-btn{background:var(--panel-2);border:1px solid var(--line);color:var(--text);border-radius:6px;padding:6px 10px;font-size:12px;cursor:pointer;display:inline-flex;align-items:center;gap:6px}
  .eng-root .fpb-btn:hover{background:#2a3550}.eng-root .fpb-btn:disabled{opacity:.4;cursor:default}.eng-root .fpb-btn.icon{padding:6px 8px}
  .eng-root .fpb-btn.danger{color:#ffd7d9;border-color:#5a2a2f;background:#2a1a1d}
  .eng-root .fpb-seg{display:flex;background:var(--panel-2);border:1px solid var(--line);border-radius:6px;overflow:hidden}
  .eng-root .fpb-seg button{background:transparent;border:0;color:var(--dim);padding:6px 9px;cursor:pointer;font-size:12px}
  .eng-root .fpb-seg button.on{background:var(--accent);color:#08111f;font-weight:600}
  .eng-root .fpb-chk{display:flex;align-items:center;gap:6px;color:var(--dim);font-size:12px;cursor:pointer}
  .eng-rail{grid-area:rail;background:var(--panel);border-right:1px solid var(--line);display:flex;flex-direction:column;align-items:center;gap:6px;padding:8px 0}
  .eng-root .tool{width:42px;height:42px;border-radius:9px;border:1px solid transparent;background:transparent;color:var(--dim);cursor:pointer;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;font-size:8.5px}
  .eng-root .tool svg{width:20px;height:20px;stroke:currentColor;fill:none;stroke-width:1.7}
  .eng-root .tool:hover{color:var(--text);background:var(--panel-2)}
  .eng-root .tool.on{color:#08111f;background:var(--accent);border-color:var(--accent)}.eng-root .tool.on svg{stroke:#08111f}
  .eng-canvas{grid-area:canvas;position:relative;overflow:hidden;background:#0c0f16}
  #eng-paper{position:absolute;inset:0;width:100%;height:100%;display:block;cursor:crosshair;touch-action:none}
  .eng-root .fpb-hint{position:absolute;left:50%;top:14px;transform:translateX(-50%);background:rgba(20,26,38,.92);border:1px solid var(--line);color:var(--dim);padding:6px 12px;border-radius:20px;font-size:12px;pointer-events:none;max-width:80%;text-align:center}
  .eng-root .fpb-hint b{color:var(--accent-2)}
  .eng-root .fpb-props{grid-area:props;background:var(--panel);border-left:1px solid var(--line);overflow:auto;padding:12px}
  .eng-root .fpb-props h3{margin:0 0 4px;font-size:11px;letter-spacing:.7px;text-transform:uppercase;color:var(--mute);font-weight:600}
  .eng-root .fpb-props .sub{color:var(--dim);font-size:12px;margin-bottom:12px}
  .eng-root .pf{display:flex;flex-direction:column;gap:5px;margin-bottom:12px}
  .eng-root .pf label{font-size:11px;text-transform:uppercase;color:var(--mute);font-weight:600}
  .eng-root .pf input,.eng-root .pf select{background:var(--panel-2);color:var(--text);border:1px solid var(--line);border-radius:6px;padding:7px 8px;font:13px var(--mono)}
  .eng-root .pf .row{display:flex;gap:8px}.eng-root .pf .row>*{flex:1}
  .eng-root .pf-read{display:flex;justify-content:space-between;font-size:12.5px;padding:5px 0;border-bottom:1px dashed var(--line)}
  .eng-root .pf-read span{color:var(--dim)}.eng-root .pf-read b{font-family:var(--mono);color:var(--text)}
  .eng-root .btn-row{display:flex;gap:8px;margin-top:6px}.eng-root .btn-row .fpb-btn{flex:1;justify-content:center}
  .eng-pal{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px}
  .eng-pal-h{width:100%;font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--mute);margin:6px 0 2px;font-weight:600}
  .eng-chip{display:inline-flex;align-items:center;gap:6px;background:var(--panel-2);border:1px solid var(--line);color:var(--text);border-radius:14px;padding:4px 9px;font-size:11.5px;cursor:pointer}
  .eng-chip:hover{background:#2a3550}.eng-chip.on{background:var(--accent);color:#08111f;border-color:var(--accent);font-weight:600}
  .eng-sw{width:9px;height:9px;border-radius:2px;display:inline-block}
  .eng-root .fpb-status{grid-area:status;display:flex;align-items:center;gap:16px;padding:0 12px;background:var(--panel);border-top:1px solid var(--line);color:var(--dim);font:11.5px var(--mono)}
  .eng-root .fpb-status b{color:var(--text)}.eng-root .fpb-status .k{color:var(--mute)}
  #eng-overlay{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:1}
  .eng-sim{position:absolute;left:10px;bottom:10px;z-index:3;background:rgba(20,26,38,.94);border:1px solid var(--line);border-radius:8px;padding:8px;width:238px;color:var(--dim);font-size:11.5px}
  .eng-sim-btns{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:7px}
  .eng-sim-btns button{background:var(--panel-2);border:1px solid var(--line);color:var(--text);border-radius:6px;padding:5px 8px;font-size:11px;cursor:pointer}
  .eng-sim-btns button:hover{background:#2a3550}
  .eng-sim-btns button.on{background:var(--accent);color:#08111f;font-weight:600;border-color:var(--accent)}
  .eng-sim-btns button.ghost{color:var(--dim)}
  .eng-sim-out{line-height:1.55}.eng-sim-out b{color:var(--text)}
  .eng-sim-out .r{display:flex;justify-content:space-between;gap:8px}
  .eng-sim-out .good{color:var(--good)}.eng-sim-out .warn{color:var(--door)}.eng-sim-out .bad{color:var(--bad)}`;
  const st=document.createElement("style"); st.id="eng-css"; st.textContent=css; document.head.appendChild(st);
}

// ============================ public API ============================
function mount(rootEl){
  root = (typeof rootEl==="string") ? document.getElementById(rootEl) : rootEl;
  if(!root){ console.warn("[engine] mount root not found"); return; }
  buildChrome();
  loadFromState();
  _mounted=true;
  window.addEventListener("keydown",onKey);
  window.addEventListener("keyup",onKey);
  zoomLbl(); syncTool();
  requestAnimationFrame(()=>render());
  return API;
}
const API = {
  mount, render, resetView:()=>{M.zoom=1;M.panX=80;M.panY=80;zoomLbl();render();},
  setTool:(t)=>{M.tool=t;M.placingDefId=null;syncTool();render();},
  place:(defId)=>{M.placingDefId=defId;M.tool="select";syncTool();render();flash(`Placing — click on the plan.`);},
  refreshPalette:()=>{ if(!M.sel) renderProps(); },
  getModel:()=>({nodes:M.nodes,walls:M.walls,openings:M.openings,rooms:M.rooms,elements:M.elements,gridFt:M.gridFt,unit:M.unit}),
  setModel:(m)=>{ if(!m)return; M.nodes=m.nodes||{};M.walls=m.walls||[];M.openings=m.openings||[];M.rooms=m.rooms||[];M.elements=m.elements||[]; if(m.gridFt)M.gridFt=m.gridFt; if(m.unit)M.unit=m.unit; M.hist=[];M.future=[]; render(); persist(); },
  setOverlay, clearOverlay, setSimOut,
  viewport:()=>({panX:M.panX,panY:M.panY,zoom:M.zoom,PPF}),
  defOf,
  _M:M,
};
window.Engine = API;

})();
