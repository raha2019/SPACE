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
  showLabels:true,
  // X/Y coordinate reference grid on the stage (Layout Builder).
  showGrid:false,
  // Editable header metadata, persisted via autosave + export.
  projectInfo:{
    project: "Invention Studio Layout Optimization for Safety and Accessibility",
    lab:     "Georgia Tech MATRIX Lab",
    build:   "v0.5 prototype",
  },
  // How the Elements sidebar groups rows.
  elementsSort: "risk",   // "risk" | "category"
  // Dismissible prototype banner — true once the user closes it.
  bannerDismissed: false,
  // Heatmap grid resolution: "coarse" | "medium" | "fine".
  simResolution: "medium",
  // Width of the left sidebar column in px (user-resizable via divider).
  leftColWidth: null,
  // Optional numeric override (multiplier of the base grid resolution).
  // When set, takes precedence over simResolution.
  simResolutionFactor: null,
  // When true, the last-run analysis is re-fired after every render()
  // (debounced) so the heatmap stays in sync with layout edits.
  analysisLive: false,
  analysisLastSim: null,
  // User-editable tool groups. id is a stable slug; color is the swatch.
  categories:[
    { id:"general",   label:"General",      color:"#5aa9ff" },
    { id:"hand",      label:"Hand Tools",   color:"#7cc4ff" },
    { id:"power",     label:"Power Tools",  color:"#f0b441" },
    { id:"cutting",   label:"Cutting",      color:"#ef5d6f" },
    { id:"finishing", label:"Finishing",    color:"#34c98a" },
    { id:"assembly",  label:"Assembly",     color:"#a3cf4a" },
  ],
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
  // Heatmap overlay — null = off, else a METRIC_DEFS key.
  heatmapMetric:null,
  transformPanelPos:null,
  // Snap-to-grid dashboard layout: { cols, items:{ widgetId:{x,y,w,h} } }
  // in grid units. null until initDashboard() seeds it from defaults.
  dashboard:null,
  // User-overridden wall-type colors from the draw editor's key.
  wallTypeColors:null,
  // User preference weighting for the weighted-metrics score. null = use the
  // METRIC_DEFS defaults; otherwise a map metricId -> fractional weight.
  // Saved in the autosave snapshot and the exported configuration.
  metricWeights:null,
};

/* Effective weight for a metric (user override or the built-in default). */
function metricWeight(id){
  if(state.metricWeights && Number.isFinite(state.metricWeights[id])) return state.metricWeights[id];
  const md = METRIC_DEFS.find(m => m.id === id);
  return md ? md.weight : 0;
}
function metricWeightTotal(){
  let t = 0; for(const md of METRIC_DEFS) t += metricWeight(md.id);
  return t || 1;
}
function defaultMetricWeights(){
  const o = {}; for(const md of METRIC_DEFS) o[md.id] = md.weight; return o;
}

/* ------------------------------------------------------------------
   4.5  PERSISTENCE — autosave snapshot to localStorage so the user's
   imports, custom elements, edited positions, and per-preset edits
   survive a page reload. Save is debounced so drags don't thrash
   storage; restore happens at init() before the first render().
   ------------------------------------------------------------------ */
