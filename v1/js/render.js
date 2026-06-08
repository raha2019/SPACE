"use strict";
/* ------------------------------------------------------------------
   7. RENDERING — stage, regions, zones, clearance, flow lines
   ------------------------------------------------------------------ */
const stageEl = document.getElementById("stage");

function renderRegions(){
  stageEl.querySelectorAll(".region-shade").forEach(n=>n.remove());
  REGIONS.forEach(r=>{
    const d = document.createElement("div");
    d.className = "region-shade";
    d.style.left = r.x+"%"; d.style.top = r.y+"%";
    d.style.width = r.w+"%"; d.style.height = r.h+"%";
    d.style.background = r.color;
    d.innerHTML = `<span class="lbl">${r.label}</span>`;
    stageEl.appendChild(d);
  });
}

/* X/Y coordinate reference grid on the stage. Lines are drawn in a
   preserveAspectRatio="none" SVG (so they map to stage %), while the
   coordinate labels are HTML divs positioned by % so text isn't stretched.
   Labels show real units when a scale is calibrated, otherwise percent. */
function renderGrid(){
  stageEl.querySelectorAll(".coord-grid,.cg-label").forEach(n=>n.remove());
  if(!state.showGrid) return;
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("class", "coord-grid");
  svg.setAttribute("viewBox", "0 0 100 100");
  svg.setAttribute("preserveAspectRatio", "none");
  const step = 10;
  let lines = "";
  for(let p = 0; p <= 100; p += step){
    const major = (p % 50 === 0);
    const cls = major ? "cg-line cg-major" : "cg-line";
    lines += `<line x1="${p}" y1="0" x2="${p}" y2="100" class="${cls}"/>`;
    lines += `<line x1="0" y1="${p}" x2="100" y2="${p}" class="${cls}"/>`;
  }
  svg.innerHTML = lines;
  stageEl.appendChild(svg);
  const scaled = (typeof hasScale === "function") && hasScale();
  const fmt = (p, axis) => scaled ? pctToUnits(p, axis).toFixed(0) : p + "%";
  const frag = document.createDocumentFragment();
  for(let p = step; p < 100; p += step){
    const xl = document.createElement("div");
    xl.className = "cg-label cg-x";
    xl.style.left = p + "%";
    xl.textContent = fmt(p, "x");
    frag.appendChild(xl);
    const yl = document.createElement("div");
    yl.className = "cg-label cg-y";
    yl.style.top = p + "%";
    yl.textContent = fmt(p, "y");
    frag.appendChild(yl);
  }
  // Unit marker in the corner.
  const corner = document.createElement("div");
  corner.className = "cg-label cg-origin";
  corner.textContent = scaled ? (state.scale.unit) : "%";
  frag.appendChild(corner);
  stageEl.appendChild(frag);
}

function renderFlowLines(){
  stageEl.querySelectorAll(".flow-line,.flow-label").forEach(n=>n.remove());
  if(!state.showFlow) return;

  // Connector corridor centerline (vertical)
  const conn = state.zones.connector;
  if(conn){
    const c = rect(conn);
    const line = document.createElement("div");
    line.className="flow-line";
    line.style.left=(c.cx)+"%";
    line.style.top=c.y1+"%";
    line.style.width="0";
    line.style.height=(c.y2-c.y1)+"%";
    line.style.borderTop="0";
    line.style.borderLeft="2px dashed rgba(122,160,255,.55)";
    stageEl.appendChild(line);
    const lbl = document.createElement("div");
    lbl.className="flow-label";
    lbl.style.left=(c.cx-7)+"%"; lbl.style.top=(c.y1-3)+"%";
    lbl.textContent="Connector";
    stageEl.appendChild(lbl);
  }
  // Egress lines: entrance -> exitN, entrance -> exitS
  drawEgress("entrance","exitN");
  drawEgress("entrance","exitS");
}
function drawEgress(aId,bId){
  if(!state.zones[aId] || !state.zones[bId]) return;
  const a = rect(state.zones[aId]);
  const b = rect(state.zones[bId]);
  const ln = document.createElement("div");
  ln.className="flow-line";
  // SVG-style approximation using a rotated div
  const x1=a.cx, y1=a.cy, x2=b.cx, y2=b.cy;
  const len = Math.hypot(x2-x1, y2-y1);
  const angle = Math.atan2(y2-y1, x2-x1) * 180/Math.PI;
  ln.style.left = x1+"%";
  ln.style.top  = y1+"%";
  ln.style.width = len+"%";
  ln.style.height = "0";
  ln.style.transformOrigin = "0 0";
  ln.style.transform = `rotate(${angle}deg)`;
  ln.style.borderTop = "1.5px dashed rgba(255,90,110,.45)";
  stageEl.appendChild(ln);
}

