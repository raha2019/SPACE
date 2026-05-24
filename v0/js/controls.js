"use strict";
/* ------------------------------------------------------------------
   12. CONTROLS WIRING
   ------------------------------------------------------------------ */
function wireControls(){
  // Tabs
  document.getElementById("tabs").addEventListener("click",(e)=>{
    const b = e.target.closest("button[data-preset]");
    if(!b) return;
    document.querySelectorAll("#tabs button").forEach(x=>x.classList.remove("active"));
    b.classList.add("active");
    loadPreset(b.dataset.preset);
    evaluate();
    render();
  });

  // Traffic
  document.getElementById("trafficMode").addEventListener("change",(e)=>{
    state.trafficMode = e.target.value;
    evaluate(); render();
  });

  // Switch helper
  function bindSwitch(id, key, after){
    const el = document.getElementById(id);
    if(state[key]) el.classList.add("on");
    el.addEventListener("click",()=>{
      state[key] = !state[key];
      el.classList.toggle("on", state[key]);
      if(after) after();
      evaluate(); render();
    });
  }
  bindSwitch("activeUse","activeUse");
  bindSwitch("showClearance","showClearance");
  bindSwitch("showFlow","showFlow");
  bindSwitch("showSidebar","showSidebar", applySidebarVisibility);

  // Reset
  document.getElementById("resetBtn").addEventListener("click",()=>{
    loadPreset(state.preset);
    evaluate(); render();
  });

  // Export
  document.getElementById("exportBtn").addEventListener("click", exportProject);
}

function exportJSON(){ exportProject(); } // legacy alias

