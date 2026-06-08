"use strict";
/* ==================================================================
   DASHBOARD — snap-to-grid, drag-to-move, drag-to-resize widget layout.
   Vanilla JS. Operates on .card[data-widget] elements inside #appGrid.
   Layout lives in state.dashboard.items (grid units) and persists via
   the existing autosave snapshot.

   Grid units: x/y are 0-based column/row indices; w/h are spans.
   Keep DASH_GAP / DASH_ROW_H in sync with css/dashboard.css.
   ================================================================== */

const DASH_COLS    = 12;
const DASH_ROW_H   = 36;   // px per row track (grid-auto-rows)
const DASH_GAP     = 14;   // px grid gap
const DASH_MIN_W   = 2;
const DASH_MIN_H   = 3;
// Bump when DASH_DEFAULTS changes so persisted layouts adopt the new default.
const DASH_VERSION = 3;

/* Default arrangement (grid units, 12 columns):
     LEFT  (x0,w3):  elements, weighted metrics, risk summary
     MID   (x3,w6):  layout builder (stage) across the top; below it split into
                     left half (x3,w3: top issues, flags) and right half
                     (x6,w3: conclusion, mentor note)
     RIGHT (x9,w3):  analysis widget, then the simulation result widgets that
                     appear when an analysis is run. */
const DASH_DEFAULTS = {
  // Left column
  elements:   { x:0, y:0,  w:3, h:8  },
  metrics:    { x:0, y:8,  w:3, h:5  },
  risk:       { x:0, y:13, w:3, h:5  },
  // Middle: stage on top, then the two stacked sub-columns beneath it
  stage:      { x:3, y:0,  w:6, h:14 },
  topIssues:  { x:3, y:14, w:3, h:6  },
  flags:      { x:3, y:20, w:3, h:6  },
  conclusion: { x:6, y:14, w:3, h:12 },
  // Right column
  analysis:   { x:9, y:0,  w:3, h:10 },
  simResults: { x:9, y:10, w:3, h:7  },
  simPenalty: { x:9, y:17, w:3, h:6  },
};

function dashDefaults(){
  const o = {};
  for(const k in DASH_DEFAULTS) o[k] = { ...DASH_DEFAULTS[k] };
  return o;
}

/* Ensure state.dashboard exists and every known widget has a slot
   (new widgets added in later versions inherit their default). */
function dashItems(){
  // Re-seed from defaults when missing or when the default layout version
  // changed (so existing users pick up a new default arrangement once).
  if(!state.dashboard || !state.dashboard.items || state.dashboard.version !== DASH_VERSION){
    state.dashboard = { version: DASH_VERSION, cols: DASH_COLS, items: dashDefaults() };
  }
  const items = state.dashboard.items;
  for(const k in DASH_DEFAULTS){
    if(!items[k]) items[k] = { ...DASH_DEFAULTS[k] };
  }
  return items;
}

function dashWidgetEls(){
  const grid = document.getElementById("appGrid");
  return grid ? Array.from(grid.querySelectorAll(":scope > [data-widget]")) : [];
}

function dashApplyItem(el, it){
  el.style.gridColumn = (it.x + 1) + " / span " + it.w;
  el.style.gridRow    = (it.y + 1) + " / span " + it.h;
}

function dashRenderPositions(){
  const items = dashItems();
  for(const el of dashWidgetEls()){
    const it = items[el.dataset.widget];
    if(it) dashApplyItem(el, it);
  }
}

function dashRectsOverlap(a, b){
  return a.x < b.x + b.w && a.x + a.w > b.x &&
         a.y < b.y + b.h && a.y + a.h > b.y;
}

/* Push overlapping widgets downward so none collide with priorityId,
   which keeps its position. Only currently-visible widgets participate. */
function dashResolve(priorityId){
  const items = dashItems();
  const visibleIds = dashWidgetEls()
    .filter(el => getComputedStyle(el).display !== "none")
    .map(el => el.dataset.widget)
    .filter(id => items[id]);
  const others = visibleIds
    .filter(id => id !== priorityId)
    .sort((a, b) => (items[a].y - items[b].y) || (items[a].x - items[b].x));
  const placed = (priorityId && items[priorityId]) ? [ { ...items[priorityId] } ] : [];
  for(const id of others){
    const it = { ...items[id] };
    let guard = 0;
    while(placed.some(p => dashRectsOverlap(it, p)) && guard++ < 500) it.y++;
    items[id].y = it.y;
    placed.push({ ...it });
  }
}

/* Pixel geometry of one grid cell, accounting for the container padding. */
function dashMetrics(){
  const grid = document.getElementById("appGrid");
  const cs = getComputedStyle(grid);
  const padL = parseFloat(cs.paddingLeft) || 0;
  const padR = parseFloat(cs.paddingRight) || 0;
  const padT = parseFloat(cs.paddingTop) || 0;
  const r = grid.getBoundingClientRect();
  const contentW = r.width - padL - padR;
  return {
    left:  r.left + padL,
    top:   r.top + padT,
    pitchX:(contentW + DASH_GAP) / DASH_COLS,
    pitchY: DASH_ROW_H + DASH_GAP,
  };
}

let _dashDrag = null;