function renderZones(){
  // Remove old
  stageEl.querySelectorAll(".zone,.clearance").forEach(n=>n.remove());

  for(const def of allZoneDefs()){
    const z = state.zones[def.id];
    if(!z) continue;
    // Excluded ("inc" toggle off) → hide entirely from the stage.
    if(z.included === false) continue;


    const el = document.createElement("div");
    el.className = `zone r${def.risk} ${def.fixed?"fixed":""}`;
    if(def.elementClass === "structural"){
      el.classList.add("struct-" + (def.subtype || "wall"));
      if(def.wallType) el.classList.add("wall-" + def.wallType);
    }
    if(def.elementClass === "amenity"){
      el.classList.add("amenity");
    }
    // Custom elements with a real footprint drop the boxy fill/border so
    // the composite SVG inside is the only thing the user sees as the
    // element's "shape" (the bounding rect is still clickable/draggable).
    if(def.custom && def.shapes && def.shapes.length){
      el.classList.add("shape-only");
    }
    if(state.selectedId === def.id) el.classList.add("selected");
    if(z.included === false) el.classList.add("excluded");
    if(z.activeUse) el.classList.add("active-use-on");
    el.dataset.id = def.id;
    el.style.left = z.x+"%";
    el.style.top  = z.y+"%";
    el.style.width  = z.w+"%";
    el.style.height = z.h+"%";
    // Category order drives stage layering: earlier categories sit
    // behind, later ones in front. Zones without a category fall back
    // to a baseline so they don't collide with intentional layering.
    // Layering: structural (walls/floors/doors) is always the bottom layer
    // so tools and amenities draw on top of it. Categorized tools layer by
    // category order above that; everything else sits in between.
    if(def.elementClass === "structural"){
      el.style.zIndex = "1";
    } else if(def.cat && Array.isArray(state.categories)){
      const idx = state.categories.findIndex(c => c.id === def.cat);
      el.style.zIndex = String(idx >= 0 ? 10 + idx : 8);
    } else {
      el.style.zIndex = "8";
    }
    if(z.rotation){
      el.style.transform = `rotate(${z.rotation}deg)`;
      el.style.transformOrigin = "center center";
    }

    // Amenities keep their marker icon/label visible even when labels are
    // off — the icon is the element's identity, not a name annotation.
    const isAmenity = def.elementClass === "amenity";
    const labelHidden = state.showLabels === false && !isAmenity;
    el.innerHTML = `
      <div class="row1" style="${labelHidden ? "display:none" : ""}">
        <span class="lbl" title="${def.label}${def.description ? "\n" + def.description : ""}">${def.label}</span>
        <span class="warn-ico" data-ico></span>
      </div>
      <div class="badge" style="${labelHidden ? "display:none" : ""}">R${def.risk} · ${RISK_TAGS[def.risk]}</div>
    `;

    // For custom elements with composite footprints, overlay an SVG
    // showing the actual shape + axis + risk vectors (in local 0-100
    // coords). The bounding rect is still the zone div itself.
    if(def.custom && def.shapes && def.shapes.length){
      const svg = buildCompositeSVG(def);
      if(svg) el.appendChild(svg);
    }

    stageEl.appendChild(el);
    attachZoneInteractions(el, def);
  }
}

/* Build an SVG node visualizing a custom element's composite footprint,
   principal axis, and risk vectors in its local 0-100 coordinate
   space. Stored as an overlay inside the .zone div. */
