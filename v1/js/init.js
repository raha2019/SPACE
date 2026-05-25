"use strict";
function init(){
  loadPreset("current");
  wireControls();
  wireConfigImport();
  wireImageImport();
  wireCalibrationModal();
  wireTransformPanel();
  wireElementBuilder();
  wireSimulations();
  applySidebarVisibility();
  refreshStatusBars();
  evaluate();
  render();
}
window.addEventListener("DOMContentLoaded", init);