const _PERSIST_KEY = "space.v1.app";
let _persistTimer = null;
function saveAppState(){
  if(_persistTimer) clearTimeout(_persistTimer);
  _persistTimer = setTimeout(()=>{
    try {
      const snap = {
        v: 1,
        zoneDefs: ZONE_DEFS,
        presets: PRESETS,
        regions: REGIONS,
        state: {
          preset: state.preset,
          zones: state.zones,
          trafficMode: state.trafficMode,
          activeUse: state.activeUse,
          showClearance: state.showClearance,
          showFlow: state.showFlow,
          showSidebar: state.showSidebar,
          showGrid: state.showGrid,
          units: state.units,
          scale: state.scale,
          customElements: state.customElements,
          structuralElements: state.structuralElements,
          amenityElements: state.amenityElements,
          heatmapMetric: state.heatmapMetric,
          imports: state.imports,
          statusCollapsed: state.statusCollapsed,
          bannerDismissed: state.bannerDismissed,
          elementsSort: state.elementsSort,
          projectInfo: state.projectInfo,
          categories: state.categories,
          simResolution: state.simResolution,
          simResolutionFactor: state.simResolutionFactor,
          leftColWidth: state.leftColWidth,
          analysisLive: state.analysisLive,
          analysisLastSim: state.analysisLastSim,
          transformPanelPos: state.transformPanelPos,
          dashboard: state.dashboard,
          wallTypeColors: state.wallTypeColors,
          metricWeights: state.metricWeights,
        },
      };
      localStorage.setItem(_PERSIST_KEY, JSON.stringify(snap));
    } catch(e){
      console.warn("[persist] save failed:", e && e.message);
    }
  }, 300);
}

function loadAppState(){
  try {
    const raw = localStorage.getItem(_PERSIST_KEY);
    if(!raw) return false;
    const snap = JSON.parse(raw);
    if(!snap || snap.v !== 1) return false;
    // Mutate the const arrays/object in place to preserve any references
    // held in other modules.
    ZONE_DEFS.length = 0;
    if(Array.isArray(snap.zoneDefs)) ZONE_DEFS.push(...snap.zoneDefs);
    for(const k of Object.keys(PRESETS)) delete PRESETS[k];
    if(snap.presets && typeof snap.presets === "object") Object.assign(PRESETS, snap.presets);
    REGIONS.length = 0;
    if(Array.isArray(snap.regions)) REGIONS.push(...snap.regions);
    if(snap.state && typeof snap.state === "object") Object.assign(state, snap.state);
    return true;
  } catch(e){
    console.warn("[persist] load failed:", e && e.message);
    return false;
  }
}

function clearAppState(){
  try { localStorage.removeItem(_PERSIST_KEY); } catch(e){}
}

/* Recompute element % dimensions from their stored absolute (wReal/hReal)
   so a scale change keeps each element's real-world footprint. Built-in
   elements without wReal/hReal are left alone. Call after scale or
   floor-plan changes. */
function refitElementsToScale(){
  if(!hasScale()) return;
  function fit(def){
    if(!def || !Number.isFinite(def.wReal) || !Number.isFinite(def.hReal)) return;
    const cur = currentUnit();
    // The stored real dims were entered under def.realUnit, which may differ
    // from the current unit (e.g. an element made in meters, then the floor
    // plan recalibrated in feet). Convert first so the element keeps its true
    // real-world footprint, then re-stamp the unit so it stays consistent.
    if(def.realUnit && def.realUnit !== cur){
      def.wReal = convertUnits(def.wReal, def.realUnit, cur);
      def.hReal = convertUnits(def.hReal, def.realUnit, cur);
    }
    def.realUnit = cur;
    const newW = unitsToPct(def.wReal, "x");
    const newH = unitsToPct(def.hReal, "y");
    if(Number.isFinite(newW) && newW > 0) def.w = newW;
    if(Number.isFinite(newH) && newH > 0) def.h = newH;
    const z = state.zones[def.id];
    if(z){ z.w = def.w; z.h = def.h; }
  }
  for(const d of state.customElements)     fit(d);
  for(const d of state.structuralElements)  fit(d);
  for(const d of state.amenityElements)     fit(d);
  for(const d of ZONE_DEFS)                 fit(d);
}

/* ------------------------------------------------------------------
   5. UTILITY MATH
   ------------------------------------------------------------------ */

/* Real-units helpers. Internally all geometry is stored as 0..100% of
   the stage. Once a scale has been calibrated, we can convert between
   percent and real-world units (feet/meters) for display and input.
   Returns null when no scale is set. */
function hasScale(){ return !!(state.scale && state.scale.pxPerUnit); }
function currentUnit(){ return state.scale ? state.scale.unit : state.units; }