function buildCompositeSVG(def){
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class","composite-svg");
  svg.setAttribute("viewBox","0 0 100 100");
  svg.setAttribute("preserveAspectRatio","none");

  // Inline marker defs so arrowheads work outside the builder's
  // preview canvas. Each marker gets a per-zone-unique id since
  // multiple .composite-svg elements share the page.
  const uid = def.id;
  const defsNode = document.createElementNS(ns,"defs");
  defsNode.innerHTML = `
    <marker id="kb-${uid}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" fill="#ff5e6e"/>
    </marker>
    <marker id="mat-${uid}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" fill="#e8a83b"/>
    </marker>
    <marker id="axis-${uid}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" fill="#f5d76e"/>
    </marker>
  `;
  svg.appendChild(defsNode);

  // 1) footprint shapes
  (def.shapes || []).forEach(sh=>{
    if(sh.type === "rect"){
      const r = document.createElementNS(ns,"rect");
      r.setAttribute("class","fp");
      r.setAttribute("x", sh.x); r.setAttribute("y", sh.y);
      r.setAttribute("width", sh.w); r.setAttribute("height", sh.h);
      if(sh.rotation){
        r.setAttribute("transform", `rotate(${sh.rotation} ${sh.x + sh.w/2} ${sh.y + sh.h/2})`);
      }
      svg.appendChild(r);
    } else if(sh.type === "circle"){
      const c = document.createElementNS(ns,"circle");
      c.setAttribute("class","fp");
      c.setAttribute("cx", sh.x); c.setAttribute("cy", sh.y);
      c.setAttribute("r", sh.radius);
      svg.appendChild(c);
    } else if(sh.type === "polygon"){
      // Free-form footprint (walls, doors, rooms) drawn in the wall editor.
      const poly = document.createElementNS(ns,"polygon");
      poly.setAttribute("class","fp");
      poly.setAttribute("points", (sh.points||[]).map(p=>`${p.x},${p.y}`).join(" "));
      // Per-instance color (from the editable wall-type key) overrides CSS.
      if(def.color){
        poly.style.stroke = def.color;
        poly.style.fill   = def.color;
        poly.style.fillOpacity = (def.subtype === "construction") ? 0.14
                               : (def.subtype === "floor") ? 0 : 0.55;
      }
      svg.appendChild(poly);
    }
  });

  // 2) risk vectors (drawn before axis so axis sits on top). Each kind
  // now stores an array of entries; we also fall back to the legacy
  // singular fields so old saves keep rendering.
  const axisAngle = (def.principalAxis && def.principalAxis.angle) || 0;
  const _eachZone = (arr, legacy, cls) => {
    const list = Array.isArray(arr) && arr.length ? arr
              : (legacy && legacy.type && legacy.type !== "none" ? [legacy] : []);
    for(const e of list) drawRiskZone(svg, e, cls, axisAngle, uid);
  };
  _eachZone(def.operatorFootprints,    def.operatorFootprint,    "op");
  _eachZone(def.maintenanceFootprints, def.maintenanceFootprint, "mt");
  _eachZone(def.kickbackVectors,       def.kickbackVector,       "kb");
  _eachZone(def.materialVectors,       def.materialVector,       "mat");

  // 3) principal axis
  if(def.principalAxis && def.principalAxis.length > 0){
    const ang = axisAngle * Math.PI / 180;
    const len = def.principalAxis.length;
    const x2 = 50 + Math.cos(ang) * len/2;
    const y2 = 50 + Math.sin(ang) * len/2;
    const line = document.createElementNS(ns,"line");
    line.setAttribute("class","axis");
    line.setAttribute("x1","50"); line.setAttribute("y1","50");
    line.setAttribute("x2", x2); line.setAttribute("y2", y2);
    line.setAttribute("marker-end", `url(#axis-${uid})`);
    svg.appendChild(line);
  }
  return svg;
}

