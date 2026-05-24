"use strict";
/* ------------------------------------------------------------------
   4. STATE
   ------------------------------------------------------------------ */
const state = {
  preset:"current",
  zones:{},                 // id -> {x,y,w,h,rotation,included,activeUse}
  trafficMode:"normal",
  activeUse:false,
  showClearance:false,
  showFlow:true,
  showSidebar:true,
  flags:[],
  metrics:{},
  score:0,
  gate:"pass",
  selectedId:null,
  customElements:[],        // tool-type custom elements
  structuralElements:[],    // walls, floors, doors
  amenityElements:[],       // eyewash, fire ext, etc.
  editingId:null,
  editingType:null,         // "tool" | "structural" | "amenity" — paired with editingId
  // Unit & scale state
  units:"ft",               // "ft" or "m"; only displayed once scale exists
  scale:null,               // {pxPerUnit, unit, stageWidthPx, stageHeightPx} once calibrated
  // Retained imported assets so Export Project can re-bundle them
  imports:{
    floorPlan:null,         // {filename, dataUrl, width, height, importedAt}
    config:null,            // {filename, text, importedAt}
  },
  defaultStageBg:null,
  // UI state for collapsible status banner
  statusCollapsed:false,
};
/* ------------------------------------------------------------------
   5. UTILITY MATH
   ------------------------------------------------------------------ */

/* Real-units helpers. Internally all geometry is stored as 0..100% of
   the stage. Once a scale has been calibrated, we can convert between
   percent and real-world units (feet/meters) for display and input.
   Returns null when no scale is set. */
function hasScale(){ return !!(state.scale && state.scale.pxPerUnit); }
function currentUnit(){ return state.scale ? state.scale.unit : state.units; }

function stageDimsPx(){
  // Pixel dimensions of the floor plan image currently driving the
  // stage. Falls back to the loaded image if no calibration yet.
  if(state.scale && state.scale.stageWidthPx){
    return { w: state.scale.stageWidthPx, h: state.scale.stageHeightPx };
  }
  if(state.imports && state.imports.floorPlan){
    return { w: state.imports.floorPlan.width, h: state.imports.floorPlan.height };
  }
  // Default Matterport aspect.
  return { w: 1600, h: 994 };
}

function stageDimsUnits(){
  if(!hasScale()) return null;
  const px = stageDimsPx();
  return { w: px.w / state.scale.pxPerUnit, h: px.h / state.scale.pxPerUnit };
}

// Percent ↔ units conversions. `axis` is 'x' or 'y'.
function pctToUnits(pct, axis){
  const du = stageDimsUnits();
  if(!du) return null;
  return (pct / 100) * (axis === 'y' ? du.h : du.w);
}
function unitsToPct(u, axis){
  const du = stageDimsUnits();
  if(!du) return null;
  return (u / (axis === 'y' ? du.h : du.w)) * 100;
}

// Format a percent value as either real units (when calibrated) or
// the percent itself. Used everywhere the user reads a dimension.
function fmtDim(pct, axis){
  if(hasScale()){
    const v = pctToUnits(pct, axis);
    return v.toFixed(2) + " " + state.scale.unit;
  }
  return (+pct).toFixed(1) + "%";
}

// Label suffix for inputs — shows the active unit or "%".
function unitLabel(){
  return hasScale() ? state.scale.unit : "%";
}

function rect(z){
  // Returns {x1,y1,x2,y2,cx,cy} in normalized coordinates.
  return {
    x1:z.x, y1:z.y, x2:z.x+z.w, y2:z.y+z.h,
    cx:z.x+z.w/2, cy:z.y+z.h/2, w:z.w, h:z.h,
  };
}
function overlapArea(a,b){
  const w = Math.max(0, Math.min(a.x2,b.x2)-Math.max(a.x1,b.x1));
  const h = Math.max(0, Math.min(a.y2,b.y2)-Math.max(a.y1,b.y1));
  return w*h;
}
function rectDist(a,b){
  // Min edge-to-edge distance between two axis-aligned rects.
  const dx = Math.max(0, Math.max(a.x1-b.x2, b.x1-a.x2));
  const dy = Math.max(0, Math.max(a.y1-b.y2, b.y1-a.y2));
  return Math.hypot(dx,dy);
}
function dist(ax,ay,bx,by){ return Math.hypot(ax-bx, ay-by); }
function clamp(v,lo,hi){ return Math.max(lo,Math.min(hi,v)); }
function segIntersectRect(p1,p2,r){
  // Check if a line segment p1-p2 intersects rect r (Liang-Barsky-ish).
  const x1=p1.x,y1=p1.y,x2=p2.x,y2=p2.y;
  const dx=x2-x1, dy=y2-y1;
  let t0=0,t1=1;
  const p=[-dx,dx,-dy,dy], q=[x1-r.x1, r.x2-x1, y1-r.y1, r.y2-y1];
  for(let i=0;i<4;i++){
    if(p[i]===0){ if(q[i]<0) return false; }
    else{
      const t=q[i]/p[i];
      if(p[i]<0){ if(t>t1) return false; if(t>t0) t0=t; }
      else      { if(t<t0) return false; if(t<t1) t1=t; }
    }
  }
  return true;
}

/* "Active use" expands assembly/work zone footprints to simulate
   chairs, carts, bins, and project material spillover. Returns an
   inflated rect for proximity / overlap checks. */
function effectiveRect(id, z, activeUse){
  const r = rect(z);
  if(!activeUse) return r;
  const expanding = ["asm1","asm2","craftland","electronics","bike","print3d"];
  if(expanding.includes(id)){
    const pad = 2.2;
    return { x1:r.x1-pad, y1:r.y1-pad, x2:r.x2+pad, y2:r.y2+pad,
             cx:r.cx, cy:r.cy, w:r.w+pad*2, h:r.h+pad*2 };
  }
  return r;
}

/* ------------------------------------------------------------------
   6. PRESET LOADING
   ------------------------------------------------------------------ */
function allZoneDefs(){
  // Returns the union of built-in ZONE_DEFS and all user-added elements
  // (tools + structural + amenity). Order matters: built-ins first so
  // their evaluation rules see them in the expected positions.
  return ZONE_DEFS
    .concat(state.customElements)
    .concat(state.structuralElements)
    .concat(state.amenityElements);
}

function loadPreset(name){
  state.preset = name;
  const preset = PRESETS[name];
  state.zones = {};
  for(const def of allZoneDefs()){
    const p = (preset.zones && preset.zones[def.id]) || {x:50,y:50};
    state.zones[def.id] = {
      x: p.x, y: p.y,
      w: p.w !== undefined ? p.w : def.w,
      h: p.h !== undefined ? p.h : def.h,
      rotation: p.rotation || 0,
      included: true,           // per-element evaluation/render toggle
      activeUse: false,         // per-element active-use toggle
    };
  }
  document.getElementById("presetPill").textContent =
    name === "current" ? "Current" : (name === "altA" ? "Alt A" : "Alt B");
}
