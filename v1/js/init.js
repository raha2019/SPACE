"use strict";
function init(){
  const restored = loadAppState();
  if(!restored){
    loadPreset("current");
  }
  wireControls();
  wireConfigImport();
  wireImageImport();
  wireCalibrationModal();
  wireTransformPanel();
  wireElementBuilder();
  wireProjectImportWizard();
  applySidebarVisibility();
  if(typeof applyLabelsVisibility === "function") applyLabelsVisibility();
  // Rebuild preset tabs after restore so user-added alternatives appear.
  if(typeof rebuildTabs === "function") rebuildTabs();
  // Repaint the editable header metadata from restored state.
  if(typeof applyProjectHeader === "function") applyProjectHeader();
  // After a restore, push the cached floor plan back onto the stage
  // and adopt the imported aspect ratio (these live in the DOM, not state).
  if(restored && state.imports && state.imports.floorPlan){
    const fp = state.imports.floorPlan;
    const stage = document.getElementById("stage");
    if(stage){
      stage.style.backgroundImage = `url('${fp.dataUrl}')`;
      stage.style.setProperty("--stage-aspect", `${fp.width} / ${fp.height}`);
    }
  }
  refreshStatusBars();
  evaluate();
  render();
}
window.addEventListener("DOMContentLoaded", init);