function drawRiskZone(svg, zone, cls, axisAngle, uid){
  if(!zone || zone.type === "none") return;
  const ns = "http://www.w3.org/2000/svg";
  const ang = axisAngle || 0;
  // Resolve the offset exactly like the Element Builder live preview: prefer
  // offsetX/offsetY, fall back to the legacy single `offset` along the axis.
  // (Previously the stage ignored offsetX/offsetY, so footprints rendered
  // centered on the tool and didn't match the preview.)
  let ox = zone.offsetX, oy = zone.offsetY;
  if(ox === undefined && zone.offset !== undefined){
    const a = ang * Math.PI / 180;
    ox = Math.cos(a) * zone.offset; oy = Math.sin(a) * zone.offset;
  }
  ox = ox || 0; oy = oy || 0;
  if(zone.type === "radius"){
    const c = document.createElementNS(ns,"circle");
    c.setAttribute("class", cls);
    c.setAttribute("cx", 50 + ox); c.setAttribute("cy", 50 + oy);
    c.setAttribute("r", zone.radius || 30);
    svg.appendChild(c);
  } else if(zone.type === "shape"){
    const r = document.createElementNS(ns,"rect");
    r.setAttribute("class", cls);
    const w = zone.w || 40, h = zone.h || 20;
    r.setAttribute("x", 50 - w/2 + ox);
    r.setAttribute("y", 50 - h/2 + oy);
    r.setAttribute("width", w);
    r.setAttribute("height", h);
    r.setAttribute("transform", `rotate(${ang} ${50 + ox} ${50 + oy})`);
    svg.appendChild(r);
  } else if(zone.type === "vector"){
    // Vector cones are drawn at the stage level (see renderVectorOverlay)
    // so they extend until they hit a wall/door. Skip per-element render.
  }
}

function applyZoneFlagDecorations(){
  // Map zone id -> worst severity. Only the FIRST zone in a flag's
  // zone list is treated as "primary" (the cause). Subsequent zones
  // are contextual (e.g. "obstructed exit") and should not receive a
  // warning icon — they are referenced for explanatory text only.
  // Also skip fixed zones from icon decoration so labels stay readable.
  const fixedIds = new Set(ZONE_DEFS.filter(d=>d.fixed).map(d=>d.id));
  const idToWorst = {};
  for(const f of state.flags){
    const primary = (f.zones||[])[0];
    if(!primary || fixedIds.has(primary)) continue;
    const cur = idToWorst[primary];
    const order = {crit:3, warn:2, notice:1};
    if(!cur || order[f.severity] > order[cur]) idToWorst[primary] = f.severity;
  }
  stageEl.querySelectorAll(".zone").forEach(el=>{
    const id = el.dataset.id;
    const ico = el.querySelector("[data-ico]");
    const sev = idToWorst[id];
    el.classList.remove("flagged","crit","warn","notice");
    ico.className = "warn-ico";
    ico.textContent = "";
    if(sev){
      el.classList.add("flagged", sev);
      ico.classList.add(sev);
      ico.textContent = sev === "crit" ? "⚠" : (sev === "warn" ? "▲" : "•");
    }
  });
}

/* ------------------------------------------------------------------
   8. POINTER INTERACTIONS — drag + click-to-select
   ------------------------------------------------------------------ */
function attachZoneInteractions(el, def){
  let dragging = false;
  let didMove = false;
  let startX, startY, startZx, startZy, stageRect;

  el.addEventListener("pointerdown", (e)=>{
    el.setPointerCapture(e.pointerId);
    dragging = true;
    didMove = false;
    if(!isZoneLocked(def.id)) el.classList.add("dragging");
    stageRect = stageEl.getBoundingClientRect();
    startX = e.clientX; startY = e.clientY;
    const z = state.zones[def.id];
    startZx = z.x; startZy = z.y;
    e.preventDefault();
    e.stopPropagation();
  });

  el.addEventListener("pointermove",(e)=>{
    if(!dragging) return;
    if(isZoneLocked(def.id)) return; // locked zones still selectable but not draggable
    const z = state.zones[def.id];
    const dxPx = e.clientX - startX;
    const dyPx = e.clientY - startY;
    if(Math.abs(dxPx) > 3 || Math.abs(dyPx) > 3) didMove = true;
    const dxPct = (dxPx/stageRect.width)*100;
    const dyPct = (dyPx/stageRect.height)*100;
    let nx = startZx + dxPct;
    let ny = startZy + dyPct;
    if(e.shiftKey){
      nx = Math.round(nx/2)*2;
      ny = Math.round(ny/2)*2;
    }
    // Clamp against the ROTATED footprint so a rotated element can't clip off-stage.
    const p = clampZonePos(z, nx, ny);
    z.x = p.x; z.y = p.y;
    el.style.left = z.x+"%";
    el.style.top  = z.y+"%";
    // Update transform-panel inputs live while dragging
    if(state.selectedId === def.id) updateTransformPanelInputs();
    evaluate(); render(true);
  });

  const finish = (e)=>{
    if(!dragging) return;
    dragging = false;
    el.classList.remove("dragging");
    // Treat a pointerup without movement as a click → select.
    if(!didMove) selectZone(def.id);
    evaluate(); render();
  };
  el.addEventListener("pointerup", finish);
  el.addEventListener("pointercancel", finish);
}

