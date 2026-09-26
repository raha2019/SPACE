"use strict";
/* ==================================================================
   ENGINE SIMULATIONS  (v3 re-platform — Phase 2)
   Feet-native simulations that read the Layout Engine model directly
   (walls/rooms/openings + element instances) — NO %-of-stage layer.
   Reuses the existing pure algorithm cores + constants from sim_*.js:
     _adaDistanceTransform, _egressBFS, _egressMaxDeadEnd,
     _noiseWallCrossings, _noiseRefDist, _ptInRotRect, _ptInRotEllipse,
     _adaIsBlocking, _egressIsBlocking, clamp, and the NFPA/ADA/OSHA/
     NOISE/FIRE/FUMES constants — so the math matches the old sims.
   Paints an overlay aligned to the engine viewport and writes a compact
   result readout via Engine.setOverlay / Engine.setSimOut.
   ================================================================== */
(function(){

// ---- small local geometry helpers ----
const lerp=(a,b,t)=>({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t});
const clampi=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
function pointSeg(p,a,b){ const dx=b.x-a.x,dy=b.y-a.y,L2=dx*dx+dy*dy||1e-9;
  let t=((p.x-a.x)*dx+(p.y-a.y)*dy)/L2; t=Math.max(0,Math.min(1,t));
  return { t, d:Math.hypot(p.x-(a.x+dx*t),p.y-(a.y+dy*t)) }; }
function polyAreaFt(m,ids){ let a=0; for(let i=0;i<ids.length;i++){const p=m.nodes[ids[i]],q=m.nodes[ids[(i+1)%ids.length]]; if(!p||!q)return 0; a+=p.x*q.y-q.x*p.y;} return Math.abs(a)/2; }
const CST=(n,d)=>(typeof window[n]!=="undefined"?window[n]:d);   // read a global sim constant with fallback

// ---- scene bounds (feet) ----
function sceneBBox(m){
  let x1=Infinity,y1=Infinity,x2=-Infinity,y2=-Infinity;
  const grow=(x,y)=>{ x1=Math.min(x1,x);y1=Math.min(y1,y);x2=Math.max(x2,x);y2=Math.max(y2,y); };
  for(const id in m.nodes){ grow(m.nodes[id].x,m.nodes[id].y); }
  for(const e of m.elements){ const rr=Math.hypot(e.w/2,e.h/2); grow(e.x-rr,e.y-rr); grow(e.x+rr,e.y+rr); }
  if(!isFinite(x1)) return null;
  const MG=3; x1-=MG;y1-=MG;x2+=MG;y2+=MG;
  return { x0:x1, y0:y1, W:Math.max(x2-x1,1), H:Math.max(y2-y1,1) };
}

// ---- element footprint in feet (rotated rect + operator footprint) ----
function elementFootprintFt(inst, def, includeOp){
  const cx=inst.x, cy=inst.y, Wf=inst.w, Hf=inst.h, rot=(inst.rot||0)*Math.PI/180;
  const cosR=Math.cos(rot), sinR=Math.sin(rot);
  const shapes=[{kind:"rect",cx,cy,hw:Wf/2,hh:Hf/2,ang:rot}];
  if(includeOp && def){
    const axisAng=((def.principalAxis&&def.principalAxis.angle)||0)*Math.PI/180;
    const ops=(Array.isArray(def.operatorFootprints)&&def.operatorFootprints.length)?def.operatorFootprints
      :(def.operatorFootprint&&def.operatorFootprint.type&&def.operatorFootprint.type!=="none"?[def.operatorFootprint]:[]);
    for(const op of ops){ if(!op||op.type==="none")continue;
      const dxf=((op.offsetX||0)/100)*Wf, dyf=((op.offsetY||0)/100)*Hf;
      const fx=cx+(dxf*cosR-dyf*sinR), fy=cy+(dxf*sinR+dyf*cosR);
      if(op.type==="radius"){ const r=(op.radius||15)/100; shapes.push({kind:"ellipse",cx:fx,cy:fy,rx:r*Wf,ry:r*Hf,ang:rot}); }
      else if(op.type==="shape"){ shapes.push({kind:"rect",cx:fx,cy:fy,hw:(op.w||20)/100*Wf/2,hh:(op.h||15)/100*Hf/2,ang:rot+axisAng}); }
    }
  }
  let x1=Infinity,y1=Infinity,x2=-Infinity,y2=-Infinity;
  for(const s of shapes){ const reach=(s.kind==="ellipse")?Math.max(s.rx,s.ry):Math.hypot(s.hw,s.hh);
    x1=Math.min(x1,s.cx-reach);y1=Math.min(y1,s.cy-reach);x2=Math.max(x2,s.cx+reach);y2=Math.max(y2,s.cy+reach); }
  const test=(xf,yf)=>shapes.some(s=> s.kind==="ellipse"?_ptInRotEllipse(xf,yf,s):_ptInRotRect(xf,yf,s));
  return { test, aabb:{x1,y1,x2,y2} };
}

// stamp a rotated rect (w×h @ ang, feet) into a grid, setting matched cells to `val`
function stampRot(grid,cols,rows,bb,res,cx,cy,w,h,ang,val){
  const reach=Math.hypot(w/2,h/2);
  const c1=clampi(Math.floor((cx-reach-bb.x0)/res),0,cols), c2=clampi(Math.ceil((cx+reach-bb.x0)/res),0,cols);
  const r1=clampi(Math.floor((cy-reach-bb.y0)/res),0,rows), r2=clampi(Math.ceil((cy+reach-bb.y0)/res),0,rows);
  const s={cx,cy,hw:w/2,hh:h/2,ang};
  for(let r=r1;r<r2;r++)for(let c=c1;c<c2;c++){ const px=bb.x0+(c+0.5)*res, py=bb.y0+(r+0.5)*res; if(_ptInRotRect(px,py,s)) grid[r*cols+c]=val; }
}

// ---- occupancy grid: walls+windows+blocking elements = 1; doors carved to 0; exits collected ----
function buildBlockGrid(m, bb, res, forEgress){
  const cols=Math.max(1,Math.ceil(bb.W/res)), rows=Math.max(1,Math.ceil(bb.H/res));
  const grid=new Uint8Array(cols*rows);
  const isBlockDef=forEgress?(typeof _egressIsBlocking==="function"?_egressIsBlocking:()=>true)
                            :(typeof _adaIsBlocking==="function"?_adaIsBlocking:()=>true);
  // walls + windows (windows stay solid; doors carved later)
  for(const w of m.walls){ const a=m.nodes[w.a],b=m.nodes[w.b]; if(!a||!b)continue; const th=w.thick||0.5;
    const minx=Math.min(a.x,b.x)-th/2,maxx=Math.max(a.x,b.x)+th/2,miny=Math.min(a.y,b.y)-th/2,maxy=Math.max(a.y,b.y)+th/2;
    const c1=clampi(Math.floor((minx-bb.x0)/res),0,cols),c2=clampi(Math.ceil((maxx-bb.x0)/res),0,cols);
    const r1=clampi(Math.floor((miny-bb.y0)/res),0,rows),r2=clampi(Math.ceil((maxy-bb.y0)/res),0,rows);
    for(let r=r1;r<r2;r++)for(let c=c1;c<c2;c++){ const px=bb.x0+(c+0.5)*res,py=bb.y0+(r+0.5)*res; if(pointSeg({x:px,y:py},a,b).d<=th/2+res*0.25) grid[r*cols+c]=1; }
  }
  // blocking element footprints
  const activeMode=(typeof state!=="undefined" && state.activeUse);
  for(const e of m.elements){ const def=Engine.defOf(e.defId); if(!isBlockDef(def))continue;
    const fp=elementFootprintFt(e,def, !!(activeMode&&e.activeUse)); const ab=fp.aabb;
    const c1=clampi(Math.floor((ab.x1-bb.x0)/res),0,cols),c2=clampi(Math.ceil((ab.x2-bb.x0)/res),0,cols);
    const r1=clampi(Math.floor((ab.y1-bb.y0)/res),0,rows),r2=clampi(Math.ceil((ab.y2-bb.y0)/res),0,rows);
    for(let r=r1;r<r2;r++)for(let c=c1;c<c2;c++){ if(fp.test(bb.x0+(c+0.5)*res,bb.y0+(r+0.5)*res)) grid[r*cols+c]=1; }
  }
  // carve door gaps to free + collect exits
  const exit=new Uint8Array(cols*rows); let anyExit=false;
  const carve=(o,markExit)=>{ const w=m.walls.find(x=>x.id===o.wall); if(!w)return; const a=m.nodes[w.a],b=m.nodes[w.b]; if(!a||!b)return;
    const c=lerp(a,b,o.t), ang=Math.atan2(b.y-a.y,b.x-a.x), th=(w.thick||0.5)+res*2;
    stampRot(grid,cols,rows,bb,res,c.x,c.y,o.w,th,ang,0);
    if(markExit){ stampRot(exit,cols,rows,bb,res,c.x,c.y,o.w,th,ang,1); anyExit=true; } };
  for(const o of m.openings){ if(o.kind==="door") carve(o, !!o.exit); }
  if(!anyExit){ for(const o of m.openings){ if(o.kind==="door") carve(o,true); } }   // fallback: every door is an exit
  return { cols, rows, grid, exit, anyExit };
}

const row=(label,val,cls)=>`<div class="r"><span>${label}</span><b class="${cls||""}">${val}</b></div>`;

// ---- ADA ----
function runAda(m,bb){
  const res=CST("ADA_GRID_RES_FT",0.5);
  const {cols,rows,grid}=buildBlockGrid(m,bb,res,false);
  const dist=_adaDistanceTransform(grid,cols,rows);
  const minCells=Math.ceil((CST("ADA_MIN_CORRIDOR_WIDTH_IN",36)/12)/res/2);
  const prefCells=Math.ceil((CST("ADA_MIN_PRIMARY_CORRIDOR_IN",44)/12)/res/2);
  const cells=new Array(cols*rows).fill(null); let free=0,fail=0,marg=0;
  for(let i=0;i<dist.length;i++){ const d=dist[i]; if(d<=0)continue; free++;
    if(d<minCells){fail++;cells[i]="rgba(220,55,55,0.55)";}
    else if(d<prefCells){marg++;cells[i]="rgba(230,165,45,0.45)";}
    else cells[i]="rgba(55,185,95,0.30)"; }
  let narrow=0; for(const o of m.openings){ if(o.kind!=="door")continue;
    const min=o.exit?CST("ADA_MIN_EXIT_DOOR_WIDTH_IN",36):CST("ADA_MIN_DOOR_WIDTH_IN",32); if(o.w*12<min)narrow++; }
  Engine.setOverlay({cols,rows,resX:res,resY:res,x0:bb.x0,y0:bb.y0,cells});
  let h=`<b>ADA clearance</b>`;
  h+=row("Corridor fails", fail, fail>0?"bad":"good");
  h+=row("Marginal", marg, marg>0?"warn":"good");
  h+=row("Clear", Math.max(0,free-fail-marg), "good");
  h+=row("Narrow doors", narrow, narrow>0?"warn":"good");
  Engine.setSimOut(h);
}

// ---- Egress ----
function runEgress(m,bb){
  const res=CST("EGRESS_GRID_RES_FT",1.0);
  const {cols,rows,grid,exit,anyExit}=buildBlockGrid(m,bb,res,true);
  const eg=new Uint8Array(cols*rows);
  for(let i=0;i<eg.length;i++) eg[i]= exit[i]?2:(grid[i]?1:0);
  const dist=_egressBFS(eg,cols,rows);
  const MAXT=CST("NFPA_MAX_TRAVEL_DISTANCE_FT",200), mid=MAXT*0.5;
  const cells=new Array(cols*rows).fill(null); let maxTravel=0;
  for(let i=0;i<dist.length;i++){ if(eg[i]===1)continue; const d=dist[i];
    if(eg[i]===2){cells[i]="rgba(50,140,240,0.65)";continue;}
    if(d<0){cells[i]="rgba(150,0,150,0.55)";continue;}
    if(d>maxTravel)maxTravel=d;
    if(d<=mid){const t=d/mid;cells[i]=`rgba(${Math.round(55+175*t)},${Math.round(185-110*t)},55,0.4)`;}
    else if(d<=MAXT){const t=(d-mid)/mid;cells[i]=`rgba(230,${Math.round(165-90*t)},45,0.5)`;}
    else cells[i]="rgba(220,50,50,0.65)"; }
  const deadEnd=_egressMaxDeadEnd(dist,eg,cols,rows);
  let area=0; for(const r of m.rooms){ if(r.nodes.every(id=>m.nodes[id])) area+=polyAreaFt(m,r.nodes); }
  if(area<=0) area=bb.W*bb.H;
  const occupants=Math.ceil(area/CST("NFPA_OCCUPANT_LOAD_FACTOR_MAKERSPACE",50));
  let exitWidthIn=0,exitCount=0; for(const o of m.openings){ if(o.kind==="door"&&(o.exit||!anyExit)){exitWidthIn+=o.w*12;exitCount++;} }
  const capacity=Math.floor(exitWidthIn/CST("NFPA_EXIT_WIDTH_PER_OCCUPANT_IN",0.2));
  Engine.setOverlay({cols,rows,resX:res,resY:res,x0:bb.x0,y0:bb.y0,cells});
  let h=`<b>Egress</b>`;
  h+=row("Exits", exitCount+(anyExit?"":" (all doors)"), exitCount>0?"good":"bad");
  h+=row("Max travel", maxTravel.toFixed(0)+" ft", maxTravel>MAXT?"bad":"good");
  h+=row("Occupant load", occupants, "");
  h+=row("Exit capacity", capacity, capacity>=occupants?"good":"warn");
  h+=row("Dead-end", deadEnd.toFixed(0)+" ft", deadEnd>CST("NFPA_MAX_DEAD_END_FT",20)?"warn":"good");
  Engine.setSimOut(h);
}

// ---- Noise ----
function runNoise(m,bb){
  const res=CST("NOISE_GRID_RES_FT",1.0);
  const cols=Math.max(1,Math.ceil(bb.W/res)), rows=Math.max(1,Math.ceil(bb.H/res));
  const AMB=CST("NOISE_AMBIENT_DBA",40), PEL=CST("OSHA_PEL_DBA",90), ACT=CST("OSHA_ACTION_LEVEL_DBA",85), WSTC=CST("NOISE_WALL_STC",35);
  const sources=[];
  for(const e of m.elements){ const d=Engine.defOf(e.defId); if(!d)continue;
    const dba=Number.isFinite(d.dba_active)?d.dba_active:((d.variableAttrs&&Number.isFinite(d.variableAttrs.noiseDb))?d.variableAttrs.noiseDb:null);
    if(dba==null||dba<=AMB)continue;
    const prob=Number.isFinite(d.schedule_prob)?d.schedule_prob:CST("NOISE_DEFAULT_SCHEDULE_PROB",0.6);
    sources.push({ cx:(e.x-bb.x0), cy:(e.y-bb.y0), dba, prob }); }
  if(!sources.length){ Engine.clearOverlay(); Engine.setSimOut("<span class='warn'>No noise sources.</span> Place a tool with an operating-dBA attribute (dba_active / noiseDb)."); return; }
  // wall STC grid (feet)
  const stc=new Float32Array(cols*rows);
  for(const w of m.walls){ const a=m.nodes[w.a],b=m.nodes[w.b]; if(!a||!b)continue; const th=w.thick||0.5;
    const minx=Math.min(a.x,b.x)-th/2,maxx=Math.max(a.x,b.x)+th/2,miny=Math.min(a.y,b.y)-th/2,maxy=Math.max(a.y,b.y)+th/2;
    const c1=clampi(Math.floor((minx-bb.x0)/res),0,cols),c2=clampi(Math.ceil((maxx-bb.x0)/res),0,cols);
    const r1=clampi(Math.floor((miny-bb.y0)/res),0,rows),r2=clampi(Math.ceil((maxy-bb.y0)/res),0,rows);
    for(let r=r1;r<r2;r++)for(let c=c1;c<c2;c++){ const px=bb.x0+(c+0.5)*res,py=bb.y0+(r+0.5)*res; if(pointSeg({x:px,y:py},a,b).d<=th/2+res*0.25){ const i=r*cols+c; if(WSTC>stc[i])stc[i]=WSTC; } } }
  const refDist=(typeof _noiseRefDist==="function")?_noiseRefDist():(m.unit==="m"?1:3.28084);
  const acc=new Float64Array(cols*rows);
  for(const src of sources){ const srcC=Math.round(src.cx/res), srcR=Math.round(src.cy/res); const w=Number.isFinite(src.prob)?src.prob:1; if(w<=0)continue;
    for(let r=0;r<rows;r++)for(let c=0;c<cols;c++){ const dd=Math.max(refDist,Math.hypot(c-srcC,r-srcR)*res);
      const directDb=src.dba-20*Math.log10(dd/refDist);
      const stcSum=(typeof _noiseWallCrossings==="function")?_noiseWallCrossings(stc,cols,rows,srcC,srcR,c,r):0;
      acc[r*cols+c]+=w*Math.pow(10,(directDb-stcSum*0.5)/10); } }
  const ambient=Math.pow(10,AMB/10); const cells=new Array(cols*rows).fill(null);
  let maxDb=-Infinity,sum=0,n=0,pel=0,action=0;
  for(let i=0;i<acc.length;i++){ const d=10*Math.log10(acc[i]+ambient); if(d>maxDb)maxDb=d; sum+=d;n++;
    if(d>=PEL){pel++;cells[i]="rgba(220,45,45,0.65)";}
    else if(d>=ACT){action++;cells[i]="rgba(230,140,40,0.55)";}
    else if(d>=70)cells[i]="rgba(230,210,50,0.40)";
    else cells[i]="rgba(55,185,95,0.25)"; }
  Engine.setOverlay({cols,rows,resX:res,resY:res,x0:bb.x0,y0:bb.y0,cells});
  let h=`<b>Noise (dBA)</b>`;
  h+=row("Sources", sources.length, "");
  h+=row("Max", maxDb.toFixed(0)+" dBA", maxDb>=PEL?"bad":(maxDb>=ACT?"warn":"good"));
  h+=row("Mean", (sum/Math.max(1,n)).toFixed(0)+" dBA", "");
  h+=row("≥ PEL cells", pel, pel>0?"bad":"good");
  Engine.setSimOut(h);
}

// ---- radius helper for fire/fumes ----
function radiusField(m,bb,cfg){
  const res=1.5, cap=140;
  const cols=Math.min(cap,Math.max(1,Math.ceil(bb.W/res))), rows=Math.min(cap,Math.max(1,Math.ceil(bb.H/res)));
  const resX=bb.W/cols, resY=bb.H/rows;
  const src=[], sink=[];
  for(const e of m.elements){ const d=Engine.defOf(e.defId); if(!d)continue;
    if(cfg.isSink(d)){ sink.push({cx:e.x-bb.x0,cy:e.y-bb.y0,r:(Number.isFinite(d.coverage)&&d.coverage>0?d.coverage:cfg.sinkR),label:d.label}); continue; }
    if(d.elementClass==="structural"||d.elementClass==="amenity")continue;
    const lvl=(d.variableAttrs&&Number.isFinite(d.variableAttrs[cfg.attr]))?d.variableAttrs[cfg.attr]:0; if(lvl<=0)continue;
    src.push({cx:e.x-bb.x0,cy:e.y-bb.y0,r:cfg.baseR+lvl*cfg.perR,mag:clamp(lvl/4,0,1),label:d.label}); }
  const cells=new Array(cols*rows).fill(null);
  for(let r=0;r<rows;r++)for(let c=0;c<cols;c++){ const xf=(c+0.5)*resX,yf=(r+0.5)*resY; let v=0;
    for(const s of src){ const dd=Math.hypot(xf-s.cx,yf-s.cy); if(dd<s.r) v=Math.max(v,s.mag*(1-dd/s.r)); }
    if(v<=0.02)continue; let cap2=0; for(const k of sink){ const dd=Math.hypot(xf-k.cx,yf-k.cy); if(dd<k.r)cap2=Math.max(cap2,1-dd/k.r); }
    const val=clamp(v*(1-cfg.mitigate*cap2),0,1); if(val<0.03)continue;
    cells[r*cols+c]=cfg.color(val); }
  let uncovered=0,worst=null;
  for(const s of src){ let best=0; for(const k of sink){ const dd=Math.hypot(s.cx-k.cx,s.cy-k.cy); if(dd<k.r)best=Math.max(best,1-dd/k.r); }
    if(best<=0)uncovered++; const exp=s.mag*(1-best); if(!worst||exp>worst.exp)worst={label:s.label,exp,covered:best>0}; }
  Engine.setOverlay({cols,rows,resX,resY,x0:bb.x0,y0:bb.y0,cells});
  return { src:src.length, sink:sink.length, uncovered, worst };
}
function runFire(m,bb){
  const r=radiusField(m,bb,{ attr:"flammability", baseR:6, perR:6, sinkR:25, mitigate:0.75,
    isSink:d=>d.elementClass==="amenity" && (d.subtype==="fire_extinguisher"||/fire\s*extinguisher/i.test(d.label||"")),
    color:v=>`hsla(${(1-v)*120},85%,50%,${(0.2+v*0.45).toFixed(2)})` });
  let h=`<b>Fire safety</b>`;
  h+=row("Extinguishers", r.sink, r.sink>0?"good":"bad");
  h+=row("Flammable tools", r.src, r.src>0?"warn":"good");
  h+=row("Uncovered", r.uncovered, r.uncovered>0?"warn":"good");
  if(r.worst) h+=row("Highest exposure", r.worst.label+(r.worst.covered?" (covered)":" (none)"), r.worst.covered?"good":"bad");
  Engine.setSimOut(h);
}
function runFumes(m,bb){
  const r=radiusField(m,bb,{ attr:"smellFumes", baseR:7, perR:8, sinkR:14, mitigate:0.8,
    isSink:d=>d.elementClass==="amenity" && (/hood|fume|exhaust|vent|sink/i.test(d.subtype||"")||/fume\s*hood|exhaust|ventilation/i.test(d.label||"")),
    color:v=>`hsla(${280-v*250},80%,55%,${(0.2+v*0.45).toFixed(2)})` });
  let h=`<b>Fumes / odor</b>`;
  h+=row("Fume sources", r.src, r.src>0?"warn":"good");
  h+=row("Hoods / exhaust", r.sink, r.sink>0?"good":(r.src>0?"warn":"good"));
  h+=row("Uncaptured", r.uncovered, r.uncovered>0?"warn":"good");
  if(r.worst) h+=row("Strongest plume", r.worst.label+(r.worst.covered?" (captured)":" (uncaptured)"), r.worst.covered?"good":"bad");
  Engine.setSimOut(h);
}

window.EngineSim = {
  run(kind){
    if(typeof Engine==="undefined"){ return; }
    const m=Engine.getModel();
    const bb=sceneBBox(m);
    if(!bb){ Engine.clearOverlay(); Engine.setSimOut("<span class='warn'>Nothing to simulate yet.</span> Draw walls or place elements first."); return; }
    try {
      if(kind==="ada") runAda(m,bb);
      else if(kind==="egress") runEgress(m,bb);
      else if(kind==="noise") runNoise(m,bb);
      else if(kind==="fire") runFire(m,bb);
      else if(kind==="fumes") runFumes(m,bb);
    } catch(err){
      Engine.setSimOut("<span class='bad'>Sim error: "+((err&&err.message)||err)+"</span>");
      console.error("[engine_sim]", err);
    }
  }
};

})();