function exportProject(){
  // Multi-file project export. We download:
  //   exports/<datestamp>/layout.json   — main project state
  //   imports/<datestamp>/floor-plan.<ext>   — original imported image (if any)
  //   imports/<datestamp>/configuration.json — original imported config (if any)
  // Browsers can't download a folder structure directly; instead we
  // prefix the filenames with the path. Users can sort them by the
  // datestamp prefix.
  const stamp = new Date().toISOString().slice(0,19).replace(/[:T]/g,"-");
  const payload = {
    project: "Invention Studio Layout Optimization for Safety and Accessibility",
    lab: "Georgia Tech MATRIX Lab",
    generatedAt: new Date().toISOString(),
    preset: state.preset,
    presetName: PRESETS[state.preset].name,
    units: hasScale() ? state.scale.unit : null,
    scale: state.scale ? { pxPerUnit: state.scale.pxPerUnit, unit: state.scale.unit,
                           stageWidthPx: state.scale.stageWidthPx, stageHeightPx: state.scale.stageHeightPx } : null,
    settings: {
      trafficMode: state.trafficMode,
      activeUse: state.activeUse,
      showClearance: state.showClearance,
      showFlow: state.showFlow,
    },
    score: state.score,
    feasibilityGate: state.gate,
    metrics: state.metrics,
    metricWeights: Object.fromEntries(METRIC_DEFS.map(m=>[m.id, m.weight])),
    flags: state.flags.map(f=>({severity:f.severity, title:f.title, why:f.why, fix:f.fix, zones:f.zones})),
    flagCounts: countFlags(),
    zones: Object.fromEntries(
      allZoneDefs().map(d=>{
        const z = state.zones[d.id];
        return [d.id, {
          label: d.label, risk: d.risk, fixed: !!d.fixed,
          x: +z.x.toFixed(2), y: +z.y.toFixed(2),
          w: +z.w.toFixed(2), h: +z.h.toFixed(2),
          xRealUnits: hasScale() ? +pctToUnits(z.x,'x').toFixed(3) : null,
          yRealUnits: hasScale() ? +pctToUnits(z.y,'y').toFixed(3) : null,
          wRealUnits: hasScale() ? +pctToUnits(z.w,'x').toFixed(3) : null,
          hRealUnits: hasScale() ? +pctToUnits(z.h,'y').toFixed(3) : null,
          rotation: +(z.rotation || 0).toFixed(1),
          included: z.included !== false,
          activeUse: !!z.activeUse,
          custom: !!d.custom,
          elementClass: d.elementClass || "builtin",
        }];
      })
    ),
    customElementDefs: state.customElements.map(d=>({
      id: d.id, label: d.label, short: d.short, risk: d.risk,
      operationRisk: d.operationRisk || null,
      moveable: !d.fixed,
      w: d.w, h: d.h,
      cat: d.cat || null,
      beginner: !!d.beginner,
      shapes: d.shapes || [],
      principalAxis: d.principalAxis || null,
      operatorFootprint:    d.operatorFootprint    || {type:"none"},
      maintenanceFootprint: d.maintenanceFootprint || {type:"none"},
      kickbackVector:       d.kickbackVector       || {type:"none"},
      materialVector:       d.materialVector       || {type:"none"},
      variableAttrs: d.variableAttrs || null,
    })),
    structuralElements: state.structuralElements.map(d=>({
      id: d.id, label: d.label, subtype: d.subtype,
      w: d.w, h: d.h,
      shapes: d.shapes,
      countWalls: !!d.countWalls,
      doorSwing: d.doorSwing,
      unionAreaPct: d.unionAreaPct,
    })),
    amenityElements: state.amenityElements.map(d=>({
      id: d.id, label: d.label, subtype: d.subtype,
      coverage: d.coverage,
      moveable: !d.fixed,
      icon: d.icon,
    })),
    notes: [
      "Coordinates are normalized 0..100% of the stage; if a scale was set, real-unit equivalents are included as xRealUnits/yRealUnits/etc.",
      "Scoring weights and warning thresholds are preliminary and intended for adjustment based on staff/PI feedback, Matterport measurements, SUMS, 3DPrinterOS, and observation data.",
    ],
  };

  // Helper to trigger a download.
  function triggerDownload(href, filename){
    const a = document.createElement("a");
    a.href = href;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(()=>{
      if(href.startsWith("blob:")) URL.revokeObjectURL(href);
      a.remove();
    }, 200);
  }

  // 1) The main project JSON. The path uses '/' so when the user
  // organizes downloads in a sensible browser, they cluster nicely.
  const txt = JSON.stringify(payload, null, 2);
  const blob = new Blob([txt], {type:"application/json"});
  const url = URL.createObjectURL(blob);
  triggerDownload(url, `exports_${stamp}__layout.json`);

  // 2) Imported floor plan (if any). Use data URL directly.
  if(state.imports && state.imports.floorPlan){
    const fp = state.imports.floorPlan;
    setTimeout(()=> triggerDownload(fp.dataUrl, `imports_${stamp}__${fp.filename || "floor-plan"}`), 300);
  }

  // 3) Imported configuration JSON (if any).
  if(state.imports && state.imports.config){
    const c = state.imports.config;
    const cblob = new Blob([c.text], {type:"application/json"});
    const curl = URL.createObjectURL(cblob);
    setTimeout(()=> triggerDownload(curl, `imports_${stamp}__${c.filename || "configuration.json"}`), 600);
  }

  // 4) A manifest so the user can see what to expect.
  const manifest = {
    generatedAt: new Date().toISOString(),
    files: [
      `exports_${stamp}__layout.json`,
      state.imports && state.imports.floorPlan ? `imports_${stamp}__${state.imports.floorPlan.filename || "floor-plan"}` : null,
      state.imports && state.imports.config ? `imports_${stamp}__${state.imports.config.filename || "configuration.json"}` : null,
    ].filter(Boolean),
    note: "These files are part of one project export. Group them by the timestamp prefix.",
  };
  const mblob = new Blob([JSON.stringify(manifest, null, 2)], {type:"application/json"});
  const murl = URL.createObjectURL(mblob);
  setTimeout(()=> triggerDownload(murl, `exports_${stamp}__manifest.json`), 900);
}