// Legacy alias retained in case any code still calls attachDrag.
function attachDrag(el, def){ attachZoneInteractions(el, def); }
/* ------------------------------------------------------------------
   10. RENDER LEFT + RIGHT PANELS
   ------------------------------------------------------------------ */
function renderMetrics(){
  const body = document.getElementById("metricsBody");
  body.innerHTML = "";
  const total = metricWeightTotal();
  for(const md of METRIC_DEFS){
    const v = state.metrics[md.id] || 0;
    const pct = ((v-1)/4)*100;
    const active = state.heatmapMetric === md.id;
    const wPct = Math.round(metricWeight(md.id) * 100);
    const div = document.createElement("div");
    div.className = "metric clickable" + (active ? " active" : "");
    div.title = active ? "Click to hide heatmap" : "Click the label to show this metric's heatmap";
    div.innerHTML = `
      <div class="lbl">
        <span>${md.label}${active ? ' <span class="hm-dot" title="Heatmap active">●</span>' : ''}</span>
        <b>${v.toFixed(1)}/5
          <span class="metric-w-wrap" title="Weight — your priority for this metric (edit to re-weight the score)">
            <input class="metric-w" type="number" min="0" max="100" step="1" value="${wPct}" />%
          </span>
        </b>
      </div>
      <div class="bar rev"><i style="width:${pct}%"></i></div>
    `;
    div.addEventListener("click", (e)=>{
      if(e.target.closest(".metric-w-wrap")) return;  // editing weight, not toggling heatmap
      state.heatmapMetric = state.heatmapMetric === md.id ? null : md.id;
      render(true);
    });
    const wInput = div.querySelector(".metric-w");
    wInput.addEventListener("click", e=>e.stopPropagation());
    wInput.addEventListener("change", ()=>{
      const val = parseFloat(wInput.value);
      if(!Number.isFinite(val) || val < 0) return;
      state.metricWeights = state.metricWeights || defaultMetricWeights();
      state.metricWeights[md.id] = val / 100;
      evaluate(); render();
      if(typeof saveAppState === "function") saveAppState();
    });
    body.appendChild(div);
  }
  // Total-weight readout + reset to defaults.
  const tot = document.createElement("div");
  tot.className = "metric-total";
  const custom = !!state.metricWeights;
  tot.innerHTML = `<span>Total weight</span><b class="${Math.round(total*100)!==100?'off':''}">${Math.round(total*100)}%</b>` +
    (custom ? `<button class="metric-w-reset" title="Reset to default weights">reset</button>` : ``);
  const rb = tot.querySelector(".metric-w-reset");
  if(rb) rb.addEventListener("click", ()=>{
    state.metricWeights = null; evaluate(); render();
    if(typeof saveAppState === "function") saveAppState();
  });
  body.appendChild(tot);
}

/* ------------------------------------------------------------------
   10.7 HEATMAP — visualize how a metric varies across the stage.
   Each metric defines a scalar field in [0, 1] (0 = cool/good,
   1 = hot/risky). Click a metric in the sidebar to toggle.
   ------------------------------------------------------------------ */
function _heatmapField(key, x, y){
  const Z = state.zones;
  const defs = allZoneDefs();
  const dist01 = (d, max) => Math.min(1, d / max);
  function nearestDist(filter){
    let best = Infinity;
    for(const d of defs){
      if(!filter(d)) continue;
      const z = Z[d.id]; if(!z) continue;
      const cx = z.x + z.w/2, cy = z.y + z.h/2;
      const dd = Math.hypot(x - cx, y - cy);
      if(dd < best) best = dd;
    }
    return best === Infinity ? 100 : best;
  }
  function densityWithin(radius, filter){
    let n = 0;
    for(const d of defs){
      if(filter && !filter(d)) continue;
      const z = Z[d.id]; if(!z) continue;
      const cx = z.x + z.w/2, cy = z.y + z.h/2;
      if(Math.hypot(x - cx, y - cy) < radius) n++;
    }
    return n;
  }
  switch(key){
    case "safety":     return 1 - dist01(nearestDist(d=>d.risk >= 4), 35);
    case "congestion": return Math.min(1, densityWithin(12, d=>!d.fixed) / 6);
    case "toolRisk":   return dist01(nearestDist(d=>d.id === "mainDesk"), 70);
    case "access":     return dist01(nearestDist(d=>d.cat === "exit"), 70);
    case "workflow":   return dist01(nearestDist(d=>d.id === "asm1" || d.id === "asm2"), 55);
    case "flex":       return Math.min(1, densityWithin(15) / 8);
    case "beginner":   return dist01(nearestDist(d=>d.id === "craftland" || d.id === "entrance"), 60);
  }
  return 0;
}