/* Linear length-unit conversion. Supports the app's display units (feet /
   meters, with a few aliases); unknown units fall through unchanged so a
   conversion is never lossy-by-guessing. 1 ft = 0.3048 m exactly. */
const _UNIT_TO_M = { m:1, meter:1, meters:1, ft:0.3048, foot:0.3048, feet:0.3048 };
function convertUnits(v, from, to){
  if(!Number.isFinite(v) || !from || !to || from === to) return v;
  const fm = _UNIT_TO_M[from], tm = _UNIT_TO_M[to];
  if(!fm || !tm) return v;
  return v * fm / tm;
}

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
  // Defensive: when a scoring/render rule names a zone id that hasn't
  // been loaded (e.g. partial elements bundle), return a degenerate rect
  // placed far off-stage so distance/overlap checks naturally fail.
  if(!z) return {x1:1e6,y1:1e6,x2:1e6,y2:1e6,cx:1e6,cy:1e6,w:0,h:0};
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

/* Clamp a zone's top-left (x,y) so its ROTATED footprint stays on the stage.
   Zones rotate about their center, so the on-stage extent is the rotated
   axis-aligned bounding box: effW = |w·cos|+|h·sin|, effH = |w·sin|+|h·cos|.
   Returns the clamped {x,y}. (Without this, dragging clamps to the unrotated
   w/h and a rotated element clips off the top/bottom or sides.) */
function clampZonePos(z, nx, ny){
  if(!z) return { x:nx, y:ny };
  const rot = (z.rotation || 0) * Math.PI / 180;
  const c = Math.abs(Math.cos(rot)), s = Math.abs(Math.sin(rot));
  const effW = z.w * c + z.h * s;
  const effH = z.w * s + z.h * c;
  let cx = nx + z.w / 2, cy = ny + z.h / 2;          // current center
  cx = (effW >= 100) ? 50 : clamp(cx, effW / 2, 100 - effW / 2);
  cy = (effH >= 100) ? 50 : clamp(cy, effH / 2, 100 - effH / 2);
  return { x: cx - z.w / 2, y: cy - z.h / 2 };
}
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

/* ------------------------------------------------------------------
   SIM OBSTACLE FOOTPRINT — shared by the ADA & egress grids.
   Returns { test(xFt,yFt)->bool, aabb:{x1,y1,x2,y2} } in feet for an
   element's blocking footprint, RESPECTING ROTATION (rotated rect, not
   AABB). When includeOperator is true (Active Use mode + the tool's
   active-use toggle), the operator footprint(s) are added so a present
   operator also blocks. Geometry is in stage feet (stageW/stageH).
   ------------------------------------------------------------------ */