/* ------------------------------------------------------------------
   12.5  CONFIGURATION IMPORT
   -----------------------------------------------------------------
   Allows the user to load a JSON "configuration file" that defines:
     - A floor plan image (as a base64 data URI, recommended for
       portability, or an http(s) URL).
     - The image's pixel dimensions (used to set the stage aspect
       ratio so coordinates remain accurate).
     - A pixel-to-real-world scale (e.g. "100 pixels = 2 meters"),
       which is displayed in the UI and stored for future use by
       scoring rules that need real distances (e.g. minimum aisle
       widths, ADA clearances, etc).

   Expected JSON schema:
     {
       "name":  "Optional human-readable name",
       "description": "Optional notes",
       "floorPlan": {
         "image":  "data:image/jpeg;base64,..."  | "https://...",
         "width":  1600,                  // pixels (image natural width)
         "height": 994                    // pixels (image natural height)
       },
       "scale": {
         "pixels":    100,                // reference run on the image
         "realLength": 2,                 // what that run equals in reality
         "unit":      "m"                 // "m" | "ft" | "cm" | "in"
       }
     }
   ------------------------------------------------------------------ */

// Defaults derived from the originally embedded Matterport image.
const DEFAULT_CONFIG = {
  name: "Default — Matterport overhead (reference)",
  floorPlan: { width: 1600, height: 994 },  // image is embedded in CSS
  scale: null  // unknown — encourages the user to import a real one
};

state.config = null;          // null until a config is imported
state.defaultStageBg = null;  // cached so we can restore on "Clear"

function validateConfig(cfg){
  const errors = [];
  if(!cfg || typeof cfg !== "object") errors.push("Config must be a JSON object.");
  if(!cfg.floorPlan || typeof cfg.floorPlan !== "object"){
    errors.push("Missing 'floorPlan' object.");
  } else {
    if(typeof cfg.floorPlan.image !== "string" || !cfg.floorPlan.image)
      errors.push("'floorPlan.image' must be a non-empty string (data URI or URL).");
    if(!Number.isFinite(cfg.floorPlan.width)  || cfg.floorPlan.width  <= 0)
      errors.push("'floorPlan.width' must be a positive number (pixels).");
    if(!Number.isFinite(cfg.floorPlan.height) || cfg.floorPlan.height <= 0)
      errors.push("'floorPlan.height' must be a positive number (pixels).");
  }
  if(!cfg.scale || typeof cfg.scale !== "object"){
    errors.push("Missing 'scale' object.");
  } else {
    if(!Number.isFinite(cfg.scale.pixels)     || cfg.scale.pixels     <= 0)
      errors.push("'scale.pixels' must be a positive number.");
    if(!Number.isFinite(cfg.scale.realLength) || cfg.scale.realLength <= 0)
      errors.push("'scale.realLength' must be a positive number.");
    if(typeof cfg.scale.unit !== "string" || !cfg.scale.unit)
      errors.push("'scale.unit' must be a non-empty string (e.g. 'm', 'ft').");
  }
  return errors;
}

function formatScale(scale){
  if(!scale) return "no scale set";
  if(scale.pxPerUnit){
    return `${scale.pxPerUnit.toFixed(2)} px/${scale.unit}`;
  }
  const px = +scale.pixels;
  const rl = +scale.realLength;
  const u  = scale.unit;
  const pxPerUnit = px / rl;
  return `${px} px = ${rl} ${u}  (${pxPerUnit.toFixed(2)} px/${u})`;
}

function applyConfig(cfg){
  if(state.defaultStageBg === null){
    const stage = document.getElementById("stage");
    state.defaultStageBg = getComputedStyle(stage).backgroundImage;
  }
  const stage = document.getElementById("stage");
  stage.style.backgroundImage = `url('${cfg.floorPlan.image}')`;
  stage.style.setProperty("--stage-aspect", `${cfg.floorPlan.width} / ${cfg.floorPlan.height}`);

  const pxPerUnit = cfg.scale.pixels / cfg.scale.realLength;
  state.config = { ...cfg, scale: { ...cfg.scale, pxPerUnit } };
  // Also adopt as the global scale so the rest of the app uses real units.
  state.scale = {
    pxPerUnit,
    unit: cfg.scale.unit,
    stageWidthPx: cfg.floorPlan.width,
    stageHeightPx: cfg.floorPlan.height,
  };
  state.units = cfg.scale.unit;

  refreshStatusBars();
  render();
}