function renderHeatmap(){
  stageEl.querySelectorAll(".heatmap-overlay").forEach(n=>n.remove());
  const key = state.heatmapMetric;
  if(!key || !allZoneDefs().length) return;

  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "heatmap-overlay");
  svg.setAttribute("viewBox", "0 0 100 100");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.style.position = "absolute";
  svg.style.inset = "0";
  svg.style.width = "100%";
  svg.style.height = "100%";
  svg.style.pointerEvents = "none";
  svg.style.zIndex = "4";

  const N = 28;
  const cell = 100 / N;
  for(let i = 0; i < N; i++){
    for(let j = 0; j < N; j++){
      const cx = (i + 0.5) * cell;
      const cy = (j + 0.5) * cell;
      const v = Math.max(0, Math.min(1, _heatmapField(key, cx, cy)));
      if(v < 0.04) continue;
      const r = document.createElementNS(ns, "rect");
      r.setAttribute("x", (i * cell).toFixed(2));
      r.setAttribute("y", (j * cell).toFixed(2));
      r.setAttribute("width", cell.toFixed(2));
      r.setAttribute("height", cell.toFixed(2));
      // 120° (green / cool) → 0° (red / hot)
      const hue = (1 - v) * 120;
      r.setAttribute("fill", `hsl(${hue}, 80%, 50%)`);
      r.setAttribute("fill-opacity", (v * 0.5).toFixed(2));
      svg.appendChild(r);
    }
  }
  stageEl.appendChild(svg);
}

function renderFlags(){
  const list = document.getElementById("warnList");
  list.innerHTML = "";
  if(state.flags.length === 0){
    list.innerHTML = `<div class="empty">No issues detected. ✓</div>`;
  } else {
    for(const f of state.flags){
      const card = document.createElement("div");
      card.className = `wcard ${f.severity}`;
      const sevLabel = f.severity==="crit" ? "Critical" : (f.severity==="warn" ? "Warning" : "Notice");
      card.innerHTML = `
        <div class="head">
          <span class="sev">${sevLabel}</span>
          <span class="ttl">${f.title}</span>
          <span class="chev">▶</span>
        </div>
        <div class="body">
          <p><b>Why it matters:</b> ${f.why}</p>
          <p><b>Suggested fix:</b> ${f.fix}</p>
        </div>
      `;
      card.querySelector(".head").addEventListener("click",()=>card.classList.toggle("open"));
      list.appendChild(card);
    }
  }
  document.getElementById("flagCountPill").textContent = `${state.flags.length}`;
}

function renderSummary(){
  const cnt = countFlags();
  document.getElementById("cnt-crit").textContent   = cnt.crit;
  document.getElementById("cnt-warn").textContent   = cnt.warn;
  document.getElementById("cnt-notice").textContent = cnt.notice;
  document.getElementById("overallScore").textContent = state.score;
  document.getElementById("conclScore").textContent   = state.score;

  const gateEl = document.getElementById("gateBadge");
  const gateEl2 = document.getElementById("conclGate");
  const gateLabels = { pass:"Pass", warn:"Warning", fail:"Fail" };
  for(const el of [gateEl, gateEl2]){
    el.className = `gate ${state.gate}`;
    el.textContent = gateLabels[state.gate];
  }
}

