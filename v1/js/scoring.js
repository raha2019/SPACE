"use strict";
/* ------------------------------------------------------------------
   9. EVALUATION — feasibility flags + weighted metrics + score
   ------------------------------------------------------------------ */
function evaluate(){
  // No elements loaded yet → nothing to score. Reset to defaults.
  const _allDefs = allZoneDefs();
  if(!_allDefs.length || !Object.keys(state.zones).length){
    state.flags = [];
    state.metrics = {};
    state.score = null;
    state.gate = "—";
    return;
  }
  // Scoring rules reference a handful of well-known zone ids (asm1, exitN,
  // mainDesk, corridor, …). When the user's bundle doesn't include one of
  // them, we want to degrade gracefully instead of throwing — otherwise an
  // exception here blocks the downstream render() and the UI freezes.
  // Start from a clean flag list every run so a mid-body throw can't leave
  // stale flags from the previous evaluation lingering in state.
  state.flags = [];
  try { _evaluateBody(_allDefs); }
  catch(e){
    console.warn("[evaluate] scoring rule threw — partial result kept.", e);
    if(!Array.isArray(state.flags)) state.flags = [];
    if(!state.metrics || typeof state.metrics !== "object") state.metrics = {};
    if(state.score == null) state.score = null;
    if(!state.gate) state.gate = "—";
  }
  // PPE / required-safety-practices flags run independently of the main
  // scoring body so they always surface, even if a layout-specific rule
  // above threw. (Deeper PPE→score weighting is wired up with analysis later.)
  try { _appendPpeFlags(_allDefs); }
  catch(e){ console.warn("[evaluate] PPE pass threw.", e); }
}

/* Flag higher-risk custom tools that declare no required PPE or safety
   practices, so their safety requirements are captured and visible. */
function _appendPpeFlags(allDefs){
  if(!Array.isArray(state.flags)) state.flags = [];
  const Z = state.zones || {};
  const isIncluded = id => !Z[id] || Z[id].included !== false;
  for(const d of allDefs){
    if(!d || !d.custom || !d.variableAttrs) continue;   // tool-type custom elements only
    if(!isIncluded(d.id)) continue;
    const va = d.variableAttrs;
    const ppe = Array.isArray(va.ppe) ? va.ppe : [];
    const practices = (va.safetyPractices || "").trim();
    const hiRisk = (d.risk >= 3) || (d.operationRisk >= 3);
    if(!(hiRisk && ppe.length === 0 && !practices)) continue;
    const key = `ppe-missing-${d.id}`;
    if(state.flags.some(f => f.key === key)) continue;
    const severity = (d.risk >= 4 || d.operationRisk >= 4) ? "warn" : "notice";
    state.flags.push({
      severity, key,
      title: `No PPE / safety practices: ${d.label}`,
      why: `${d.label} is higher-risk (display risk ${d.risk}, operation risk ${d.operationRisk}) but lists no required PPE or safety practices, so its safety requirements aren't captured.`,
      fix: `Open ${d.label} in the Element Builder → Variable Attributes and specify the required PPE (e.g. eye / hearing protection) and any mandatory safety practices.`,
      zones: [d.id],
    });
  }
}