function clearConfig(){
  state.config = null;
  state.imports.config = null;
  // Only drop the scale if it came from this config (not from manual calibration).
  // Heuristic: if we have a floor plan import with its own scale, keep that;
  // otherwise drop scale entirely.
  if(!state.imports.floorPlan || !state.imports.floorPlan.scale){
    state.scale = null;
  } else {
    state.scale = { ...state.imports.floorPlan.scale };
  }
  refreshStatusBars();
  render();
}

function importConfigFromFile(file){
  const reader = new FileReader();
  reader.onload = (e) => {
    let parsed;
    try { parsed = JSON.parse(e.target.result); }
    catch (err) { alert("Invalid JSON: " + err.message); return; }
    const errors = validateConfig(parsed);
    if(errors.length){
      alert("Configuration file is missing required fields:\n\n• " + errors.join("\n• "));
      return;
    }
    // Stash the raw file content for re-download
    state.imports.config = {
      filename: file.name,
      text: e.target.result,
      importedAt: new Date().toISOString(),
    };
    applyConfig(parsed);
  };
  reader.onerror = () => alert("Could not read the selected file.");
  reader.readAsText(file);
}

function wireConfigImport(){
  const btn = document.getElementById("importConfigBtn");
  const input = document.getElementById("importConfigInput");
  btn.addEventListener("click", () => input.click());
  input.addEventListener("change", (e) => {
    const f = e.target.files[0];
    if(f) importConfigFromFile(f);
    input.value = "";
  });
  // Status-bar interactions
  document.getElementById("csClear").addEventListener("click", clearConfig);
  document.getElementById("cfgCollapse").addEventListener("click", ()=>{
    document.getElementById("configStatus").classList.toggle("collapsed");
  });
  document.getElementById("cfgDownload").addEventListener("click", downloadImportedConfig);
  document.getElementById("fpCollapse").addEventListener("click", ()=>{
    document.getElementById("floorPlanStatus").classList.toggle("collapsed");
  });
  document.getElementById("fpDownload").addEventListener("click", downloadImportedFloorPlan);
  document.getElementById("fpClear").addEventListener("click", clearImportedFloorPlan);
  document.getElementById("fpRecalibrate").addEventListener("click", ()=>{
    if(!state.imports.floorPlan){ alert("No floor plan imported."); return; }
    openCalibrationModal(state.imports.floorPlan, /*recalibrate*/ true);
  });
}

// Refreshes both rows in the loaded-status bar — floor plan + config.
function refreshStatusBars(){
  const fpRow = document.getElementById("floorPlanStatus");
  const cfgRow = document.getElementById("configStatus");
  // Floor plan row
  if(state.imports.floorPlan){
    const fp = state.imports.floorPlan;
    fpRow.style.display = "flex";
    document.getElementById("fpName").textContent = fp.filename || "Imported floor plan";
    document.getElementById("fpDims").textContent = `${fp.width} × ${fp.height} px`;
    document.getElementById("fpScale").textContent = hasScale()
      ? `${state.scale.pxPerUnit.toFixed(2)} px/${state.scale.unit}`
      : "no scale set";
  } else {
    fpRow.style.display = "none";
  }
  // Config row
  if(state.imports.config && state.config){
    cfgRow.style.display = "flex";
    document.getElementById("csName").textContent = state.config.name || "Imported configuration";
    document.getElementById("csScale").textContent = formatScale(state.config.scale);
    document.getElementById("csDims").textContent = `${state.config.floorPlan.width} × ${state.config.floorPlan.height} px`;
  } else {
    cfgRow.style.display = "none";
  }
  // Calibration badge in the stage header
  const calib = document.getElementById("calibBadge");
  if(hasScale()){
    calib.textContent = `Calibrated · ${state.scale.pxPerUnit.toFixed(2)} px/${state.scale.unit}`;
    calib.classList.add("on");
  } else if(state.imports.floorPlan){
    calib.textContent = "Image loaded · no scale";
    calib.classList.remove("on");
  } else {
    calib.textContent = "Drag-to-calibrate";
    calib.classList.remove("on");
  }
}