function renderConclusion(){
  // No bundle loaded → minimal placeholder.
  if(!Object.keys(state.metrics).length){
    document.getElementById("primaryFail").textContent = "—";
    document.getElementById("statusSummary").textContent = "Import an elements bundle (e.g. default-elements.json) to see scoring.";
    document.getElementById("topProblems").innerHTML = `<li class="muted">No issues detected.</li>`;
    document.getElementById("topFixes").innerHTML = `<li class="muted">Layout looks acceptable.</li>`;
    return;
  }
  // Primary failure mode
  const cnt = countFlags();
  const pf = (() => {
    if(cnt.crit > 0){
      const c = state.flags.find(f=>f.severity==="crit");
      return `Critical · ${c.title}`;
    }
    if(cnt.warn > 0){
      const c = state.flags.find(f=>f.severity==="warn");
      return `Warning · ${c.title}`;
    }
    return "None — layout passes feasibility gate";
  })();
  document.getElementById("primaryFail").textContent = pf;

  // Status summary (plain English)
  const lowMetric = METRIC_DEFS
    .map(md=>({...md, v:state.metrics[md.id]}))
    .sort((a,b)=>a.v-b.v)[0];
  const summary =
    `This layout scores ${state.score}/100 and receives a ` +
    `${state.gate==="pass"?"Pass":(state.gate==="warn"?"Warning":"Fail")} status. ` +
    (cnt.crit ? `It has ${cnt.crit} critical and ${cnt.warn} warning issue(s); ` : (cnt.warn ? `It has ${cnt.warn} warning(s) but no critical failures; ` : `No critical or warning issues were detected; `)) +
    `the weakest metric is ${lowMetric.label.toLowerCase()} (${lowMetric.v.toFixed(1)}/5). ` +
    (state.activeUse ? `Active-use mode is on, so table footprints are expanded. ` : ``) +
    (state.trafficMode==="peak" ? `Peak-semester traffic increases congestion penalty. ` : (state.trafficMode==="summer" ? `Summer traffic mode lowers congestion pressure. ` : ``));
  document.getElementById("statusSummary").textContent = summary;

  // Top problems (first 3 flags by severity)
  const probs = state.flags.slice(0,3);
  const probsEl = document.getElementById("topProblems");
  probsEl.innerHTML = "";
  if(probs.length === 0){
    probsEl.innerHTML = `<li class="muted">No issues detected.</li>`;
  } else {
    probs.forEach(p=>{
      const li = document.createElement("li");
      li.innerHTML = `<b>${p.severity==="crit"?"Critical":p.severity==="warn"?"Warning":"Notice"}:</b> ${p.title}`;
      probsEl.appendChild(li);
    });
  }
  // Top fixes
  const fixesEl = document.getElementById("topFixes");
  fixesEl.innerHTML = "";
  if(probs.length === 0){
    fixesEl.innerHTML = `<li class="muted">Layout looks acceptable. Validate with staff.</li>`;
  } else {
    probs.forEach(p=>{
      const li = document.createElement("li");
      li.textContent = p.fix;
      fixesEl.appendChild(li);
    });
  }
}

/* ------------------------------------------------------------------
   10.5 VECTOR OVERLAY — kickback / material vectors as cones that
   extend from the element's center until they hit a structural
   wall/door (treated as opaque obstacles). Rendered at stage level
   so the cone can sweep past the element's bounding box.
   ------------------------------------------------------------------ */
function _walls(){
  // Collect structural walls and doors as obstacles in stage % coords.
  return allZoneDefs()
    .filter(d => d.elementClass === "structural" && (d.subtype === "wall" || d.subtype === "door"))
    .map(d => {
      const z = state.zones[d.id];
      if(!z || z.included === false) return null;
      return { x1:z.x, y1:z.y, x2:z.x+z.w, y2:z.y+z.h };
    })
    .filter(Boolean);
}

function _raycast(ox, oy, dx, dy, walls){
  // Returns t (in % units along ray) of nearest wall hit, or stage edge.
  let best = Infinity;
  // Stage bounds at 0..100
  const tBoundsX = dx > 0 ? (100 - ox) / dx : dx < 0 ? (0 - ox) / dx : Infinity;
  const tBoundsY = dy > 0 ? (100 - oy) / dy : dy < 0 ? (0 - oy) / dy : Infinity;
  best = Math.min(best, tBoundsX, tBoundsY);
  // Walls: classic slab method on each rect.
  for(const w of walls){
    let t0 = 0, t1 = best;
    const px = [-dx, dx, -dy, dy];
    const qx = [ox - w.x1, w.x2 - ox, oy - w.y1, w.y2 - oy];
    let hit = true;
    for(let i = 0; i < 4; i++){
      if(px[i] === 0){
        if(qx[i] < 0){ hit = false; break; }
      } else {
        const t = qx[i] / px[i];
        if(px[i] < 0){ if(t > t1) { hit = false; break; } if(t > t0) t0 = t; }
        else         { if(t < t0) { hit = false; break; } if(t < t1) t1 = t; }
      }
    }
    if(hit && t0 > 0 && t0 < best) best = t0;
  }
  return best;
}

