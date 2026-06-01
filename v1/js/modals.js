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
    short: "",
    risk: 2,
    operationRisk: 2,
    w: 8, h: 6,
    cat: "",
    beginner: false,
    shapes: [
      { type:"rect", x:10, y:25, w:80, h:50, rotation:0 }
    ],
    principalAxis: { angle: 0, length: 40 },
    operatorFootprint:    { type:"none" },
    maintenanceFootprint: { type:"none" },
    kickbackVector:       { type:"none" },
    materialVector:       { type:"none" },
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

function openToolForEdit(def){
  state.editingId = def.id;
  state.editingType = "tool";
  ebDraft = JSON.parse(JSON.stringify({
    label: def.label, short: def.short,
    risk: def.risk, operationRisk: def.operationRisk || 2,
    w: def.w, h: def.h,
    cat: def.cat || "", beginner: !!def.beginner,
    shapes: def.shapes || [{type:"rect",x:10,y:25,w:80,h:50,rotation:0}],
    principalAxis: def.principalAxis || {angle:0, length:40},
    operatorFootprint:    def.operatorFootprint    || {type:"none"},
    maintenanceFootprint: def.maintenanceFootprint || {type:"none"},
    kickbackVector:       def.kickbackVector       || {type:"none"},
    materialVector:       def.materialVector       || {type:"none"},
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

function loadDraftIntoForm(){
  if(!ebDraft) return;
  updateBuilderUnitLabels();
  document.getElementById("ebLabel").value = ebDraft.label;
  document.getElementById("ebShort").value = ebDraft.short;
  document.getElementById("ebRisk").value = ebDraft.risk;
  document.getElementById("ebOpRisk").value = ebDraft.operationRisk;
  document.getElementById("ebW").value = builderDisplayDim(ebDraft.w, "x");
  document.getElementById("ebH").value = builderDisplayDim(ebDraft.h, "y");
  document.getElementById("ebCat").value = ebDraft.cat || "";
  document.getElementById("ebBeginner").value = String(ebDraft.beginner);
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
  ebDraft.short = document.getElementById("ebShort").value.trim();
  ebDraft.risk = parseInt(document.getElementById("ebRisk").value, 10);
  ebDraft.operationRisk = parseInt(document.getElementById("ebOpRisk").value, 10);
  ebDraft.w = builderInputToPct(parseFloat(document.getElementById("ebW").value), "x");
  ebDraft.h = builderInputToPct(parseFloat(document.getElementById("ebH").value), "y");
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
        <input type="number" min="-50" max="50" step="1" value="${c.cx.toFixed(1)}" data-idx="${i}" data-key="cx" title="Center X (0 = element center)" />
        <input type="number" min="-50" max="50" step="1" value="${c.cy.toFixed(1)}" data-idx="${i}" data-key="cy" title="Center Y (0 = element center)" />
        <input type="number" min="1" max="100" step="1" value="${sh.w}" data-idx="${i}" data-key="w" />
        <input type="number" min="1" max="100" step="1" value="${sh.h}" data-idx="${i}" data-key="h" />
        <button class="sr-del" data-idx="${i}" title="Remove">×</button>
      `;
    } else {
      row.innerHTML = `
        <select data-idx="${i}" data-key="type">
          <option value="rect">Rect</option>
          <option value="circle" selected>Circle</option>
        </select>
        <input type="number" min="-50" max="50" step="1" value="${c.cx.toFixed(1)}" data-idx="${i}" data-key="cx" title="Center X (0 = element center)" />
        <input type="number" min="-50" max="50" step="1" value="${c.cy.toFixed(1)}" data-idx="${i}" data-key="cy" title="Center Y (0 = element center)" />
        <input type="number" min="1" max="50" step="1" value="${sh.radius}" data-idx="${i}" data-key="radius" title="Radius" />
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
        _setShapeCenterX(sh, parseFloat(e.target.value));
      } else if(key === "cy"){
        _setShapeCenterY(sh, parseFloat(e.target.value));
      } else {
        sh[key] = parseFloat(e.target.value);
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

/* --- Risk-zone editor (tab 3) --- */
const RISK_ZONE_KEYS = {
  operator: "operatorFootprint",
  maintenance: "maintenanceFootprint",
  kickback: "kickbackVector",
  material: "materialVector",
};

function renderRiskZoneEditor(zone){
  const draftKey = RISK_ZONE_KEYS[zone];
  const z = ebDraft[draftKey] || { type:"none" };
  const typeSel = document.querySelector(`.rz-type[data-zone="${zone}"]`);
  if(typeSel) typeSel.value = z.type;
  const paramsEl = document.querySelector(`.rz-params[data-zone-params="${zone}"]`);
  if(!paramsEl) return;

  if(z.type === "none"){
    paramsEl.innerHTML = "";
    return;
  }
  let html = "";
  const u = unitLabel();
  if(z.type === "radius"){
    html = `<div class="rz-field"><label>Radius (${u})</label>
      <input type="number" data-z="${zone}" data-k="radius" min="0" step="0.5" value="${displayValue(z.radius ?? 15)}" /></div>`;
  } else if(z.type === "shape"){
    // Initialize offsetX/offsetY from legacy `offset` if needed.
    if(z.offsetX === undefined && z.offset !== undefined){
      const angRad = ((ebDraft.principalAxis && ebDraft.principalAxis.angle)||0) * Math.PI/180;
      z.offsetX = Math.cos(angRad) * z.offset;
      z.offsetY = Math.sin(angRad) * z.offset;
      delete z.offset;
    }
    html = `
      <div class="rz-field"><label>Width (${u})</label>
        <input type="number" data-z="${zone}" data-k="w" min="0" step="0.5" value="${displayValue(z.w ?? 20)}" /></div>
      <div class="rz-field"><label>Height (${u})</label>
        <input type="number" data-z="${zone}" data-k="h" min="0" step="0.5" value="${displayValue(z.h ?? 15)}" /></div>
      <div class="rz-field"><label>Offset X (${u})</label>
        <input type="number" data-z="${zone}" data-k="offsetX" step="0.5" value="${displayValue(z.offsetX ?? 0)}" /></div>
      <div class="rz-field"><label>Offset Y (${u})</label>
        <input type="number" data-z="${zone}" data-k="offsetY" step="0.5" value="${displayValue(z.offsetY ?? 0)}" /></div>`;
  } else if(z.type === "vector"){
    // Cone semantics: ray extends from the element until it hits a
    // wall/door. Origin defaults to element center but can be offset.
    // Direction defaults to the principal axis but can be rotated.
    const spread  = z.angleSpread !== undefined ? z.angleSpread : 12;
    const angle   = z.angle !== undefined ? z.angle : 0;
    const offX    = z.offsetX !== undefined ? z.offsetX : 0;
    const offY    = z.offsetY !== undefined ? z.offsetY : 0;
    html = `
      <div class="rz-field">
        <label>Angle (° from axis)</label>
        <input type="number" data-z="${zone}" data-k="angle" min="-180" max="180" step="5" value="${angle}" />
      </div>
      <div class="rz-field">
        <label>Spread (° each side)</label>
        <input type="number" data-z="${zone}" data-k="angleSpread" min="0" max="89" step="1" value="${spread}" />
      </div>
      <div class="rz-field">
        <label>Offset X (${u})</label>
        <input type="number" data-z="${zone}" data-k="offsetX" step="0.5" value="${displayValue(offX)}" />
      </div>
      <div class="rz-field">
        <label>Offset Y (${u})</label>
        <input type="number" data-z="${zone}" data-k="offsetY" step="0.5" value="${displayValue(offY)}" />
      </div>
      <div class="rz-field" style="grid-column:1 / span 2">
        <div class="rz-help">Cone origin = element center + offset. Direction = principal axis + angle. Magnitude is infinite — the ray terminates at the first wall or door.</div>
      </div>`;
  }
  paramsEl.innerHTML = html;
  paramsEl.querySelectorAll("input").forEach(inp=>{
    inp.addEventListener("input", e=>{
      const k = e.target.dataset.k;
      const dz = ebDraft[draftKey];
      const raw = parseFloat(e.target.value);
      if(!Number.isFinite(raw)) return;
      // Angles stay in degrees; dimensions/offsets convert from displayed
      // unit to internal % storage.
      if(k === "angle" || k === "angleSpread") dz[k] = raw;
      else dz[k] = inputValue(raw);
      drawShapeCanvas();
    });
  });
}

/* Helpers: convert a stored % value to displayed real-units value
   and vice versa. When no scale is set, identity. Used by risk-zone
   inputs so the field labels match what the user reads. */
function displayValue(pct){
  if(!hasScale()) return +(+pct).toFixed(2);
  // Assume "x" axis sizing for risk zones (close enough for these widgets).
  return +(pctToUnits(pct, 'x')).toFixed(2);
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

  const fakeDef = {
    id: "_preview",
    shapes: ebDraft.shapes,
    principalAxis: ebDraft.principalAxis,
    operatorFootprint:    ebDraft.operatorFootprint,
    maintenanceFootprint: ebDraft.maintenanceFootprint,
    kickbackVector:       ebDraft.kickbackVector,
    materialVector:       ebDraft.materialVector,
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
  inner += rzSVG(fakeDef.operatorFootprint, "op-zone");
  inner += rzSVG(fakeDef.maintenanceFootprint, "mt-zone");
  inner += rzSVG(fakeDef.kickbackVector, "kb-vector");
  inner += rzSVG(fakeDef.materialVector, "mat-vector");

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
  if(!Number.isFinite(d.w) || d.w<=0 || d.w>50){ alert("Bounding width must be 1-50."); switchBuilderTab("basic"); return; }
  if(!Number.isFinite(d.h) || d.h<=0 || d.h>50){ alert("Bounding height must be 1-50."); switchBuilderTab("basic"); return; }
  if(!d.shapes || !d.shapes.length){ alert("Add at least one footprint shape."); switchBuilderTab("footprint"); return; }

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
    short: d.short || d.label.slice(0, 10),
    risk: clamp(d.risk, 0, 5),
    operationRisk: clamp(d.operationRisk, 1, 4),
    w: d.w, h: d.h,
    cat: d.cat || undefined,
    beginner: !!d.beginner,
    custom: true,
    fixed: false,
    shapes: JSON.parse(JSON.stringify(d.shapes)),
    principalAxis: { angle: d.principalAxis.angle, length: d.principalAxis.length },
    operatorFootprint:    JSON.parse(JSON.stringify(d.operatorFootprint)),
    maintenanceFootprint: JSON.parse(JSON.stringify(d.maintenanceFootprint)),
    kickbackVector:       JSON.parse(JSON.stringify(d.kickbackVector)),
    materialVector:       JSON.parse(JSON.stringify(d.materialVector)),
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
  // Risk-zone type dropdowns
  document.querySelectorAll(".rz-type").forEach(sel=>{
    sel.addEventListener("change", e=>{
      const zone = e.target.dataset.zone;
      const key = RISK_ZONE_KEYS[zone];
      const newType = e.target.value;
      if(newType === "none") ebDraft[key] = { type:"none" };
      else if(newType === "radius") ebDraft[key] = { type:"radius", radius: 15 };
      else if(newType === "shape") ebDraft[key] = { type:"shape", w:20, h:15, offsetX:0, offsetY:0 };
      else if(newType === "vector") ebDraft[key] = { type:"vector", length:25, width:8 };
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

  // Click outside the modal closes it.
  document.getElementById("elementBuilderBackdrop").addEventListener("click", (e)=>{
    if(e.target.id === "elementBuilderBackdrop") closeElementBuilder();
  });
}