function downloadImportedFloorPlan(){
  const fp = state.imports.floorPlan;
  if(!fp){ alert("No floor plan to download."); return; }
  const a = document.createElement("a");
  a.href = fp.dataUrl;
  a.download = fp.filename || "floor-plan";
  document.body.appendChild(a);
  a.click();
  setTimeout(()=> a.remove(), 100);
}

function downloadImportedConfig(){
  const c = state.imports.config;
  if(!c){ alert("No configuration to download."); return; }
  const blob = new Blob([c.text], {type:"application/json"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = c.filename || "configuration.json";
  document.body.appendChild(a);
  a.click();
  setTimeout(()=>{ URL.revokeObjectURL(url); a.remove(); }, 100);
}

function clearImportedFloorPlan(){
  state.imports.floorPlan = null;
  state.scale = null;
  const stage = document.getElementById("stage");
  if(state.defaultStageBg !== null){
    stage.style.backgroundImage = state.defaultStageBg;
  } else {
    stage.style.removeProperty("background-image");
  }
  stage.style.removeProperty("--stage-aspect");
  refreshStatusBars();
  render();
}

/* ------------------------------------------------------------------
   12.6  ELEMENTS SIDEBAR
   -----------------------------------------------------------------
   Renders the list of all zones grouped by risk tier and wires
   click-to-select. The Show-Sidebar toggle controls visibility of
   the entire left column.
   ------------------------------------------------------------------ */
function renderElementsList(){
  const listEl = document.getElementById("elementsList");
  if(!listEl) return;
  const all = allZoneDefs();

  // Group by risk band (fixed first, then by risk ascending, then custom).
  // Structural and amenity elements get their own groups at the bottom.
  const structural = all.filter(d=>d.elementClass==="structural");
  const amenity = all.filter(d=>d.elementClass==="amenity");
  const groups = {
    "Fixed":    all.filter(d=>d.fixed && d.elementClass!=="structural" && d.elementClass!=="amenity"),
    "Low (R1)": all.filter(d=>!d.fixed && d.risk===1 && !d.elementClass),
    "Moderate (R2-R3)": all.filter(d=>!d.fixed && (d.risk===2 || d.risk===3) && !d.elementClass),
    "High (R4-R5)":     all.filter(d=>!d.fixed && (d.risk===4 || d.risk===5) && !d.elementClass),
    "Circulation / Open": all.filter(d=>!d.fixed && (d.cat==="corridor"||d.cat==="open") && !d.elementClass),
    "Structural": structural,
    "Safety / Amenity": amenity,
  };

  listEl.innerHTML = "";
  for(const [name, items] of Object.entries(groups)){
    if(!items.length) continue;
    const hdr = document.createElement("div");
    hdr.className = "el-group-hdr";
    hdr.textContent = name;
    listEl.appendChild(hdr);
    for(const def of items){
      const z = state.zones[def.id] || {};
      const row = document.createElement("div");
      row.className = "el-row r"+def.risk;
      if(def.custom) row.classList.add("custom");
      if(state.selectedId === def.id) row.classList.add("selected");
      if(z.included === false) row.classList.add("excluded");
      row.dataset.id = def.id;

      const swColor = riskSwatchColor(def);
      const incOn = z.included !== false;
      const auOn = !!z.activeUse;
      row.innerHTML = `
        <span class="el-swatch" style="background:${swColor.bg};border-color:${swColor.border}"></span>
        <span class="el-label">${def.label}</span>
        <span class="el-meta">R${def.risk}</span>
        ${def.fixed ? '<span class="el-fixed-tag">Fixed</span>' : ''}
        <span class="el-toggles">
          <span class="el-tog ${incOn?'on':''}" data-tog="included" title="Include in evaluation and stage">
            <span class="et-dot"></span><span class="et-lbl">inc</span>
          </span>
          <span class="el-tog ${auOn?'on':''}" data-tog="activeUse" title="Apply active-use expansion to this element">
            <span class="et-dot"></span><span class="et-lbl">act</span>
          </span>
        </span>
      `;
      // Row click selects, but toggle clicks shouldn't propagate.
      row.addEventListener("click", (e)=>{
        const tog = e.target.closest(".el-tog");
        if(tog){
          e.stopPropagation();
          const key = tog.dataset.tog;
          if(key === "included") z.included = !(z.included !== false);
          else if(key === "activeUse") z.activeUse = !z.activeUse;
          evaluate(); render();
          return;
        }
        selectZone(def.id);
      });
      listEl.appendChild(row);
    }
  }
  document.getElementById("elementCountPill").textContent = `${all.length}`;
}

function riskSwatchColor(def){
  // Mirrors the CSS .zone.rN colors at higher saturation for legibility.
  const map = {
    0: {bg:"rgba(155,165,185,.55)", border:"rgba(220,225,235,.85)"},
    1: {bg:"rgba(58,167,118,.55)",  border:"rgba(58,167,118,.95)"},
    2: {bg:"rgba(109,177,90,.55)",  border:"rgba(150,200,90,.95)"},
    3: {bg:"rgba(224,167,58,.6)",   border:"rgba(240,180,60,1)"},
    4: {bg:"rgba(232,123,59,.6)",   border:"rgba(240,140,60,1)"},
    5: {bg:"rgba(229,72,72,.65)",   border:"rgba(255,90,90,1)"},
  };
  return map[def.risk] || map[0];
}

function applySidebarVisibility(){
  const grid = document.getElementById("appGrid");
  if(state.showSidebar) grid.classList.remove("no-sidebar");
  else grid.classList.add("no-sidebar");
}

/* ------------------------------------------------------------------
   12.7  SELECTION + TRANSFORM PANEL
   -----------------------------------------------------------------
   When a zone is clicked (or selected from the sidebar), a floating
   "format" panel anchored to the top-right of the stage opens. It
   exposes precise inputs for X, Y, W, H and rotation, similar to
   PowerPoint's selection inspector. Rotation is stored on the zone
   and rendered via CSS `transform: rotate()`. Note: feasibility
   scoring uses axis-aligned bounding rects, so rotation is visual
   only — for accurate scoring with rotated geometry, we would need
   oriented bounding-box overlap tests.
   ------------------------------------------------------------------ */
function selectZone(id){
  state.selectedId = id;
  render(); // re-renders zones + sidebar + transform panel
}

function deselectZone(){
  state.selectedId = null;
  render();
}

function refreshTransformPanel(){
  const panel = document.getElementById("transformPanel");
  if(!panel) return;
  if(!state.selectedId){
    panel.classList.remove("open");
    return;
  }
  const def = allZoneDefs().find(d=>d.id===state.selectedId);
  const z = state.zones[state.selectedId];
  if(!def || !z){
    panel.classList.remove("open");
    return;
  }
  panel.classList.add("open");
  document.getElementById("tpTitle").textContent = def.label;
  updateTransformPanelInputs();

  // Disable inputs for fixed zones — they're still selectable for
  // reference, but can't be moved/resized/rotated.
  const isFixed = !!def.fixed;
  for(const id of ["tpX","tpY","tpW","tpH","tpRotRange","tpRotNum","tpResetSize","tpResetRot"]){
    const el = document.getElementById(id);
    if(el) el.disabled = isFixed;
  }
  document.querySelectorAll("#transformPanel [data-rot]").forEach(b=>b.disabled = isFixed);
}

function updateTransformPanelInputs(){
  const z = state.zones[state.selectedId];
  if(!z) return;
  const set = (id, val) => {
    const el = document.getElementById(id);
    if(el && document.activeElement !== el) el.value = val;
  };
  // Display in real units when a scale is calibrated, otherwise %.
  const xDisp = hasScale() ? +pctToUnits(z.x,'x').toFixed(2) : +z.x.toFixed(2);
  const yDisp = hasScale() ? +pctToUnits(z.y,'y').toFixed(2) : +z.y.toFixed(2);
  const wDisp = hasScale() ? +pctToUnits(z.w,'x').toFixed(2) : +z.w.toFixed(2);
  const hDisp = hasScale() ? +pctToUnits(z.h,'y').toFixed(2) : +z.h.toFixed(2);
  set("tpX", xDisp);
  set("tpY", yDisp);
  set("tpW", wDisp);
  set("tpH", hDisp);
  // Update section labels to reflect the active unit.
  const u = hasScale() ? state.scale.unit : "% of stage";
  const pLbl = document.getElementById("tpPosLbl");
  const sLbl = document.getElementById("tpSizeLbl");
  if(pLbl) pLbl.textContent = `Position (${u})`;
  if(sLbl) sLbl.textContent = `Size (${u})`;
  const rot = +(z.rotation || 0).toFixed(0);
  set("tpRotRange", rot);
  set("tpRotNum", rot);
  document.getElementById("tpRotVal").textContent = `${rot}°`;
}

function applyTransformInput(field, raw){
  if(!state.selectedId) return;
  const z = state.zones[state.selectedId];
  let v = parseFloat(raw);
  if(!Number.isFinite(v)) return;
  if(field === "rotation"){
    z.rotation = v;
  } else {
    // If a scale is calibrated, inputs are in real units; convert
    // back to internal percent storage.
    let pct;
    if(hasScale()){
      const axis = (field === "y" || field === "h") ? "y" : "x";
      pct = unitsToPct(v, axis);
    } else {
      pct = v;
    }
    if(field === "x") z.x = clamp(pct, 0, 100 - z.w);
    if(field === "y") z.y = clamp(pct, 0, 100 - z.h);
    if(field === "w") z.w = clamp(pct, 1, 100 - z.x);
    if(field === "h") z.h = clamp(pct, 1, 100 - z.y);
  }
  evaluate();
  render();
}

function resetSelectedSize(){
  if(!state.selectedId) return;
  const def = allZoneDefs().find(d=>d.id===state.selectedId);
  const z = state.zones[state.selectedId];
  if(!def || !z) return;
  z.w = def.w; z.h = def.h;
  z.x = clamp(z.x, 0, 100 - z.w);
  z.y = clamp(z.y, 0, 100 - z.h);
  evaluate(); render();
}

function resetSelectedRotation(){
  if(!state.selectedId) return;
  state.zones[state.selectedId].rotation = 0;
  evaluate(); render();
}

function wireTransformPanel(){
  document.getElementById("tpClose").addEventListener("click", deselectZone);
  document.getElementById("tpX").addEventListener("input", e => applyTransformInput("x", e.target.value));
  document.getElementById("tpY").addEventListener("input", e => applyTransformInput("y", e.target.value));
  document.getElementById("tpW").addEventListener("input", e => applyTransformInput("w", e.target.value));
  document.getElementById("tpH").addEventListener("input", e => applyTransformInput("h", e.target.value));
  document.getElementById("tpRotRange").addEventListener("input", e=>{
    document.getElementById("tpRotNum").value = e.target.value;
    applyTransformInput("rotation", e.target.value);
  });
  document.getElementById("tpRotNum").addEventListener("input", e=>{
    const v = parseFloat(e.target.value);
    if(Number.isFinite(v)){
      const range = document.getElementById("tpRotRange");
      // Clamp range slider only; allow the number field to go further.
      range.value = clamp(v, -180, 180);
    }
    applyTransformInput("rotation", e.target.value);
  });
  document.querySelectorAll("#transformPanel [data-rot]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      applyTransformInput("rotation", btn.dataset.rot);
    });
  });
  document.getElementById("tpResetSize").addEventListener("click", resetSelectedSize);
  document.getElementById("tpResetRot").addEventListener("click", resetSelectedRotation);

  // Click on empty stage area deselects.
  stageEl.addEventListener("pointerdown", (e)=>{
    if(e.target === stageEl) deselectZone();
  });
}

