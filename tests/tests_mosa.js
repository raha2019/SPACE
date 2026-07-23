"use strict";
/* ------------------------------------------------------------------
   Unit tests for sim_mosa.js (mosaOptimize, _mosaArchiveInsert,
   _mosaSampleWeights).

   Requires the following globals to be defined before this file runs:
     evalDominates, evaluateLayout    (from sim_eval.js)
     mosaOptimize, _mosaArchiveInsert,
     _mosaSampleWeights               (from sim_mosa.js)
     state, ZONE_DEFS, allZoneDefs,
     stageDimsUnits, _resetState,
     _addZone                         (state stubs)
     test, renderResults              (test runner)
     overlapArea, clamp               (math helpers)

   Browser: open tests/index_mosa.html (loads all deps then this file).
   Node:    run tests/run_mosa_tests.mjs.
   ------------------------------------------------------------------ */

// ---------------------------------------------------------------------------
// Test 1: _mosaSampleWeights returns a valid point on the 3-simplex.
// ---------------------------------------------------------------------------

test("MOSA: _mosaSampleWeights returns valid simplex point (50 samples)", () => {
  let allValid = true;
  for (let i = 0; i < 50; i++) {
    const w = _mosaSampleWeights();
    const nonNeg = w[0] >= 0 && w[1] >= 0 && w[2] >= 0;
    const sumsToOne = Math.abs(w[0] + w[1] + w[2] - 1) < 1e-9;
    if (!nonNeg || !sumsToOne) { allValid = false; break; }
  }
  return {
    pass: allValid,
    detail: "50 calls: all weights non-negative and summing to 1.0",
  };
});

// ---------------------------------------------------------------------------
// Test 2: _mosaArchiveInsert correctly rejects dominated vectors and evicts
// members the new candidate dominates.
// ---------------------------------------------------------------------------

test("MOSA: _mosaArchiveInsert rejects dominated vectors and evicts dominated members", () => {
  const ar = [];

  // A = (0.5, 0.5, 0.5): added (archive was empty).
  const r1 = _mosaArchiveInsert(ar, {}, { ada: 0.5, egress: 0.5, noise: 0.5 });

  // B = (0.3, 0.7, 0.5): trade-off with A (better ada, worse egress) -- added.
  const r2 = _mosaArchiveInsert(ar, {}, { ada: 0.3, egress: 0.7, noise: 0.5 });

  // D = (0.8, 0.8, 0.8): dominated by A and B -- should be rejected (r3 === false).
  const r3 = _mosaArchiveInsert(ar, {}, { ada: 0.8, egress: 0.8, noise: 0.8 });

  // Z = (0.1, 0.1, 0.1): dominates A and B -- should evict both, archive size -> 1.
  _mosaArchiveInsert(ar, {}, { ada: 0.1, egress: 0.1, noise: 0.1 });

  let noInternal = true;
  for (let i = 0; i < ar.length; i++) {
    for (let j = 0; j < ar.length; j++) {
      if (i !== j && evalDominates(ar[i].vec, ar[j].vec)) noInternal = false;
    }
  }

  return {
    pass: r1 && r2 && !r3 && ar.length === 1 && noInternal,
    detail:
      "r1=" + r1 + " r2=" + r2 + " dominated_rejected=" + !r3 +
      " size=" + ar.length + " noInternal=" + noInternal,
  };
});

// ---------------------------------------------------------------------------
// Test 3: mosaOptimize returns a well-formed {front, seedVec, stats} object
// and the loop actually runs (accepted + rejected + infeasible > 0).
// ---------------------------------------------------------------------------

