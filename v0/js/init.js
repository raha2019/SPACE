"use strict";
function init(){
  loadPreset("current");
  wireControls();
  wireConfigImport();
  wireImageImport();
  wireCalibrationModal();
  wireTransformPanel();
  wireElementBuilder();
  applySidebarVisibility();
  refreshStatusBars();
  evaluate();
  render();
}
window.addEventListener("DOMContentLoaded", init);