/* ------------------------------------------------------------------
   12.8  IMAGE IMPORT (floor plan only — separate from configuration)
   -----------------------------------------------------------------
   Accepts PNG/JPG/SVG/WEBP/GIF and uses it as the stage background.
   For raster formats we measure natural dimensions and update the
   stage aspect ratio to match. SVG is also supported; if dimensions
   are missing, we fall back to the default aspect.

   DXF/DWG: NOT supported natively in-browser. We surface a clear
   message so the user knows to convert first (e.g. via Autodesk
   viewer export, LibreCAD, or a server-side converter).
   ------------------------------------------------------------------ */
function importFloorPlanImage(file){
  const validImage = /^image\/(png|jpe?g|svg\+xml|webp|gif)$/i.test(file.type || "");
  const ext = (file.name.split('.').pop() || "").toLowerCase();
  if(["dxf","dwg"].includes(ext)){
    alert(
      "DXF/DWG files can't be rendered directly in the browser. " +
      "Please export your CAD drawing as PNG, JPG, or SVG and import again.\n\n" +
      "Workflows that work today:\n" +
      "  • Autodesk Viewer → Export as image\n" +
      "  • LibreCAD / QCAD → File → Export → PNG/SVG\n" +
      "  • Inkscape can open SVG exports for clean-up"
    );
    return;
  }
  if(!validImage && !["png","jpg","jpeg","svg","webp","gif"].includes(ext)){
    alert("Unsupported file type. Please use PNG, JPG, SVG, WEBP, or GIF.");
    return;
  }
  const reader = new FileReader();
  reader.onload = (e)=>{
    const dataUrl = e.target.result;
    const probe = new Image();
    probe.onload = ()=>{
      const w = probe.naturalWidth || 1600;
      const h = probe.naturalHeight || 994;
      const payload = { dataUrl, width:w, height:h, filename:file.name, importedAt:new Date().toISOString() };
      openCalibrationModal(payload, /*recalibrate*/ false);
    };
    probe.onerror = ()=>{
      const payload = { dataUrl, width:1600, height:994, filename:file.name, importedAt:new Date().toISOString() };
      openCalibrationModal(payload, /*recalibrate*/ false);
    };
    probe.src = dataUrl;
  };
  reader.onerror = ()=> alert("Could not read the selected image.");
  reader.readAsDataURL(file);
}

function applyFloorPlan(opts){
  if(state.defaultStageBg === null){
    state.defaultStageBg = getComputedStyle(stageEl).backgroundImage;
  }
  stageEl.style.backgroundImage = `url('${opts.dataUrl}')`;
  stageEl.style.setProperty("--stage-aspect", `${opts.width} / ${opts.height}`);

  state.imports.floorPlan = {
    filename: opts.filename || "Imported floor plan",
    dataUrl: opts.dataUrl,
    width: opts.width,
    height: opts.height,
    importedAt: opts.importedAt || new Date().toISOString(),
    scale: opts.scale || null,
  };
  if(opts.scale){
    state.scale = {
      pxPerUnit: opts.scale.pxPerUnit,
      unit: opts.scale.unit,
      stageWidthPx: opts.width,
      stageHeightPx: opts.height,
    };
    state.units = opts.scale.unit;
  }
  refreshStatusBars();
  render();
}

function wireImageImport(){
  const btn = document.getElementById("importImageBtn");
  const input = document.getElementById("importImageInput");
  btn.addEventListener("click", ()=> input.click());
  input.addEventListener("change", e=>{
    const f = e.target.files[0];
    if(f) importFloorPlanImage(f);
    input.value = "";
  });
}
