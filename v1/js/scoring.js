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
  // Generic flags that work for any (custom/imported) layout.
  try { _appendGenericFlags(); }
  catch(e){ console.warn("[evaluate] generic flag pass threw.", e); }
  state.flags = dedupeFlags(state.flags);
}

/* Layout-agnostic flag rules: door blockage and the "vector reaches another
   tool's operator zone" failure mode. Safe on any layout. */
function _appendGenericFlags(){
  if(!Array.isArray(state.flags)) state.flags = [];
  const tools = _scTools();
  const doors = _scDoors();
  const r = id => _scRect(id);

  // Tool blocking / crowding a door or exit.
  for(const dr of doors){
    for(const t of tools){
      const d = rectDist(r(t.id), r(dr.id));
      const blocks = d < 1.5 || overlapArea(r(t.id), r(dr.id)) > 0.5;
      if(blocks){
        const sev = t.risk >= 4 ? "crit" : "warn";
        state.flags.push({ severity: sev, key:`door-block-${t.id}-${dr.id}`,
          title:`${t.label} blocks ${dr.label}`,
          why:`${t.label} sits in/at the doorway of ${dr.label}, obstructing egress and accessibility.`,
          fix:`Move ${t.label} clear of ${dr.label} (keep ≥ a person-width of clearance).`,
          zones:[t.id, dr.id] });
      } else if(d < 5){
        state.flags.push({ severity:"notice", key:`door-near-${t.id}-${dr.id}`,
          title:`${t.label} crowds ${dr.label}`,
          why:`${t.label} is close to ${dr.label}; circulation through the door may be tight.`,
          fix:`Increase clearance around ${dr.label}.`,
          zones:[t.id, dr.id] });
      }
    }
  }

  // Kickback / material vector reaching another tool's operator zone.
  for(const c of _scVectorConflicts()){
    state.flags.push({ severity:"warn", key:`vec-${c.kind}-${c.from.id}-${c.to.id}`,
      title:`${c.from.label} ${c.kind} reaches ${c.to.label}'s operator zone`,
      why:`The ${c.kind} path of ${c.from.label} sweeps through where an operator stands at ${c.to.label}. Someone working at ${c.to.label} could be struck by ${c.kind === "kickback" ? "kickback/debris" : "material being fed"} from ${c.from.label}.`,
      fix:`Rotate or relocate ${c.from.label} so its ${c.kind} vector points away from ${c.to.label}'s operator footprint, or move ${c.to.label}.`,
      zones:[c.from.id, c.to.id] });
  }
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

  // The detailed rules below reference the built-in Invention Studio layout's
  // named zones (asm1, corridor, exitN, …). On a custom/imported layout those
  // are absent — and rect(undefined) returns a far-off degenerate rect, so two
  // missing zones look "coincident" and misfire (then crash on defs[id].label).
  // Run the generic overlap check always; gate the named-zone rules behind this.
  const _isDefaultLayout = !!(Z.mainDesk && Z.corridor && Z.asm1);

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

  if(_isDefaultLayout){
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
  } // end _isDefaultLayout

  state.flags = dedupeFlags(flags);

  // ---------- METRICS (1..5)
  const m = computeMetrics();
  state.metrics = m;

  // ---------- SCORE
  let raw = 0;
  // Weights are normalized by their total so user-edited preference weights
  // (which need not sum to 100%) keep the score on the same 20..100 scale.
  const _wTotal = (typeof metricWeightTotal === "function") ? metricWeightTotal() : 1;
  for(const md of METRIC_DEFS){
    // 1 -> 20%, 5 -> 100%; use (m-1)/4 -> 0..1 mapped to 20..100.
    const norm = ((m[md.id]-1)/4) * 80 + 20;
    const w = (typeof metricWeight === "function") ? metricWeight(md.id) : md.weight;
    raw += norm * (w / _wTotal);
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

/* ==================================================================
   GENERIC LAYOUT ANALYSIS HELPERS
   These work for ANY layout (custom/imported), not just the built-in
   Invention Studio default. Used by the generic metrics + flag rules.
   ================================================================== */
function _scIncluded(){
  return allZoneDefs().filter(d => { const z = state.zones[d.id]; return z && z.included !== false; });
}
function _scIsStructural(d){ return d.elementClass === "structural"; }
function _scIsAmenity(d){ return d.elementClass === "amenity"; }
// True if an element's center is within the active analysis room scope.
function _scInScope(d){
  if(typeof pointInAnalysisScope !== "function") return true;
  const z = state.zones[d.id]; if(!z) return false;
  return pointInAnalysisScope(z.x + z.w/2, z.y + z.h/2);
}
// "Tools" = movable, non-structural, non-amenity working elements, within scope.
function _scTools(){
  return _scIncluded().filter(d => !d.fixed && !_scIsStructural(d) && !_scIsAmenity(d)
    && d.cat !== "corridor" && d.cat !== "open" && _scInScope(d));
}
function _scDoors(){
  return _scIncluded().filter(d =>
    (d.elementClass === "structural" && d.subtype === "door") ||
    d.cat === "exit" || d.cat === "structural-door" ||
    ["exitN","exitS","entrance"].includes(d.id));
}
function _scFloors(){ return _scIncluded().filter(d => d.elementClass === "structural" && d.subtype === "floor"); }
function _scRect(id){ const z = state.zones[id]; return effectiveRect(id, z, state.activeUse || (z && z.activeUse)); }
function _scNoPPE(d){
  const va = d.variableAttrs; if(!va) return false;
  const ppe = Array.isArray(va.ppe) ? va.ppe : [];
  return ppe.length === 0 && !((va.safetyPractices||"").trim());
}
function _scUsableArea(){
  const floors = _scFloors();
  if(!floors.length) return 100*100;             // whole stage if no rooms defined
  let a = 0; for(const f of floors){ const z = state.zones[f.id]; if(z) a += z.w * z.h; }
  return a > 0 ? a : 100*100;
}
/* World-space (stage %) centers of a tool's operator footprints, accounting
   for the element's offset, size, principal axis, and rotation. */
function _scRiskZoneCenters(def, kind){
  const z = state.zones[def.id]; if(!z) return [];
  const arr = (kind === "operator") ? (def.operatorFootprints || (def.operatorFootprint ? [def.operatorFootprint] : []))
                                    : (def[kind] || []);
  const cx = z.x + z.w/2, cy = z.y + z.h/2;
  const baseAngle = ((def.principalAxis && def.principalAxis.angle) || 0) + (z.rotation || 0);
  const a = baseAngle * Math.PI/180, cosA = Math.cos(a), sinA = Math.sin(a);
  const out = [];
  for(const e of arr){
    if(!e || e.type === "none" || e.type === "vector") continue;
    const ox = (e.offsetX || 0) * (z.w/100), oy = (e.offsetY || 0) * (z.h/100);
    out.push({ x: cx + (ox*cosA - oy*sinA), y: cy + (ox*sinA + oy*cosA) });
  }
  return out;
}
/* Detect kickback / material vectors of one tool whose cone reaches the
   operator footprint of ANOTHER tool — the "inadvertent risk" failure mode. */
function _scVectorConflicts(){
  const tools = _scTools();
  const conflicts = [];
  const inCone = (px,py, ox,oy, dirDeg, spreadDeg, len) => {
    const dx = px-ox, dy = py-oy, dd = Math.hypot(dx,dy);
    if(dd < 0.01 || dd > len) return false;
    const ang = Math.atan2(dy,dx) * 180/Math.PI;
    const diff = ((ang - dirDeg + 540) % 360) - 180;
    return Math.abs(diff) <= (spreadDeg + 6);
  };
  for(const A of tools){
    const za = state.zones[A.id]; if(!za) continue;
    const acx = za.x+za.w/2, acy = za.y+za.h/2;
    const baseA = ((A.principalAxis && A.principalAxis.angle)||0) + (za.rotation||0);
    const vecs = [].concat(A.kickbackVectors||[], A.materialVectors||[])
                   .filter(v => v && v.type === "vector");
    if(!vecs.length) continue;
    for(const v of vecs){
      const a = baseA*Math.PI/180, cosA=Math.cos(a), sinA=Math.sin(a);
      const ox=(v.offsetX||0)*(za.w/100), oy=(v.offsetY||0)*(za.h/100);
      const origX = acx + (ox*cosA - oy*sinA), origY = acy + (ox*sinA + oy*cosA);
      const dir = baseA + (v.angle||0);
      const spread = v.angleSpread !== undefined ? v.angleSpread : 12;
      const isKb = (A.kickbackVectors||[]).includes(v);
      for(const B of tools){
        if(B === A) continue;
        const opc = _scRiskZoneCenters(B, "operator");
        for(const p of opc){
          if(inCone(p.x,p.y, origX,origY, dir, spread, 45)){
            conflicts.push({ from:A, to:B, kind: isKb ? "kickback" : "material" });
            break;
          }
        }
      }
    }
  }
  return conflicts;
}

/* ---- METRICS computation: generic heuristics from layout state ---- */
function computeMetrics(){
  const Z = state.zones;
  const defs = Object.fromEntries(allZoneDefs().map(d=>[d.id,d]));
  const r = id => effectiveRect(id, Z[id], state.activeUse);
  // Generic path for custom/imported layouts (no built-in named zones).
  if(!Z.mainDesk || !Z.corridor || !Z.asm1){
    return _computeMetricsGeneric();
  }
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

/* Generic metrics for ANY layout — derived from element geometry, risk,
   doors, rooms, and vector conflicts rather than hard-coded zone ids. */
function _computeMetricsGeneric(){
  const Z = state.zones;
  const tools  = _scTools();
  const doors  = _scDoors();
  const hr     = tools.filter(t => t.risk >= 4);
  const r      = id => _scRect(id);
  const N = tools.length;

  // occupancy density (footprint area / usable floor area)
  let occupied = 0; for(const t of tools){ const z = Z[t.id]; if(z) occupied += z.w*z.h; }
  const density = clamp(occupied / _scUsableArea(), 0, 1.2);

  // overlaps + clustering
  let overlapPairs = 0, critOverlap = 0, tightPairs = 0;
  for(let i=0;i<N;i++) for(let j=i+1;j<N;j++){
    const a = tools[i], b = tools[j];
    const oa = overlapArea(r(a.id), r(b.id));
    if(oa > 1){ overlapPairs++; if(a.risk>=4 || b.risk>=4) critOverlap++; }
    if(rectDist(r(a.id), r(b.id)) < 1.5) tightPairs++;
  }
  const vConflicts = _scVectorConflicts();
  const nearestDoor = id => doors.length ? Math.min(...doors.map(dr => rectDist(r(id), r(dr.id)))) : 25;

  // CONGESTION — free space, clustering, overlaps, traffic
  let congestion = 5 - density*3.0 - tightPairs*0.25 - overlapPairs*0.3;
  if(state.trafficMode === "peak") congestion -= 0.8; else if(state.trafficMode === "summer") congestion += 0.3;
  if(state.activeUse) congestion -= 0.5;

  // SAFETY — overlaps, high-risk near low-risk, vector conflicts, missing PPE
  let safety = 5 - critOverlap*1.2 - (overlapPairs-critOverlap)*0.4 - vConflicts.length*0.6;
  for(const h of hr) for(const t of tools){
    if(t === h) continue;
    if(t.risk <= 1 && rectDist(r(h.id), r(t.id)) < 5) safety -= 0.3;
  }
  safety -= tools.filter(t => (t.risk>=3 || t.operationRisk>=3) && _scNoPPE(t)).length * 0.3;

  // TOOL RISK & SUPERVISION — high-risk tools far from a door/exit
  let toolRisk = 5;
  for(const t of tools.filter(t => t.risk >= 3)){
    const d = nearestDoor(t.id);
    if(d > 45) toolRisk -= 0.4; else if(d > 30) toolRisk -= 0.2;
  }

  // ACCESS — tools blocking doors/exits
  let access = 5;
  for(const dr of doors) for(const t of tools){
    const d = rectDist(r(t.id), r(dr.id));
    if(d < 2) access -= 0.8; else if(d < 5) access -= 0.3;
  }

  // WORKFLOW — related tools (same category) grouped together
  let workflow = 4;
  const byCat = {};
  for(const t of tools){ const c = t.cat || "_none"; (byCat[c] = byCat[c] || []).push(t); }
  let frac = 0, groups = 0;
  for(const c in byCat){
    const arr = byCat[c]; if(arr.length < 2) continue; groups++;
    let near = 0, pairs = 0;
    for(let i=0;i<arr.length;i++) for(let j=i+1;j<arr.length;j++){ pairs++; if(rectDist(r(arr[i].id), r(arr[j].id)) < 28) near++; }
    frac += pairs ? near/pairs : 0;
  }
  if(groups) workflow = 3 + 2*(frac/groups);

  // FLEXIBILITY — open floor ratio
  let flex = clamp(5*(1 - density), 1, 5);

  // BEGINNER APPROACHABILITY — high-risk away from doors, beginner tools near
  let beginner = 5;
  for(const h of hr){ if(nearestDoor(h.id) < 8) beginner -= 0.4; }
  for(const t of tools){ if(t.beginner && nearestDoor(t.id) > 40) beginner -= 0.3; }

  const out = { congestion, safety, toolRisk, access, workflow, flex, beginner };
  for(const k in out) out[k] = clamp(+(+out[k]).toFixed(2), 1, 5);
  return out;
}
