"use strict";
/* ==================================================================
   FLOOR PLAN BUILDER — IN-APP BRIDGE  (v3 integration)
   Embeds the standalone builder (fpb.html) in a modal <iframe> and
   converts its drawing into the app's structural elements so every
   simulation (ADA / egress / noise / fire / fumes) runs on it.

   The builder works in FEET; the app stores geometry as 0..100% of the
   stage. On "Apply to project" we:
     1. bound the drawing in feet, fit that box to the stage (so the plan
        fills the canvas) and set state.scale from the real feet — the
        "fit to stage, preserve feet" mapping.
     2. convert walls -> thick wall elements (built in feet for true
        thickness, then mapped to %), splitting each wall at door/window
        openings so doors are passable gaps and windows are see-through
        (but movement-blocking) infills.
     3. convert rooms -> floor elements (used for room-scoped analysis).

   Elements carry rawDraw.source="fpb" so a re-open reloads the plan and
   a re-apply cleanly replaces the previous one, leaving hand-drawn
   (wall-editor) and legacy structural elements untouched.
   ================================================================== */

const FPB_PXPERFT   = 24;    // px/ft stored in state.scale (unit is what matters)
const FPB_MARGIN_FT = 2;     // breathing room added around the drawing
const FPB_MIN_PIECE_FT = 0.3;// drop wall slivers shorter than this after splitting

/* ---- geometry helpers (feet space) ---- */
function _fpbThickQuadFt(a, b, tFt){
  const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len * (tFt / 2), ny = dx / len * (tFt / 2);
  return [ {x:a.x+nx,y:a.y+ny}, {x:b.x+nx,y:b.y+ny}, {x:b.x-nx,y:b.y-ny}, {x:a.x-nx,y:a.y-ny} ];
}
function _fpbLerp(a, b, t){ return { x:a.x + (b.x-a.x)*t, y:a.y + (b.y-a.y)*t }; }
function _fpbProjT(p, a, b){
  const dx=b.x-a.x, dy=b.y-a.y, l2=dx*dx+dy*dy||1;
  return ((p.x-a.x)*dx + (p.y-a.y)*dy)/l2;
}
function _fpbDistToSeg(p, a, b){
  let t = Math.max(0, Math.min(1, _fpbProjT(p, a, b)));
  const q = _fpbLerp(a, b, t);
  return Math.hypot(p.x-q.x, p.y-q.y);
}

/* ---- open / close the embedded editor ---- */
function openFpbModal(){
  const bd = document.getElementById("fpbBackdrop");
  if(!bd) return;
  // close the Element Builder if it's open behind us
  const eb = document.getElementById("elementBuilderBackdrop");
  if(eb) eb.classList.remove("open");
  bd.classList.add("open");
  const frame = document.getElementById("fpbFrame");
  if(!frame) return;
  const seed = () => {
    try {
      const api = frame.contentWindow && frame.contentWindow.FPB;
      if(!api) return;
      if(state.fpbPlan) api.loadPlan(state.fpbPlan);
      // Auto-import the app's loaded floor-plan image (and its calibrated scale,
      // if any) so it's ready to trace — unless the editor already has an image.
      if(typeof api.hasImage === "function" && !api.hasImage()){
        const fp = state.imports && state.imports.floorPlan;
        if(fp && fp.dataUrl){
          let wFt = null, hFt = null, unit = "ft", locked = false;
          if(fp.scale && fp.scale.pxPerUnit && fp.width && fp.height){
            // Use the image's OWN calibration (independent of any later plan scale).
            unit = fp.scale.unit || "ft";
            const wU = fp.width / fp.scale.pxPerUnit, hU = fp.height / fp.scale.pxPerUnit;
            wFt = unit === "m" ? wU / 0.3048 : wU;
            hFt = unit === "m" ? hU / 0.3048 : hU;
            locked = true;                       // calibrated → drop in trace mode
          } else if(fp.width && fp.height){
            wFt = 30; hFt = 30 * (fp.height / fp.width);   // uncalibrated: 30 ft wide default
          }
          api.setReferenceImage({ dataUrl:fp.dataUrl, wFt, hFt, unit, locked, opacity:0.6 });
        }
      }
    } catch(_){ /* cross-frame not ready yet */ }
  };
  // The iframe preloads via its src, so its FPB bridge is usually ready by the
  // time this runs — seed immediately. Otherwise wait for it to finish loading.
  const api = frame.contentWindow && frame.contentWindow.FPB;
  if(api){ seed(); }
  else {
    frame.addEventListener("load", seed, { once:true });
    if(!frame.getAttribute("src")) frame.setAttribute("src", "fpb.html");
  }
}
function closeFpbModal(){
  const bd = document.getElementById("fpbBackdrop");
  if(bd) bd.classList.remove("open");
}