function dashStartMove(el, e){
  const it = dashItems()[el.dataset.widget];
  if(!it) return;
  const r = el.getBoundingClientRect();
  _dashDrag = {
    mode:"move", el, id: el.dataset.widget,
    offX: e.clientX - r.left, offY: e.clientY - r.top,
  };
  el.classList.add("dragging");
  Object.assign(el.style, {
    position:"fixed", zIndex:"1000", pointerEvents:"none",
    width: r.width + "px", height: r.height + "px",
    left: r.left + "px", top: r.top + "px",
  });
  const ph = document.createElement("div");
  ph.className = "widget-placeholder";
  ph.dataset.gx = it.x; ph.dataset.gy = it.y;
  dashApplyItem(ph, it);
  document.getElementById("appGrid").appendChild(ph);
  _dashDrag.placeholder = ph;
  dashBeginPointer(e);
}

function dashStartResize(el, e){
  const it = dashItems()[el.dataset.widget];
  if(!it) return;
  _dashDrag = { mode:"resize", el, id: el.dataset.widget };
  el.classList.add("resizing");
  const ph = document.createElement("div");
  ph.className = "widget-placeholder";
  dashApplyItem(ph, it);
  document.getElementById("appGrid").appendChild(ph);
  _dashDrag.placeholder = ph;
  dashBeginPointer(e);
}

function dashBeginPointer(e){
  document.body.classList.add("dash-editing");
  window.addEventListener("pointermove", dashOnPointerMove);
  window.addEventListener("pointerup", dashOnPointerUp, { once:true });
  e.preventDefault();
}

function dashOnPointerMove(e){
  if(!_dashDrag) return;
  const m = dashMetrics();
  const it = dashItems()[_dashDrag.id];
  if(!it) return;

  if(_dashDrag.mode === "move"){
    const elLeft = e.clientX - _dashDrag.offX;
    const elTop  = e.clientY - _dashDrag.offY;
    _dashDrag.el.style.left = elLeft + "px";
    _dashDrag.el.style.top  = elTop + "px";
    let gx = Math.round((elLeft - m.left) / m.pitchX);
    let gy = Math.round((elTop  - m.top)  / m.pitchY);
    gx = clamp(gx, 0, DASH_COLS - it.w);
    gy = Math.max(0, gy);
    _dashDrag.placeholder.dataset.gx = gx;
    _dashDrag.placeholder.dataset.gy = gy;
    _dashDrag.placeholder.style.gridColumn = (gx + 1) + " / span " + it.w;
    _dashDrag.placeholder.style.gridRow    = (gy + 1) + " / span " + it.h;
  } else {
    const r = _dashDrag.el.getBoundingClientRect();
    let w = Math.round((e.clientX - r.left + DASH_GAP) / m.pitchX);
    let h = Math.round((e.clientY - r.top  + DASH_GAP) / m.pitchY);
    w = clamp(w, DASH_MIN_W, DASH_COLS - it.x);
    h = Math.max(DASH_MIN_H, h);
    it.w = w; it.h = h;
    dashApplyItem(_dashDrag.el, it);
    dashApplyItem(_dashDrag.placeholder, it);
  }
}

function dashOnPointerUp(){
  if(!_dashDrag) return;
  const it = dashItems()[_dashDrag.id];
  const el = _dashDrag.el;

  if(_dashDrag.mode === "move"){
    const gx = parseInt(_dashDrag.placeholder.dataset.gx, 10);
    const gy = parseInt(_dashDrag.placeholder.dataset.gy, 10);
    if(Number.isFinite(gx)) it.x = gx;
    if(Number.isFinite(gy)) it.y = gy;
    Object.assign(el.style, {
      position:"", zIndex:"", pointerEvents:"",
      width:"", height:"", left:"", top:"",
    });
    el.classList.remove("dragging");
    dashApplyItem(el, it);
  } else {
    el.classList.remove("resizing");
  }

  if(_dashDrag.placeholder) _dashDrag.placeholder.remove();
  dashResolve(_dashDrag.id);
  dashRenderPositions();
  document.body.classList.remove("dash-editing");
  window.removeEventListener("pointermove", dashOnPointerMove);
  _dashDrag = null;
  if(typeof saveAppState === "function") saveAppState();
  if(typeof render === "function") render();   // stage may have changed size
}

function dashResetLayout(){
  state.dashboard = { version: DASH_VERSION, cols: DASH_COLS, items: dashDefaults() };
  dashRenderPositions();
  if(typeof saveAppState === "function") saveAppState();
  if(typeof render === "function") render();
}

function initDashboard(){
  const grid = document.getElementById("appGrid");
  if(!grid) return;
  dashItems();
  for(const el of dashWidgetEls()){
    const h3 = el.querySelector("h3");
    if(h3 && !h3.querySelector(".wgrip")){
      const grip = document.createElement("span");
      grip.className = "wgrip";
      grip.title = "Drag to move this widget";
      grip.setAttribute("aria-hidden", "true");
      grip.textContent = "⠿";
      h3.insertBefore(grip, h3.firstChild);
      grip.addEventListener("pointerdown", (e) => { if(e.button === 0) dashStartMove(el, e); });
    }
    if(!el.querySelector(".wresize")){
      const rz = document.createElement("span");
      rz.className = "wresize";
      rz.title = "Drag to resize this widget";
      el.appendChild(rz);
      rz.addEventListener("pointerdown", (e) => { if(e.button === 0) dashStartResize(el, e); });
    }
  }
  dashRenderPositions();
  const resetBtn = document.getElementById("resetDashboardBtn");
  if(resetBtn && !resetBtn._dashWired){
    resetBtn.addEventListener("click", dashResetLayout);
    resetBtn._dashWired = true;
  }
}