test("MOSA: mosaOptimize returns {front, seedVec, stats} with valid fields", () => {
  _resetState();

  // Minimal layout: one exit (fixed anchor) and two movable tools.
  _addZone(
    { id: "exit1", cat: "exit" },
    { x: 88, y: 38, w: 7, h: 24 }
  );
  _addZone(
    { id: "t1", cat: "tool", dba_active: 80, schedule_prob: 0.7 },
    { x: 10, y: 20, w: 10, h: 10 }
  );
  _addZone(
    { id: "t2", cat: "tool", dba_active: 75, schedule_prob: 0.5 },
    { x: 50, y: 50, w: 10, h: 10 }
  );

  const result = mosaOptimize({ movableIds: ["t1", "t2"], iters: 150 });

  const hasFront   = Array.isArray(result.front);
  const hasStats   = result.stats && typeof result.stats.iters === "number";
  const hasSeed    = result.seedVec &&
    ["ada", "egress", "noise"].every(k => typeof result.seedVec[k] === "number");
  const seedRange  = hasSeed &&
    ["ada", "egress", "noise"].every(k => result.seedVec[k] >= 0 && result.seedVec[k] <= 1);
  const didWork    = hasStats &&
    (result.stats.accepted + result.stats.rejected + result.stats.infeasible > 0);

  return {
    pass: hasFront && hasStats && hasSeed && seedRange && didWork,
    detail:
      "front.length=" + (hasFront ? result.front.length : "?") +
      " iters=" + (hasStats ? result.stats.iters : "?") +
      " accepted=" + (hasStats ? result.stats.accepted : "?") +
      " seedVec=(" + (hasSeed
        ? result.seedVec.ada.toFixed(3) + "," +
          result.seedVec.egress.toFixed(3) + "," +
          result.seedVec.noise.toFixed(3)
        : "?") + ")",
  };
});

// ---------------------------------------------------------------------------
// Test 4: the returned front satisfies the archive non-domination invariant,
// every pos snapshot has plausible coordinates, and state.zones is restored
// to seed positions after mosaOptimize returns.
// ---------------------------------------------------------------------------

test("MOSA: front satisfies non-domination invariant and state is restored", () => {
  _resetState();

  _addZone(
    { id: "exit1", cat: "exit" },
    { x: 88, y: 38, w: 7, h: 24 }
  );
  _addZone(
    { id: "t1", cat: "tool", dba_active: 80, schedule_prob: 0.7 },
    { x: 10, y: 20, w: 10, h: 10 }
  );
  _addZone(
    { id: "t2", cat: "tool", dba_active: 75, schedule_prob: 0.5 },
    { x: 50, y: 50, w: 10, h: 10 }
  );

  const seedX = state.zones["t1"].x;
  const seedY = state.zones["t1"].y;

  const result = mosaOptimize({ movableIds: ["t1", "t2"], iters: 200 });

  // State restoration: t1 must be back at seed position.
  const t1Back =
    state.zones["t1"].x === seedX &&
    state.zones["t1"].y === seedY;

  if (!result.front || result.front.length === 0) {
    return {
      pass: false,
      detail: "front is empty -- no feasible solutions found. state_restored=" + t1Back,
    };
  }

  // Non-domination invariant: no front[i] dominates front[j] for i !== j.
  let noInternal = true;
  outer: for (let i = 0; i < result.front.length; i++) {
    for (let j = 0; j < result.front.length; j++) {
      if (i !== j && evalDominates(result.front[i].vec, result.front[j].vec)) {
        noInternal = false;
        break outer;
      }
    }
  }

  // Position validity: each pos snapshot value should be a number.
  let posValid = true;
  for (const pt of result.front) {
    if (!pt.pos) { posValid = false; break; }
    for (const id in pt.pos) {
      const z = pt.pos[id];
      if (typeof z.x !== "number" || typeof z.y !== "number") { posValid = false; break; }
    }
    if (!posValid) break;
  }

  return {
    pass: noInternal && posValid && t1Back,
    detail:
      "front.length=" + result.front.length +
      " noInternal=" + noInternal +
      " posValid=" + posValid +
      " state_restored=" + t1Back,
  };
});

// ---------------------------------------------------------------------------
// Render results (must be called after all tests are registered).
// ---------------------------------------------------------------------------

renderResults();