function _evaluateBody(_allDefs){
  const flags = [];
  const Z = state.zones;
  const defs = Object.fromEntries(_allDefs.map(d=>[d.id,d]));
  // Per-element activeUse OR the global activeUse drives expansion.
  const r = id => {
    const z = Z[id];
    const ae = state.activeUse || (z && z.activeUse);
    return effectiveRect(id, z, ae);
  };
  const isIncluded = id => !Z[id] || Z[id].included !== false;

  // ---- helpers
  function addFlag(severity, key, title, why, fix, zones){
    flags.push({ severity, key, title, why, fix, zones: zones || [] });
  }

  // ---------- 1. Object overlap
  const movable = allZoneDefs().filter(d=>!d.fixed && d.cat!=="corridor" && d.cat!=="open" && isIncluded(d.id));
  for(let i=0;i<movable.length;i++){
    for(let j=i+1;j<movable.length;j++){
      const a=movable[i], b=movable[j];
      const oa = overlapArea(r(a.id), r(b.id));
      if(oa > 1.0){ // non-trivial overlap (in % units squared)
        const sev = (a.risk>=4 || b.risk>=4) ? "crit" : (oa>4 ? "warn" : "notice");
        addFlag(sev, `overlap-${a.id}-${b.id}`,
          `Overlap: ${a.label} ↔ ${b.label}`,
          `Zones overlap by ~${oa.toFixed(1)} sq-units. Overlapping footprints reduce safe working area and complicate supervision.`,
          `Separate ${a.label} and ${b.label} so their footprints (including chairs/carts in active-use) do not intersect.`,
          [a.id,b.id]);
      }
    }
  }

  // ---------- 2. Movable too close to emergency exits
  const exits = ["exitN","exitS"];
  for(const def of movable){
    for(const ex of exits){
      const d = rectDist(r(def.id), rect(Z[ex]));
      if(d < 3 || overlapArea(r(def.id), rect(Z[ex])) > 0){
        addFlag("crit", `exit-${def.id}-${ex}`,
          `Critical: ${def.label} blocks ${defs[ex].label}`,
          `Exit routes must stay clear during normal and active-use conditions. ${def.label} is ${d.toFixed(1)} units from the exit.`,
          `Move ${def.label} at least 6 units away from ${defs[ex].label}.`,
          [def.id, ex]);
      } else if(d < 6){
        addFlag("warn", `exit-near-${def.id}-${ex}`,
          `${def.label} crowds ${defs[ex].label}`,
          `${def.label} is close to an emergency exit (${d.toFixed(1)} units). Even modest crowding here is risky.`,
          `Increase clearance to ≥ 6 units from ${defs[ex].label}.`,
          [def.id, ex]);
      }
    }
  }

  // ---------- 3. High-risk tools too close to assembly / Craftland
  const beginnerCenters = ["asm1","asm2","craftland","xr"];
  const highRisk = allZoneDefs().filter(d=>d.risk>=4 && isIncluded(d.id));
  for(const hr of highRisk){
    for(const bg of beginnerCenters){
      const d = rectDist(r(hr.id), r(bg));
      const limit = hr.risk===5 ? 7 : 5;
      if(d < limit){
        const sev = hr.risk===5 && d<3 ? "crit" : "warn";
        addFlag(sev, `hr-${hr.id}-${bg}`,
          `${hr.label} too close to ${defs[bg].label}`,
          `High-risk tool (R${hr.risk}) is ${d.toFixed(1)} units from a beginner-facing zone. Sparks, fumes, debris, or noise can affect novice users.`,
          `Move ${hr.label} ≥ ${limit} units from ${defs[bg].label}, ideally toward the perimeter or behind a partition.`,
          [hr.id, bg]);
      }
    }
  }

  // ---------- 4. Craftland too far from entrance / not visible
  {
    const cl = r("craftland"), en = rect(Z.entrance);
    const d = rectDist(cl, en);
    if(d > 25){
      addFlag("warn","craftland-far",
        `Craftland is far from the entrance`,
        `Beginner-friendly zones should be visible/approachable from the entrance to encourage first-time visitors. Distance ≈ ${d.toFixed(0)} units.`,
        `Relocate Craftland closer to the front-of-house or improve sightlines from the Main Desk.`,
        ["craftland","entrance"]);
    } else if(d > 18){
      addFlag("notice","craftland-mid",
        `Craftland visibility could be improved`,
        `Craftland is ${d.toFixed(0)} units from the entrance — acceptable but not ideal for beginner approachability.`,
        `Consider a closer or more visible placement for Craftland.`,
        ["craftland","entrance"]);
    }
  }

  // ---------- 5. Assembly tables crowd main corridor / exits
  for(const t of ["asm1","asm2"]){
    const d = rectDist(r(t), rect(Z.corridor));
    if(d < 1 || overlapArea(r(t), rect(Z.corridor)) > 0){
      addFlag("warn", `asm-corr-${t}`,
        `${defs[t].label} crowds Main Corridor`,
        `Assembly footprint extends into the main corridor; users seated/standing here will reduce circulation width.`,
        `Pull ${defs[t].label} back so chairs and projects do not extend into the corridor.`,
        [t,"corridor"]);
    }
  }

  // ---------- 6. Connector corridor obstruction
  {
    const conn = rect(Z.connector);
    for(const def of movable){
      if(def.cat==="corridor" || def.cat==="open") continue;
      const oa = overlapArea(r(def.id), conn);
      if(oa > 1){
        const sev = def.risk >= 4 ? "crit" : "warn";
        addFlag(sev, `conn-${def.id}`,
          `Connector corridor blocked by ${def.label}`,
          `The middle connector links the dense left shop to the right-side area. Blockage harms accessibility and emergency flow (overlap ≈ ${oa.toFixed(1)}).`,
          `Move ${def.label} out of the connector. Maintain a clear vertical channel through the middle of the floor.`,
          [def.id,"connector"]);
      }
    }
  }

  // ---------- 7. Tight clustering in dense left shop
  {
    const leftShop = movable.filter(d=>{
      const z = Z[d.id]; return (z.x + z.w/2) < 52;
    });
    let clusterPairs = 0;
    for(let i=0;i<leftShop.length;i++){
      for(let j=i+1;j<leftShop.length;j++){
        if(rectDist(r(leftShop[i].id), r(leftShop[j].id)) < 1.5) clusterPairs++;
      }
    }
    if(clusterPairs >= 5){
      addFlag("warn","left-cluster",
        `Dense left-shop area is over-clustered`,
        `${clusterPairs} pairs of zones sit within 1.5 units of each other. Tight clustering harms accessibility, supervision, and circulation.`,
        `Spread zones out — keep ≥ 1.5 units between movable footprints in the left shop.`,
        leftShop.map(d=>d.id));
    } else if(clusterPairs >= 2){
      addFlag("notice","left-cluster-mild",
        `Some clustering in the left shop`,
        `${clusterPairs} adjacent zone pairs are tightly packed.`,
        `Inspect the densest cluster and slightly increase spacing.`,
        leftShop.map(d=>d.id));
    }
  }

  // ---------- 8. Active-use obstruction around tables
  if(state.activeUse){
    const tables = ["asm1","asm2","craftland","electronics"];
    for(const t of tables){
      const ex = effectiveRect(t, Z[t], true);
      const base = rect(Z[t]);
      const others = movable.filter(d=>d.id!==t);
      for(const o of others){
        const oa = overlapArea(ex, r(o.id));
        const baseOA = overlapArea(base, r(o.id));
        if(oa > 1 && baseOA < 0.2){
          addFlag("warn",`active-${t}-${o.id}`,
            `Active-Use footprint of ${defs[t].label} touches ${o.label}`,
            `In active use, ${defs[t].label} expands (chairs, carts, materials) and intrudes on ${o.label}. This causes pathway/working-area obstruction.`,
            `Add ≥ 2 units of buffer around ${defs[t].label}, or relocate ${o.label}.`,
            [t,o.id]);
        }
      }
    }
  }

  // ---------- 9. Accessibility — narrow circulation gaps near corridor
  {
    const corr = rect(Z.corridor);
    let tight = 0;
    for(const def of movable){
      const d = rectDist(r(def.id), corr);
      if(d < 1.5 && def.id!=="corridor") tight++;
    }
    if(tight >= 4){
      addFlag("warn","access-gaps",
        `Major circulation gaps may be too narrow`,
        `${tight} zones sit almost flush with the main corridor. Wheelchair / cart pathway clearance may be inadequate.`,
        `Maintain ≥ 1.5 units of clear space along the main corridor on both sides.`,
        ["corridor"]);
    }
  }

  // ---------- 10. Emergency path obstruction
  //   Realistic egress proxy: the corridor + connector form the
  //   primary egress channel. Flag movable zones that overlap them
  //   OR sit in the direct horizontal band between entrance and an
  //   exit (a thin band, not the full diagonal of the floor).
  {
    const en = rect(Z.entrance);
    const conn = rect(Z.connector);
    const corr = rect(Z.corridor);
    for(const exId of ["exitN","exitS"]){
      const exR = rect(Z[exId]);
      // Define an egress band: from the connector to the exit (right side),
      // hugging the exit's vertical position. ~6% tall band horizontally.
      const bandY1 = Math.min(exR.y1, exR.cy-3);
      const bandY2 = Math.max(exR.y2, exR.cy+3);
      const band = { x1: conn.cx-2, y1: bandY1, x2: exR.x1, y2: bandY2 };
      if(band.x2 <= band.x1) continue;
      for(const def of movable){
        const oa = overlapArea(r(def.id), band);
        if(oa > 0.6){
          const sev = def.risk>=4 ? "crit" : "warn";
          addFlag(sev, `egress-${def.id}-${exId}`,
            `Egress path to ${defs[exId].label} obstructed by ${def.label}`,
            `${def.label} intrudes on the direct egress band leading to ${defs[exId].label} (overlap ≈ ${oa.toFixed(1)}). This route should remain clear during normal and active-use conditions.`,
            `Move ${def.label} out of the horizontal corridor leading to ${defs[exId].label}.`,
            [def.id, exId]);
        }
      }
    }
    // Also: any movable zone fully blocking the connector centerline
    // is already handled by check (6); we keep that as the main metric.
  }

  // ---------- 11. High-risk tools in low-visibility / high-traffic areas
  {
    for(const hr of highRisk){
      const c = rect(Z[hr.id]);
      const cor = rect(Z.corridor);
      const d = rectDist(c, cor);
      if(d < 2.5){
        addFlag("warn",`hr-traffic-${hr.id}`,
          `${hr.label} sits in a high-traffic zone`,
          `High-risk tools placed adjacent to the main corridor mix bystanders with hazardous operations.`,
          `Move ${hr.label} away from the main corridor, ideally to a perimeter alcove or partitioned room.`,
          [hr.id,"corridor"]);
      }
    }
  }

  state.flags = dedupeFlags(flags);

  // ---------- METRICS (1..5)
  const m = computeMetrics();
  state.metrics = m;

  // ---------- SCORE
  let raw = 0;
  for(const md of METRIC_DEFS){
    // 1 -> 20%, 5 -> 100%; use (m-1)/4 -> 0..1 mapped to 20..100.
    const norm = ((m[md.id]-1)/4) * 80 + 20;
    raw += norm * md.weight;
  }
  // Apply traffic multiplier on congestion-related portion
  const trafficPenalty = state.trafficMode==="peak" ? 6 : (state.trafficMode==="summer" ? -2 : 0);
  raw -= trafficPenalty;
  if(state.activeUse) raw -= 3;

  // Flag penalties
  const cnt = countFlags();
  raw -= cnt.crit * 12;
  raw -= cnt.warn * 4;
  raw -= cnt.notice * 1;

  state.score = clamp(Math.round(raw), 0, 100);

  // ---------- GATE
  if(cnt.crit > 0) state.gate = "fail";
  else if(cnt.warn > 2) state.gate = "warn";
  else if(cnt.warn > 0 || cnt.notice > 2) state.gate = "warn";
  else state.gate = "pass";
}

