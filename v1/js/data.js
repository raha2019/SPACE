"use strict";
/* =================================================================
   INVENTION STUDIO LAYOUT RISK SIMULATOR — vanilla JS
   -----------------------------------------------------------------
   v1 starts EMPTY: ZONE_DEFS, PRESETS, and REGIONS are populated at
   runtime by importing an elements-bundle JSON (see default-elements.json
   in this folder, and the elements-bundle handling in controls.js).
   ================================================================= */

/* ------------------------------------------------------------------
   1. ZONE CATALOG
       Mutated in place by applyElementsBundle() in controls.js.
       Always declared as a const array so other modules can hold a
       stable reference; populate with .push(...newDefs).
   ------------------------------------------------------------------ */
const ZONE_DEFS = [];

const RISK_TAGS = { 0:"—", 1:"Low", 2:"Mod", 3:"Mod-Hi", 4:"High", 5:"V.High" };

/* ------------------------------------------------------------------
   2. LAYOUT PRESETS
       Empty stubs so loadPreset(name) doesn't crash before an
       elements bundle is imported. applyElementsBundle() replaces
       the contents in place (Object.assign after deleting old keys).
   ------------------------------------------------------------------ */
const PRESETS = {
  current: { name: "Empty",       zones: {} },
  altA:    { name: "Empty Alt A", zones: {} },
  altB:    { name: "Empty Alt B", zones: {} },
};

/* ------------------------------------------------------------------
   3. REGION SHADES — populated by applyElementsBundle().
   ------------------------------------------------------------------ */
const REGIONS = [];

const METRIC_DEFS = [
  { id:"congestion",   label:"Congestion & Pathway Flow",            weight:0.20 },
  { id:"safety",       label:"Safety Behavior Risk",                 weight:0.20 },
  { id:"toolRisk",     label:"Tool Risk & Supervision",              weight:0.15 },
  { id:"access",       label:"Accessibility Quality",                weight:0.15 },
  { id:"workflow",     label:"Workflow Adjacency & Travel Efficiency",weight:0.15 },
  { id:"flex",         label:"Flexibility & Future Adaptability",    weight:0.10 },
  { id:"beginner",     label:"Beginner Approachability",             weight:0.05 },
];
