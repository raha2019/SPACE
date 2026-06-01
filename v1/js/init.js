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