function dedupeFlags(arr){
  const seen = new Set();
  const out = [];
  for(const f of arr){
    if(seen.has(f.key)) continue;
    seen.add(f.key);
    out.push(f);
  }
  // Sort: crit > warn > notice
  const order = {crit:0,warn:1,notice:2};
  out.sort((a,b)=>order[a.severity]-order[b.severity]);
  return out;
}
function countFlags(){
  const c = {crit:0,warn:0,notice:0};
  state.flags.forEach(f=>c[f.severity]++);
  return c;
}

/* ---- METRICS computation: heuristics from layout state ---- */
function computeMetrics(){
  const Z = state.zones;
  const defs = Object.fromEntries(allZoneDefs().map(d=>[d.id,d]));
  const r = id => effectiveRect(id, Z[id], state.activeUse);
  const cnt = (function(){
    const c = {crit:0,warn:0,notice:0};
    state.flags.forEach(f=>c[f.severity]++);
    return c;
  })();

  // CONGESTION: penalize blocked corridor + tight cluster + traffic mode
  let congestion = 5;
  if(state.flags.find(f=>f.key.startsWith("conn-"))) congestion -= 1.5;
  if(state.flags.find(f=>f.key==="left-cluster")) congestion -= 1.2;
  if(state.flags.find(f=>f.key==="left-cluster-mild")) congestion -= 0.5;
  if(state.flags.find(f=>f.key.startsWith("asm-corr-"))) congestion -= 0.7;
  if(state.trafficMode==="peak") congestion -= 0.8;
  if(state.trafficMode==="summer") congestion += 0.3;
  if(state.activeUse) congestion -= 0.6;

  // SAFETY: emergency / overlap / hr near beginner
  let safety = 5;
  state.flags.forEach(f=>{
    if(f.key.startsWith("exit-") || f.key.startsWith("egress-")) safety -= f.severity==="crit"? 1.6 : 0.8;
    if(f.key.startsWith("overlap-")) safety -= f.severity==="crit"? 1.0 : 0.4;
    if(f.key.startsWith("hr-") && !f.key.startsWith("hr-traffic-")) safety -= 0.6;
  });

  // TOOL RISK & SUPERVISION: line of sight from main desk to high-risk
  const md = rect(Z.mainDesk);
  let supervisionPenalty = 0;
  for(const d of allZoneDefs().filter(d=>d.risk>=3 && (Z[d.id] && Z[d.id].included !== false))){
    const z = rect(Z[d.id]);
    const distMD = dist(md.cx,md.cy, z.cx,z.cy);
    if(distMD > 55) supervisionPenalty += 0.25;
  }
  let toolRisk = clamp(5 - supervisionPenalty - state.flags.filter(f=>f.key.startsWith("hr-traffic-")).length*0.6, 1, 5);

  // ACCESSIBILITY: corridor crowding + circulation gaps
  let access = 5;
  if(state.flags.find(f=>f.key==="access-gaps")) access -= 1.2;
  state.flags.filter(f=>f.key.startsWith("conn-")).forEach(_=>access-=0.6);
  state.flags.filter(f=>f.key.startsWith("asm-corr-")).forEach(_=>access-=0.4);

  // WORKFLOW ADJACENCY: assembly should be near 3D printing, electronics, storage
  let workflow = 5;
  const adj = (a,b,limit)=> rectDist(rect(Z[a]),rect(Z[b])) <= limit;
  if(!adj("asm1","print3d",30) && !adj("asm2","print3d",30)) workflow -= 0.7;
  if(!adj("asm1","electronics",30) && !adj("asm2","electronics",30)) workflow -= 0.7;
  if(!adj("asm1","storage",40) && !adj("asm2","storage",40)) workflow -= 0.4;
  // Reward grouping high-risk near each other (efficient ventilation/PPE)
  const hrIds = ["welding","waterjet","metal","wood","cnc","laser"];
  let hrPair=0;
  for(let i=0;i<hrIds.length;i++)for(let j=i+1;j<hrIds.length;j++){
    if(rectDist(rect(Z[hrIds[i]]),rect(Z[hrIds[j]])) < 14) hrPair++;
  }
  workflow += clamp(hrPair*0.05, 0, 0.4);

  // FLEXIBILITY: more open right-area + fewer wall-locked footprints = better flex
  let flex = 4;
  // Reward: asm tables not pinned to a wall
  ["asm1","asm2"].forEach(id=>{
    const z = Z[id];
    if(z.x>3 && z.y>3 && (z.x+z.w)<97 && (z.y+z.h)<97) flex += 0.3;
  });
  // Penalize crit overlaps
  if(cnt.crit>0) flex -= 1.0;

  // BEGINNER APPROACHABILITY: craftland near entrance + assembly visible from desk
  let beginner = 5;
  const cd = rectDist(rect(Z.craftland), rect(Z.entrance));
  if(cd > 28) beginner -= 1.5;
  else if(cd > 20) beginner -= 0.7;
  // Assembly visible (close-ish) to main desk
  const asmD = Math.min(
    rectDist(rect(Z.asm1), rect(Z.mainDesk)),
    rectDist(rect(Z.asm2), rect(Z.mainDesk)),
  );
  if(asmD > 28) beginner -= 0.6;
  // High-risk shouldn't dominate the front
  for(const d of allZoneDefs().filter(d=>d.risk>=4 && (Z[d.id] && Z[d.id].included !== false))){
    const z = Z[d.id];
    if(z.x < 25 && z.y > 50) beginner -= 0.5;
  }

  return {
    congestion: clamp(+congestion.toFixed(2), 1, 5),
    safety:     clamp(+safety.toFixed(2),     1, 5),
    toolRisk:   clamp(+toolRisk.toFixed(2),   1, 5),
    access:     clamp(+access.toFixed(2),     1, 5),
    workflow:   clamp(+workflow.toFixed(2),   1, 5),
    flex:       clamp(+flex.toFixed(2),       1, 5),
    beginner:   clamp(+beginner.toFixed(2),   1, 5),
  };
}
