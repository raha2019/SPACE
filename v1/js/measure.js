"use strict";
/* ==================================================================
   MEASUREMENT TOOL — click two points on the layout to read the
   real-world distance between them (uses the calibrated scale; falls
   back to a pixel length with a hint when no scale is set).
   Toggle via the "Measure" switch in the Layout Builder toolbar.
   ================================================================== */

let measureState = { active:false, p1:null, p2:null };   // points in stage %

function _measureOverlay(){
  let svg = document.getElementById("measureOverlay");
  if(!svg){
    const stage = document.getElementById("stage");
    if(!stage) return null;
    const ns = "http://www.w3.org/2000/svg";
    svg = document.createElementNS(ns, "svg");
    svg.id = "measureOverlay";
    svg.setAttribute("viewBox", "0 0 100 100");
    svg.setAttribute("preserveAspectRatio", "none");
    svg.style.cssText = "position:absolute;inset:0;width:100%;height:100%;z-index:20;pointer-events:none;";
    stage.appendChild(svg);
    svg.addEventListener("click", _measureClick);
  }
  return svg;
}

function setMeasureMode(on){
  measureState.active = !!on;
  if(!on){ measureState.p1 = null; measureState.p2 = null; }
  const svg = _measureOverlay();
  if(svg){
    svg.style.pointerEvents = on ? "auto" : "none";
    svg.style.cursor = on ? "crosshair" : "default";
  }
  drawMeasure();
}

function _measureClick(e){
  if(!measureState.active) return;
  const svg = _measureOverlay(); if(!svg) return;
  const r = svg.getBoundingClientRect();
  const p = {
    x: clamp((e.clientX - r.left) / r.width  * 100, 0, 100),
    y: clamp((e.clientY - r.top)  / r.height * 100, 0, 100),
  };
  if(!measureState.p1)       { measureState.p1 = p; measureState.p2 = null; }
  else if(!measureState.p2)  { measureState.p2 = p; }
  else                       { measureState.p1 = p; measureState.p2 = null; }
  drawMeasure();
  e.stopPropagation(); e.preventDefault();
}

function _measureLabel(p1, p2){
  // Always report in the project's real units. Pixels/percent aren't
  // meaningful, so without a calibrated scale we prompt for one instead.
  const du = (typeof stageDimsUnits === "function") ? stageDimsUnits() : null;
  if(!du) return "set scale to measure";
  const fx = (p2.x - p1.x)/100 * du.w, fy = (p2.y - p1.y)/100 * du.h;
  return Math.hypot(fx, fy).toFixed(2) + " " + (state.scale ? state.scale.unit : "");
}

function drawMeasure(){
  const svg = _measureOverlay(); if(!svg) return;
  const { p1, p2 } = measureState;
  let h = "";
  if(p1){
    h += `<circle class="ms-pt" cx="${p1.x}" cy="${p1.y}" r="0.8"/>`;
    if(p2){
      h += `<line class="ms-line" x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}"/>`;
      h += `<circle class="ms-pt" cx="${p2.x}" cy="${p2.y}" r="0.8"/>`;
      const mx = (p1.x + p2.x)/2, my = (p1.y + p2.y)/2;
      const lbl = _measureLabel(p1, p2);
      const halfW = Math.max(7, lbl.length * 0.62);
      h += `<rect class="ms-bg" x="${mx-halfW}" y="${my-3.4}" width="${halfW*2}" height="5.4" rx="0.8"/>`;
      h += `<text class="ms-txt" x="${mx}" y="${my+0.7}" text-anchor="middle">${lbl}</text>`;
    }
  }
  svg.innerHTML = h;
}

function wireMeasureTool(){
  const sw = document.getElementById("measureTool");
  if(sw && !sw._measureWired){
    sw._measureWired = true;
    sw.addEventListener("click", () => {
      const on = !sw.classList.contains("on");
      sw.classList.toggle("on", on);
      setMeasureMode(on);
    });
  }
  _measureOverlay();   // ensure overlay exists in the DOM
}
