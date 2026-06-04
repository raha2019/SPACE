"use strict";
/* ------------------------------------------------------------------
   12.95  SCALE CALIBRATION MODAL
   -----------------------------------------------------------------
   After importing a floor plan, the user clicks two points on the
   image and enters the real distance + unit. We solve px/unit from
   that and store it as state.scale. The whole UI then displays
   dimensions in those units.
   ------------------------------------------------------------------ */
let calState = null; // {payload, pt1, pt2, recalibrate}

function openCalibrationModal(payload, recalibrate){
  calState = { payload, pt1:null, pt2:null, recalibrate: !!recalibrate };
  document.getElementById("calImage").src = payload.dataUrl;
  document.getElementById("calOverlay").innerHTML = "";
  document.getElementById("calConfirm").disabled = true;
  document.getElementById("calStatus").innerHTML = "Click <b>point 1</b> on the image.";
  document.getElementById("calibrationBackdrop").classList.add("open");
  // Pre-select unit from existing setting if any
  if(state.scale && state.scale.unit){
    document.getElementById("calUnit").value = state.scale.unit;
  } else {
    document.getElementById("calUnit").value = state.units || "ft";
  }
}

function closeCalibrationModal(){
  document.getElementById("calibrationBackdrop").classList.remove("open");
  calState = null;
}

function calCanvasClick(e){
  if(!calState) return;
  const img = document.getElementById("calImage");
  const rect = img.getBoundingClientRect();
  // Coordinates as percent of displayed image area
  const xPct = ((e.clientX - rect.left) / rect.width) * 100;
  const yPct = ((e.clientY - rect.top)  / rect.height) * 100;
  if(!calState.pt1){
    calState.pt1 = { x:xPct, y:yPct };
    document.getElementById("calStatus").innerHTML = "Click <b>point 2</b> on the image.";
  } else if(!calState.pt2){
    calState.pt2 = { x:xPct, y:yPct };
    document.getElementById("calStatus").innerHTML = "Enter the real distance and click <b>Confirm Scale</b>.";
    document.getElementById("calConfirm").disabled = false;
  } else {
    // Restart
    calState.pt1 = { x:xPct, y:yPct };
    calState.pt2 = null;
    document.getElementById("calConfirm").disabled = true;
    document.getElementById("calStatus").innerHTML = "Click <b>point 2</b> on the image.";
  }
  drawCalOverlay();
}

function drawCalOverlay(){
  const svg = document.getElementById("calOverlay");
  if(!svg || !calState) return;
  let html = "";
  const r = 1.2; // viewBox is 100x100 % space
  if(calState.pt1){
    html += `<circle class="cal-point" cx="${calState.pt1.x}" cy="${calState.pt1.y}" r="${r}"/>`;
  }
  if(calState.pt2){
    html += `<circle class="cal-point" cx="${calState.pt2.x}" cy="${calState.pt2.y}" r="${r}"/>`;
    html += `<line class="cal-line" x1="${calState.pt1.x}" y1="${calState.pt1.y}" x2="${calState.pt2.x}" y2="${calState.pt2.y}"/>`;
    const mx = (calState.pt1.x + calState.pt2.x)/2;
    const my = (calState.pt1.y + calState.pt2.y)/2;
    const v = parseFloat(document.getElementById("calDistance").value) || 0;
    const u = document.getElementById("calUnit").value;
    html += `<rect class="cal-label-bg" x="${mx-7}" y="${my-3}" width="14" height="4" rx="0.5"/>`;
    html += `<text class="cal-label" x="${mx}" y="${my+0.5}" text-anchor="middle">${v} ${u}</text>`;
  }
  svg.innerHTML = html;
}

function wireCalibrationModal(){
  document.getElementById("calClose").addEventListener("click", closeCalibrationModal);
  document.getElementById("calibrationBackdrop").addEventListener("click", (e)=>{
    if(e.target.id === "calibrationBackdrop") closeCalibrationModal();
  });
  document.getElementById("calCanvasWrap").addEventListener("click", calCanvasClick);
  document.getElementById("calClear").addEventListener("click", ()=>{
    if(!calState) return;
    calState.pt1 = null; calState.pt2 = null;
    document.getElementById("calConfirm").disabled = true;
    document.getElementById("calStatus").innerHTML = "Click <b>point 1</b> on the image.";
    drawCalOverlay();
  });
  document.getElementById("calDistance").addEventListener("input", drawCalOverlay);
  document.getElementById("calUnit").addEventListener("change", drawCalOverlay);
  document.getElementById("calSkip").addEventListener("click", ()=>{
    if(!calState) return;
    const p = calState.payload;
    // Apply without scale
    applyFloorPlan({ ...p, scale:null });
    closeCalibrationModal();
    _maybeAdvanceProjectImport();
  });
  document.getElementById("calConfirm").addEventListener("click", ()=>{
    if(!calState || !calState.pt1 || !calState.pt2) return;
    const dist = parseFloat(document.getElementById("calDistance").value);
    const unit = document.getElementById("calUnit").value;
    if(!Number.isFinite(dist) || dist <= 0){ alert("Please enter a positive real distance."); return; }
    const p = calState.payload;
    // Convert percent endpoints to pixel coordinates in the original image
    const x1px = (calState.pt1.x/100) * p.width;
    const y1px = (calState.pt1.y/100) * p.height;
    const x2px = (calState.pt2.x/100) * p.width;
    const y2px = (calState.pt2.y/100) * p.height;
    const linePx = Math.hypot(x2px-x1px, y2px-y1px);
    if(linePx < 1){ alert("Line too short to calibrate. Please pick more separated points."); return; }
    const pxPerUnit = linePx / dist;
    applyFloorPlan({ ...p, scale:{ pxPerUnit, unit } });
    closeCalibrationModal();
    _maybeAdvanceProjectImport();
  });
}

// If the Import Project wizard is currently open, refresh the step cards
// after the floor plan / calibration step finishes.
function _maybeAdvanceProjectImport(){
  if(!state.pendingProjectImport) return;
  state.pendingProjectImport = null;
  const bd = document.getElementById("projectImportBackdrop");
  if(bd && bd.classList.contains("open") && typeof _piRefreshCards === "function"){
    _piRefreshCards();
  }
}

/* ------------------------------------------------------------------
   12.9  ELEMENT BUILDER
   -----------------------------------------------------------------
   Defines custom zone types with rich attributes:
     • multi-shape footprint (rectangles + circles in local 0-100 coords)
     • principal axis (front-face) — angle + length
     • operator / maintenance / kickback / material risk zones
       each defined as none, radius, shape, or vector
     • variable attributes (flammability, collateral damage,
       maintenance frequency, noise dB, smell/fumes)
   The builder supports both Create and Edit modes (state.editingId).
   The current built-in feasibility rules target specific zone IDs;
   custom elements render with full overlays but won't trip the
   hardcoded rules until generic risk-based rules are added later.
   ------------------------------------------------------------------ */

// Working draft held outside state.customElements until Save / Update.
// Resets when openElementBuilder() is called.
let ebDraft = null;
let ebStructDraft = null;
let ebAmenityDraft = null;

function blankDraft(){
  return {
    label: "",
    description: "",
    risk: 2,
    operationRisk: 2,
    w: 8, h: 6,
    cat: "",
    beginner: false,
    // Shape coords during EDITING are in absolute % of stage (consistent
    // with how form inputs round-trip through builderInputToPct / Display).
    // saveCustomElement tightens the bounding around the shapes and
    // normalizes everything to local 0-100 of that bounding for storage.
    shapes: [
      { type:"rect", x:0, y:0, w:6, h:4, rotation:0 }
    ],
    principalAxis: { angle: 0, length: 40 },
    operatorFootprints:    [],   // each entry: { type, ...params }
    maintenanceFootprints: [],
    kickbackVectors:       [],
    materialVectors:       [],
    variableAttrs: {
      flammability: 2,
      collateralDamage: 2,
      maintenanceFrequency: "weekly",
      noiseDb: 60,
      smellFumes: 1,
    },
  };
}

/* Builder-screen switching. The modal can be in one of:
     "chooser"    — initial cards (new tool / structural / amenity, or edit existing)
     "tool"       — full tool builder (tabs)
     "structural" — walls/door/floor builder
     "amenity"    — eyewash/fire-ext/etc. builder
*/
function showBuilderScreen(name){
  const map = { chooser:"screenChooser", tool:"screenTool",
                structural:"screenStructural", amenity:"screenAmenity" };
  Object.values(map).forEach(id=>{
    const el = document.getElementById(id);
    if(el) el.style.display = (id === map[name]) ? "block" : "none";
  });
  // Footer button visibility per screen
  const backBtn = document.getElementById("ebBack");
  const saveBtn = document.getElementById("ebSave");
  if(name === "chooser"){
    backBtn.style.display = "none";
    saveBtn.style.display = "none";
    document.getElementById("ebSubtitle").textContent = "Choose what to create or edit";
  } else {
    backBtn.style.display = "inline-block";
    saveBtn.style.display = "inline-block";
  }
}

function openElementBuilder(){
  state.editingId = null;
  state.editingType = null;
  ebDraft = null;
  document.getElementById("elementBuilderBackdrop").classList.add("open");
  document.getElementById("ebEditBanner").style.display = "none";
  showBuilderScreen("chooser");
  renderChooserExisting();
}

// Called from chooser to enter the tool builder for a new tool.
function startNewTool(){
  state.editingId = null;
  state.editingType = "tool";
  ebDraft = blankDraft();
  showBuilderScreen("tool");
  document.getElementById("ebEditBanner").style.display = "none";
  document.getElementById("ebSave").textContent = "Add Element";
  document.getElementById("ebSubtitle").textContent = "Create a custom tool / workstation";
  switchBuilderTab("basic");
  loadDraftIntoForm();
  setTimeout(()=> document.getElementById("ebLabel").focus(), 50);
}

function startNewStructural(){
  state.editingId = null;
  state.editingType = "structural";
  ebStructDraft = blankStructuralDraft();
  showBuilderScreen("structural");
  document.getElementById("ebSave").textContent = "Add Structural";
  document.getElementById("ebSubtitle").textContent = "Create walls, floor space, or doors";
  loadStructuralDraftIntoForm();
}

