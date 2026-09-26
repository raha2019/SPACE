"use strict";
/* ==================================================================
   ENGINE RULES  (v3 re-platform — rule-based simulation setup)
   A declarative safety / adjacency rules layer over the Layout Engine
   model. Curated preset rules (NFPA/ANSI/OSHA-informed) with adjustable
   thresholds; evaluates the feet model and produces pass/warn/fail flags
   + a findings list, shown in a floating "Rules" panel.
   Custom user-authored rules are a later pass — presets are hard-coded
   here but their thresholds are editable and persisted in state.engineRules.
   ================================================================== */
(function(){

// ---- element predicates (operate on a resolved def) ----
const attr=(d,k)=>(d&&d.variableAttrs&&Number.isFinite(d.variableAttrs[k]))?d.variableAttrs[k]:0;
const isAmenity=d=>d&&d.elementClass==="amenity";
const isStructural=d=>d&&d.elementClass==="structural";
const isTool=d=>d&&!isAmenity(d)&&!isStructural(d);
const isFlammable=d=>isTool(d)&&attr(d,"flammability")>0;
const isExtinguisher=d=>isAmenity(d)&&(d.subtype==="fire_extinguisher"||/fire\s*extinguisher/i.test(d.label||""));
const isFumeSource=d=>isTool(d)&&attr(d,"smellFumes")>0;
const isHood=d=>isAmenity(d)&&(/hood|fume|exhaust|vent|sink/i.test(d.subtype||"")||/fume\s*hood|exhaust|ventilation/i.test(d.label||""));
const isChemical=d=>isTool(d)&&(attr(d,"chemical")>0||attr(d,"smellFumes")>=2);
const isEyewash=d=>isAmenity(d)&&/eye\s*wash|eyewash|shower|first[\s_]*aid/i.test((d.subtype||"")+" "+(d.label||""));
const loudDba=d=>Math.max(d&&Number.isFinite(d.dba_active)?d.dba_active:0, attr(d,"noiseDb"));
function ppeList(d){ if(!d)return[]; let p=d.ppe||(d.variableAttrs&&d.variableAttrs.ppe); if(!p)return[];
  if(Array.isArray(p))return p.filter(Boolean); if(typeof p==="string")return p.split(/[,;]/).map(s=>s.trim()).filter(Boolean); return []; }

// ---- geometry ----
const cdist=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
const halfR=e=>Math.hypot((e.w||2)/2,(e.h||2)/2);
const gap=(a,b)=>cdist(a,b)-halfR(a)-halfR(b);

// ---- model access ----
function instances(m){ return (m.elements||[]).map(e=>({e, def:Engine.defOf(e.defId)})).filter(x=>x.def); }
const nameOf=x=>x.def.short||x.def.label||x.e.defId;
function where(list,pred){ return list.filter(x=>pred(x.def)); }

// ---- result helpers ----
const R=(status,findings)=>({status,findings:findings||[]});
const na=msg=>R("na",[{msg}]);
function coverage(src,sinks,maxDist,sinkLabel){
  const findings=[];
  for(const s of src){ let best=Infinity; for(const k of sinks) best=Math.min(best,cdist(s.e,k.e));
    if(best>maxDist) findings.push({msg:`${nameOf(s)} — nearest ${sinkLabel} is ${best.toFixed(0)} ft away (limit ${maxDist} ft)`, elId:s.e.id}); }
  return R(findings.length?"fail":"pass", findings.length?findings:[{msg:`All ${src.length} within ${maxDist} ft of ${sinkLabel}.`}]);
}

// ---- preset rules ----
const RULES=[
  { id:"fire", label:"Fire-extinguisher reach", sev:"high", param:{key:"maxDist",label:"Max distance",unit:"ft",def:50},
    run:(m,list,p)=>{ const src=where(list,isFlammable), sink=where(list,isExtinguisher);
      if(!src.length) return na("No flammable tools placed.");
      if(!sink.length) return R("fail", src.map(s=>({msg:`${nameOf(s)} — no fire extinguisher in the layout`,elId:s.e.id})));
      return coverage(src,sink,p.maxDist,"extinguisher"); } },

  { id:"eyewash", label:"Eyewash / shower reach", sev:"high", param:{key:"maxDist",label:"Max distance",unit:"ft",def:55},
    run:(m,list,p)=>{ const src=where(list,isChemical), sink=where(list,isEyewash);
      if(!src.length) return na("No chemical / high-fume stations placed.");
      if(!sink.length) return R("fail", src.map(s=>({msg:`${nameOf(s)} — no eyewash/shower in the layout (ANSI Z358.1)`,elId:s.e.id})));
      return coverage(src,sink,p.maxDist,"eyewash/shower"); } },

  { id:"fume", label:"Fume capture (hood reach)", sev:"med", param:{key:"maxDist",label:"Max distance",unit:"ft",def:14},
    run:(m,list,p)=>{ const src=where(list,isFumeSource), sink=where(list,isHood);
      if(!src.length) return na("No fume/odor sources placed.");
      if(!sink.length) return R("warn", src.map(s=>({msg:`${nameOf(s)} — no fume hood / exhaust nearby`,elId:s.e.id})));
      const cov=coverage(src,sink,p.maxDist,"hood/exhaust"); if(cov.status==="fail")cov.status="warn"; return cov; } },

  { id:"egress", label:"Egress exit present", sev:"high", param:null,
    run:(m,list)=>{ const exits=(m.openings||[]).filter(o=>o.kind==="door"&&o.exit);
      const doors=(m.openings||[]).filter(o=>o.kind==="door");
      if(exits.length) return R("pass",[{msg:`${exits.length} egress exit(s) marked.`}]);
      if(doors.length) return R("warn",[{msg:`${doors.length} door(s) but none marked as an egress exit — mark exits in door properties (falling back to all doors).`}]);
      return R("fail",[{msg:"No doors/exits in the layout."}]); } },

  { id:"clearance", label:"Tool clearance / spacing", sev:"med", param:{key:"minGap",label:"Min gap",unit:"ft",def:3},
    run:(m,list,p)=>{ const tools=where(list,isTool); const findings=[];
      for(let i=0;i<tools.length;i++)for(let j=i+1;j<tools.length;j++){ const g=gap(tools[i].e,tools[j].e);
        if(g<p.minGap) findings.push({msg:`${nameOf(tools[i])} ↔ ${nameOf(tools[j])} only ${Math.max(0,g).toFixed(1)} ft apart (min ${p.minGap} ft)`,elId:tools[i].e.id}); }
      if(!tools.length) return na("No tools placed.");
      return R(findings.length?"warn":"pass", findings.length?findings:[{msg:`All tool pairs ≥ ${p.minGap} ft apart.`}]); } },

  { id:"noise", label:"Hearing-protection zones", sev:"info", param:{key:"dba",label:"dBA threshold",unit:"dBA",def:85},
    run:(m,list,p)=>{ const loud=where(list,d=>loudDba(d)>=p.dba);
      if(!loud.length) return R("pass",[{msg:`No tools at or above ${p.dba} dBA.`}]);
      return R("info", loud.map(s=>({msg:`${nameOf(s)} operates at ${loudDba(s.def).toFixed(0)} dBA — hearing protection zone`,elId:s.e.id}))); } },

  { id:"ppe", label:"PPE-required elements", sev:"info", param:null,
    run:(m,list)=>{ const req=list.filter(x=>ppeList(x.def).length);
      if(!req.length) return R("pass",[{msg:"No elements flag required PPE."}]);
      return R("info", req.map(x=>({msg:`${nameOf(x)} — PPE: ${ppeList(x.def).join(", ")}`,elId:x.e.id}))); } },
];

// ---- params persistence ----
function paramVal(rule){
  if(!rule.param) return null;
  const store=(typeof state!=="undefined"&&state.engineRules)||{};
  const v=store[rule.id]&&store[rule.id][rule.param.key];
  return Number.isFinite(v)?v:rule.param.def;
}
function setParam(rule,val){
  if(typeof state==="undefined")return;
  state.engineRules=state.engineRules||{};
  state.engineRules[rule.id]=state.engineRules[rule.id]||{};
  state.engineRules[rule.id][rule.param.key]=val;
  if(typeof saveAppState==="function") saveAppState();
}

// ---- evaluate ----
function evaluate(){
  const m=Engine.getModel(); const list=instances(m);
  return RULES.map(rule=>{
    const p={}; if(rule.param) p[rule.param.key]=paramVal(rule);
    let res; try{ res=rule.run(m,list,p); }catch(err){ res=R("na",[{msg:"rule error: "+(err&&err.message||err)}]); console.error("[rules]",rule.id,err); }
    return { id:rule.id, label:rule.label, sev:rule.sev, param:rule.param, pval:rule.param?p[rule.param.key]:null,
             status:res.status, findings:res.findings };
  });
}

// ---- panel ----
const SEVDOT={pass:"#39b57a",warn:"#e0913a",fail:"#e5545c",info:"#4f9dff",na:"#6c7890"};
let panel=null, open=false;
function ensureCss(){ if(document.getElementById("eng-rules-css"))return;
  const css=`
  .eng-rules{position:absolute;right:10px;top:10px;bottom:44px;width:304px;z-index:4;background:rgba(20,26,38,.97);border:1px solid var(--line);border-radius:8px;display:flex;flex-direction:column;color:var(--dim);font-size:12px}
  .eng-rules-hd{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid var(--line);color:var(--text);font-weight:600}
  .eng-rules-hd button{background:none;border:0;color:var(--dim);font-size:16px;cursor:pointer;line-height:1}
  .eng-rules-sum{padding:8px 12px;border-bottom:1px solid var(--line);font-size:12px}
  .eng-rules-body{flex:1;overflow:auto;padding:4px 12px}
  .eng-rule{padding:8px 0;border-bottom:1px dashed var(--line)}
  .eng-rule-top{display:flex;align-items:center;gap:8px}
  .eng-rule-dot{width:9px;height:9px;border-radius:50%;flex:none}
  .eng-rule-name{flex:1;color:var(--text)}
  .eng-rule-st{font-size:10px;text-transform:uppercase;letter-spacing:.4px;color:var(--mute)}
  .eng-rule-thr{display:flex;align-items:center;gap:5px;margin-top:5px;color:var(--mute);font-size:11px}
  .eng-rule-thr input{width:58px;background:var(--panel-2);color:var(--text);border:1px solid var(--line);border-radius:5px;padding:3px 5px;font:11px var(--mono)}
  .eng-rule-find{margin-top:5px;font-size:11px;line-height:1.5}
  .eng-rule-find div{color:var(--dim);padding:2px 0 2px 12px;text-indent:-9px}
  .eng-rules-ft{padding:8px 12px;border-top:1px solid var(--line)}
  .eng-rules-ft button{width:100%;background:var(--accent);color:#08111f;border:0;border-radius:6px;padding:7px;font-weight:600;cursor:pointer}`;
  const st=document.createElement("style"); st.id="eng-rules-css"; st.textContent=css; document.head.appendChild(st);
}
function build(){
  const canvas=document.querySelector(".eng-canvas"); if(!canvas)return null;
  ensureCss();
  panel=document.createElement("div"); panel.className="eng-rules"; panel.id="eng-rules";
  canvas.appendChild(panel);
  return panel;
}
function render(){
  if(!panel)return;
  const results=evaluate();
  const counts={fail:0,warn:0,pass:0,info:0,na:0}; results.forEach(r=>counts[r.status]++);
  const overall = counts.fail?"fail":(counts.warn?"warn":"pass");
  const oc={fail:"var(--bad)",warn:"var(--door)",pass:"var(--good)"}[overall];
  let h=`<div class="eng-rules-hd">Safety &amp; adjacency rules <button id="eng-rules-x" title="Close">×</button></div>`;
  h+=`<div class="eng-rules-sum">Overall: <b style="color:${oc}">${overall.toUpperCase()}</b> · <span class="bad">${counts.fail} fail</span> · <span class="warn">${counts.warn} warn</span> · ${counts.pass} pass</div>`;
  h+=`<div class="eng-rules-body">`;
  for(const r of results){
    h+=`<div class="eng-rule"><div class="eng-rule-top"><span class="eng-rule-dot" style="background:${SEVDOT[r.status]}"></span><span class="eng-rule-name">${r.label}</span><span class="eng-rule-st">${r.status}</span></div>`;
    if(r.param) h+=`<div class="eng-rule-thr"><label>${r.param.label}</label><input type="number" data-rule="${r.id}" step="1" min="0" value="${r.pval}"><span>${r.param.unit}</span></div>`;
    if(r.findings&&r.findings.length){ h+=`<div class="eng-rule-find">`+r.findings.slice(0,6).map(f=>`<div>${esc(f.msg)}</div>`).join("")+(r.findings.length>6?`<div>…and ${r.findings.length-6} more</div>`:"")+`</div>`; }
    h+=`</div>`;
  }
  h+=`</div><div class="eng-rules-ft"><button id="eng-rules-recheck">Re-check</button></div>`;
  panel.innerHTML=h;
  panel.querySelector("#eng-rules-x").onclick=()=>toggle(false);
  panel.querySelector("#eng-rules-recheck").onclick=render;
  panel.querySelectorAll("input[data-rule]").forEach(inp=>inp.addEventListener("change",()=>{
    const rule=RULES.find(x=>x.id===inp.dataset.rule); const v=parseFloat(inp.value);
    if(rule&&rule.param&&Number.isFinite(v)){ setParam(rule,v); render(); }
  }));
}
function esc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}
function toggle(force){
  open = (typeof force==="boolean")?force:!open;
  if(open){ if(!panel||!panel.isConnected) build(); if(panel){ panel.style.display="flex"; render(); } }
  else if(panel){ panel.style.display="none"; }
}

window.EngineRules = { evaluate, toggle, render:()=>{ if(open) render(); } };

})();
