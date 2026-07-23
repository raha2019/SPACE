"use strict";
/**
 * v2/engine-adapter.browser.js  --  THE SEAM (browser execution half).
 *
 * Classic (non-module) script for the live app. The v1 engine's `state`,
 * `ZONE_DEFS`, `evaluateLayout`, and `mosaOptimize` are page globals declared
 * by non-module <script> tags, so this file is ALSO a classic script (an ES
 * module could not see those lexical globals).
 *
 * It reuses the exact same translation logic as the Node adapter: load
 * `v2/project-to-engine.mjs` first (as a module — it publishes
 * `globalThis.SPACE_V2 = { translateProject, applyTranslated }`), then load this
 * file. One translation code path, two environments.
 *
 * Load order in index.html (after the engine scripts):
 *   <script type="module" src="v2/project-to-engine.mjs"></script>
 *   <script src="v2/engine-adapter.browser.js"></script>
 *
 * Public global:
 *   spaceV2ApplyProject(project)          -> movableIds  (mutates window.state / ZONE_DEFS)
 *   spaceV2RunProject(project, opts?)      -> { seedVec, front, frontLength, dominatingCount, stats }
 *
 * NOTE: like the interactive app, a browser MOSA run is only deterministic if a
 * seed is provided; pass opts.seed (or set state.mosaSeed) to reproduce a pin.
 */
(function (global) {
  function requireSeam() {
    var seam = global.SPACE_V2;
    if (!seam || typeof seam.translateProject !== "function" ||
        typeof seam.applyTranslated !== "function") {
      throw new Error(
        "SPACE_V2 seam not loaded. Include " +
        "<script type=\"module\" src=\"v2/project-to-engine.mjs\"></script> before this file.");
    }
    return seam;
  }

  function requireEngine() {
    if (typeof state === "undefined" || typeof ZONE_DEFS === "undefined" ||
        typeof mosaOptimize !== "function" || typeof evaluateLayout !== "function") {
      throw new Error("v1 engine globals (state, ZONE_DEFS, mosaOptimize, evaluateLayout) not present.");
    }
  }

  /** Translate a project and apply it to the live engine state. Returns movableIds. */
  function spaceV2ApplyProject(project) {
    var seam = requireSeam();
    requireEngine();
    var t = seam.translateProject(project);
    // `state` and `ZONE_DEFS` are page globals; applyTranslated mutates them in place.
    seam.applyTranslated(state, ZONE_DEFS, t);
    return t.movableIds.slice();
  }

  /** Apply + run MOSA through the unmodified engine. opts: { seed?, iters? }. */
  function spaceV2RunProject(project, opts) {
    opts = opts || {};
    var movableIds = spaceV2ApplyProject(project);
    var mosaOpts = { movableIds: movableIds };
    var iters = opts.iters != null ? opts.iters
      : (project.optimization && project.optimization.iters);
    if (typeof iters === "number" && iters > 0) mosaOpts.iters = iters;
    var seed = opts.seed != null ? opts.seed
      : (project.optimization && project.optimization.seed);
    if (seed != null) {
      // mosaOptimize seeds Math.random internally from opts.seed (Mulberry32),
      // for the whole search — the reproducible path.
      mosaOpts.seed = (typeof seed === "string" && seed.toLowerCase().indexOf("0x") === 0)
        ? parseInt(seed, 16) : (typeof seed === "string" ? parseInt(seed, 10) : seed);
    }
    var r = mosaOptimize(mosaOpts);
    var dom = 0;
    for (var i = 0; i < r.front.length; i++) {
      if (evalDominates(r.front[i].vec, r.seedVec)) dom++;
    }
    return {
      seedVec: r.seedVec,
      front: r.front,
      frontLength: r.front.length,
      dominatingCount: dom,
      stats: r.stats,
    };
  }

  global.spaceV2ApplyProject = spaceV2ApplyProject;
  global.spaceV2RunProject = spaceV2RunProject;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