function startNewAmenity(){
  state.editingId = null;
  state.editingType = "amenity";
  ebAmenityDraft = blankAmenityDraft();
  showBuilderScreen("amenity");
  document.getElementById("ebSave").textContent = "Add Safety Item";
  document.getElementById("ebSubtitle").textContent = "Create a safety / amenity item";
  renderAmenitySubtypes();
  loadAmenityDraftIntoForm();
}

function openElementBuilderForEdit(id){
  // Determine which collection it lives in.
  let def = state.customElements.find(d=>d.id===id);
  if(def){ openToolForEdit(def); return; }
  def = state.structuralElements.find(d=>d.id===id);
  if(def){ openStructuralForEdit(def); return; }
  def = state.amenityElements.find(d=>d.id===id);
  if(def){ openAmenityForEdit(def); return; }
  alert("Element not found.");
}

// Normalize legacy singular fields into the new array shape so old
// elements continue to render and edit. Each call returns a fresh array.
function _toArr(legacy, arr){
  const out = Array.isArray(arr) ? arr.map(e => ({...e})) : [];
  if(legacy && legacy.type && legacy.type !== "none") out.unshift({ ...legacy });
  return out;
}

function openToolForEdit(def){
  state.editingId = def.id;
  state.editingType = "tool";
  // Convert stored shapes & risk zones (local 0-100 of bounding) back to
  // absolute coords (% of stage) so the editor form shows real-unit
  // values consistent with what the user typed when creating them.
  const W = def.w || 0, H = def.h || 0;
  const absShapes = (def.shapes || []).map(sh => _denormShape(sh, W, H));
  const denormArr = arr => (arr || []).map(z => _denormRiskZone(z, W, H));
  ebDraft = JSON.parse(JSON.stringify({
    label: def.label,
    description: def.description || "",
    risk: def.risk, operationRisk: def.operationRisk || 2,
    w: def.w, h: def.h,
    cat: def.cat || "", beginner: !!def.beginner,
    shapes: absShapes.length ? absShapes : [{type:"rect", x:0, y:0, w:6, h:4, rotation:0}],
    principalAxis: def.principalAxis || {angle:0, length:40},
    operatorFootprints:    denormArr(_toArr(def.operatorFootprint,    def.operatorFootprints)),
    maintenanceFootprints: denormArr(_toArr(def.maintenanceFootprint, def.maintenanceFootprints)),
    kickbackVectors:       denormArr(_toArr(def.kickbackVector,       def.kickbackVectors)),
    materialVectors:       denormArr(_toArr(def.materialVector,       def.materialVectors)),
    variableAttrs: def.variableAttrs || blankDraft().variableAttrs,
  }));
  document.getElementById("elementBuilderBackdrop").classList.add("open");
  showBuilderScreen("tool");
  document.getElementById("ebEditBanner").style.display = "flex";
  document.getElementById("ebSave").textContent = "Update Element";
  document.getElementById("ebSubtitle").textContent = `Editing: ${def.label}`;
  switchBuilderTab("basic");
  loadDraftIntoForm();
}

function openStructuralForEdit(def){
  state.editingId = def.id;
  state.editingType = "structural";
  ebStructDraft = JSON.parse(JSON.stringify({
    label: def.label,
    subtype: def.subtype || "wall",
    shapes: def.shapes || [],
    countWalls: !!def.countWalls,
    doorSwing: def.doorSwing || 90,
  }));
  document.getElementById("elementBuilderBackdrop").classList.add("open");
  showBuilderScreen("structural");
  document.getElementById("ebSave").textContent = "Update Structural";
  document.getElementById("ebSubtitle").textContent = `Editing: ${def.label}`;
  loadStructuralDraftIntoForm();
}

function openAmenityForEdit(def){
  state.editingId = def.id;
  state.editingType = "amenity";
  ebAmenityDraft = JSON.parse(JSON.stringify({
    label: def.label,
    subtype: def.subtype || "first_aid",
    size: def.w || 3,
    coverage: def.coverage || 15,
  }));
  document.getElementById("elementBuilderBackdrop").classList.add("open");
  showBuilderScreen("amenity");
  document.getElementById("ebSave").textContent = "Update Safety Item";
  document.getElementById("ebSubtitle").textContent = `Editing: ${def.label}`;
  renderAmenitySubtypes();
  loadAmenityDraftIntoForm();
}

function closeElementBuilder(){
  document.getElementById("elementBuilderBackdrop").classList.remove("open");
  state.editingId = null;
  state.editingType = null;
}

function switchBuilderTab(name){
  document.querySelectorAll("#screenTool .modal-tab").forEach(t=>{
    t.classList.toggle("active", t.dataset.tab === name);
  });
  document.querySelectorAll("#screenTool .tab-panel").forEach(p=>{
    p.classList.toggle("active", p.dataset.tab === name);
  });
  if(name === "footprint" || name === "zones") drawShapeCanvas();
  if(name === "export") refreshExportTab();
}

/* Element Builder → Export tab. Serializes just the current draft as a
   one-element elements-bundle JSON so it can be imported into another
   project verbatim. */
function refreshExportTab(){
  const preEl = document.getElementById("ebExportPreview");
  const fnEl  = document.getElementById("ebExportFilename");
  if(!preEl || !ebDraft) return;
  readFormIntoDraft();
  const def = buildDefFromDraft(ebDraft, ebDraft._exportId || _ebSlug(ebDraft.label || "element"));
  const bundle = {
    kind: "elements-bundle",
    name: (ebDraft.label || "Element") + " — single-element export",
    generatedAt: new Date().toISOString(),
    elementDefs: [def],
  };
  preEl.textContent = JSON.stringify(bundle, null, 2);
  if(fnEl && !fnEl.value){
    fnEl.value = `element_${_ebSlug(ebDraft.label || "element")}.json`;
  }
}

function _ebSlug(s){
  return String(s || "element").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "element";
}

