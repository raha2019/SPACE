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

  // Traffic Mode lives in the Analysis modal now — its <select> is
  // wired inside openAnalysisModal() since it's created lazily.

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
  bindSwitch("showLabels","showLabels", applyLabelsVisibility);
  bindSwitch("showGrid","showGrid");

  // Reset
  document.getElementById("resetBtn").addEventListener("click",()=>{
    loadPreset(state.preset);
    evaluate(); render();
  });

  // Export
  document.getElementById("exportBtn").addEventListener("click", exportProject);

  // Analysis is now an always-visible sidebar widget instead of a toolbar
  // button + modal. It is wired by wireAnalysisPanel() at init.

  // Editable header metadata (Project / Lab / Build).
  wireProjectHeader();

  // Dismissible prototype banner.
  const bannerEl = document.getElementById("prototypeBanner");
  const bannerX  = document.getElementById("prototypeBannerClose");
  if(bannerEl && state.bannerDismissed) bannerEl.classList.add("dismissed");
  if(bannerX){
    bannerX.addEventListener("click", ()=>{
      bannerEl.classList.add("dismissed");
      state.bannerDismissed = true;
      if(typeof saveAppState === "function") saveAppState();
    });
  }

  // Sidebar sort selector.
  const sortSel = document.getElementById("elementsSort");
  if(sortSel){
    sortSel.value = state.elementsSort || "risk";
    sortSel.addEventListener("change", (e)=>{
      state.elementsSort = e.target.value;
      renderElementsList();
      if(typeof saveAppState === "function") saveAppState();
    });
  }

  // Add / Remove alternative
  const addAlt = document.getElementById("addAltBtn");
  if(addAlt) addAlt.addEventListener("click", addAlternative);
  const rmAlt = document.getElementById("removeAltBtn");
  if(rmAlt) rmAlt.addEventListener("click", removeCurrentAlternative);
}

/* ------------------------------------------------------------------
   ALTERNATIVES — preset tabs are user-extendable. "current" is the
   immutable baseline and cannot be removed.
   ------------------------------------------------------------------ */
function rebuildTabs(){
  const tabsEl = document.getElementById("tabs");
  if(!tabsEl) return;
  tabsEl.innerHTML = "";
  const order = Object.keys(PRESETS);
  for(const key of order){
    const btn = document.createElement("button");
    btn.dataset.preset = key;
    btn.textContent = (PRESETS[key] && PRESETS[key].name) ||
      (key === "current" ? "Current Layout" : key);
    if(key === state.preset) btn.classList.add("active");
    tabsEl.appendChild(btn);
  }
}

function addAlternative(){
  const baseName = prompt("Name this alternative:", "Alternative " + (Object.keys(PRESETS).length));
  if(!baseName) return;
  const slug = "alt_" + baseName.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  let key = slug, n = 2;
  while(PRESETS[key]) { key = slug + "_" + n; n++; }
  // Seed positions by cloning the currently-visible state.zones (so the
  // user keeps editing where they left off, just under a new tab).
  const zones = {};
  for(const [id, z] of Object.entries(state.zones)){
    zones[id] = { x: z.x, y: z.y, w: z.w, h: z.h, rotation: z.rotation || 0 };
  }
  PRESETS[key] = { name: baseName, zones };
  loadPreset(key);
  rebuildTabs();
  evaluate(); render();
}

function removeCurrentAlternative(){
  if(state.preset === "current"){
    alert("Current Layout cannot be removed.");
    return;
  }
  const name = (PRESETS[state.preset] && PRESETS[state.preset].name) || state.preset;
  if(!confirm(`Remove alternative "${name}"?`)) return;
  delete PRESETS[state.preset];
  loadPreset("current");
  rebuildTabs();
  evaluate(); render();
}

/* ------------------------------------------------------------------
   EDITABLE HEADER METADATA (Project / Lab / Build).
   Each value lives on state.projectInfo, persists via autosave, and is
   round-tripped through Export / Import Project.
   ------------------------------------------------------------------ */
function wireProjectHeader(){
  const fields = [
    { id: "piProject", key: "project" },
    { id: "piLab",     key: "lab" },
    { id: "piBuild",   key: "build" },
  ];
  if(!state.projectInfo) state.projectInfo = { project:"", lab:"", build:"" };
  for(const f of fields){
    const el = document.getElementById(f.id);
    if(!el) continue;
    el.textContent = state.projectInfo[f.key] || "";
    el.addEventListener("input", ()=>{
      state.projectInfo[f.key] = el.textContent.trim();
      if(typeof saveAppState === "function") saveAppState();
    });
    el.addEventListener("keydown", (e)=>{
      // Enter commits without inserting a newline.
      if(e.key === "Enter"){ e.preventDefault(); el.blur(); }
    });
  }
}

function applyProjectHeader(){
  // Re-paint the DOM from state.projectInfo (used after restore / import).
  if(!state.projectInfo) return;
  const map = { piProject:"project", piLab:"lab", piBuild:"build" };
  for(const id of Object.keys(map)){
    const el = document.getElementById(id);
    if(el) el.textContent = state.projectInfo[map[id]] || "";
  }
}

/* ------------------------------------------------------------------
   ANALYSIS — always-visible sidebar widget (#analysisCard in index.html).
   Replaces the old toolbar button + modal. Wires the run buttons, the
   Live-mode toggle, traffic mode, and the resolution controls. Reuses the
   existing sim helpers (runSingleSim / runAllSims / clearSimOverlays /
   setSimResolution). Note: _simSetActive() already toggles .sim-active on
   #simAdaBtn / #simEgressBtn / #simNoiseBtn and enables/disables
   #simClearBtn, so those highlight automatically after a run.
   ------------------------------------------------------------------ */
