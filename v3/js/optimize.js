"use strict";
/* ==================================================================
   OPTIMIZE LAYOUT — constrained simulated annealing.
   Auto-arranges the included, non-fixed, in-scope (selected-room) tools to
   maximize the weighted score from evaluate(), subject to hard constraints:
     • footprint stays inside the analysis-scope room(s)
     • no overlap with walls / doors / fixed elements / other tools
   Seeds from the current layout, so it never starts from scratch, and asks
   for confirmation before committing (Reset Layout can still undo).
   Algorithm design: see IDEAS.md "D-OPT".
   ================================================================== */

function optimizeLayout(){
  if(typeof _scTools !== "function"){ alert("Optimizer unavailable."); return; }

  // Movable = included, non-fixed, in-scope tools that aren't locked.
  const movable = _scTools().filter(t => { const z = state.zones[t.id]; return z && !z.locked; });
  if(movable.length < 2){
    alert("Optimize Layout needs at least 2 movable, in-scope elements.\n\nMake sure the tools are inside the selected room, included, and unlocked.");
    return;
  }

  // Scope bounding box (selected rooms, else stage).
  const rooms = (typeof getAnalysisRooms === "function") ? getAnalysisRooms() : [];
  let bb = { x1:2, y1:2, x2:98, y2:98 };
  if(rooms.length){
    bb = { x1:Infinity, y1:Infinity, x2:-Infinity, y2:-Infinity };
    for(const f of rooms){
      const poly = roomPolygonPct(f); if(!poly) continue;
      for(const p of poly){ bb.x1=Math.min(bb.x1,p.x); bb.y1=Math.min(bb.y1,p.y); bb.x2=Math.max(bb.x2,p.x); bb.y2=Math.max(bb.y2,p.y); }
    }
  }
  const inScope = (x,y) => (typeof pointInAnalysisScope === "function") ? pointInAnalysisScope(x,y) : true;

  // Obstacles = included, non-floor elements that aren't the movable tools.
  const movableIds = new Set(movable.map(t => t.id));
  const obstacles = allZoneDefs().filter(d => {
    const z = state.zones[d.id]; if(!z || z.included === false) return false;
    if(d.elementClass === "structural" && d.subtype === "floor") return false;
    return !movableIds.has(d.id);
  });
  // Rotation-aware AABB (so non-square tools' real footprint is used).
  const rotAABB = z => {
    const a = (z.rotation||0)*Math.PI/180, c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
    const ew = z.w*c + z.h*s, eh = z.w*s + z.h*c;
    const cx = z.x + z.w/2, cy = z.y + z.h/2;
    return { x1:cx-ew/2, y1:cy-eh/2, x2:cx+ew/2, y2:cy+eh/2 };
  };
  const footInside = z => {
    const a = rotAABB(z), p = 0.3;
    return inScope(a.x1+p, a.y1+p) && inScope(a.x2-p, a.y1+p) &&
           inScope(a.x1+p, a.y2-p) && inScope(a.x2-p, a.y2-p) && inScope((a.x1+a.x2)/2, (a.y1+a.y2)/2);
  };
  const collides = (id, z) => {
    const ra = rotAABB(z);
    for(const o of obstacles){ const oz = state.zones[o.id]; if(oz && overlapArea(ra, rotAABB(oz)) > 0.3) return true; }
    for(const m of movable){ if(m.id === id) continue; const mz = state.zones[m.id]; if(mz && overlapArea(ra, rotAABB(mz)) > 0.3) return true; }
    return false;
  };
  // Operator + material-handling footprints must stay USABLE: their centers
  // should lie inside the room and not fall inside a wall/other element. Each
  // blocked footprint costs ACCESS_W objective points, so the optimizer keeps
  // them clear (and rotates tools to point them at free space).
  const ACCESS_W = 4;
  const inRect = (p, z) => p.x >= z.x && p.x <= z.x+z.w && p.y >= z.y && p.y <= z.y+z.h;
  const accessPenalty = () => {
    if(typeof _scRiskZoneCenters !== "function") return 0;
    let pen = 0;
    for(const t of movable){
      const centers = [].concat(_scRiskZoneCenters(t, "operator"), _scRiskZoneCenters(t, "materialVectors"));
      for(const p of centers){
        if(!inScope(p.x, p.y)){ pen++; continue; }
        let blocked = false;
        for(const o of obstacles){ const oz = state.zones[o.id]; if(oz && inRect(p, oz)){ blocked = true; break; } }
        if(!blocked) for(const m of movable){ if(m.id===t.id) continue; const mz = state.zones[m.id]; if(mz && inRect(p, mz)){ blocked = true; break; } }
        if(blocked) pen++;
      }
    }
    return pen;
  };
  const ROTS = [0, 90, 180, 270];

  const snapshot = () => { const s = {}; for(const t of movable){ const z = state.zones[t.id]; s[t.id] = { x:z.x, y:z.y, rotation:z.rotation||0 }; } return s; };
  const restore  = s => { for(const id in s){ const z = state.zones[id]; if(z){ z.x = s[id].x; z.y = s[id].y; z.rotation = s[id].rotation; } } };
  // Objective = weighted score minus footprint-accessibility penalty.
  const objNow = () => { evaluate(); return (state.score == null ? 0 : state.score) - ACCESS_W * accessPenalty(); };

  const original = snapshot();
  const startObj = objNow();
  const startScore = (state.score == null ? 0 : state.score);
  let cur = startObj;
  let best = { obj: startObj, pos: snapshot() };

  // Simulated annealing.
  const ITERS = Math.min(700, Math.max(300, 60 * movable.length));
  let T = 12;
  for(let it = 0; it < ITERS; it++){
    T *= 0.992;
    const t = movable[Math.floor(Math.random() * movable.length)];
    const z = state.zones[t.id];
    const prev = { x:z.x, y:z.y, rotation:z.rotation||0 };
    const move = Math.random();
    if(move < 0.25){
      // rotation move (orients operator/material footprints toward free space)
      z.rotation = ROTS[Math.floor(Math.random()*ROTS.length)];
    } else if(move < 0.55){
      // local nudge
      z.x = clamp(prev.x + (Math.random()-0.5)*12, 0, 100 - z.w);
      z.y = clamp(prev.y + (Math.random()-0.5)*12, 0, 100 - z.h);
    } else {
      // jump anywhere in scope (and maybe re-orient)
      z.x = clamp(bb.x1 + Math.random()*Math.max(0.1, (bb.x2 - bb.x1 - z.w)), 0, 100 - z.w);
      z.y = clamp(bb.y1 + Math.random()*Math.max(0.1, (bb.y2 - bb.y1 - z.h)), 0, 100 - z.h);
      if(Math.random() < 0.5) z.rotation = ROTS[Math.floor(Math.random()*ROTS.length)];
    }
    if(!footInside(z) || collides(t.id, z)){ z.x = prev.x; z.y = prev.y; z.rotation = prev.rotation; continue; }
    const ns = objNow();
    const d = ns - cur;
    if(d >= 0 || Math.random() < Math.exp(d / Math.max(0.5, T))){
      cur = ns;
      if(ns > best.obj){ best = { obj: ns, pos: snapshot() }; }
    } else {
      z.x = prev.x; z.y = prev.y; z.rotation = prev.rotation;   // reject
    }
  }

  if(best.obj <= startObj + 0.01){
    restore(original); evaluate(); render();
    alert(`Optimize Layout: no better arrangement found (score stayed ${startScore}/100). Layout unchanged.`);
    return;
  }
  restore(best.pos); evaluate(); render();
  const endScore = (state.score == null ? 0 : state.score);
  const keep = confirm(`Optimize Layout improved the layout (score ${startScore} → ${endScore}/100, with operator/material footprints kept clear).\n\nKeep this arrangement? (Cancel to revert)`);
  if(!keep) restore(original);
  evaluate(); render();
  if(typeof saveAppState === "function") saveAppState();
}