function _ebExportDownload(){
  const preEl = document.getElementById("ebExportPreview");
  const fnEl  = document.getElementById("ebExportFilename");
  if(!preEl) return;
  refreshExportTab();
  const txt = preEl.textContent || "";
  if(!txt || txt === "—") return;
  const blob = new Blob([txt], { type: "application/json" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url;
  a.download = (fnEl && fnEl.value.trim()) || `element_${_ebSlug(ebDraft.label || "element")}.json`;
  document.body.appendChild(a);
  a.click();
  setTimeout(()=>{ URL.revokeObjectURL(url); a.remove(); }, 200);
}

function _ebExportCopy(){
  const preEl = document.getElementById("ebExportPreview");
  if(!preEl) return;
  refreshExportTab();
  const txt = preEl.textContent || "";
  if(!txt || txt === "—") return;
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(txt).then(
      ()=>{ const btn = document.getElementById("ebExportCopy"); if(btn){ const o = btn.textContent; btn.textContent = "Copied ✓"; setTimeout(()=>{ btn.textContent = o; }, 1200); } },
      ()=>{ alert("Could not copy — your browser blocked clipboard access."); }
    );
  } else {
    alert("Clipboard API unavailable in this browser.");
  }
}

function renderChooserExisting(){
  const listEl = document.getElementById("chooserExistingList");
  if(!listEl) return;
  const all = []
    .concat(state.customElements.map(d=>({d, type:"tool"})))
    .concat(state.structuralElements.map(d=>({d, type:"structural"})))
    .concat(state.amenityElements.map(d=>({d, type:"amenity"})));
  if(!all.length){
    listEl.innerHTML = '<div class="empty-custom">No custom elements yet.</div>';
    return;
  }
  listEl.innerHTML = "";
  for(const {d, type} of all){
    const row = document.createElement("div");
    row.className = "custom-list-item";
    const typeTag = type === "tool" ? "Tool" : type === "structural" ? d.subtype : d.subtype;
    row.innerHTML = `
      <span class="cli-label">${d.label}</span>
      <span class="cli-meta">${typeTag}</span>
      <button class="cli-edit" data-id="${d.id}">Edit</button>
      <button class="cli-del" data-id="${d.id}">Remove</button>
    `;
    row.querySelector(".cli-edit").addEventListener("click", ()=> openElementBuilderForEdit(d.id));
    row.querySelector(".cli-del").addEventListener("click", ()=>{
      if(type === "tool") deleteCustomElement(d.id);
      else if(type === "structural") deleteStructuralElement(d.id);
      else deleteAmenityElement(d.id);
    });
    listEl.appendChild(row);
  }
}

/* --- Form ⇄ draft mapping ---
   ebDraft.w and ebDraft.h are stored as % of stage internally. When a
   scale is set we display them in the calibrated real unit (m/ft) and
   convert back on read. updateBuilderUnitLabels() refreshes the inline
   "(unit)" labels so the user knows which unit the input is in. */
function builderDisplayDim(pct, axis){
  return hasScale() ? +pctToUnits(pct, axis).toFixed(2) : +pct.toFixed(2);
}
function builderInputToPct(v, axis){
  if(!Number.isFinite(v)) return 0;
  return hasScale() ? unitsToPct(v, axis) : v;
}
function updateBuilderUnitLabels(){
  const u = unitLabel();
  for(const id of ["ebWUnit","ebHUnit","amSizeUnit","amCoverageUnit"]){
    const el = document.getElementById(id);
    if(el) el.textContent = hasScale() ? u : "% of stage";
  }
}

/* Union extent of every "physical" region the element occupies in local
   0..100 coords: footprint shapes + non-vector operator/maintenance/
   kickback/material zones. Vector cones are excluded because they
   extend to infinity (clipped by walls at render time).
   Pass an extents object instead of just shapes so we can capture all
   risk-zone kinds without duplicating the loop. */
function _absorbRect(box, x1, y1, x2, y2){
  if(x1 < box.x1) box.x1 = x1;
  if(y1 < box.y1) box.y1 = y1;
  if(x2 > box.x2) box.x2 = x2;
  if(y2 > box.y2) box.y2 = y2;
}

function _ebFullExtent(draft){
  const box = { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity };
  // 1. Footprint shapes (these set the baseline).
  for(const sh of (draft.shapes || [])){
    if(sh.type === "circle"){
      _absorbRect(box, (sh.x||0)-(sh.radius||0), (sh.y||0)-(sh.radius||0),
                       (sh.x||0)+(sh.radius||0), (sh.y||0)+(sh.radius||0));
    } else {
      _absorbRect(box, sh.x||0, sh.y||0, (sh.x||0)+(sh.w||0), (sh.y||0)+(sh.h||0));
    }
  }
  // 2. Operator / maintenance / kickback / material — radius + shape kinds.
  //    Vectors are skipped (infinite, wall-clipped).
  const zoneArrays = [
    draft.operatorFootprints,
    draft.maintenanceFootprints,
    draft.kickbackVectors,
    draft.materialVectors,
  ];
  for(const arr of zoneArrays){
    if(!Array.isArray(arr)) continue;
    for(const z of arr){
      if(!z || z.type === "vector" || z.type === "none") continue;
      if(z.type === "radius"){
        const r = z.radius || 0;
        _absorbRect(box, 50 - r, 50 - r, 50 + r, 50 + r);
      } else if(z.type === "shape"){
        const ox = z.offsetX || 0, oy = z.offsetY || 0;
        const w = z.w || 0,        h = z.h || 0;
        _absorbRect(box, 50 + ox - w/2, 50 + oy - h/2,
                         50 + ox + w/2, 50 + oy + h/2);
      }
    }
  }
  if(!Number.isFinite(box.x1)) return null;
  return { ...box, w: box.x2 - box.x1, h: box.y2 - box.y1 };
}

// Back-compat: kept for any callers that just want the shapes extent.
function _ebShapesExtent(shapes){
  return _ebFullExtent({ shapes });
}

/* Shape-only extent (no risk zones). Used as the *bounding* at save
   time so the rendered boundary tightly wraps the footprint. Risk zones
   live inside / can extend beyond the bounding — they don't enlarge it. */
function _ebOnlyShapeExtent(shapes){
  if(!shapes || !shapes.length) return null;
  const box = { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity };
  for(const sh of shapes){
    if(sh.type === "circle"){
      _absorbRect(box, (sh.x||0)-(sh.radius||0), (sh.y||0)-(sh.radius||0),
                       (sh.x||0)+(sh.radius||0), (sh.y||0)+(sh.radius||0));
    } else {
      _absorbRect(box, sh.x||0, sh.y||0, (sh.x||0)+(sh.w||0), (sh.y||0)+(sh.h||0));
    }
  }
  if(!Number.isFinite(box.x1)) return null;
  return { ...box, w: box.x2 - box.x1, h: box.y2 - box.y1 };
}

/* Re-normalize one shape from absolute coords to local 0-100 of bounding. */
function _normShape(sh, ext){
  if(!ext || ext.w <= 0 || ext.h <= 0) return sh;
  if(sh.type === "circle"){
    return { ...sh,
      x: ((sh.x||0) - ext.x1) / ext.w * 100,
      y: ((sh.y||0) - ext.y1) / ext.h * 100,
      radius: (sh.radius || 0) / Math.min(ext.w, ext.h) * 100,
    };
  }
  return { ...sh,
    x: ((sh.x||0) - ext.x1) / ext.w * 100,
    y: ((sh.y||0) - ext.y1) / ext.h * 100,
    w: (sh.w || 0) / ext.w * 100,
    h: (sh.h || 0) / ext.h * 100,
  };
}

/* Re-normalize one risk-zone entry from absolute coords to local 0-100. */
function _normRiskZone(z, ext){
  if(!ext || ext.w <= 0 || ext.h <= 0) return z;
  const out = {...z};
  if(z.type === "radius"){
    out.radius = (z.radius || 0) / Math.min(ext.w, ext.h) * 100;
  } else if(z.type === "shape"){
    out.w = (z.w || 0) / ext.w * 100;
    out.h = (z.h || 0) / ext.h * 100;
    out.offsetX = (z.offsetX || 0) / ext.w * 100;
    out.offsetY = (z.offsetY || 0) / ext.h * 100;
  } else if(z.type === "vector"){
    out.offsetX = (z.offsetX || 0) / ext.w * 100;
    out.offsetY = (z.offsetY || 0) / ext.h * 100;
  }
  return out;
}

/* Inverse: local 0-100 of bounding (W,H) back to absolute coords.
   Used at openToolForEdit so the form starts with absolute values. */
function _denormShape(sh, W, H){
  if(!W || !H) return sh;
  if(sh.type === "circle"){
    return { ...sh,
      x: (sh.x||0) / 100 * W,
      y: (sh.y||0) / 100 * H,
      radius: (sh.radius || 0) / 100 * Math.min(W, H),
    };
  }
  return { ...sh,
    x: (sh.x||0) / 100 * W,
    y: (sh.y||0) / 100 * H,
    w: (sh.w || 0) / 100 * W,
    h: (sh.h || 0) / 100 * H,
  };
}

function _denormRiskZone(z, W, H){
  if(!W || !H) return z;
  const out = {...z};
  if(z.type === "radius"){
    out.radius = (z.radius || 0) / 100 * Math.min(W, H);
  } else if(z.type === "shape"){
    out.w = (z.w || 0) / 100 * W;
    out.h = (z.h || 0) / 100 * H;
    out.offsetX = (z.offsetX || 0) / 100 * W;
    out.offsetY = (z.offsetY || 0) / 100 * H;
  } else if(z.type === "vector"){
    out.offsetX = (z.offsetX || 0) / 100 * W;
    out.offsetY = (z.offsetY || 0) / 100 * H;
  }
  return out;
}

/* "Current size: 4.5 ft × 3 ft" readout under the Basic tab. */
function updateBuilderSizeReadout(){
  const out = document.getElementById("ebSizeReadoutValue");
  if(!out || !ebDraft) return;
  // Use the shape-only extent — that's what saveCustomElement uses as
  // the bounding, and what the user sees as the boundary on stage.
  const ext = _ebOnlyShapeExtent(ebDraft.shapes);
  if(!ext){ out.textContent = "—"; return; }
  const w = ext.w, h = ext.h;
  const u = unitLabel();
  if(hasScale()){
    out.textContent = `${builderDisplayDim(w,"x").toFixed(2)} × ${builderDisplayDim(h,"y").toFixed(2)} ${u}`;
  } else {
    out.textContent = `${w.toFixed(1)} × ${h.toFixed(1)} ${u}`;
  }
}

/* Editable color+name category picker used by the Element Builder Basic
   tab. Categories live on state.categories so they persist across
   reloads via the autosave snapshot. */
function renderCategoryPicker(){
  const host = document.getElementById("ebCategoryPicker");
  if(!host) return;
  const cats = (state.categories || []);
  const hidden = document.getElementById("ebCat");
  const current = (hidden && hidden.value) || (ebDraft && ebDraft.cat) || "";
  host.innerHTML = "";
  for(const c of cats){
    const chip = document.createElement("span");
    chip.className = "eb-cat-chip" + (c.id === current ? " selected" : "");
    chip.innerHTML = `<span class="eb-cat-swatch" style="background:${c.color}"></span><span class="eb-cat-name">${c.label}</span><button type="button" class="eb-cat-del" title="Remove this category">×</button>`;
    chip.addEventListener("click", (e)=>{
      // Ignore clicks on the delete button itself.
      if(e.target.closest(".eb-cat-del")) return;
      if(hidden) hidden.value = c.id;
      if(ebDraft) ebDraft.cat = c.id;
      renderCategoryPicker();
    });
    chip.querySelector(".eb-cat-del").addEventListener("click", (e)=>{
      e.stopPropagation();
      if(!confirm(`Remove category "${c.label}"? Elements using it will become uncategorized.`)) return;
      state.categories = (state.categories || []).filter(x=>x.id !== c.id);
      // Clear any element def that referenced this category.
      const clear = arr => { for(const d of arr || []) if(d.cat === c.id) delete d.cat; };
      clear(state.customElements); clear(state.structuralElements); clear(state.amenityElements);
      clear(ZONE_DEFS);
      if(ebDraft && ebDraft.cat === c.id) ebDraft.cat = "";
      if(hidden && hidden.value === c.id) hidden.value = "";
      renderCategoryPicker();
      if(typeof renderElementsList === "function") renderElementsList();
      if(typeof saveAppState === "function") saveAppState();
    });
    host.appendChild(chip);
  }
  // "+ Add" inline editor
  const adder = document.createElement("div");
  adder.className = "eb-cat-adder";
  adder.innerHTML = `
    <input type="color" id="ebCatNewColor" value="#5aa9ff" title="Pick a color" />
    <input type="text"  id="ebCatNewLabel" placeholder="New group name" maxlength="32" />
    <button type="button" class="btn ghost" id="ebCatNewAdd">+ Add</button>`;
  host.appendChild(adder);
  document.getElementById("ebCatNewAdd").addEventListener("click", ()=>{
    const label = document.getElementById("ebCatNewLabel").value.trim();
    const color = document.getElementById("ebCatNewColor").value || "#5aa9ff";
    if(!label){ alert("Enter a category name."); return; }
    const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    let id = slug, n = 2;
    while((state.categories || []).find(c=>c.id === id)){ id = slug + "_" + n; n++; }
    (state.categories = state.categories || []).push({ id, label, color });
    if(hidden) hidden.value = id;
    if(ebDraft) ebDraft.cat = id;
    renderCategoryPicker();
  });
}

function loadDraftIntoForm(){
  if(!ebDraft) return;
  updateBuilderUnitLabels();
  document.getElementById("ebLabel").value = ebDraft.label;
  const descEl = document.getElementById("ebDescription");
  if(descEl) descEl.value = ebDraft.description || "";
  document.getElementById("ebRisk").value = ebDraft.risk;
  document.getElementById("ebOpRisk").value = ebDraft.operationRisk;
  document.getElementById("ebCat").value = ebDraft.cat || "";
  document.getElementById("ebBeginner").value = String(ebDraft.beginner);
  updateBuilderSizeReadout();
  renderCategoryPicker();
  document.getElementById("ebAxisAngle").value = ebDraft.principalAxis.angle;
  document.getElementById("ebAxisLength").value = ebDraft.principalAxis.length;
  document.getElementById("ebFlam").value = ebDraft.variableAttrs.flammability;
  document.getElementById("ebCollat").value = ebDraft.variableAttrs.collateralDamage;
  document.getElementById("ebMaintFreq").value = ebDraft.variableAttrs.maintenanceFrequency;
  document.getElementById("ebNoise").value = ebDraft.variableAttrs.noiseDb;
  document.getElementById("ebSmell").value = ebDraft.variableAttrs.smellFumes;
  updateBuilderPreview();
  renderShapeList();
  renderRiskZoneEditor("operator");
  renderRiskZoneEditor("maintenance");
  renderRiskZoneEditor("kickback");
  renderRiskZoneEditor("material");
  drawShapeCanvas();
}

function readFormIntoDraft(){
  if(!ebDraft) return;
  ebDraft.label = document.getElementById("ebLabel").value.trim();
  const descEl2 = document.getElementById("ebDescription");
  ebDraft.description = descEl2 ? descEl2.value.trim() : "";
  ebDraft.risk = parseInt(document.getElementById("ebRisk").value, 10);
  ebDraft.operationRisk = parseInt(document.getElementById("ebOpRisk").value, 10);
  // ebW / ebH are gone — w/h is derived from the union extent of the
  // footprint shapes during saveCustomElement. updateBuilderSizeReadout()
  // shows the live derived size on the Basic tab.
  ebDraft.cat = document.getElementById("ebCat").value || "";
  ebDraft.beginner = document.getElementById("ebBeginner").value === "true";
  ebDraft.principalAxis.angle = parseFloat(document.getElementById("ebAxisAngle").value) || 0;
  ebDraft.principalAxis.length = parseFloat(document.getElementById("ebAxisLength").value) || 0;
  ebDraft.variableAttrs.flammability = parseInt(document.getElementById("ebFlam").value, 10);
  ebDraft.variableAttrs.collateralDamage = parseInt(document.getElementById("ebCollat").value, 10);
  ebDraft.variableAttrs.maintenanceFrequency = document.getElementById("ebMaintFreq").value;
  ebDraft.variableAttrs.noiseDb = parseFloat(document.getElementById("ebNoise").value) || 0;
  ebDraft.variableAttrs.smellFumes = parseInt(document.getElementById("ebSmell").value, 10);
}

function updateBuilderPreview(){
  const risk = parseInt(document.getElementById("ebRisk").value, 10) || 0;
  const sw = document.getElementById("ebPreviewSw");
  const txt = document.getElementById("ebPreviewTxt");
  const c = riskSwatchColor({risk});
  sw.style.background = c.bg;
  sw.style.borderColor = c.border;
  txt.textContent = `Display Risk ${risk} — ${RISK_TAGS[risk] || "—"}`;
}

/* --- Shape list editor (tab 2) --- */
/* Element Builder shape coords are now CENTERED — the user enters the
   shape's CENTER (cx, cy) relative to the element's center (0,0 = middle).
   We continue to store top-left-anchored coords internally so the render
   pipeline doesn't change. */
function _shapeCenter(sh){
  if(sh.type === "circle") return { cx: (sh.x||0) - 50, cy: (sh.y||0) - 50 };
  return { cx: ((sh.x||0) + (sh.w||0)/2) - 50, cy: ((sh.y||0) + (sh.h||0)/2) - 50 };
}
function _setShapeCenterX(sh, cx){
  if(sh.type === "circle") sh.x = cx + 50;
  else sh.x = (cx + 50) - (sh.w||0)/2;
}
function _setShapeCenterY(sh, cy){
  if(sh.type === "circle") sh.y = cy + 50;
  else sh.y = (cy + 50) - (sh.h||0)/2;
}

function renderShapeList(){
  const listEl = document.getElementById("ebShapeList");
  listEl.innerHTML = "";
  // When the floor plan has a scale, show every shape coord in real units
  // (ft/m). Otherwise stay in local 0..100 percent of the bounding box.
  const u = unitLabel();
  // Per-axis conversion: X-axis fields (Cx, W, radius) use stage-width
  // pixels-per-unit; Y-axis fields (Cy, H) use stage-height. Without
  // this split, 4 ft × 4 ft renders as a rectangle on non-square stages.
  const dvx = v => +(builderDisplayDim(v, "x")).toFixed(2);
  const dvy = v => +(builderDisplayDim(v, "y")).toFixed(2);
  const ivx = v => builderInputToPct(parseFloat(v), "x");
  const ivy = v => builderInputToPct(parseFloat(v), "y");
  const hdr = document.querySelector('#screenTool .shape-row-headers');
  if(hdr){
    hdr.innerHTML = `<div>Type</div><div>Cx (${u})</div><div>Cy (${u})</div><div>W / R (${u})</div><div>H (${u})</div><div></div>`;
  }
  ebDraft.shapes.forEach((sh, i)=>{
    const row = document.createElement("div");
    row.className = "shape-row";
    const c = _shapeCenter(sh);
    if(sh.type === "rect"){
      row.innerHTML = `
        <select data-idx="${i}" data-key="type">
          <option value="rect" selected>Rect</option>
          <option value="circle">Circle</option>
        </select>
        <input type="number" step="0.5" value="${dvx(c.cx)}" data-idx="${i}" data-key="cx" title="Center X (0 = element center)" />
        <input type="number" step="0.5" value="${dvy(c.cy)}" data-idx="${i}" data-key="cy" title="Center Y (0 = element center)" />
        <input type="number" min="0.1" step="0.5" value="${dvx(sh.w)}" data-idx="${i}" data-key="w" />
        <input type="number" min="0.1" step="0.5" value="${dvy(sh.h)}" data-idx="${i}" data-key="h" />
        <button class="sr-del" data-idx="${i}" title="Remove">×</button>
      `;
    } else {
      row.innerHTML = `
        <select data-idx="${i}" data-key="type">
          <option value="rect">Rect</option>
          <option value="circle" selected>Circle</option>
        </select>
        <input type="number" step="0.5" value="${dvx(c.cx)}" data-idx="${i}" data-key="cx" title="Center X (0 = element center)" />
        <input type="number" step="0.5" value="${dvy(c.cy)}" data-idx="${i}" data-key="cy" title="Center Y (0 = element center)" />
        <input type="number" min="0.1" step="0.5" value="${dvx(sh.radius)}" data-idx="${i}" data-key="radius" title="Radius" />
        <span class="sr-label" style="text-align:center;align-self:center">—</span>
        <button class="sr-del" data-idx="${i}" title="Remove">×</button>
      `;
    }
    listEl.appendChild(row);
  });
  listEl.querySelectorAll("input,select").forEach(inp=>{
    inp.addEventListener("input", e=>{
      const idx = parseInt(e.target.dataset.idx, 10);
      const key = e.target.dataset.key;
      const sh = ebDraft.shapes[idx];
      if(key === "type"){
        // Preserve the shape's center when converting between rect and circle.
        const c = _shapeCenter(sh);
        if(e.target.value === "circle"){
          ebDraft.shapes[idx] = { type:"circle",
            x: c.cx + 50, y: c.cy + 50,
            radius: Math.min(sh.w||20, sh.h||20)/2 };
        } else {
          const w = (sh.radius||10)*2, h = (sh.radius||10)*2;
          ebDraft.shapes[idx] = { type:"rect",
            x: (c.cx + 50) - w/2, y: (c.cy + 50) - h/2,
            w, h, rotation: 0 };
        }
        renderShapeList();
      } else if(key === "cx"){
        _setShapeCenterX(sh, ivx(e.target.value));
      } else if(key === "cy"){
        _setShapeCenterY(sh, ivy(e.target.value));
      } else if(key === "h"){
        sh.h = ivy(e.target.value);
      } else {
        // w, radius — X-axis
        sh[key] = ivx(e.target.value);
      }
      drawShapeCanvas();
    });
  });
  listEl.querySelectorAll(".sr-del").forEach(b=>{
    b.addEventListener("click", e=>{
      const idx = parseInt(e.currentTarget.dataset.idx, 10);
      ebDraft.shapes.splice(idx, 1);
      renderShapeList();
      drawShapeCanvas();
    });
  });
}

/* --- Risk-zone editor (tab 3) --- maps zone-kind → draft array. */
const RISK_ZONE_ARRAY_KEYS = {
  operator:    "operatorFootprints",
  maintenance: "maintenanceFootprints",
  kickback:    "kickbackVectors",
  material:    "materialVectors",
};

// Vector kinds: vectors only support the "vector" type, footprints
// support all three (none is implied by deleting the entry).
const RISK_ZONE_DEFAULT_TYPE = {
  operator:    "radius",
  maintenance: "shape",
  kickback:    "vector",
  material:    "vector",
};

function _rzNewEntry(zone){
  const t = RISK_ZONE_DEFAULT_TYPE[zone] || "radius";
  if(t === "radius") return { type:"radius", radius: 15 };
  if(t === "shape")  return { type:"shape",  w: 20, h: 15, offsetX: 0, offsetY: 0 };
  return { type:"vector", angle: 0, angleSpread: 12, offsetX: 0, offsetY: 0 };
}

function _rzEntryHTML(zone, entry, i){
  const u = unitLabel();
  const allowed = (zone === "kickback" || zone === "material")
    ? ["vector","radius","shape"]
    : ["radius","shape","vector"];
  const typeOpts = allowed.map(t =>
    `<option value="${t}"${entry.type === t ? " selected" : ""}>${
      t === "radius" ? "Radius" : t === "shape" ? "Rectangle" : "Vector"
    }</option>`).join("");

  let params = "";
  if(entry.type === "radius"){
    params = `
      <div class="rz-field"><label>Radius (${u})</label>
        <input type="number" data-z="${zone}" data-i="${i}" data-k="radius" min="0" step="0.5" value="${displayValue(entry.radius ?? 15, "x")}" /></div>`;
  } else if(entry.type === "shape"){
    // Migrate legacy `offset` to offsetX/offsetY once.
    if(entry.offsetX === undefined && entry.offset !== undefined){
      const angRad = ((ebDraft.principalAxis && ebDraft.principalAxis.angle) || 0) * Math.PI/180;
      entry.offsetX = Math.cos(angRad) * entry.offset;
      entry.offsetY = Math.sin(angRad) * entry.offset;
      delete entry.offset;
    }
    params = `
      <div class="rz-field"><label>Width (${u})</label>
        <input type="number" data-z="${zone}" data-i="${i}" data-k="w" min="0" step="0.5" value="${displayValue(entry.w ?? 20, "x")}" /></div>
      <div class="rz-field"><label>Height (${u})</label>
        <input type="number" data-z="${zone}" data-i="${i}" data-k="h" min="0" step="0.5" value="${displayValue(entry.h ?? 15, "y")}" /></div>
      <div class="rz-field"><label>Offset X (${u})</label>
        <input type="number" data-z="${zone}" data-i="${i}" data-k="offsetX" step="0.5" value="${displayValue(entry.offsetX ?? 0, "x")}" /></div>
      <div class="rz-field"><label>Offset Y (${u})</label>
        <input type="number" data-z="${zone}" data-i="${i}" data-k="offsetY" step="0.5" value="${displayValue(entry.offsetY ?? 0, "y")}" /></div>`;
  } else if(entry.type === "vector"){
    const spread = entry.angleSpread !== undefined ? entry.angleSpread : 12;
    const angle  = entry.angle !== undefined ? entry.angle : 0;
    const offX   = entry.offsetX !== undefined ? entry.offsetX : 0;
    const offY   = entry.offsetY !== undefined ? entry.offsetY : 0;
    params = `
      <div class="rz-field"><label>Angle (° from axis)</label>
        <input type="number" data-z="${zone}" data-i="${i}" data-k="angle" min="-180" max="180" step="5" value="${angle}" /></div>
      <div class="rz-field"><label>Spread (° each side)</label>
        <input type="number" data-z="${zone}" data-i="${i}" data-k="angleSpread" min="0" max="89" step="1" value="${spread}" /></div>
      <div class="rz-field"><label>Offset X (${u})</label>
        <input type="number" data-z="${zone}" data-i="${i}" data-k="offsetX" step="0.5" value="${displayValue(offX, "x")}" /></div>
      <div class="rz-field"><label>Offset Y (${u})</label>
        <input type="number" data-z="${zone}" data-i="${i}" data-k="offsetY" step="0.5" value="${displayValue(offY, "y")}" /></div>`;
  }

  return `
    <div class="rz-entry" data-z="${zone}" data-i="${i}">
      <div class="rz-entry-hdr">
        <span class="rz-entry-label">#${i + 1}</span>
        <select class="rz-entry-type" data-z="${zone}" data-i="${i}">${typeOpts}</select>
        <button type="button" class="rz-entry-del" data-z="${zone}" data-i="${i}" title="Remove this entry">×</button>
      </div>
      <div class="rz-params-grid">${params}</div>
    </div>`;
}

function renderRiskZoneEditor(zone){
  const draftKey = RISK_ZONE_ARRAY_KEYS[zone];
  if(!ebDraft[draftKey]) ebDraft[draftKey] = [];
  const arr = ebDraft[draftKey];
  const paramsEl = document.querySelector(`.rz-params[data-zone-params="${zone}"]`);
  if(!paramsEl) return;

  if(!arr.length){
    paramsEl.innerHTML = `<div class="rz-empty">None. Click <b>+ Add</b> above to create one.</div>`;
    return;
  }
  paramsEl.innerHTML = arr.map((e, i) => _rzEntryHTML(zone, e, i)).join("");

  // Field inputs — update the matching entry.
  paramsEl.querySelectorAll("input[data-i]").forEach(inp=>{
    inp.addEventListener("input", e=>{
      const i = parseInt(e.target.dataset.i, 10);
      const k = e.target.dataset.k;
      const entry = ebDraft[draftKey][i];
      if(!entry) return;
      const raw = parseFloat(e.target.value);
      if(!Number.isFinite(raw)) return;
      if(k === "angle" || k === "angleSpread") entry[k] = raw;
      else {
        // Per-axis: H / Cy / offsetY use Y-axis; W / Cx / offsetX /
        // radius use X-axis. Without the split, square inputs render as
        // rectangles on a non-square stage.
        const axis = (k === "h" || k === "cy" || k === "offsetY") ? "y" : "x";
        entry[k] = builderInputToPct(raw, axis);
      }
      drawShapeCanvas();
    });
  });

  // Type select per entry → reseed defaults for the new type.
  paramsEl.querySelectorAll(".rz-entry-type").forEach(sel=>{
    sel.addEventListener("change", e=>{
      const i = parseInt(e.target.dataset.i, 10);
      const newType = e.target.value;
      // Replace with a fresh entry of the new type, keeping nothing.
      ebDraft[draftKey][i] = (() => {
        if(newType === "radius") return { type:"radius", radius: 15 };
        if(newType === "shape")  return { type:"shape",  w: 20, h: 15, offsetX: 0, offsetY: 0 };
        return { type:"vector", angle: 0, angleSpread: 12, offsetX: 0, offsetY: 0 };
      })();
      renderRiskZoneEditor(zone);
      drawShapeCanvas();
    });
  });

  // Delete buttons.
  paramsEl.querySelectorAll(".rz-entry-del").forEach(btn=>{
    btn.addEventListener("click", e=>{
      const i = parseInt(e.target.dataset.i, 10);
      ebDraft[draftKey].splice(i, 1);
      renderRiskZoneEditor(zone);
      drawShapeCanvas();
    });
  });
}

/* Helpers: convert a stored % value to displayed real-units value
   and vice versa. When no scale is set, identity. Used by risk-zone
   inputs so the field labels match what the user reads. */
function displayValue(pct, axis){
  if(!hasScale()) return +(+pct).toFixed(2);
  return +(pctToUnits(pct, axis || 'x')).toFixed(2);
}
function inputValue(displayed){
  if(!hasScale()) return +displayed;
  return +(unitsToPct(displayed, 'x'));
}

/* --- Live preview canvas inside the builder --- */
function drawShapeCanvas(){
  // Draw to both the Footprint tab canvas and the Zones tab canvas
  // so both stay in sync as the user edits.
  if(!ebDraft) return;
  drawShapeCanvasInto("ebCanvasGrid", "ebCanvasContent", "");
  drawShapeCanvasInto("ebCanvasGridZ", "ebCanvasContentZ", "Z");
  updateBuilderSizeReadout();
}

function drawShapeCanvasInto(gridId, contentId, suffix){
  const content = document.getElementById(contentId);
  const grid = document.getElementById(gridId);
  if(!content || !grid) return;
  // Grid lines (10% spacing)
  let g = "";
  for(let i=10;i<100;i+=10){
    g += `<line class="grid-line" x1="${i}" y1="0" x2="${i}" y2="100"/>`;
    g += `<line class="grid-line" x1="0" y1="${i}" x2="100" y2="${i}"/>`;
  }
  g += `<line class="center-line" x1="50" y1="0" x2="50" y2="100"/>`;
  g += `<line class="center-line" x1="0" y1="50" x2="100" y2="50"/>`;
  grid.innerHTML = g;

  // Draft coords are absolute (% of stage). The preview SVG uses
  // viewBox 0-100 representing the bounding box, so we normalize on the
  // fly using the same shape-only extent that saveCustomElement will use.
  const _pvExt = _ebOnlyShapeExtent(ebDraft.shapes) || { x1:0, y1:0, w:100, h:100 };
  const fakeDef = {
    id: "_preview",
    shapes: (ebDraft.shapes || []).map(sh => _normShape(sh, _pvExt)),
    principalAxis: ebDraft.principalAxis,
    operatorFootprints:    (ebDraft.operatorFootprints    || []).map(z => _normRiskZone(z, _pvExt)),
    maintenanceFootprints: (ebDraft.maintenanceFootprints || []).map(z => _normRiskZone(z, _pvExt)),
    kickbackVectors:       (ebDraft.kickbackVectors       || []).map(z => _normRiskZone(z, _pvExt)),
    materialVectors:       (ebDraft.materialVectors       || []).map(z => _normRiskZone(z, _pvExt)),
  };
  let inner = "";
  (fakeDef.shapes || []).forEach(sh=>{
    if(sh.type === "rect"){
      inner += `<rect class="footprint-shape" x="${sh.x}" y="${sh.y}" width="${sh.w}" height="${sh.h}"${sh.rotation?` transform="rotate(${sh.rotation} ${sh.x+sh.w/2} ${sh.y+sh.h/2})"`:""}/>`;
    } else if(sh.type === "circle"){
      inner += `<circle class="footprint-shape" cx="${sh.x}" cy="${sh.y}" r="${sh.radius}"/>`;
    }
  });
  const ang = (fakeDef.principalAxis && fakeDef.principalAxis.angle) || 0;
  const angRad = ang * Math.PI/180;

  function rzSVG(z, cls){
    if(!z || z.type === "none") return "";
    if(z.type === "radius"){
      return `<circle class="${cls}" cx="50" cy="50" r="${z.radius || 15}"/>`;
    }
    if(z.type === "shape"){
      const w = z.w || 20, h = z.h || 15;
      const ox = z.offsetX !== undefined ? z.offsetX : (z.offset !== undefined ? Math.cos(angRad)*z.offset : 0);
      const oy = z.offsetY !== undefined ? z.offsetY : (z.offset !== undefined ? Math.sin(angRad)*z.offset : 0);
      // Note: shape zones rotate with the principal axis so "along axis"
      // semantics stay intuitive even after axis rotation.
      return `<rect class="${cls}" x="${50 - w/2 + ox}" y="${50 - h/2 + oy}" width="${w}" height="${h}" transform="rotate(${ang} ${50 + ox} ${50 + oy})"/>`;
    }
    if(z.type === "vector"){
      // Cone preview: origin = element center + offset, direction =
      // principal axis + per-vector angle. Magnitude infinite on stage;
      // here we cap at the local preview box edge so it stays readable.
      const spread = z.angleSpread !== undefined ? z.angleSpread : 12;
      const extraAng = (z.angle || 0) * Math.PI / 180;
      const sRad = spread * Math.PI / 180;
      const L = 80;
      const cx = 50 + (z.offsetX || 0);
      const cy = 50 + (z.offsetY || 0);
      const dir = angRad + extraAng;
      const tipL = { x: cx + Math.cos(dir - sRad) * L, y: cy + Math.sin(dir - sRad) * L };
      const tipR = { x: cx + Math.cos(dir + sRad) * L, y: cy + Math.sin(dir + sRad) * L };
      return `<polygon class="${cls}" points="${cx.toFixed(2)},${cy.toFixed(2)} ${tipL.x.toFixed(2)},${tipL.y.toFixed(2)} ${tipR.x.toFixed(2)},${tipR.y.toFixed(2)}"/>`;
    }
    return "";
  }
  for(const e of fakeDef.operatorFootprints)    inner += rzSVG(e, "op-zone");
  for(const e of fakeDef.maintenanceFootprints) inner += rzSVG(e, "mt-zone");
  for(const e of fakeDef.kickbackVectors)       inner += rzSVG(e, "kb-vector");
  for(const e of fakeDef.materialVectors)       inner += rzSVG(e, "mat-vector");

  if(fakeDef.principalAxis && fakeDef.principalAxis.length > 0){
    const x2 = 50 + Math.cos(angRad)*fakeDef.principalAxis.length/2;
    const y2 = 50 + Math.sin(angRad)*fakeDef.principalAxis.length/2;
    inner += `<line class="axis-arrow" x1="50" y1="50" x2="${x2}" y2="${y2}"/>`;
  }
  content.innerHTML = inner;
}

/* --- Save / Update --- */
function saveCustomElement(){
  readFormIntoDraft();
  const d = ebDraft;
  if(!d.label){ alert("Please enter a name."); switchBuilderTab("basic"); return; }
  if(!d.shapes || !d.shapes.length){ alert("Add at least one footprint shape."); switchBuilderTab("footprint"); return; }
  // Bounding = shape extent ONLY (risk zones may extend beyond it
  // visually). All editing coords are in absolute % of stage; here we
  // tighten the bounding to the shape extent and re-normalize shapes &
  // risk zones to local 0-100 of the new bounding so the renderer draws
  // each piece at its true absolute size.
  const ext = _ebOnlyShapeExtent(d.shapes);
  if(!ext || ext.w <= 0 || ext.h <= 0){
    alert("Element must have a positive footprint area."); switchBuilderTab("footprint"); return;
  }
  d.w = ext.w; d.h = ext.h;
  d.shapes = d.shapes.map(sh => _normShape(sh, ext));
  for(const k of ["operatorFootprints","maintenanceFootprints","kickbackVectors","materialVectors"]){
    if(Array.isArray(d[k])) d[k] = d[k].map(z => _normRiskZone(z, ext));
  }
  // If a scale is set, also remember the absolute size so the element
  // keeps its real-world footprint when the floor plan changes.
  if(hasScale()){
    d.wReal = pctToUnits(d.w, "x");
    d.hReal = pctToUnits(d.h, "y");
    d.realUnit = state.scale.unit;
  }

  if(state.editingId){
    // Update existing
    const idx = state.customElements.findIndex(x=>x.id===state.editingId);
    if(idx < 0){ alert("Editing target not found."); return; }
    const id = state.editingId;
    state.customElements[idx] = buildDefFromDraft(d, id);
    // Resize the live zone if w/h changed.
    const z = state.zones[id];
    if(z){
      z.w = d.w; z.h = d.h;
      z.x = clamp(z.x, 0, 100 - z.w);
      z.y = clamp(z.y, 0, 100 - z.h);
    }
  } else {
    // Create new — place at (0,0) so it matches the import workflow.
    const baseId = "custom_" + d.label.toLowerCase().replace(/[^a-z0-9]+/g,"_").replace(/^_|_$/g,"");
    let id = baseId, n = 2;
    const taken = new Set(allZoneDefs().map(x=>x.id));
    while(taken.has(id)){ id = baseId + "_" + n; n++; }
    state.customElements.push(buildDefFromDraft(d, id));
    state.zones[id] = {
      x: 0, y: 0,
      w: d.w, h: d.h, rotation: 0,
      included: true, activeUse: false,
      locked: false,
    };
  }
  evaluate(); render();
  renderCustomElementList();
  closeElementBuilder();
}

function buildDefFromDraft(d, id){
  return {
    id,
    label: d.label,
    description: d.description || "",
    risk: clamp(d.risk, 0, 5),
    operationRisk: clamp(d.operationRisk, 1, 4),
    w: d.w, h: d.h,
    wReal: d.wReal,        // absolute width in d.realUnit (if set)
    hReal: d.hReal,        // absolute height in d.realUnit
    realUnit: d.realUnit,  // "ft" | "m" | etc.
    cat: d.cat || undefined,
    beginner: !!d.beginner,
    custom: true,
    fixed: false,
    shapes: JSON.parse(JSON.stringify(d.shapes)),
    principalAxis: { angle: d.principalAxis.angle, length: d.principalAxis.length },
    operatorFootprints:    JSON.parse(JSON.stringify(d.operatorFootprints    || [])),
    maintenanceFootprints: JSON.parse(JSON.stringify(d.maintenanceFootprints || [])),
    kickbackVectors:       JSON.parse(JSON.stringify(d.kickbackVectors       || [])),
    materialVectors:       JSON.parse(JSON.stringify(d.materialVectors       || [])),
    variableAttrs: JSON.parse(JSON.stringify(d.variableAttrs)),
  };
}

function renderCustomElementList(){
  const listEl = document.getElementById("ebCustomList");
  if(!listEl) return;
  if(!state.customElements.length){
    listEl.innerHTML = '<div class="empty-custom">No custom elements yet.</div>';
    return;
  }
  listEl.innerHTML = "";
  for(const def of state.customElements){
    const row = document.createElement("div");
    row.className = "custom-list-item";
    const mvTxt = def.fixed ? "Fixed" : "Moveable";
    const opR = def.operationRisk ? `· Op${def.operationRisk}` : "";
    row.innerHTML = `
      <span class="cli-label">${def.label}</span>
      <span class="cli-meta">R${def.risk} ${opR} · ${def.w}×${def.h} · ${mvTxt}</span>
      <button class="cli-edit" data-id="${def.id}">Edit</button>
      <button class="cli-del" data-id="${def.id}">Remove</button>
    `;
    row.querySelector(".cli-edit").addEventListener("click", ()=> openElementBuilderForEdit(def.id));
    row.querySelector(".cli-del").addEventListener("click", ()=> deleteCustomElement(def.id));
    listEl.appendChild(row);
  }
}

function deleteCustomElement(id){
  if(!confirm("Remove this custom element? This cannot be undone.")) return;
  state.customElements = state.customElements.filter(d=>d.id!==id);
  delete state.zones[id];
  if(state.selectedId === id) state.selectedId = null;
  if(state.editingId === id){
    state.editingId = null;
    closeElementBuilder();
  } else {
    evaluate(); render();
    renderCustomElementList();
  }
}

/* ==================================================================
   STRUCTURAL BUILDER  (walls / floor space / doors)
   ------------------------------------------------------------------
   Stored as state.structuralElements. A single structural element
   can have multiple shapes that, when overlapping, are treated as
   one merged area for dimension reporting (union extent + monte-carlo
   union area). Subtype affects rendering and downstream calculations:
     - wall: fixed, blocks movement
     - floor: defines usable area, optional "count walls" flag
     - door: fixed, has a swing direction
   ================================================================== */
const STRUCTURAL_DEFAULTS = {
  wall:  { color:"struct-wall"  },
  floor: { color:"struct-floor" },
  door:  { color:"struct-door"  },
};

function blankStructuralDraft(){
  return {
    label: "",
    subtype: "wall",
    shapes: [{ type:"rect", x:20, y:40, w:60, h:10 }],
    countWalls: false,
    doorSwing: 90,
  };
}

function loadStructuralDraftIntoForm(){
  if(!ebStructDraft) return;
  document.getElementById("sbType").value = ebStructDraft.subtype;
  document.getElementById("sbLabel").value = ebStructDraft.label;
  document.getElementById("sbCountWalls").value = String(ebStructDraft.countWalls);
  document.getElementById("sbDoorSwing").value = ebStructDraft.doorSwing;
  document.getElementById("sbFloorWallToggleField").style.display =
    (ebStructDraft.subtype === "floor") ? "flex" : "none";
  document.getElementById("sbDoorSwingField").style.display =
    (ebStructDraft.subtype === "door") ? "flex" : "none";
  renderStructuralShapeList();
  drawStructuralCanvas();
}

function renderStructuralShapeList(){
  const listEl = document.getElementById("sbShapesList");
  if(!listEl) return;
  listEl.innerHTML = "";
  ebStructDraft.shapes.forEach((sh, i)=>{
    const row = document.createElement("div");
    row.className = "struct-shape-row";
    if(sh.type === "rect"){
      row.innerHTML =
        '<select data-idx="'+i+'" data-k="type">' +
          '<option value="rect" selected>Rect</option>' +
          '<option value="circle">Circle</option>' +
        '</select>' +
        '<input type="number" min="0" max="100" step="0.5" value="'+sh.x+'" data-idx="'+i+'" data-k="x" />' +
        '<input type="number" min="0" max="100" step="0.5" value="'+sh.y+'" data-idx="'+i+'" data-k="y" />' +
        '<input type="number" min="0.5" max="100" step="0.5" value="'+sh.w+'" data-idx="'+i+'" data-k="w" />' +
        '<input type="number" min="0.5" max="100" step="0.5" value="'+sh.h+'" data-idx="'+i+'" data-k="h" />' +
        '<button class="sr-del" data-idx="'+i+'" title="Remove">x</button>';
    } else {
      row.innerHTML =
        '<select data-idx="'+i+'" data-k="type">' +
          '<option value="rect">Rect</option>' +
          '<option value="circle" selected>Circle</option>' +
        '</select>' +
        '<input type="number" min="0" max="100" step="0.5" value="'+sh.x+'" data-idx="'+i+'" data-k="x" title="Center X" />' +
        '<input type="number" min="0" max="100" step="0.5" value="'+sh.y+'" data-idx="'+i+'" data-k="y" title="Center Y" />' +
        '<input type="number" min="0.5" max="50" step="0.5" value="'+(sh.radius || 5)+'" data-idx="'+i+'" data-k="radius" title="Radius" />' +
        '<span class="sr-label" style="text-align:center;align-self:center">-</span>' +
        '<button class="sr-del" data-idx="'+i+'" title="Remove">x</button>';
    }
    listEl.appendChild(row);
  });
  listEl.querySelectorAll("input,select").forEach(inp=>{
    inp.addEventListener("input", e=>{
      const idx = parseInt(e.target.dataset.idx, 10);
      const k = e.target.dataset.k;
      const sh = ebStructDraft.shapes[idx];
      if(k === "type"){
        if(e.target.value === "circle"){
          ebStructDraft.shapes[idx] = { type:"circle",
            x: (sh.x || 0) + (sh.w || 0)/2,
            y: (sh.y || 0) + (sh.h || 0)/2,
            radius: Math.min(sh.w || 10, sh.h || 10)/2 };
        } else {
          ebStructDraft.shapes[idx] = { type:"rect",
            x: Math.max(0, (sh.x || 50) - (sh.radius || 5)),
            y: Math.max(0, (sh.y || 50) - (sh.radius || 5)),
            w: (sh.radius || 5) * 2, h: (sh.radius || 5) * 2 };
        }
        renderStructuralShapeList();
      } else {
        sh[k] = parseFloat(e.target.value);
      }
      drawStructuralCanvas();
    });
  });
  listEl.querySelectorAll(".sr-del").forEach(b=>{
    b.addEventListener("click", e=>{
      const idx = parseInt(e.currentTarget.dataset.idx, 10);
      ebStructDraft.shapes.splice(idx, 1);
      renderStructuralShapeList();
      drawStructuralCanvas();
    });
  });
}

function drawStructuralCanvas(){
  if(!ebStructDraft) return;
  const grid = document.getElementById("sbCanvasGrid");
  const content = document.getElementById("sbCanvasContent");
  if(!grid || !content) return;
  let g = "";
  for(let i=10;i<100;i+=10){
    g += '<line class="grid-line" x1="0" y1="'+i+'" x2="160" y2="'+i+'"/>';
  }
  for(let i=16;i<160;i+=16){
    g += '<line class="grid-line" x1="'+i+'" y1="0" x2="'+i+'" y2="100"/>';
  }
  grid.innerHTML = g;

  const cls = STRUCTURAL_DEFAULTS[ebStructDraft.subtype].color + "-shape";
  let inner = "";
  ebStructDraft.shapes.forEach(sh=>{
    if(sh.type === "rect"){
      const x = sh.x * 1.6, w = sh.w * 1.6;
      inner += '<rect class="'+cls+'" x="'+x+'" y="'+sh.y+'" width="'+w+'" height="'+sh.h+'"/>';
    } else if(sh.type === "circle"){
      const cx = sh.x * 1.6;
      inner += '<circle class="'+cls+'" cx="'+cx+'" cy="'+sh.y+'" r="'+(sh.radius * 1.6)+'"/>';
    }
  });
  const ext = unionExtent(ebStructDraft.shapes);
  if(ext){
    const x = ext.x1 * 1.6;
    const w = (ext.x2 - ext.x1) * 1.6;
    inner += '<rect class="union-outline" x="'+x+'" y="'+ext.y1+'" width="'+w+'" height="'+(ext.y2-ext.y1)+'"/>';
  }
  content.innerHTML = inner;

  document.getElementById("sbDimCount").textContent = ebStructDraft.shapes.length;
  if(ext){
    const w = ext.x2 - ext.x1, h = ext.y2 - ext.y1;
    document.getElementById("sbDimExt").textContent = fmtDim(w,'x') + ' x ' + fmtDim(h,'y');
    const areaPct = unionAreaPct(ebStructDraft.shapes);
    document.getElementById("sbDimArea").textContent = hasScale()
      ? unionAreaReal(ebStructDraft.shapes)
      : areaPct.toFixed(2) + " %sq";
  } else {
    document.getElementById("sbDimExt").textContent = "-";
    document.getElementById("sbDimArea").textContent = "-";
  }
}

/* Bounding extent of all shapes in % coords. Returns null if empty. */
function unionExtent(shapes){
  if(!shapes || !shapes.length) return null;
  let x1=100, y1=100, x2=0, y2=0, any=false;
  for(const sh of shapes){
    if(sh.type === "rect"){
      x1 = Math.min(x1, sh.x); y1 = Math.min(y1, sh.y);
      x2 = Math.max(x2, sh.x + sh.w); y2 = Math.max(y2, sh.y + sh.h);
      any = true;
    } else if(sh.type === "circle"){
      x1 = Math.min(x1, sh.x - sh.radius); y1 = Math.min(y1, sh.y - sh.radius);
      x2 = Math.max(x2, sh.x + sh.radius); y2 = Math.max(y2, sh.y + sh.radius);
      any = true;
    }
  }
  return any ? {x1,y1,x2,y2} : null;
}

/* Approximate union area via monte-carlo sampling. Good enough for
   live preview at ~4k samples. */
function unionAreaPct(shapes){
  if(!shapes || !shapes.length) return 0;
  const ext = unionExtent(shapes);
  if(!ext) return 0;
  const N = 4000;
  let hits = 0;
  for(let i=0;i<N;i++){
    const px = ext.x1 + Math.random()*(ext.x2-ext.x1);
    const py = ext.y1 + Math.random()*(ext.y2-ext.y1);
    if(pointInAnyShape(px, py, shapes)) hits++;
  }
  const extArea = (ext.x2-ext.x1)*(ext.y2-ext.y1);
  return (hits / N) * extArea;
}

function unionAreaReal(shapes){
  if(!hasScale()) return "";
  const a = unionAreaPct(shapes);
  const du = stageDimsUnits();
  const realArea = (a / 10000) * du.w * du.h;
  return realArea.toFixed(2) + " " + state.scale.unit + "^2";
}

function pointInAnyShape(px, py, shapes){
  for(const sh of shapes){
    if(sh.type === "rect"){
      if(px >= sh.x && px <= sh.x + sh.w && py >= sh.y && py <= sh.y + sh.h) return true;
    } else if(sh.type === "circle"){
      const dx = px - sh.x, dy = py - sh.y;
      if(dx*dx + dy*dy <= sh.radius*sh.radius) return true;
    }
  }
  return false;
}

function saveStructuralElement(){
  const d = ebStructDraft;
  if(!d.label.trim()){ alert("Please enter a name."); return; }
  if(!d.shapes.length){ alert("Add at least one shape."); return; }

  const ext = unionExtent(d.shapes) || {x1:0,y1:0,x2:20,y2:20};
  const w = ext.x2 - ext.x1, h = ext.y2 - ext.y1;
  const subtype = d.subtype;

  // Re-base shapes to local 0..100% within the bounding box so they
  // render correctly via the composite SVG pipeline used on the stage.
  const localShapes = d.shapes.map(sh=>{
    if(sh.type === "rect"){
      return { type:"rect",
        x: ((sh.x - ext.x1) / w) * 100,
        y: ((sh.y - ext.y1) / h) * 100,
        w: (sh.w / w) * 100,
        h: (sh.h / h) * 100 };
    } else {
      return { type:"circle",
        x: ((sh.x - ext.x1) / w) * 100,
        y: ((sh.y - ext.y1) / h) * 100,
        radius: (sh.radius / Math.min(w, h)) * 100 };
    }
  });

  const buildDef = (id) => ({
    id, label: d.label.trim(),
    short: d.label.trim().slice(0,10),
    risk: 0,
    elementClass: "structural",
    subtype,
    custom: true,
    fixed: subtype === "wall" || subtype === "door",
    w, h,
    shapes: localShapes,
    rawShapes: JSON.parse(JSON.stringify(d.shapes)),
    countWalls: d.countWalls,
    doorSwing: d.doorSwing,
    unionAreaPct: unionAreaPct(d.shapes),
  });

  if(state.editingId){
    const idx = state.structuralElements.findIndex(x=>x.id===state.editingId);
    if(idx < 0){ alert("Editing target not found."); return; }
    const id = state.editingId;
    state.structuralElements[idx] = buildDef(id);
    const z = state.zones[id];
    if(z){ z.w = w; z.h = h; z.x = clamp(z.x, 0, 100-z.w); z.y = clamp(z.y, 0, 100-z.h); }
  } else {
    const slug = d.label.toLowerCase().replace(/[^a-z0-9]+/g,"_").replace(/^_|_$/g,"");
    let id = "struct_" + (slug || subtype), n=2;
    const taken = new Set(allZoneDefs().map(x=>x.id));
    while(taken.has(id)){ id = "struct_" + (slug || subtype) + "_" + n; n++; }
    state.structuralElements.push(buildDef(id));
    state.zones[id] = {
      x: ext.x1, y: ext.y1, w, h, rotation:0,
      included:true, activeUse:false,
      locked: subtype === "wall" || subtype === "door",
    };
  }
  evaluate(); render();
  closeElementBuilder();
}

function deleteStructuralElement(id){
  if(!confirm("Remove this structural element?")) return;
  state.structuralElements = state.structuralElements.filter(d=>d.id!==id);
  delete state.zones[id];
  if(state.selectedId === id) state.selectedId = null;
  if(state.editingId === id){ closeElementBuilder(); }
  else { evaluate(); render(); renderChooserExisting(); }
}

/* ==================================================================
   AMENITY BUILDER  (eyewash, fire ext, etc.)
   ------------------------------------------------------------------
   Single-point items with a coverage radius. Subtype drives the
   icon, default coverage, and downstream calculations (fire ext
   reduces fire risk, eyewash reduces chem-exposure risk, etc).
   ================================================================== */
const AMENITY_SUBTYPES = [
  { id:"eyewash",          icon:"EW",  label:"Eye-Wash",           coverage:15, desc:"Required within 10s travel of hazards." },
  { id:"shower",           icon:"SH",  label:"Emergency Shower",   coverage:18, desc:"Required for chemical exposure stations." },
  { id:"first_aid",        icon:"+",   label:"First Aid Kit",      coverage:20, desc:"Should be visible from work areas." },
  { id:"fire_extinguisher",icon:"FX",  label:"Fire Extinguisher",  coverage:12, desc:"Reduces local fire risk." },
  { id:"sand",             icon:"SA",  label:"Sand Bucket",        coverage:8,  desc:"For metal / Class D fires." },
  { id:"sink",             icon:"SK",  label:"Sink",               coverage:10, desc:"Hand-washing access." },
  { id:"fume_hood",        icon:"FH",  label:"Fume Hood",          coverage:6,  desc:"Local exhaust for fumes / dust." },
  { id:"trash",            icon:"TR",  label:"Trash Can",          coverage:6,  desc:"Waste receptacle. Toggle bag liner per unit.", hasBag:true },
];

function blankAmenityDraft(){
  return {
    label: "",
    subtype: "fire_extinguisher",
    size: 3,
    coverage: 12,
  };
}

function renderAmenitySubtypes(){
  const grid = document.getElementById("amSubtypeGrid");
  if(!grid) return;
  grid.innerHTML = "";
  for(const sub of AMENITY_SUBTYPES){
    const card = document.createElement("div");
    card.className = "amenity-subtype-card" + (sub.id === ebAmenityDraft.subtype ? " selected" : "");
    card.innerHTML =
      '<div class="as-icon">' + sub.icon + '</div>' +
      '<div class="as-title">' + sub.label + '</div>' +
      '<div class="as-desc">' + sub.desc + '</div>';
    card.addEventListener("click", ()=>{
      ebAmenityDraft.subtype = sub.id;
      ebAmenityDraft.coverage = sub.coverage;
      if(!ebAmenityDraft.label.trim()) ebAmenityDraft.label = sub.label;
      renderAmenitySubtypes();
      loadAmenityDraftIntoForm();
    });
    grid.appendChild(card);
  }
}

function loadAmenityDraftIntoForm(){
  if(!ebAmenityDraft) return;
  updateBuilderUnitLabels();
  document.getElementById("amLabel").value = ebAmenityDraft.label;
  document.getElementById("amSize").value = builderDisplayDim(ebAmenityDraft.size, "x");
  document.getElementById("amCoverage").value = builderDisplayDim(ebAmenityDraft.coverage, "x");
  // Show bag toggle only for subtypes that support it (e.g. Trash Can).
  const sub = AMENITY_SUBTYPES.find(s=>s.id === ebAmenityDraft.subtype);
  const bagField = document.getElementById("amBagField");
  if(bagField){
    bagField.style.display = (sub && sub.hasBag) ? "" : "none";
    const cb = document.getElementById("amHasBag");
    if(cb) cb.checked = !!ebAmenityDraft.hasBag;
  }
}

function saveAmenityElement(){
  const d = ebAmenityDraft;
  if(!d.subtype){ alert("Pick a safety/amenity type."); return; }
  const sub = AMENITY_SUBTYPES.find(s=>s.id === d.subtype);
  const label = (d.label || sub.label).trim();
  if(!label){ alert("Please enter a name."); return; }
  if(!Number.isFinite(d.size) || d.size <= 0){ alert("Marker size must be positive."); return; }

  const buildDef = (id) => ({
    id, label,
    short: sub.icon,
    risk: 0,
    elementClass: "amenity",
    subtype: d.subtype,
    custom: true,
    fixed: false,
    w: d.size, h: d.size,
    coverage: d.coverage,
    icon: sub.icon,
    hasBag: sub.hasBag ? !!d.hasBag : undefined,
  });

  if(state.editingId){
    const idx = state.amenityElements.findIndex(x=>x.id===state.editingId);
    if(idx < 0){ alert("Editing target not found."); return; }
    const id = state.editingId;
    state.amenityElements[idx] = buildDef(id);
    const z = state.zones[id];
    if(z){ z.w = d.size; z.h = d.size; }
  } else {
    const slug = label.toLowerCase().replace(/[^a-z0-9]+/g,"_").replace(/^_|_$/g,"");
    let id = "amenity_" + (slug || d.subtype), n=2;
    const taken = new Set(allZoneDefs().map(x=>x.id));
    while(taken.has(id)){ id = "amenity_" + (slug || d.subtype) + "_" + n; n++; }
    state.amenityElements.push(buildDef(id));
    state.zones[id] = {
      x: 0, y: 0,
      w: d.size, h: d.size, rotation:0,
      included:true, activeUse:false,
      locked: false,
    };
  }
  evaluate(); render();
  closeElementBuilder();
}

function deleteAmenityElement(id){
  if(!confirm("Remove this safety/amenity item?")) return;
  state.amenityElements = state.amenityElements.filter(d=>d.id!==id);
  delete state.zones[id];
  if(state.selectedId === id) state.selectedId = null;
  if(state.editingId === id){ closeElementBuilder(); }
  else { evaluate(); render(); renderChooserExisting(); }
}


function wireElementBuilder(){
  document.getElementById("elementBuilderBtn").addEventListener("click", openElementBuilder);
  document.getElementById("ebClose").addEventListener("click", closeElementBuilder);
  document.getElementById("ebCancel").addEventListener("click", closeElementBuilder);

  // Save button dispatches based on the screen we're on.
  document.getElementById("ebSave").addEventListener("click", ()=>{
    if(state.editingType === "tool") saveCustomElement();
    else if(state.editingType === "structural") saveStructuralElement();
    else if(state.editingType === "amenity") saveAmenityElement();
  });

  // Element Builder → Export tab actions.
  const exDl = document.getElementById("ebExportDownload");
  if(exDl) exDl.addEventListener("click", _ebExportDownload);
  const exCp = document.getElementById("ebExportCopy");
  if(exCp) exCp.addEventListener("click", _ebExportCopy);
  // Live-refresh the preview when the user changes anything elsewhere in
  // the builder — easiest hook is the tab switch (already calls
  // refreshExportTab) plus an explicit refresh when the filename input
  // gets focus (covers the "tabs not switched but want fresh data" case).
  const exFn = document.getElementById("ebExportFilename");
  if(exFn) exFn.addEventListener("focus", refreshExportTab);

  // Back-to-chooser button (visible on non-chooser screens).
  document.getElementById("ebBack").addEventListener("click", ()=>{
    state.editingId = null;
    state.editingType = null;
    showBuilderScreen("chooser");
    renderChooserExisting();
  });

  // Chooser cards
  document.querySelectorAll("#screenChooser .chooser-card").forEach(card=>{
    card.addEventListener("click", ()=>{
      const choice = card.dataset.choice;
      if(choice === "new-tool") startNewTool();
      else if(choice === "new-structural") startNewStructural();
      else if(choice === "new-amenity") startNewAmenity();
      else if(choice === "import-elements") document.getElementById("importElementsInput").click();
    });
  });

  // Import elements file (hidden file input inside chooser screen)
  document.getElementById("importElementsInput").addEventListener("change", (e)=>{
    const f = e.target.files[0];
    if(f) importElementsFile(f);
    e.target.value = "";
  });

  // Tool-builder bits
  document.getElementById("ebExitEdit").addEventListener("click", ()=>{
    state.editingId = null;
    state.editingType = null;
    showBuilderScreen("chooser");
    renderChooserExisting();
  });
  document.getElementById("ebRisk").addEventListener("change", updateBuilderPreview);
  document.getElementById("ebAddShape").addEventListener("click", ()=>{
    ebDraft.shapes.push({ type:"rect", x:30, y:30, w:40, h:40, rotation:0 });
    renderShapeList();
    drawShapeCanvas();
  });
  // Tab switching (scope to tool screen only)
  document.querySelectorAll("#screenTool .modal-tab").forEach(t=>{
    t.addEventListener("click", ()=> switchBuilderTab(t.dataset.tab));
  });
  // Axis inputs
  ["ebAxisAngle","ebAxisLength"].forEach(id=>{
    document.getElementById(id).addEventListener("input", ()=>{
      ebDraft.principalAxis.angle = parseFloat(document.getElementById("ebAxisAngle").value)||0;
      ebDraft.principalAxis.length = parseFloat(document.getElementById("ebAxisLength").value)||0;
      drawShapeCanvas();
    });
  });
  // Risk-zone +Add buttons — append a fresh default entry of the
  // appropriate kind, then re-render the editor for that zone.
  document.querySelectorAll(".rz-add").forEach(btn=>{
    btn.addEventListener("click", e=>{
      const zone = e.currentTarget.dataset.zone;
      const arrKey = RISK_ZONE_ARRAY_KEYS[zone];
      if(!ebDraft[arrKey]) ebDraft[arrKey] = [];
      ebDraft[arrKey].push(_rzNewEntry(zone));
      renderRiskZoneEditor(zone);
      drawShapeCanvas();
    });
  });

  // Structural-builder wiring
  document.getElementById("sbType").addEventListener("change", e=>{
    ebStructDraft.subtype = e.target.value;
    document.getElementById("sbFloorWallToggleField").style.display =
      (e.target.value === "floor") ? "flex" : "none";
    document.getElementById("sbDoorSwingField").style.display =
      (e.target.value === "door") ? "flex" : "none";
    drawStructuralCanvas();
  });
  document.getElementById("sbLabel").addEventListener("input", e=>{
    ebStructDraft.label = e.target.value;
  });
  document.getElementById("sbCountWalls").addEventListener("change", e=>{
    ebStructDraft.countWalls = e.target.value === "true";
  });
  document.getElementById("sbDoorSwing").addEventListener("input", e=>{
    ebStructDraft.doorSwing = parseFloat(e.target.value) || 0;
    drawStructuralCanvas();
  });
  document.getElementById("sbAddShape").addEventListener("click", ()=>{
    ebStructDraft.shapes.push({ type:"rect", x:40, y:40, w:20, h:20 });
    renderStructuralShapeList();
    drawStructuralCanvas();
  });

  // Amenity-builder wiring
  document.getElementById("amLabel").addEventListener("input", e=>{
    ebAmenityDraft.label = e.target.value;
  });
  document.getElementById("amSize").addEventListener("input", e=>{
    ebAmenityDraft.size = builderInputToPct(parseFloat(e.target.value) || 3, "x");
  });
  document.getElementById("amCoverage").addEventListener("input", e=>{
    ebAmenityDraft.coverage = builderInputToPct(parseFloat(e.target.value) || 0, "x");
  });
  const amHasBag = document.getElementById("amHasBag");
  if(amHasBag) amHasBag.addEventListener("change", e=>{
    if(ebAmenityDraft) ebAmenityDraft.hasBag = e.target.checked;
  });

  // Click outside the modal closes it.
  document.getElementById("elementBuilderBackdrop").addEventListener("click", (e)=>{
    if(e.target.id === "elementBuilderBackdrop") closeElementBuilder();
  });
}