function _ptInRotRect(xf, yf, s){
  const dx = xf - s.cx, dy = yf - s.cy;
  const c = Math.cos(-s.ang), si = Math.sin(-s.ang);
  const lx = dx * c - dy * si, ly = dx * si + dy * c;
  return Math.abs(lx) <= s.hw && Math.abs(ly) <= s.hh;
}
function _ptInRotEllipse(xf, yf, s){
  const dx = xf - s.cx, dy = yf - s.cy;
  const c = Math.cos(-s.ang), si = Math.sin(-s.ang);
  const lx = dx * c - dy * si, ly = dx * si + dy * c;
  const rx = s.rx || 1e-6, ry = s.ry || 1e-6;
  return (lx*lx)/(rx*rx) + (ly*ly)/(ry*ry) <= 1;
}
function simBlockerFootprint(def, z, stageW, stageH, includeOperator){
  const cxf = (z.x + z.w/2)/100 * stageW;
  const cyf = (z.y + z.h/2)/100 * stageH;
  const Wf  = z.w/100 * stageW, Hf = z.h/100 * stageH;
  const rot = (z.rotation || 0) * Math.PI/180;
  const cosR = Math.cos(rot), sinR = Math.sin(rot);
  const shapes = [{ kind:"rect", cx:cxf, cy:cyf, hw:Wf/2, hh:Hf/2, ang:rot }];

  if(includeOperator){
    const axisAng = ((def.principalAxis && def.principalAxis.angle) || 0) * Math.PI/180;
    const ops = (Array.isArray(def.operatorFootprints) && def.operatorFootprints.length)
      ? def.operatorFootprints
      : (def.operatorFootprint && def.operatorFootprint.type && def.operatorFootprint.type !== "none" ? [def.operatorFootprint] : []);
    for(const op of ops){
      if(!op || op.type === "none") continue;
      const ox = op.offsetX || 0, oy = op.offsetY || 0;     // local 0-100 from center
      const dxf = (ox/100) * Wf, dyf = (oy/100) * Hf;        // bbox-aligned feet
      const fx = cxf + (dxf*cosR - dyf*sinR);
      const fy = cyf + (dxf*sinR + dyf*cosR);
      if(op.type === "radius"){
        const r = (op.radius || 15)/100;
        shapes.push({ kind:"ellipse", cx:fx, cy:fy, rx:r*Wf, ry:r*Hf, ang:rot });
      } else if(op.type === "shape"){
        shapes.push({ kind:"rect", cx:fx, cy:fy, hw:(op.w||20)/100*Wf/2, hh:(op.h||15)/100*Hf/2, ang:rot + axisAng });
      }
    }
  }

  // AABB over all shapes (rough: use circumscribed radius per shape)
  let x1=Infinity,y1=Infinity,x2=-Infinity,y2=-Infinity;
  for(const s of shapes){
    const reach = (s.kind === "ellipse") ? Math.max(s.rx, s.ry)
                                         : Math.hypot(s.hw, s.hh);
    x1 = Math.min(x1, s.cx - reach); y1 = Math.min(y1, s.cy - reach);
    x2 = Math.max(x2, s.cx + reach); y2 = Math.max(y2, s.cy + reach);
  }
  const test = (xf, yf) => shapes.some(s =>
    s.kind === "ellipse" ? _ptInRotEllipse(xf, yf, s) : _ptInRotRect(xf, yf, s));
  return { test, aabb:{ x1, y1, x2, y2 } };
}

/* "Active use" expands assembly/work zone footprints to simulate
   chairs, carts, bins, and project material spillover. Returns an
   inflated rect for proximity / overlap checks. */
function effectiveRect(id, z, activeUse){
  const r = rect(z);
  if(!z || !activeUse) return r;
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
  // Snapshot the OUTGOING preset's edited positions back into PRESETS so
  // that switching tabs and coming back preserves what the user did.
  // Only runs when there's a meaningful state.zones to capture (i.e. on
  // every switch after the first preset load).
  if(state.preset && PRESETS[state.preset] && Object.keys(state.zones || {}).length){
    const prev = PRESETS[state.preset];
    if(!prev.zones) prev.zones = {};
    for(const [id, z] of Object.entries(state.zones)){
      prev.zones[id] = {
        x: z.x, y: z.y,
        w: z.w, h: z.h,
        rotation: z.rotation || 0,
      };
    }
  }

  state.preset = name;
  const preset = PRESETS[name];
  state.zones = {};
  for(const def of allZoneDefs()){
    const p = (preset && preset.zones && preset.zones[def.id]) || {x:50,y:50};
    state.zones[def.id] = {
      x: p.x, y: p.y,
      w: p.w !== undefined ? p.w : def.w,
      h: p.h !== undefined ? p.h : def.h,
      rotation: p.rotation || 0,
      included: true,           // per-element evaluation/render toggle
      activeUse: false,         // per-element active-use toggle
      locked: !!def.fixed,      // runtime lock; toggled from transform panel
    };
  }
  document.getElementById("presetPill").textContent =
    name === "current" ? "Current" : (name === "altA" ? "Alt A" : "Alt B");
}