function wireAnalysisPanel(){
  const card = document.getElementById("analysisCard");
  if(!card || card._analysisWired) return;
  card._analysisWired = true;

  const runSim = (which) => {
    state.analysisLastSim = which;
    if(typeof saveAppState === "function") saveAppState();
    if(which === "all"){ if(typeof runAllSims === "function") runAllSims(); }
    else if(typeof runSingleSim === "function") runSingleSim(which);
    // Run All sets _simActive to null (which disables Clear); re-enable it
    // since overlays are now showing.
    const clr = document.getElementById("simClearBtn");
    if(clr) clr.disabled = false;
    _updateAnalysisActivePill(which);
  };

  const bind = (id, fn) => { const el = document.getElementById(id); if(el) el.addEventListener("click", fn); };
  bind("simAdaBtn",    () => runSim("ada"));
  bind("simEgressBtn", () => runSim("egress"));
  bind("simNoiseBtn",  () => runSim("noise"));
  bind("simAllBtn",    () => runSim("all"));
  bind("simClearBtn",  () => {
    if(typeof clearSimOverlays === "function") clearSimOverlays();
    state.analysisLastSim = null;
    if(typeof saveAppState === "function") saveAppState();
    _updateAnalysisActivePill(null);
  });

  // Live-mode toggle (reuses the .switch component).
  const live = document.getElementById("analysisLiveSwitch");
  if(live){
    live.classList.toggle("on", !!state.analysisLive);
    live.addEventListener("click", () => {
      state.analysisLive = !state.analysisLive;
      live.classList.toggle("on", state.analysisLive);
      if(typeof saveAppState === "function") saveAppState();
    });
  }

  // Traffic mode.
  const tmSel = document.getElementById("analysisTrafficMode");
  if(tmSel){
    tmSel.value = state.trafficMode || "normal";
    tmSel.addEventListener("change", () => {
      state.trafficMode = tmSel.value;
      evaluate(); render();
      if(typeof saveAppState === "function") saveAppState();
    });
  }

  // Resolution radios — picking one clears any numeric slider override.
  card.querySelectorAll('input[name="simRes"]').forEach(r => {
    r.checked = (r.value === (state.simResolution || "medium"));
    r.addEventListener("change", () => {
      if(!r.checked) return;
      state.simResolution = r.value;
      state.simResolutionFactor = null;
      if(typeof setSimResolution === "function") setSimResolution(r.value);
      const slider = document.getElementById("simResSlider");
      if(slider) slider.value = (r.value === "coarse" ? 2 : r.value === "fine" ? 0.5 : 1);
      _updateSimResReadout(card);
      if(typeof saveAppState === "function") saveAppState();
    });
  });

  // Numeric slider — takes precedence over the radios when used.
  const slider = document.getElementById("simResSlider");
  if(slider){
    const f0 = Number.isFinite(state.simResolutionFactor) && state.simResolutionFactor > 0
      ? state.simResolutionFactor
      : (state.simResolution === "coarse" ? 2 : state.simResolution === "fine" ? 0.5 : 1);
    slider.value = f0;
    slider.addEventListener("input", () => {
      const f = parseFloat(slider.value);
      if(!Number.isFinite(f) || f <= 0) return;
      state.simResolutionFactor = f;
      state.simResolution = f >= 1.5 ? "coarse" : f <= 0.75 ? "fine" : "medium";
      if(typeof setSimResolution === "function") setSimResolution(f);
      card.querySelectorAll('input[name="simRes"]').forEach(r => { r.checked = (r.value === state.simResolution); });
      _updateSimResReadout(card);
      if(typeof saveAppState === "function") saveAppState();
    });
  }

  _updateSimResReadout(card);
  _updateAnalysisActivePill(state.analysisLastSim);
}

/* Small status pill in the Analysis widget header showing the last sim run. */
function _updateAnalysisActivePill(which){
  const pill = document.getElementById("analysisActivePill");
  if(!pill) return;
  const label = { ada:"ADA", egress:"Egress", noise:"Noise", all:"All" }[which] || "Idle";
  pill.textContent = label;
}

/* Translate the current resolution factor into a human-friendly readout
   for the Analysis modal slider. Pulls the ADA grid res as a proxy
   since all three sims scale together. */
function _updateSimResReadout(bd){
  const out = bd.querySelector("#simResReadout");
  if(!out) return;
  const f = Number.isFinite(state.simResolutionFactor) && state.simResolutionFactor > 0
    ? state.simResolutionFactor
    : (state.simResolution === "coarse" ? 2 : state.simResolution === "fine" ? 0.5 : 1);
  // ADA's base resolution is 0.5 ft per cell.
  const cellFt = (0.5 * f).toFixed(2);
  out.textContent = `${f.toFixed(2)}× · ~${cellFt} ft/cell`;
}

function exportJSON(){ exportProject(); } // legacy alias