function renderVectorOverlay(){
  // Remove old overlay.
  stageEl.querySelectorAll(".vector-overlay").forEach(n => n.remove());

  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "vector-overlay");
  svg.setAttribute("viewBox", "0 0 100 100");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.style.position = "absolute";
  svg.style.inset = "0";
  svg.style.width  = "100%";
  svg.style.height = "100%";
  svg.style.pointerEvents = "none";
  svg.style.zIndex = "5";

  const walls = _walls();
  const SAMPLES = 9; // rays across the cone

  // Flatten each element's vector arrays into the (entry, class) list.
  // Legacy singular fields are honored as a single-entry fallback.
  function _collectVectors(def){
    const out = [];
    const push = (arr, legacy, cls) => {
      const list = Array.isArray(arr) && arr.length ? arr
                : (legacy ? [legacy] : []);
      for(const v of list) if(v && v.type === "vector") out.push({ v, cls });
    };
    push(def.kickbackVectors, def.kickbackVector, "vec-kb");
    push(def.materialVectors, def.materialVector, "vec-mat");
    return out;
  }

  for(const def of allZoneDefs()){
    const z = state.zones[def.id];
    if(!z || z.included === false) continue;
    const vectors = _collectVectors(def);
    if(!vectors.length) continue;
    const eCx = z.x + z.w / 2;
    const eCy = z.y + z.h / 2;
    const baseAngle = (def.principalAxis && def.principalAxis.angle) || 0;
    const rot = z.rotation || 0;
    for(const {v, cls} of vectors){
      if(!v || v.type !== "vector") continue;
      const spread = v.angleSpread !== undefined ? v.angleSpread : 12;
      // Per-vector origin offset (in element-local %; rotate with the element).
      const ox = (v.offsetX || 0) * (z.w / 100);
      const oy = (v.offsetY || 0) * (z.h / 100);
      const rotRad = rot * Math.PI / 180;
      const cosR = Math.cos(rotRad), sinR = Math.sin(rotRad);
      const cx = eCx + (ox * cosR - oy * sinR);
      const cy = eCy + (ox * sinR + oy * cosR);
      const center = (baseAngle + (v.angle || 0) + rot) * Math.PI / 180;
      const sRad = spread * Math.PI / 180;
      const pts = [`${cx.toFixed(2)},${cy.toFixed(2)}`];
      for(let i = 0; i < SAMPLES; i++){
        const a = center - sRad + (2 * sRad) * (i / (SAMPLES - 1));
        const dx = Math.cos(a), dy = Math.sin(a);
        const t = _raycast(cx, cy, dx, dy, walls);
        const px = cx + dx * t, py = cy + dy * t;
        pts.push(`${px.toFixed(2)},${py.toFixed(2)}`);
      }
      const poly = document.createElementNS(ns, "polygon");
      poly.setAttribute("class", cls);
      poly.setAttribute("points", pts.join(" "));
      svg.appendChild(poly);
    }
  }
  stageEl.appendChild(svg);
}

/* ------------------------------------------------------------------
   11. MASTER RENDER
   ------------------------------------------------------------------ */
function render(partial){
  if(!partial){
    renderRegions();
    renderZones();
  }
  renderGrid();
  renderVectorOverlay();
  renderHeatmap();
  applyZoneFlagDecorations();
  renderMetrics();
  if(typeof renderAnalysisRooms === "function") renderAnalysisRooms();
  renderFlags();
  renderSummary();
  renderConclusion();
  renderElementsList();
  refreshTransformPanel();
  const all = allZoneDefs();
  document.getElementById("zoneCountPill").textContent =
    `${all.length} zones · ${all.filter(d=>!d.fixed).length} movable`;
  // Autosave a snapshot to localStorage (debounced inside).
  if(typeof saveAppState === "function") saveAppState();
  // Live analysis re-run on layout change (debounced inside).
  if(typeof triggerLiveSim === "function") triggerLiveSim();
}
