/**
 * Temporary Node.js test runner for SPACE sim module tests.
 * Not committed. Provides the minimum browser stubs needed to run tests.js
 * in Node without a DOM. Mirrors what tests/index.html does in a browser.
 */

"use strict";

// ---- browser stubs ----
global.document = {
  createElement: (tag) => {
    if (tag === "canvas") {
      return {
        getContext: () => ({
          clearRect: () => {},
          fillRect: () => {},
          fillStyle: "",
          globalAlpha: 1,
        }),
        width: 0,
        height: 0,
        style: {},
      };
    }
    return { innerHTML: "", style: {}, appendChild: () => {} };
  },
  getElementById: (id) => {
    if (id === "results") return { innerHTML: "" };
    return null;
  },
  querySelector: () => null,
  querySelectorAll: () => [],
};
global.window = global;
global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
global.console = console;

// ---- sim_ui.js stubs (loaded before sim modules in the browser) ----
global.simGetCanvas = () => document.createElement("canvas");
global.simShowError = () => {};
global.simShowAdaResults = () => {};
global.simShowEgressResults = () => {};
global.simShowNoiseResults = () => {};
global.simShowFireResults = () => {};
global.simShowFumesResults = () => {};
global._simEsc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ---- state.js stubs needed after Rahul's changes ----
// simBlockerFootprint: Rahul added this to sim_ada.js / sim_egress.js.
// Provides a simple AABB footprint (no rotation) sufficient for the tests,
// which all use rotation=0.
global.simBlockerFootprint = function(def, z, stageW, stageH, includeOperator) {
  const cxf = (z.x + z.w / 2) / 100 * stageW;
  const cyf = (z.y + z.h / 2) / 100 * stageH;
  const hw  = z.w / 100 * stageW / 2;
  const hh  = z.h / 100 * stageH / 2;
  const x1  = cxf - hw, y1 = cyf - hh, x2 = cxf + hw, y2 = cyf + hh;
  return {
    test: (xf, yf) => xf >= x1 && xf <= x2 && yf >= y1 && yf <= y2,
    aabb: { x1, y1, x2, y2 },
  };
};
// analysisScopeAreaUnits / roomScopeActive / pointInAnalysisScope:
// used with typeof guards in sim_egress.js so not strictly needed,
// but define them anyway to be safe.
global.analysisScopeAreaUnits = () => null;
global.roomScopeActive = () => false;
global.pointInAnalysisScope = () => true;
// convertUnits / currentUnit: used by _noiseRefDist() in sim_noise.js.
global.convertUnits = (v, from, to) => {
  const toM = { m: 1, meter: 1, meters: 1, ft: 0.3048, foot: 0.3048, feet: 0.3048 };
  if (!toM[from] || !toM[to]) return v;
  return v * toM[from] / toM[to];
};
global.currentUnit = () => "ft";

// ---- optimizer UI stubs ----
global._setOptButtonState = () => {};
global._showOptProgress = () => {};
global._showOptError = () => {};
global._showOptResults = () => {};
global._drawGhostOverlay = () => {};
global.wireOptimizer = () => {};

// ---- load sim modules in the same order as tests/index.html ----
const path = require("path");
const fs   = require("fs");
const vm   = require("vm");

function loadFile(relPath) {
  const abs = path.join(__dirname, relPath);
  const src = fs.readFileSync(abs, "utf8");
  try {
    vm.runInThisContext(src, { filename: abs });
  } catch (e) {
    console.error("ERROR loading " + relPath + ": " + e.message);
    process.exit(1);
  }
}

loadFile("../v1/js/sim_ada.js");
loadFile("../v1/js/sim_egress.js");
loadFile("../v1/js/sim_noise.js");
loadFile("../v1/js/sim_eval.js");
loadFile("../v1/js/sim_optimizer.js");
loadFile("tests.js");

// ---- report results to stdout ----
const passed = _results.filter(r => r.pass).length;
const failed = _results.filter(r => !r.pass).length;
console.log("\n=== SPACE Test Suite Results ===");
console.log(passed + " passed, " + failed + " failed\n");
for (const r of _results) {
  const marker = r.pass ? "PASS" : "FAIL";
  const detail = r.detail ? "  [" + r.detail + "]" : "";
  console.log(marker + "  " + r.name + detail);
}
process.exit(failed > 0 ? 1 : 0);
