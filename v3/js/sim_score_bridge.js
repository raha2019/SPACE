"use strict";
/* ------------------------------------------------------------------
   SIMULATION SCORE BRIDGE
   Maps the latest sim run results to advisory score penalty values.

   This file is the canonical reference for the bridge API. Because no
   <script> tag can be added to index.html without touching Rahul's
   code, the cache object and getSimScoreContribution() are inlined
   verbatim at the top of sim_ui.js. If a script tag for this file is
   ever added, it will redefine the same globals — the behavior is
   identical either way.

   Cache schema (each sim module writes here after a successful run):
     _simResultCache.ada    = { corr: { free, fail, marginal }, doors: [] }
     _simResultCache.egress = { occupants, exitCap: { capacity, exitCount,
                                totalWidthIn }, maxTravel, deadEnd }
     _simResultCache.noise  = { maxDb, meanDb, actionCells, pelCells,
                                totalCells, sources }

   Penalty ranges:
     ADA     0–15 pts  (scaled from % of walkable area failing corridor check)
     Egress  0–15 pts  (travel distance + exit capacity shortfall)
     Noise   0–10 pts  (% of space above action level and PEL)
     Total   0–40 pts  (advisory; does NOT modify scoring.js score)
   ------------------------------------------------------------------ */

const _simResultCache = {
  ada:    null,
  egress: null,
  noise:  null,
};

/* Returns an advisory penalty breakdown based on the most recent sim
   results stored in _simResultCache. Returns zeros and "not run yet"
   messages for any sim that has not been executed.             */
function getSimScoreContribution() {
  let adaPenalty = 0, egressPenalty = 0, noisePenalty = 0;
  const details = {
    ada:    "No ADA check run yet.",
    egress: "No egress check run yet.",
    noise:  "No noise check run yet.",
  };

  // ---- ADA penalty (0–15)
  // Scales linearly with fraction of walkable area failing the 36-in
  // corridor width check. Each door below minimum adds 2 pts.
  const ada = _simResultCache.ada;
  if (ada) {
    const failFrac = ada.corr.free > 0 ? ada.corr.fail / ada.corr.free : 0;
    adaPenalty = Math.min(15, Math.round(failFrac * 15));
    if (ada.doors.length > 0) adaPenalty = Math.min(15, adaPenalty + ada.doors.length * 2);
    if (failFrac > 0) {
      details.ada = (failFrac * 100).toFixed(1) + "% of walkable area fails corridor width check.";
    } else if (ada.doors.length > 0) {
      details.ada = ada.doors.length + " door(s) below ADA minimum width.";
    } else {
      details.ada = "No corridor or door violations detected.";
    }
  }

  // ---- Egress penalty (0–15)
  // Travel distance: 0 pts if <= 100 ft, scales to 10 pts at the NFPA
  // 200-ft limit and beyond. Exit capacity shortfall adds up to 5 pts.
  const egress = _simResultCache.egress;
  if (egress) {
    let travelPenalty = 0;
    if (egress.maxTravel > 100) {
      travelPenalty = Math.min(10, Math.round((egress.maxTravel - 100) / 100 * 10));
    }
    const shortfall = Math.max(0, egress.occupants - egress.exitCap.capacity);
    const capacityPenalty = shortfall > 0 ? Math.min(5, Math.ceil(shortfall / 10)) : 0;
    egressPenalty = Math.min(15, travelPenalty + capacityPenalty);
    const parts = [];
    if (egress.maxTravel > 100) parts.push("max travel " + egress.maxTravel.toFixed(0) + " ft (limit 200 ft)");
    if (shortfall > 0) parts.push("exit capacity short by " + shortfall + " persons");
    details.egress = parts.length > 0 ? parts.join("; ") + "." : "Travel distance and exit capacity acceptable.";
  }

  // ---- Noise penalty (0–10)
  // 5 pts from fraction above action level (85 dBA), 10 pts from
  // fraction above PEL (90 dBA), summed and capped at 10.
  const noise = _simResultCache.noise;
  if (noise && noise.totalCells > 0) {
    const actionFrac = noise.actionCells / noise.totalCells;
    const pelFrac    = noise.pelCells    / noise.totalCells;
    noisePenalty = Math.min(10, Math.round(actionFrac * 5 + pelFrac * 10));
    details.noise = (actionFrac * 100).toFixed(1) + "% of space above action level; " +
                    (pelFrac * 100).toFixed(1) + "% above PEL.";
  }

  return {
    adaPenalty,
    egressPenalty,
    noisePenalty,
    totalPenalty: adaPenalty + egressPenalty + noisePenalty,
    details,
  };
}