/* ---- apply: builder plan (feet) -> structural elements (%) ---- */
function fpbApplyPlan(){
  const frame = document.getElementById("fpbFrame");
  const api = frame && frame.contentWindow && frame.contentWindow.FPB;
  if(!api){ alert("The floor-plan editor isn't ready yet — give it a moment and try again."); return; }
  const plan = api.getPlan();
  const walls = (plan && plan.wallSegments) || [];
  const rooms = (plan && plan.roomPolygons) || [];
  const openings = (plan && plan.doors) || [];   // doors + windows
  if(!walls.length && !rooms.length){
    alert("Draw at least one wall or room before applying to the project.");
    return;
  }

  // 1) bound the drawing in feet
  let x1=Infinity, y1=Infinity, x2=-Infinity, y2=-Infinity;
  const grow=(x,y)=>{ x1=Math.min(x1,x); y1=Math.min(y1,y); x2=Math.max(x2,x); y2=Math.max(y2,y); };
  walls.forEach(s=>{ grow(s.x1,s.y1); grow(s.x2,s.y2); });
  rooms.forEach(r=>r.points.forEach(p=>grow(p.x,p.y)));
  openings.forEach(o=>grow(o.x,o.y));
  if(!isFinite(x1)){ alert("Nothing measurable to apply."); return; }
  x1-=FPB_MARGIN_FT; y1-=FPB_MARGIN_FT; x2+=FPB_MARGIN_FT; y2+=FPB_MARGIN_FT;
  const planW = Math.max(x2-x1, 1), planH = Math.max(y2-y1, 1);
  const toPct = (x,y)=>({ x:(x-x1)/planW*100, y:(y-y1)/planH*100 });
  const quadFtToLocal = (quad)=>{
    const pct = quad.map(c=>toPct(c.x, c.y));
    const bb = _wdBBox(pct);
    return { bb, local:_wdLocalize(pct, bb) };
  };

  // 2) set scale + stage aspect ("fit to stage, preserve feet")
  state.scale = { pxPerUnit:FPB_PXPERFT, unit:"ft",
                  stageWidthPx:planW*FPB_PXPERFT, stageHeightPx:planH*FPB_PXPERFT };
  state.units = "ft";
  const stage = document.getElementById("stage");
  if(stage) stage.style.setProperty("--stage-aspect", `${planW} / ${planH}`);
  if(typeof refitElementsToScale === "function") refitElementsToScale();

  // 3) build elements
  const taken = new Set(allZoneDefs().map(x=>x.id));
  const mkId = (base)=>{ let id=base, n=2; while(taken.has(id)){ id=base+"_"+n; n++; } taken.add(id); return id; };
  const newDefs = [], newZones = {};
  const wallCol = (typeof WALL_TYPES!=="undefined" && WALL_TYPES.wall) ? WALL_TYPES.wall.color : "#dde1eb";
  const doorCol = (typeof WALL_TYPES!=="undefined" && WALL_TYPES.door) ? WALL_TYPES.door.color : "#d8aa5a";

  const pushStruct = (idBase, label, quad, attrs, raw)=>{
    const { bb, local } = quadFtToLocal(quad);
    if(bb.w <= 0 && bb.h <= 0) return;
    const id = mkId(idBase);
    newDefs.push(Object.assign({
      id, label, short:String(label).slice(0,10), risk:0,
      elementClass:"structural", custom:true, fixed:true,
      w:bb.w, h:bb.h, shapes:[{ type:"polygon", points:local }],
      rawDraw:Object.assign({ source:"fpb" }, raw),
    }, attrs));
    newZones[id] = { x:bb.x1, y:bb.y1, w:bb.w, h:bb.h, rotation:0, included:true, activeUse:false, locked:true };
  };

  // 3a) rooms -> floor polygons
  rooms.forEach((room, i)=>{
    const pct = room.points.map(p=>toPct(p.x, p.y));
    const bb = _wdBBox(pct);
    if(bb.w <= 0 || bb.h <= 0) return;
    const id = mkId("fpb_room_"+(i+1));
    const local = _wdLocalize(pct, bb);
    const label = room.name || `Room ${i+1}`;
    newDefs.push({
      id, label, short:label.slice(0,10), risk:0,
      elementClass:"structural", subtype:"floor", blocksMovement:false,
      custom:true, fixed:true, w:bb.w, h:bb.h,
      shapes:[{ type:"polygon", points:local }],
      zoneTag:"",
      rawDraw:{ source:"fpb", kind:"room", points:room.points.map(p=>({...p})) },
    });
    newZones[id] = { x:bb.x1, y:bb.y1, w:bb.w, h:bb.h, rotation:0, included:true, activeUse:false, locked:true };
  });

  // 3b) associate each opening with its nearest wall segment
  const segs = walls.map((s)=>({
    a:{x:s.x1,y:s.y1}, b:{x:s.x2,y:s.y2}, thick:(s.thickFt>0?s.thickFt:0.5), gaps:[],
  }));
  const standaloneOpenings = [];
  openings.forEach(o=>{
    const c = { x:o.x, y:o.y };
    let best=null, bd=Infinity;
    segs.forEach(sg=>{ const d=_fpbDistToSeg(c, sg.a, sg.b); if(d<bd){ bd=d; best=sg; } });
    const tol = best ? Math.max(1.5, best.thick + 1) : 0;
    if(best && bd <= tol){
      const segLen = Math.hypot(best.b.x-best.a.x, best.b.y-best.a.y) || 1;
      const t0 = Math.max(0, Math.min(1, _fpbProjT(c, best.a, best.b)));
      const half = ((o.widthFt>0?o.widthFt:3) / 2) / segLen;
      best.gaps.push({ t0:Math.max(0,t0-half), t1:Math.min(1,t0+half), kind:o.kind, w:o.widthFt||3 });
    } else {
      standaloneOpenings.push(o);
    }
  });

  // 3c) walls -> solid pieces (blocking) + door gaps (passable) + window infills (blocking)
  let wi=0, di=0, ni=0;
  segs.forEach((sg)=>{
    const gaps = sg.gaps.slice().sort((p,q)=>p.t0-q.t0);
    const segLen = Math.hypot(sg.b.x-sg.a.x, sg.b.y-sg.a.y) || 1;
    // solid intervals = [0,1] minus the gaps
    let cursor = 0;
    const solids = [];
    gaps.forEach(g=>{ if(g.t0 > cursor) solids.push([cursor, g.t0]); cursor = Math.max(cursor, g.t1); });
    if(cursor < 1) solids.push([cursor, 1]);
    // emit solids as wall elements
    solids.forEach(([ta,tb])=>{
      if((tb-ta)*segLen < FPB_MIN_PIECE_FT) return;
      const a=_fpbLerp(sg.a,sg.b,ta), b=_fpbLerp(sg.a,sg.b,tb);
      pushStruct("fpb_wall_"+(++wi), "Wall "+wi, _fpbThickQuadFt(a,b,sg.thick), {
        subtype:"wall", wallType:"normal", blocksMovement:true, stc:35, color:wallCol,
      }, { kind:"wall" });
    });
    // emit each gap as a door (passable) or window (blocking, low STC)
    gaps.forEach(g=>{
      const a=_fpbLerp(sg.a,sg.b,g.t0), b=_fpbLerp(sg.a,sg.b,g.t1);
      const quad=_fpbThickQuadFt(a,b,sg.thick);
      if(g.kind === "window"){
        pushStruct("fpb_window_"+(++ni), "Window "+ni, quad, {
          subtype:"wall", wallType:"window", blocksMovement:true, stc:28, color:"#8fd0ff",
        }, { kind:"window" });
      } else {
        pushStruct("fpb_door_"+(++di), "Door "+di, quad, {
          subtype:"door", blocksMovement:false, stc:20, color:doorCol,
        }, { kind:"door" });
      }
    });
  });

  // 3d) openings not attached to any wall -> a small passable/see-through stub
  standaloneOpenings.forEach(o=>{
    const half=(o.widthFt>0?o.widthFt:3)/2;
    const ang=(o.angleDeg||0)*Math.PI/180, dx=Math.cos(ang)*half, dy=Math.sin(ang)*half;
    const a={x:o.x-dx,y:o.y-dy}, b={x:o.x+dx,y:o.y+dy};
    const quad=_fpbThickQuadFt(a,b,0.5);
    if(o.kind==="window") pushStruct("fpb_window_"+(++ni), "Window "+ni, quad,
      { subtype:"wall", wallType:"window", blocksMovement:true, stc:28, color:"#8fd0ff" }, { kind:"window" });
    else pushStruct("fpb_door_"+(++di), "Door "+di, quad,
      { subtype:"door", blocksMovement:false, stc:20, color:doorCol }, { kind:"door" });
  });

  // 4) replace prior FPB elements; keep hand-drawn + legacy structural intact
  const existing = state.structuralElements || [];
  const preserved = existing.filter(d=>!(d.rawDraw && d.rawDraw.source === "fpb"));
  existing.filter(d=>d.rawDraw && d.rawDraw.source === "fpb").forEach(d=>{ delete state.zones[d.id]; });
  state.structuralElements = preserved.concat(newDefs);
  Object.assign(state.zones, newZones);

  // remember the plan so re-opening the editor shows this layout
  state.fpbPlan = plan;

  if(typeof evaluate === "function") evaluate();
  if(typeof render === "function") render();
  if(typeof refreshStatusBars === "function") refreshStatusBars();
  if(typeof saveAppState === "function") saveAppState();
  closeFpbModal();

  const nWall = newDefs.filter(d=>d.subtype==="wall"&&d.wallType!=="window").length;
  const nDoor = newDefs.filter(d=>d.subtype==="door").length;
  const nRoom = newDefs.filter(d=>d.subtype==="floor").length;
  if(typeof toast === "function"){
    toast(`Floor plan applied — ${nWall} walls, ${nDoor} doors, ${nRoom} rooms (${planW.toFixed(0)}×${planH.toFixed(0)} ft).`);
  }
}

/* ---- wiring ---- */
function wireFpbBridge(){
  const apply = document.getElementById("fpbApplyBtn");
  if(apply && !apply._fpbWired){ apply._fpbWired = true; apply.addEventListener("click", fpbApplyPlan); }
  const cancel = document.getElementById("fpbCancelBtn");
  if(cancel && !cancel._fpbWired){ cancel._fpbWired = true; cancel.addEventListener("click", closeFpbModal); }
  const x = document.getElementById("fpbCloseX");
  if(x && !x._fpbWired){ x._fpbWired = true; x.addEventListener("click", closeFpbModal); }
}
