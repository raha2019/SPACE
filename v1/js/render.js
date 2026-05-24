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

    // Clearance halo (movable, high-risk only, included only)
    if(state.showClearance && !def.fixed && z.included !== false){
      const halo = document.createElement("div");
      halo.className = "clearance";
      const r = rect(z);
      const radius = 6 + def.risk * 1.8;
      halo.style.left = (r.cx - radius)+"%";
      halo.style.top  = (r.cy - radius)+"%";
      halo.style.width  = (radius*2)+"%";
      halo.style.height = (radius*2)+"%";
      stageEl.appendChild(halo);
    }

    const el = document.createElement("div");
    el.className = `zone r${def.risk} ${def.fixed?"fixed":""}`;
    if(def.elementClass === "structural"){
      el.classList.add("struct-" + (def.subtype || "wall"));
    }
    if(def.elementClass === "amenity"){
      el.classList.add("amenity");
    }
    if(state.selectedId === def.id) el.classList.add("selected");
    if(z.included === false) el.classList.add("excluded");
    if(z.activeUse) el.classList.add("active-use-on");
    el.dataset.id = def.id;
    el.style.left = z.x+"%";
    el.style.top  = z.y+"%";
    el.style.width  = z.w+"%";
    el.style.height = z.h+"%";
    if(z.rotation){
      el.style.transform = `rotate(${z.rotation}deg)`;
      el.style.transformOrigin = "center center";
    }

    el.innerHTML = `
      <div class="row1">
        <span class="lbl" title="${def.label}">${def.short || def.label}</span>
        <span class="warn-ico" data-ico></span>
      </div>
      <div class="badge">R${def.risk} · ${RISK_TAGS[def.risk]}</div>
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
    }
  });

  // 2) risk vectors (drawn before axis so axis sits on top)
  const axisAngle = (def.principalAxis && def.principalAxis.angle) || 0;
  drawRiskZone(svg, def.operatorFootprint, "op", axisAngle, uid);
  drawRiskZone(svg, def.maintenanceFootprint, "mt", axisAngle, uid);
  drawRiskZone(svg, def.kickbackVector, "kb", axisAngle, uid);
  drawRiskZone(svg, def.materialVector, "mat", axisAngle, uid);

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
  if(zone.type === "radius"){
    const c = document.createElementNS(ns,"circle");
    c.setAttribute("class", cls);
    c.setAttribute("cx", "50"); c.setAttribute("cy","50");
    c.setAttribute("r", zone.radius || 30);
    svg.appendChild(c);
  } else if(zone.type === "shape"){
    const r = document.createElementNS(ns,"rect");
    r.setAttribute("class", cls);
    const w = zone.w || 40, h = zone.h || 20;
    r.setAttribute("x", 50 - w/2);
    r.setAttribute("y", 50 - h/2);
    r.setAttribute("width", w);
    r.setAttribute("height", h);
    if(zone.offset){
      const ang = axisAngle * Math.PI/180;
      const dx = Math.cos(ang) * zone.offset;
      const dy = Math.sin(ang) * zone.offset;
      r.setAttribute("transform", `translate(${dx} ${dy}) rotate(${axisAngle} ${50} ${50})`);
    }
    svg.appendChild(r);
  } else if(zone.type === "vector"){
    const ang = axisAngle * Math.PI/180;
    const length = zone.length || 30;
    const width = zone.width || 8;
    const r = document.createElementNS(ns,"rect");
    r.setAttribute("class", cls);
    r.setAttribute("x", "50");
    r.setAttribute("y", 50 - width/2);
    r.setAttribute("width", length);
    r.setAttribute("height", width);
    r.setAttribute("transform", `rotate(${axisAngle} 50 50)`);
    svg.appendChild(r);
    const x2 = 50 + Math.cos(ang) * length;
    const y2 = 50 + Math.sin(ang) * length;
    const line = document.createElementNS(ns,"line");
    line.setAttribute("class", cls);
    line.setAttribute("x1","50"); line.setAttribute("y1","50");
    line.setAttribute("x2", x2); line.setAttribute("y2", y2);
    if(cls === "kb" || cls === "mat"){
      line.setAttribute("marker-end", `url(#${cls}-${uid})`);
    }
    svg.appendChild(line);
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
    nx = clamp(nx, 0, 100 - z.w);
    ny = clamp(ny, 0, 100 - z.h);
    z.x = nx; z.y = ny;
    el.style.left = nx+"%";
    el.style.top  = ny+"%";
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
  for(const md of METRIC_DEFS){
    const v = state.metrics[md.id] || 0;
    const pct = ((v-1)/4)*100;
    const div = document.createElement("div");
    div.className = "metric";
    div.innerHTML = `
      <div class="lbl"><span>${md.label}</span><b>${v.toFixed(1)}/5 <span class="muted">·${(md.weight*100)|0}%</span></b></div>
      <div class="bar rev"><i style="width:${pct}%"></i></div>
    `;
    body.appendChild(div);
  }
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
   11. MASTER RENDER
   ------------------------------------------------------------------ */
function render(partial){
  if(!partial){
    renderRegions();
    renderZones();
  }
  renderFlowLines();
  applyZoneFlagDecorations();
  renderMetrics();
  renderFlags();
  renderSummary();
  renderConclusion();
  renderElementsList();
  refreshTransformPanel();
  const all = allZoneDefs();
  document.getElementById("zoneCountPill").textContent =
    `${all.length} zones · ${all.filter(d=>!d.fixed).length} movable`;
}