function exportProject(){
  // Two-file project export — exactly what Import Project consumes:
  //   exports_<stamp>__project.json     — elementDefs + zones + scale + floorPlan dims
  //   exports_<stamp>__<floor-plan.ext> — the original floor-plan image (if any)
  const stamp = new Date().toISOString().slice(0,19).replace(/[:T]/g,"-");

  const _allDefs = allZoneDefs();
  const elementDefs = _allDefs.map(d=>{
    // Round-trip everything the builder + import paths know about. Keys
    // not relevant to a given element-kind are simply omitted.
    const base = { id:d.id, label:d.label, risk:d.risk };
    if(d.description)    base.description = d.description;
    if(d.short && d.short !== d.label) base.short = d.short; // legacy carry
    if(d.cat)            base.cat = d.cat;
    if(d.beginner)       base.beginner = true;
    if(d.fixed)          base.fixed = true;
    if(Number.isFinite(d.w)) base.w = d.w;
    if(Number.isFinite(d.h)) base.h = d.h;
    // Absolute footprint so the element keeps its real-world size when
    // the floor-plan scale changes downstream.
    if(Number.isFinite(d.wReal)) base.wReal = d.wReal;
    if(Number.isFinite(d.hReal)) base.hReal = d.hReal;
    if(d.realUnit)       base.realUnit = d.realUnit;
    // Trash-can liner flag (only present on the amenity subtype).
    if(d.hasBag !== undefined) base.hasBag = d.hasBag;
    if(d.elementClass)   base.elementClass = d.elementClass;
    if(d.subtype)        base.subtype = d.subtype;
    if(d.operationRisk)  base.operationRisk = d.operationRisk;
    if(d.shapes)         base.shapes = d.shapes;
    if(d.principalAxis)  base.principalAxis = d.principalAxis;
    // New array shape, with legacy singular fallback. Empty arrays are
    // omitted to keep the JSON tidy.
    const _arrOrLegacy = (arr, legacy) => {
      if(Array.isArray(arr) && arr.length) return arr;
      if(legacy && legacy.type && legacy.type !== "none") return [legacy];
      return null;
    };
    const op = _arrOrLegacy(d.operatorFootprints,    d.operatorFootprint);
    const mt = _arrOrLegacy(d.maintenanceFootprints, d.maintenanceFootprint);
    const kb = _arrOrLegacy(d.kickbackVectors,       d.kickbackVector);
    const ma = _arrOrLegacy(d.materialVectors,       d.materialVector);
    if(op) base.operatorFootprints    = op;
    if(mt) base.maintenanceFootprints = mt;
    if(kb) base.kickbackVectors       = kb;
    if(ma) base.materialVectors       = ma;
    if(d.variableAttrs)  base.variableAttrs = d.variableAttrs;
    if(Number.isFinite(d.dba_active))    base.dba_active    = d.dba_active;
    if(Number.isFinite(d.schedule_prob)) base.schedule_prob = d.schedule_prob;
    if(Number.isFinite(d.stcOverride))   base.stcOverride   = d.stcOverride;
    if(d.coverage !== undefined) base.coverage = d.coverage;
    if(d.icon)           base.icon = d.icon;
    if(d.countWalls !== undefined) base.countWalls = d.countWalls;
    if(d.doorSwing !== undefined)  base.doorSwing = d.doorSwing;
    if(d.unionAreaPct !== undefined) base.unionAreaPct = d.unionAreaPct;
    return base;
  });

  const zones = Object.fromEntries(_allDefs.map(d=>{
    const z = state.zones[d.id]; if(!z) return [d.id, null];
    const out = {
      x:+z.x.toFixed(3), y:+z.y.toFixed(3),
      w:+z.w.toFixed(3), h:+z.h.toFixed(3),
    };
    if(z.rotation) out.rotation = +z.rotation.toFixed(1);
    return [d.id, out];
  }).filter(([,v])=>v));

  // Snapshot the currently-visible preset's edits back into PRESETS so
  // every alternative exports with the freshest positions.
  if(state.preset && PRESETS[state.preset]){
    if(!PRESETS[state.preset].zones) PRESETS[state.preset].zones = {};
    for(const [id, z] of Object.entries(state.zones)){
      PRESETS[state.preset].zones[id] = {
        x: z.x, y: z.y, w: z.w, h: z.h, rotation: z.rotation || 0,
      };
    }
  }
  // Strip down each preset to just label + positions for the export.
  const presetsOut = {};
  for(const [key, p] of Object.entries(PRESETS)){
    presetsOut[key] = {
      name: p.name || key,
      zones: Object.fromEntries(
        Object.entries(p.zones || {}).map(([id, z])=>{
          const out = { x: +Number(z.x).toFixed(3), y: +Number(z.y).toFixed(3) };
          if(Number.isFinite(z.w)) out.w = +Number(z.w).toFixed(3);
          if(Number.isFinite(z.h)) out.h = +Number(z.h).toFixed(3);
          if(z.rotation) out.rotation = +Number(z.rotation).toFixed(1);
          return [id, out];
        })
      ),
    };
  }

  const fp = state.imports && state.imports.floorPlan;
  const project = {
    kind: "project",
    name: state.config && state.config.name ? state.config.name : "Invention Studio Project",
    generatedAt: new Date().toISOString(),
    floorPlan: fp ? { width: fp.width, height: fp.height, filename: fp.filename } : null,
    scale: state.scale ? {
      pixels: state.scale.pxPerUnit,    // px per 1 unit
      realLength: 1,
      unit: state.scale.unit,
    } : null,
    activePreset: state.preset,
    projectInfo: state.projectInfo ? { ...state.projectInfo } : undefined,
    elementDefs,
    categories: (state.categories && state.categories.length) ? state.categories : undefined,
    // Live state.zones for backward-compat (positions of the currently
    // active preset). Tools that only know the old shape still work.
    zones,
    // Multi-alternative payload: positions per preset key. Importers
    // that know about this restore all alternatives at once.
    presets: presetsOut,
    regions: REGIONS && REGIONS.length ? REGIONS : undefined,
  };

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

  // 1) The project JSON.
  const txt = JSON.stringify(project, null, 2);
  const blob = new Blob([txt], {type:"application/json"});
  const url = URL.createObjectURL(blob);
  triggerDownload(url, `exports_${stamp}__project.json`);

  // 2) The floor plan image (if one was imported).
  if(fp && fp.dataUrl){
    setTimeout(()=> triggerDownload(fp.dataUrl, `exports_${stamp}__${fp.filename || "floor-plan"}`), 300);
  }
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
  if(!cfg || typeof cfg !== "object"){
    errors.push("Config must be a JSON object.");
    return errors;
  }
  const hasFloorPlan = !!cfg.floorPlan;
  const hasScale     = !!cfg.scale;
  const hasZones     = cfg.zones && typeof cfg.zones === "object" && Object.keys(cfg.zones).length > 0;

  if(!hasFloorPlan && !hasScale && !hasZones){
    errors.push("Configuration must include at least one of: 'floorPlan', 'scale', 'zones'.");
  }
  if(hasFloorPlan){
    if(typeof cfg.floorPlan.image !== "string" || !cfg.floorPlan.image)
      errors.push("'floorPlan.image' must be a non-empty string (data URI or URL).");
    if(!Number.isFinite(cfg.floorPlan.width)  || cfg.floorPlan.width  <= 0)
      errors.push("'floorPlan.width' must be a positive number (pixels).");
    if(!Number.isFinite(cfg.floorPlan.height) || cfg.floorPlan.height <= 0)
      errors.push("'floorPlan.height' must be a positive number (pixels).");
  }
  if(hasScale){
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

  // 1. Floor plan (optional — user may have imported the image separately).
  if(cfg.floorPlan && cfg.floorPlan.image){
    stage.style.backgroundImage = `url('${cfg.floorPlan.image}')`;
    stage.style.setProperty("--stage-aspect", `${cfg.floorPlan.width} / ${cfg.floorPlan.height}`);
  }

  // 2. Scale (optional).
  if(cfg.scale){
    const pxPerUnit = cfg.scale.pixels / cfg.scale.realLength;
    const widthPx  = (cfg.floorPlan && cfg.floorPlan.width)  || (state.scale && state.scale.stageWidthPx)  || null;
    const heightPx = (cfg.floorPlan && cfg.floorPlan.height) || (state.scale && state.scale.stageHeightPx) || null;
    state.scale = {
      pxPerUnit,
      unit: cfg.scale.unit,
      stageWidthPx: widthPx,
      stageHeightPx: heightPx,
    };
    state.units = cfg.scale.unit;
    if(typeof refitElementsToScale === "function") refitElementsToScale();
  }
  state.config = { ...cfg };

  // 3. Zone positions (optional). Updates existing zones; skips ids not present.
  if(cfg.zones && typeof cfg.zones === "object"){
    let applied = 0, missing = [];
    for(const [id, p] of Object.entries(cfg.zones)){
      if(!state.zones[id]){ missing.push(id); continue; }
      if(Number.isFinite(p.x)) state.zones[id].x = p.x;
      if(Number.isFinite(p.y)) state.zones[id].y = p.y;
      if(Number.isFinite(p.w)) state.zones[id].w = p.w;
      if(Number.isFinite(p.h)) state.zones[id].h = p.h;
      if(Number.isFinite(p.rotation)) state.zones[id].rotation = p.rotation;
      applied++;
    }
    if(missing.length){
      console.warn(`[config] ${applied} positions applied; ${missing.length} not yet imported as elements: ${missing.join(", ")}`);
    }
  }

  refreshStatusBars();
  evaluate();
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

/* ------------------------------------------------------------------
   ELEMENTS BUNDLE — load element definitions only (no positions).
   Goes through the Element Builder's "Import elements file" button.
   Each imported def becomes an EDITABLE custom element placed at
   (0, 0). Positions are assigned later via Import Configuration.
   ------------------------------------------------------------------ */
function validateElementsBundle(b){
  const errs = [];
  if(!b || typeof b !== "object") errs.push("Bundle must be a JSON object.");
  if(!Array.isArray(b.elementDefs) || !b.elementDefs.length)
    errs.push("'elementDefs' must be a non-empty array.");
  return errs;
}

function applyElementsBundle(bundle){
  const existingIds = new Set([
    ...ZONE_DEFS.map(d=>d.id),
    ...state.customElements.map(d=>d.id),
    ...state.structuralElements.map(d=>d.id),
    ...state.amenityElements.map(d=>d.id),
  ]);
  let added = 0, skipped = 0;
  for(const raw of bundle.elementDefs){
    if(!raw || !raw.id){ skipped++; continue; }
    if(existingIds.has(raw.id)){ skipped++; continue; }

    // Mark as a custom element so it shows up in the Edit-Existing list
    // and is editable through the Element Builder. Leave elementClass
    // undefined (it's only "structural"/"amenity" for those specific kinds);
    // sidebar grouping relies on a falsy elementClass for tool-like rows.
    const def = { ...raw, custom: true };
    if(raw.elementClass) def.elementClass = raw.elementClass;
    state.customElements.push(def);
    existingIds.add(def.id);

    // Default placement: top-left corner. User imports a configuration
    // file next to set proper coordinates. Initial lock state mirrors
    // def.fixed so original "fixed" defaults still apply, but the user
    // can toggle lock/unlock from the transform panel.
    state.zones[def.id] = {
      x: 0, y: 0,
      w: Number.isFinite(def.w) ? def.w : 8,
      h: Number.isFinite(def.h) ? def.h : 6,
      rotation: 0,
      included: true,
      activeUse: false,
      locked: !!def.fixed,
    };
    added++;
  }
  // Optional regions hint (kept for parity with prior bundle shape).
  if(Array.isArray(bundle.regions) && !REGIONS.length) REGIONS.push(...bundle.regions);

  evaluate();
  render();
  renderElementsList();
  if(skipped){
    console.warn(`[elements] imported ${added}, skipped ${skipped} (duplicate id or missing id).`);
  }
}

function importElementsFile(file){
  const reader = new FileReader();
  reader.onload = (e) => {
    let parsed;
    try { parsed = JSON.parse(e.target.result); }
    catch (err) { alert("Invalid JSON: " + err.message); return; }
    const errors = validateElementsBundle(parsed);
    if(errors.length){
      alert("Elements bundle is invalid:\n\n• " + errors.join("\n• "));
      return;
    }
    applyElementsBundle(parsed);
    // Refresh the Edit-Existing list inside the open builder modal.
    if(typeof renderChooserExisting === "function") renderChooserExisting();
  };
  reader.onerror = () => alert("Could not read the selected file.");
  reader.readAsText(file);
}

/* ------------------------------------------------------------------
   PROJECT FILE — unified format: elements + positions + scale in one JSON.
   Imported via the "Import Project" wizard (also delivered when a legacy
   bundle/config has elementDefs+zones). applyProject() routes through the
   existing elements-bundle and config code paths so behavior matches the
   step-by-step flow exactly.
   ------------------------------------------------------------------ */
function validateProject(p){
  const errs = [];
  if(!p || typeof p !== "object"){
    errs.push("Project must be a JSON object.");
    return errs;
  }
  if(p.elementDefs !== undefined && !Array.isArray(p.elementDefs))
    errs.push("'elementDefs' must be an array.");
  if(p.zones !== undefined && (typeof p.zones !== "object" || p.zones === null))
    errs.push("'zones' must be an object.");
  if(!p.elementDefs && !p.zones)
    errs.push("Project must include at least 'elementDefs' or 'zones'.");
  return errs;
}

function applyProject(project){
  // 1. Elements — go through the bundle path so they're editable customs.
  if(Array.isArray(project.elementDefs) && project.elementDefs.length){
    applyElementsBundle({
      elementDefs: project.elementDefs,
      regions: project.regions,
    });
  }
  // 1.5. User-defined categories (color + name swatches).
  if(Array.isArray(project.categories) && project.categories.length){
    state.categories = project.categories.map(c => ({...c}));
  }
  // 1.6. Editable header metadata.
  if(project.projectInfo && typeof project.projectInfo === "object"){
    state.projectInfo = { ...state.projectInfo, ...project.projectInfo };
    if(typeof applyProjectHeader === "function") applyProjectHeader();
  }
  // 2. Per-alternative positions. If the project carries a presets map,
  //    rebuild PRESETS entirely so every alternative tab shows up.
  if(project.presets && typeof project.presets === "object"){
    for(const k of Object.keys(PRESETS)) delete PRESETS[k];
    for(const [key, p] of Object.entries(project.presets)){
      PRESETS[key] = {
        name: p.name || key,
        zones: p.zones || {},
      };
    }
    if(typeof rebuildTabs === "function") rebuildTabs();
  }
  // 3. Floor plan + scale (skip if absent — user can import floor plan
  //    separately and hit "Skip scale" in the calibration modal).
  if(project.scale || project.floorPlan){
    applyConfig({
      name: project.name,
      scale: project.scale,
      floorPlan: project.floorPlan,
    });
  }
  // 4. Active preset — load it so its positions hit state.zones AFTER
  //    PRESETS has been rebuilt. Fall back to legacy top-level zones or
  //    the first preset, whichever exists.
  const preferred = project.activePreset && PRESETS[project.activePreset]
    ? project.activePreset
    : (Object.keys(PRESETS)[0] || "current");
  if(PRESETS[preferred]){
    loadPreset(preferred);
  } else if(project.zones){
    // Legacy single-preset payload: apply zones onto whatever's there.
    applyConfig({ zones: project.zones });
  }
  if(typeof rebuildTabs === "function") rebuildTabs();
}

function importConfigFromFile(file){
  const reader = new FileReader();
  reader.onload = (e) => {
    let parsed;
    try { parsed = JSON.parse(e.target.result); }
    catch (err) { alert("Invalid JSON: " + err.message); return; }

    // Unified project file (kind:"project", or any JSON with both
    // elementDefs AND zones). Route to applyProject; record the import.
    const looksLikeProject = parsed && (parsed.kind === "project" ||
      (Array.isArray(parsed.elementDefs) && parsed.zones));
    if(looksLikeProject){
      const errors = validateProject(parsed);
      if(errors.length){
        alert("Project file is invalid:\n\n• " + errors.join("\n• "));
        return;
      }
      state.imports.config = {
        filename: file.name,
        text: e.target.result,
        importedAt: new Date().toISOString(),
      };
      applyProject(parsed);
      // Refresh the wizard cards if it was open.
      state.pendingProjectImport = null;
      const bd = document.getElementById("projectImportBackdrop");
      if(bd && bd.classList.contains("open") && typeof _piRefreshCards === "function"){
        _piRefreshCards();
      }
      return;
    }

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
    // Refresh the wizard cards if it was open.
    state.pendingProjectImport = null;
    const bd = document.getElementById("projectImportBackdrop");
    if(bd && bd.classList.contains("open") && typeof _piRefreshCards === "function"){
      _piRefreshCards();
    }
  };
  reader.onerror = () => alert("Could not read the selected file.");
  reader.readAsText(file);
}

/* Import Project wizard — opens a 2-card chooser modal. Each card kicks
   off a step independently. The wizard remembers completion across steps
   so the user can do them in any order. */
function startProjectImportWizard(){
  const bd = document.getElementById("projectImportBackdrop");
  if(!bd) return;
  bd.classList.add("open");
  _piRefreshCards();
}

function closeProjectImportWizard(){
  const bd = document.getElementById("projectImportBackdrop");
  if(bd) bd.classList.remove("open");
  state.pendingProjectImport = null;
}

function _piRefreshCards(){
  // Floor-plan card reflects whether a floor plan + (optional) scale is loaded.
  const fpCard = document.querySelector('#projectImportBackdrop [data-pi-step="floor-plan"]');
  const fpStatus = document.getElementById("piStatusFloorPlan");
  const hasFP = !!(state.imports && state.imports.floorPlan);
  if(fpCard) fpCard.classList.toggle("done", hasFP);
  if(fpStatus){
    if(hasFP){
      const u = hasScale() ? `${state.scale.pxPerUnit.toFixed(1)} px/${state.scale.unit}` : "no scale";
      fpStatus.textContent = `Loaded · ${u}`;
    } else {
      fpStatus.textContent = "Not started";
    }
  }
  // Project-file card reflects whether a project / config has been imported.
  const pjCard = document.querySelector('#projectImportBackdrop [data-pi-step="project-file"]');
  const pjStatus = document.getElementById("piStatusProject");
  const hasCfg = !!(state.imports && state.imports.config);
  if(pjCard) pjCard.classList.toggle("done", hasCfg);
  if(pjStatus){
    if(hasCfg){
      const cnt = allZoneDefs().length;
      pjStatus.textContent = `Loaded · ${cnt} element${cnt === 1 ? "" : "s"}`;
    } else {
      pjStatus.textContent = "Not started";
    }
  }
}

function _piTriggerStep(step){
  if(step === "floor-plan"){
    state.pendingProjectImport = "step-floor-plan";
    document.getElementById("importImageInput").click();
  } else if(step === "project-file"){
    state.pendingProjectImport = "step-project-file";
    document.getElementById("importConfigInput").click();
  }
}

function wireProjectImportWizard(){
  const bd = document.getElementById("projectImportBackdrop");
  if(!bd) return;
  document.getElementById("piClose").addEventListener("click", closeProjectImportWizard);
  document.getElementById("piDone").addEventListener("click", closeProjectImportWizard);
  bd.addEventListener("click", (e)=>{
    if(e.target.id === "projectImportBackdrop") closeProjectImportWizard();
  });
  document.querySelectorAll('#projectImportBackdrop .chooser-card').forEach(card=>{
    card.addEventListener("click", ()=> _piTriggerStep(card.dataset.piStep));
  });
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
    document.getElementById("csDims").textContent = state.config.floorPlan
      ? `${state.config.floorPlan.width} × ${state.config.floorPlan.height} px`
      : "—";
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
  // Sync the sort <select> with current state (in case state was restored).
  const sortSel = document.getElementById("elementsSort");
  if(sortSel && sortSel.value !== (state.elementsSort || "risk")){
    sortSel.value = state.elementsSort || "risk";
  }

  const mode = state.elementsSort === "category" ? "category" : "risk";
  let groups;
  if(mode === "category"){
    // One group per declared category; plus catch-alls for structural,
    // amenity, and "Uncategorized".
    const catMap = Object.fromEntries((state.categories||[]).map(c=>[c.id, c]));
    groups = {};
    for(const c of (state.categories || [])){
      groups[c.label] = all.filter(d => d.cat === c.id && d.elementClass !== "structural" && d.elementClass !== "amenity");
    }
    groups["Uncategorized"]   = all.filter(d => (!d.cat || !catMap[d.cat]) && d.elementClass !== "structural" && d.elementClass !== "amenity");
    groups["Structural"]      = all.filter(d => d.elementClass === "structural");
    groups["Safety / Amenity"]= all.filter(d => d.elementClass === "amenity");
  } else {
    const structural = all.filter(d=>d.elementClass==="structural");
    const amenity    = all.filter(d=>d.elementClass==="amenity");
    groups = {
      "Fixed":    all.filter(d=>d.fixed && d.elementClass!=="structural" && d.elementClass!=="amenity"),
      "Low (R1)": all.filter(d=>!d.fixed && d.risk===1 && !d.elementClass),
      "Moderate (R2-R3)": all.filter(d=>!d.fixed && (d.risk===2 || d.risk===3) && !d.elementClass),
      "High (R4-R5)":     all.filter(d=>!d.fixed && (d.risk===4 || d.risk===5) && !d.elementClass),
      "Circulation / Open": all.filter(d=>!d.fixed && (d.cat==="corridor"||d.cat==="open") && !d.elementClass),
      "Structural": structural,
      "Safety / Amenity": amenity,
    };
  }

  listEl.innerHTML = "";
  for(const [name, items] of Object.entries(groups)){
    if(!items.length) continue;
    // Group header gets bulk inc + activeUse toggles. State derives from
    // the members: header-inc is "on" if every row in the group is
    // included; header-act is "on" if every row has activeUse set.
    const allInc = items.every(d => (state.zones[d.id] && state.zones[d.id].included !== false));
    const allAct = items.every(d => !!(state.zones[d.id] && state.zones[d.id].activeUse));
    const hdr = document.createElement("div");
    hdr.className = "el-group-hdr";
    // When sorted by category, identify which header maps to which
    // state.categories entry so we can drag-reorder it from the sidebar.
    const matchingCat = (mode === "category")
      ? (state.categories || []).find(c => c.label === name)
      : null;
    const gripHTML = matchingCat ? '<span class="el-group-grip" aria-hidden="true">⋮⋮</span>' : "";
    // Up/down reorder arrows for category headers — a reliable alternative
    // to drag-and-drop for swapping category order (which also drives stage
    // z-index layering). Disabled at the ends of the category list.
    const catIdx   = matchingCat ? (state.categories || []).findIndex(c => c.id === matchingCat.id) : -1;
    const catCount = (state.categories || []).length;
    const reorderHTML = matchingCat ? `
      <span class="el-cat-reorder">
        <button type="button" class="el-cat-move" data-move="up"   data-cat="${matchingCat.id}" title="Move category up"   ${catIdx <= 0 ? "disabled" : ""}>▲</button>
        <button type="button" class="el-cat-move" data-move="down" data-cat="${matchingCat.id}" title="Move category down" ${catIdx >= catCount - 1 ? "disabled" : ""}>▼</button>
      </span>` : "";
    hdr.innerHTML = `
      ${gripHTML}
      <span class="el-group-name">${name}</span>
      ${reorderHTML}
      <span class="el-group-tog ${allInc ? "on" : ""}" data-grp-tog="included" title="Include/exclude every element in this group">
        <span class="et-dot"></span><span class="et-lbl">inc</span>
      </span>
      <span class="el-group-tog ${allAct ? "on" : ""}" data-grp-tog="activeUse" title="Apply active-use expansion to every element in this group">
        <span class="et-dot"></span><span class="et-lbl">act</span>
      </span>
    `;
    hdr.querySelectorAll(".el-group-tog").forEach(tog => {
      tog.addEventListener("click", (e) => {
        e.stopPropagation();
        const key = tog.dataset.grpTog;
        const currentlyAllOn = key === "included" ? allInc : allAct;
        const target = !currentlyAllOn;
        for(const d of items){
          const z = state.zones[d.id]; if(!z) continue;
          if(key === "included")  z.included  = target;
          else if(key === "activeUse") z.activeUse = target;
        }
        evaluate(); render();
      });
    });
    // Up/down arrow reorder — swap this category with its neighbor in
    // state.categories (drives both sidebar order and stage z-index).
    hdr.querySelectorAll(".el-cat-move").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id  = btn.dataset.cat;
        const dir = btn.dataset.move === "up" ? -1 : 1;
        const arr = state.categories || [];
        const i = arr.findIndex(c => c.id === id);
        const j = i + dir;
        if(i < 0 || j < 0 || j >= arr.length) return;
        [arr[i], arr[j]] = [arr[j], arr[i]];
        renderElementsList();
        if(typeof render === "function") render();
        if(typeof saveAppState === "function") saveAppState();
      });
    });
    // Drag-to-reorder for category-sorted headers. The dragged header's
    // matching state.categories entry moves to the drop target's slot;
    // stage layering follows the new order via the existing z-index hook.
    if(matchingCat){
      hdr.draggable = true;
      hdr.dataset.catId = matchingCat.id;
      hdr.classList.add("draggable");
      hdr.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("text/cat-id", matchingCat.id);
        e.dataTransfer.effectAllowed = "move";
        hdr.classList.add("dragging");
      });
      hdr.addEventListener("dragend", () => hdr.classList.remove("dragging"));
      // dragenter must also preventDefault for the drop to register in some browsers.
      hdr.addEventListener("dragenter", (e) => {
        if(e.dataTransfer.types.includes("text/cat-id")) e.preventDefault();
      });
      hdr.addEventListener("dragover", (e) => {
        if(e.dataTransfer.types.includes("text/cat-id")){
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          hdr.classList.add("drop-target");
        }
      });
      hdr.addEventListener("dragleave", () => hdr.classList.remove("drop-target"));
      hdr.addEventListener("drop", (e) => {
        e.preventDefault();
        hdr.classList.remove("drop-target");
        const fromId = e.dataTransfer.getData("text/cat-id");
        if(!fromId || fromId === matchingCat.id) return;
        const arr = state.categories;
        const fromIdx = arr.findIndex(x => x.id === fromId);
        const toIdx   = arr.findIndex(x => x.id === matchingCat.id);
        if(fromIdx < 0 || toIdx < 0) return;
        const [moved] = arr.splice(fromIdx, 1);
        arr.splice(toIdx, 0, moved);
        renderElementsList();
        if(typeof render === "function") render();
        if(typeof saveAppState === "function") saveAppState();
      });
    }
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
      const locked = !!z.locked;
      row.innerHTML = `
        <span class="el-swatch" style="background:${swColor.bg};border-color:${swColor.border}"></span>
        <span class="el-label">${def.label}</span>
        <span class="el-meta">R${def.risk}</span>
        ${locked ? '<span class="el-fixed-tag" title="Locked from transform panel">Locked</span>' : ''}
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

/* Drag the divider between the left sidebar and the stage to resize
   the sidebar. Width is clamped to [180, 60% of viewport] and persists
   via state.leftColWidth so reloads remember the choice. */
function wireLeftColResizer(){
  // Whole-column width resizing was retired in favor of per-widget resizing
  // (each card body is vertically resizable). Left as a no-op so init() and
  // any persisted state.leftColWidth no longer force a fixed column width.
  return;
  /* eslint-disable no-unreachable */
  const resizer = document.getElementById("leftColResizer");
  const grid    = document.getElementById("appGrid");
  if(!resizer || !grid) return;

  const applyWidth = (w) => {
    const max = Math.max(220, Math.floor(window.innerWidth * 0.6));
    const clamped = Math.max(180, Math.min(max, w));
    grid.style.setProperty("--left-col-w", clamped + "px");
    state.leftColWidth = clamped;
  };

  // Restore previous width on first run.
  if(Number.isFinite(state.leftColWidth) && state.leftColWidth > 0){
    grid.style.setProperty("--left-col-w", state.leftColWidth + "px");
  }

  let dragging = false;
  let startX = 0, startW = 0;
  resizer.addEventListener("pointerdown", (e) => {
    dragging = true;
    try { resizer.setPointerCapture(e.pointerId); } catch(_){}
    resizer.classList.add("dragging");
    const leftCol = document.querySelector(".col.col-left");
    startX = e.clientX;
    startW = leftCol ? leftCol.getBoundingClientRect().width : 320;
    document.body.style.cursor = "col-resize";
    e.preventDefault();
  });
  resizer.addEventListener("pointermove", (e) => {
    if(!dragging) return;
    applyWidth(startW + (e.clientX - startX));
  });
  const stop = () => {
    if(!dragging) return;
    dragging = false;
    resizer.classList.remove("dragging");
    document.body.style.cursor = "";
    if(typeof saveAppState === "function") saveAppState();
  };
  resizer.addEventListener("pointerup",     stop);
  resizer.addEventListener("pointercancel", stop);
}

function applyLabelsVisibility(){
  // Toggle a body-level flag so the .zone CSS can hide its background /
  // border / shadow (the "boundary") in lockstep with the label.
  document.body.classList.toggle("no-labels", state.showLabels === false);
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

function isZoneLocked(id){
  const z = state.zones[id];
  return !!(z && z.locked);
}

function toggleSelectedLock(){
  if(!state.selectedId) return;
  const z = state.zones[state.selectedId];
  if(!z) return;
  z.locked = !z.locked;
  evaluate();
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
  // Restore the dragged position (if any) so the panel doesn't snap back
  // to top-right when a different element is selected.
  if(state.transformPanelPos){
    panel.style.left = state.transformPanelPos.left + "px";
    panel.style.top  = state.transformPanelPos.top  + "px";
    panel.style.right = "auto";
  }
  updateTransformPanelInputs();

  // Disable inputs for locked zones — still selectable for reference,
  // but cannot be moved/rotated until unlocked. (Size is no longer
  // editable here; use "Edit element settings" instead.)
  const locked = !!z.locked;
  for(const id of ["tpX","tpY","tpRotRange","tpRotNum","tpResetRot"]){
    const el = document.getElementById(id);
    if(el) el.disabled = locked;
  }
  document.querySelectorAll("#transformPanel [data-rot]").forEach(b=>b.disabled = locked);
  const lockBtn = document.getElementById("tpLock");
  if(lockBtn){
    lockBtn.textContent = locked ? "🔒 Fixed" : "🔓 Unlocked";
    lockBtn.classList.toggle("locked", locked);
  }
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
  set("tpX", xDisp);
  set("tpY", yDisp);
  // Update section labels to reflect the active unit.
  const u = hasScale() ? state.scale.unit : "% of stage";
  const pLbl = document.getElementById("tpPosLbl");
  if(pLbl) pLbl.textContent = `Position (${u})`;
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
    // w / h are no longer editable from the transform panel — bounding
    // dimensions live on the element definition and update only when the
    // user opens "Edit element settings" and changes the footprint.
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
  document.getElementById("tpLock").addEventListener("click", toggleSelectedLock);
  document.getElementById("tpX").addEventListener("input", e => applyTransformInput("x", e.target.value));
  document.getElementById("tpY").addEventListener("input", e => applyTransformInput("y", e.target.value));
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
  document.getElementById("tpResetRot").addEventListener("click", resetSelectedRotation);
  // Open the element in its builder for full editing (footprint, risk
  // zones, etc.). Routes by elementClass so structural/amenity go to
  // their dedicated screens.
  const editBtn = document.getElementById("tpEditSettings");
  if(editBtn) editBtn.addEventListener("click", ()=>{
    const id = state.selectedId;
    if(!id) return;
    if(typeof openElementBuilderForEdit === "function"){
      openElementBuilderForEdit(id);
    }
  });

  // Drag the panel by its header. Position is stored on state so it
  // persists across reselections within the same session.
  const panel = document.getElementById("transformPanel");
  const handle = panel.querySelector(".tp-hdr");
  let drag = null;
  handle.addEventListener("pointerdown", (e)=>{
    // Don't start a drag if the user clicked the × or lock button.
    if(e.target.closest("button")) return;
    e.preventDefault();
    const r = panel.getBoundingClientRect();
    const stageR = stageEl.getBoundingClientRect();
    drag = {
      dx: e.clientX - r.left,
      dy: e.clientY - r.top,
      stageL: stageR.left,
      stageT: stageR.top,
      stageW: stageR.width,
      stageH: stageR.height,
      panelW: r.width,
      panelH: r.height,
    };
    panel.classList.add("dragging");
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener("pointermove", (e)=>{
    if(!drag) return;
    // Compute absolute position within the stage; clamp to bounds.
    let left = e.clientX - drag.dx - drag.stageL;
    let top  = e.clientY - drag.dy - drag.stageT;
    left = Math.max(0, Math.min(drag.stageW - drag.panelW, left));
    top  = Math.max(0, Math.min(drag.stageH - drag.panelH, top));
    panel.style.left = left + "px";
    panel.style.top  = top  + "px";
    panel.style.right = "auto";
    state.transformPanelPos = { left, top };
  });
  handle.addEventListener("pointerup", (e)=>{
    if(!drag) return;
    drag = null;
    panel.classList.remove("dragging");
    handle.releasePointerCapture(e.pointerId);
  });

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
    if(typeof refitElementsToScale === "function") refitElementsToScale();
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
  // Import Project wizard entry point.
  const projBtn = document.getElementById("importProjectBtn");
  if(projBtn) projBtn.addEventListener("click", startProjectImportWizard);
}
