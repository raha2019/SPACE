/**
 * tools/verify_phase1.mjs  --  Playwright browser verification for Phase 1 / Gate 1.
 *
 * GATE 1: Confirm browser wiring is intact before Phase 2 land:
 *   • sim_eval.js + sim_mosa.js load without errors
 *   • MOSA button fires, produces a non-empty Pareto table
 *   • Apply writes the chosen layout to stage; Restore returns exact pre-run state
 *   • Second MOSA run / apply / restore round-trips cleanly (double-run semantics)
 *   • Legacy #optimizeLayoutBtn dialog fires and is accepted
 *   • Zero console errors OR warnings from our modules
 *
 * MRDC 2323 CONFIGURATION (loaded the same way the headless harness sets up):
 *   The page is seeded via localStorage (space.v1.app, read by state.js loadAppState())
 *   from the repo's real bundle + configuration + scale:
 *     testcase/hub/default-elements.json        -> 21 element defs (zoneDefs)
 *     testcase/hub/default-configuration.json   -> zone positions (% coords)
 *     testcase/hub/mrdc2323-scale.json          -> real MRDC 2323 scale (9 px/ft,
 *                                                  96.6 x 88.6 ft bounding box)
 *   This reproduces the harness's EFFECTIVE evaluated state: 21 element zones at the
 *   config positions under the real MRDC scale, the enforced L-polygon analysis scope,
 *   and the same 14 movable tools. (Phase 2c: the harness now RE-REGISTERS the floor
 *   zone in state.zones after the mosa_validate.mjs:214 rebuild — matching loadPreset's
 *   allZoneDefs() semantics — so getAnalysisRooms() returns the floor room and the
 *   6-vertex SE-notch polygon is active. This seed registers FLOOR_DEF the same way
 *   (full-stage anchor x:0,y:0,w:100,h:100) so the browser enforces the identical
 *   polygon scope. The browser-enforcement probes below assert this parity.)
 *
 * Usage:
 *   node tools/verify_phase1.mjs
 *
 * Outputs:
 *   shots/00-before.png      page loaded, MRDC 2323 project active
 *   shots/01-front.png       MOSA Pareto table rendered
 *   shots/02-applied.png     knee point applied to stage
 *   shots/03-final.png       final state after legacy optimizer
 *   results/gate1.json       structured test results (machine-readable)
 *
 * Requires:
 *   playwright in node_modules  (npm install --save-dev playwright)
 *   Chromium browser            (npx playwright install chromium)
 */

import { readFileSync, statSync, mkdirSync, writeFileSync, existsSync, createReadStream } from 'fs';
import { join, dirname, extname } from 'path';
import { fileURLToPath }          from 'url';
import { createServer }           from 'http';
import { chromium }               from 'playwright';

const __dirname   = dirname(fileURLToPath(import.meta.url));
const ROOT        = join(__dirname, '..');
const SHOTS_DIR   = join(ROOT, 'shots');
const RESULTS_DIR = join(ROOT, 'results');

if (!existsSync(SHOTS_DIR))   mkdirSync(SHOTS_DIR,   { recursive: true });
if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });

/* ─── Build localStorage seed from the real MRDC 2323 bundle + config + scale ── */

const elementBundle = JSON.parse(
  readFileSync(join(ROOT, 'testcase/hub/default-elements.json'), 'utf8'));
const configBundle  = JSON.parse(
  readFileSync(join(ROOT, 'testcase/hub/default-configuration.json'), 'utf8'));
const mrdcScale     = JSON.parse(
  readFileSync(join(ROOT, 'testcase/hub/mrdc2323-scale.json'), 'utf8'));

const ELEMENT_DEFS = elementBundle.elementDefs;
const CONFIG_ZONES = configBundle.zones;
const REGIONS      = elementBundle.regions || [];

// Real MRDC 2323 scale — 9 px/ft, 96.6 x 88.6 ft bounding box (matches the harness).
const SCALE = {
  pxPerUnit:     mrdcScale.pxPerUnit,
  unit:          mrdcScale.unit,
  stageWidthPx:  mrdcScale.stageWidthPx,
  stageHeightPx: mrdcScale.stageHeightPx,
};

// Full zone objects (mirrors the harness's state.zones rebuild loop exactly:
// x/y/w/h from config with element-def fallback, rotation, included, locked=fixed).
const stateZones = {};
for (const def of ELEMENT_DEFS) {
  const cfg = CONFIG_ZONES[def.id] || {};
  stateZones[def.id] = {
    x:        cfg.x        !== undefined ? cfg.x        : 50,
    y:        cfg.y        !== undefined ? cfg.y        : 50,
    w:        cfg.w        !== undefined ? cfg.w        : def.w,
    h:        cfg.h        !== undefined ? cfg.h        : def.h,
    rotation: cfg.rotation !== undefined ? cfg.rotation : 0,
    included: true,
    activeUse: false,
    locked:   !!def.fixed,
  };
}

// Phase 2c: register the L-shaped floor room so the browser enforces the 6-vertex
// polygon exactly as the harness now does (getAnalysisRooms() -> [floor],
// pointInAnalysisScope() excludes the SE notch). Full-stage anchor so
// roomPolygonPct() maps the local polygon 1:1 into stage %.
const FLOOR_DEF = mrdcScale.floorDef;
const FLOOR_ID  = FLOOR_DEF.id;
stateZones[FLOOR_ID] = {
  x: 0, y: 0, w: 100, h: 100,
  included: true, activeUse: false, locked: false,
};

// Phase 2d: register the SE-notch structural wall so the browser's ADA/egress/noise
// grids exclude/attenuate the notch identically to the harness. Its zone carries the
// notch rectangle (simBlockerFootprint uses the zone rect).
const NOTCH_DEF = mrdcScale.notchBlockerDef;
const NOTCH_ID  = NOTCH_DEF.id;
stateZones[NOTCH_ID] = {
  x: NOTCH_DEF.x, y: NOTCH_DEF.y, w: NOTCH_DEF.w, h: NOTCH_DEF.h,
  rotation: 0, included: true, activeUse: false, locked: true,
};

// PRESETS.current.zones — position overrides (loadPreset merges w/ def defaults).
const presetsZones = {};
for (const [id, p] of Object.entries(CONFIG_ZONES)) {
  presetsZones[id] = { x: p.x, y: p.y };
  if (p.w        !== undefined) presetsZones[id].w        = p.w;
  if (p.h        !== undefined) presetsZones[id].h        = p.h;
  if (p.rotation !== undefined) presetsZones[id].rotation = p.rotation;
}

const appSnap = {
  v: 1,
  zoneDefs: ELEMENT_DEFS,
  presets: { current: { name: 'Current Layout', zones: presetsZones } },
  regions: REGIONS,
  state: {
    preset:           'current',
    zones:            stateZones,
    trafficMode:      'normal',
    activeUse:        false,
    showClearance:    false,
    showFlow:         true,
    showSidebar:      true,
    showGrid:         false,
    units:            'ft',
    scale:            SCALE,
    // Phase 2c/2d: L-polygon scope active (floor) + SE-notch objective blocker (wall).
    customElements:   [],
    structuralElements: [FLOOR_DEF, NOTCH_DEF],
    amenityElements:  [],
    analysisRooms:    null,
    heatmapMetric:    null,
    imports:          { floorPlan: null, config: null },
    statusCollapsed:  false,
    bannerDismissed:  true,   // suppress prototype notice so it doesn't cover UI
    elementsSort:     'risk',
    projectInfo: {
      project: 'Invention Studio Layout Optimization for Safety and Accessibility',
      lab:     'Georgia Tech MATRIX Lab',
      build:   'v0.5 prototype (MRDC 2323)',
    },
    categories: [
      { id: 'general',   label: 'General',      color: '#5aa9ff' },
      { id: 'hand',      label: 'Hand Tools',   color: '#7cc4ff' },
      { id: 'power',     label: 'Power Tools',  color: '#f0b441' },
      { id: 'cutting',   label: 'Cutting',      color: '#ef5d6f' },
      { id: 'finishing', label: 'Finishing',    color: '#34c98a' },
      { id: 'assembly',  label: 'Assembly',     color: '#a3cf4a' },
    ],
    simResolution:       'medium',
    simResolutionFactor: null,
    leftColWidth:        null,
    analysisLive:        false,
    analysisLastSim:     null,
    transformPanelPos:   null,
    showToolsOnly:       false,
    dashboard:           null,
    wallTypeColors:      null,
    metricWeights:       null,
  },
};

const LS_KEY   = 'space.v1.app';
const LS_VALUE = JSON.stringify(appSnap);

/* ─── Tiny static file server (serve repo ROOT on a local port) ────────────── */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg':  'image/svg+xml', '.ico': 'image/x-icon',
};

function startServer() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      try {
        // Strip query string (?v=4) and decode.
        let urlPath = decodeURIComponent(req.url.split('?')[0]);
        if (urlPath === '/' || urlPath === '') urlPath = '/v1/index.html';
        // Prevent path traversal above ROOT.
        const filePath = join(ROOT, urlPath);
        if (!filePath.startsWith(ROOT)) { res.statusCode = 403; res.end('Forbidden'); return; }
        if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
          res.statusCode = 404; res.end('Not found'); return;
        }
        res.setHeader('Content-Type', MIME[extname(filePath).toLowerCase()] || 'application/octet-stream');
        createReadStream(filePath).pipe(res);
      } catch (err) {
        res.statusCode = 500; res.end('Server error: ' + err.message);
      }
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/* ─── Zone-snapshot helpers ────────────────────────────────────────────────── */

/** Capture {id:{x,y,rotation}} for all zones from the browser context. */
async function captureZones(page) {
  return page.evaluate(() => {
    const out = {};
    for (const [id, z] of Object.entries(state.zones)) {
      out[id] = { x: z.x, y: z.y, rotation: z.rotation || 0 };
    }
    return out;
  });
}

/** EXACT (bit-for-bit) field-by-field comparison. Returns list of diff strings. */
function exactZoneDiff(a, b) {
  const diffs = [];
  const ids = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const id of ids) {
    const za = a[id], zb = b[id];
    if (!za) { diffs.push(`${id}: present only in B`); continue; }
    if (!zb) { diffs.push(`${id}: present only in A`); continue; }
    for (const f of ['x', 'y', 'rotation']) {
      const va = za[f] || 0, vb = zb[f] || 0;
      if (va !== vb) diffs.push(`${id}.${f}: A=${va} B=${vb} (Δ=${vb - va})`);
    }
  }
  return diffs;
}
function zonesExactlyEqual(a, b) { return exactZoneDiff(a, b).length === 0; }

/** Which zones moved between two snaps, expressed in stage-% terms. */
function zoneMoves(before, after) {
  const moves = [];
  for (const id of Object.keys(before)) {
    const zb = before[id], za = after[id];
    if (!za) continue;
    const dx = (za.x - zb.x), dy = (za.y - zb.y), dr = (za.rotation || 0) - (zb.rotation || 0);
    if (dx !== 0 || dy !== 0 || dr !== 0) {
      moves.push({
        id,
        dx_pct: +dx.toFixed(4),
        dy_pct: +dy.toFixed(4),
        drot_deg: +dr.toFixed(4),
        dist_pct: +Math.hypot(dx, dy).toFixed(4),
      });
    }
  }
  return moves;
}

/* ─── Which console messages originate from OUR modules ────────────────────── */
const OUR_MODULES = [
  'sim_mosa', 'sim_ui', 'sim_eval', 'sim_ada', 'sim_egress',
  'sim_noise', 'sim_fire', 'sim_fumes', 'state.js', 'scoring.js',
  'optimize.js', 'controls.js', 'data.js', 'init.js', 'render.js',
  'modals.js', 'dashboard.js', 'walldraw.js', 'sim_optimizer', 'sim_score_bridge',
];
function isOurMessage(entry) {
  const t = (entry.text || '').toLowerCase();
  const u = (entry.url  || '').toLowerCase();
  if (OUR_MODULES.some(m => u.includes(m.toLowerCase()))) return true;
  if (OUR_MODULES.some(m => t.includes(m.toLowerCase()))) return true;
  // Uncaught runtime errors always matter regardless of attribution.
  if (t.includes('uncaught') || t.includes('typeerror') ||
      t.includes('referenceerror') || t.includes('syntaxerror')) return true;
  // pageerror events are always ours (uncaught in our page).
  if (entry.type === 'pageerror') return true;
  return false;
}

/* ─── Main gate ────────────────────────────────────────────────────────────── */

async function runGate1() {
  const results = {
    gate:          'GATE 1',
    pass:          false,
    config:        'MRDC 2323 (real geometry)',
    scale:         SCALE,
    checks:        {},
    snapshots:     {},          // preRun, afterApply, afterRestore1, preRun2, afterRestore2
    moves:         {},          // applyMoves, restore1Diff, etc.
    mosaTable:     null,
    mosaTable2:    null,
    restoreSemantics: null,     // 1e answer
    consoleErrors: [],
    consoleWarnings: [],
    allConsoleMessages: [],
    optimizeConsole: [],
    dialogs:       [],
    shots:         {},
    timestamp:     new Date().toISOString(),
  };

  const server  = await startServer();
  const port    = server.address().port;
  const PAGE_URL = `http://127.0.0.1:${port}/v1/index.html`;
  console.log(`Static server: http://127.0.0.1:${port}/  (root: ${ROOT})`);
  console.log(`Page URL: ${PAGE_URL}`);

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page    = await context.newPage();

    /* ── Console listener attached BEFORE any navigation/interaction ──────── */
    page.on('console', msg => {
      const loc = msg.location() || {};
      const entry = {
        type: msg.type(),                 // severity: 'error' | 'warning' | 'log' | 'info' | ...
        text: msg.text(),
        url:  loc.url || '',
        line: loc.lineNumber,
      };
      results.allConsoleMessages.push(entry);
      if (msg.type() === 'error')   results.consoleErrors.push(entry);
      if (msg.type() === 'warning') results.consoleWarnings.push(entry);
    });
    page.on('pageerror', err => {
      const entry = { type: 'pageerror', text: err.message, url: '', line: null };
      results.consoleErrors.push(entry);
      results.allConsoleMessages.push(entry);
    });
    // Auto-accept any dialog (legacy optimizer confirm) — registered up-front.
    page.on('dialog', async dialog => {
      results.dialogs.push({ type: dialog.type(), message: dialog.message() });
      await dialog.accept();
    });

    /* ── Pre-seed localStorage before any page script runs ───────────────── */
    await page.addInitScript(({ key, value }) => {
      try { localStorage.setItem(key, value); } catch (_) {}
    }, { key: LS_KEY, value: LS_VALUE });

    /* ── 1a. Load page ───────────────────────────────────────────────────── */
    await page.goto(PAGE_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForFunction(() =>
      typeof state !== 'undefined' &&
      state.scale && state.scale.pxPerUnit > 0 &&
      typeof mosaOptimize === 'function'
    , { timeout: 15000 });

    results.checks.pageLoaded         = true;
    results.checks.mosaOptimizeLoaded = true;

    // Confirm the MRDC scale actually took (stage dims in ft).
    const stageDims = await page.evaluate(() => {
      const du = (typeof stageDimsUnits === 'function') ? stageDimsUnits() : null;
      return du ? { w: du.w, h: du.h, pxPerUnit: state.scale.pxPerUnit, unit: state.scale.unit } : null;
    });
    results.stageDimsUnits = stageDims;
    console.log(`Stage: ${stageDims ? stageDims.w.toFixed(1) + ' x ' + stageDims.h.toFixed(1) + ' ' + stageDims.unit : 'n/a'} @ ${stageDims ? stageDims.pxPerUnit : '?'} px/unit`);

    /* Phase 2c: confirm the browser enforces the L-polygon (same as harness). */
    const enf = await page.evaluate(() => {
      const rooms = (typeof getAnalysisRooms === 'function') ? getAnalysisRooms() : [];
      const poly  = (rooms[0] && typeof roomPolygonPct === 'function') ? roomPolygonPct(rooms[0]) : null;
      const probe = (x, y) => (typeof pointInAnalysisScope === 'function') ? pointInAnalysisScope(x, y) : null;
      return {
        rooms: rooms.length,
        vertices: poly ? poly.length : 0,
        notch_47_83: probe(47.5, 83),   // expect false
        interior_20_20: probe(20, 20),  // expect true
      };
    });
    results.enforcement = enf;
    results.checks.browserEnforcesPolygon =
      (enf.rooms === 1 && enf.vertices === 6 && enf.notch_47_83 === false && enf.interior_20_20 === true);
    console.log(`Browser enforcement: rooms=${enf.rooms} verts=${enf.vertices} inScope(47.5,83)=${enf.notch_47_83} inScope(20,20)=${enf.interior_20_20} -> ${results.checks.browserEnforcesPolygon ? 'PASS' : 'FAIL'}`);

    /* Pre-run snapshot. */
    const snap0 = await captureZones(page);
    results.snapshots.preRun = snap0;
    console.log(`Pre-run snapshot: ${Object.keys(snap0).length} zones.`);

    await page.screenshot({ path: join(SHOTS_DIR, '00-before.png'), fullPage: false });
    console.log('Shot: 00-before.png');

    /* ── 1b. MOSA Run 1 ──────────────────────────────────────────────────── */
    await page.locator('#simMosaBtn').scrollIntoViewIfNeeded();
    await page.locator('#simMosaBtn').click();
    console.log('Clicked #simMosaBtn. Polling for #mosRestoreBtn (table render)…');

    let tableTimedOut = false;
    try {
      await page.waitForSelector('#mosRestoreBtn', { timeout: 120000 });
    } catch (e) {
      tableTimedOut = true;
      console.log('TIMEOUT: frontier table did not render within 120 s.');
    }
    results.checks.frontierRendered = !tableTimedOut;

    await page.screenshot({ path: join(SHOTS_DIR, '01-front.png'), fullPage: false });
    console.log('Shot: 01-front.png');

    /* Extract the full front table + baseline row. */
    const mosaTable = await page.evaluate(() => {
      const rows = [];
      // Baseline row (first table in the results card).
      const allTables = document.querySelectorAll('#simResults table');
      if (allTables.length > 0) {
        const bv = {};
        allTables[0].querySelectorAll('tr').forEach(tr => {
          const tds = tr.querySelectorAll('td');
          if (tds.length >= 2) {
            const label = tds[0].textContent.trim();
            const val   = parseFloat(tds[1].textContent);
            if (label === 'ADA')    bv.ada    = val;
            if (label === 'Egress') bv.egress = val;
            if (label === 'Noise')  bv.noise  = val;
          }
        });
        if (bv.ada != null)
          rows.push({ idx: -1, isBaseline: true, isKnee: false,
                      ada: bv.ada, egress: bv.egress, noise: bv.noise });
      }
      // Front rows (each has an Apply button with data-mosa-idx).
      const applyBtns = Array.from(document.querySelectorAll('[data-mosa-idx]'));
      for (const btn of applyBtns) {
        const tr    = btn.closest('tr');
        const cells = tr ? Array.from(tr.querySelectorAll('td')) : [];
        const idxTd = cells[0] ? cells[0].textContent.trim() : '';
        rows.push({
          idx:        parseInt(btn.dataset.mosaIdx, 10),
          isBaseline: false,
          isKnee:     idxTd.includes('★'),
          ada:        cells[1] ? parseFloat(cells[1].textContent) : null,
          egress:     cells[2] ? parseFloat(cells[2].textContent) : null,
          noise:      cells[3] ? parseFloat(cells[3].textContent) : null,
        });
      }
      const front   = rows.filter(r => !r.isBaseline);
      const kneeIdx  = front.findIndex(r => r.isKnee);
      return { rows, frontCount: front.length, kneeIdx };
    });
    results.mosaTable = mosaTable;
    results.checks.frontNonEmpty = mosaTable.frontCount > 0;
    results.checks.kneeMarked    = mosaTable.kneeIdx >= 0;
    console.log(`Front: ${mosaTable.frontCount} members, knee at front index ${mosaTable.kneeIdx}.`);

    /* ── 1c. Apply the knee row (fallback to idx 0 if unmarked) ───────────── */
    const applyIdx = mosaTable.kneeIdx >= 0 ? mosaTable.kneeIdx : 0;
    await page.locator(`[data-mosa-idx="${applyIdx}"]`).click();
    await page.waitForTimeout(300);
    console.log(`Applied front index ${applyIdx}${mosaTable.kneeIdx >= 0 ? ' (knee)' : ' (fallback idx 0)'}.`);

    await page.screenshot({ path: join(SHOTS_DIR, '02-applied.png'), fullPage: false });
    console.log('Shot: 02-applied.png');

    const snapApply = await captureZones(page);
    results.snapshots.afterApply = snapApply;
    const applyMoves = zoneMoves(snap0, snapApply);
    results.moves.applyMoves = applyMoves;
    results.checks.positionsChangedAfterApply = applyMoves.length > 0;
    console.log(`Zones moved on Apply: ${applyMoves.length}`);
    for (const m of applyMoves)
      console.log(`  ${m.id}: Δx=${m.dx_pct}% Δy=${m.dy_pct}% Δrot=${m.drot_deg}° (|move|=${m.dist_pct}%)`);

    /* ── Phase 2c: classify every zone center in the APPLIED knee layout against
       the L-polygon, using the browser's own pointInAnalysisScope. Assert no
       movable tool sits in the notch. A moved tool cannot (footInside samples the
       AABB center); an unmoved movable candidate can, if _scInScope() dropped it
       from the optimizer because its default center was already in the notch. */
    const MOVABLE_TOOL_IDS = ['craftland','xr','asm1','asm2','bike','storage',
      'electronics','print3d','laser','cnc','metal','wood','welding','waterjet'];
    const notchClass = await page.evaluate((movableIds) => {
      const out = [];
      for (const [id, z] of Object.entries(state.zones)) {
        const cx = z.x + z.w / 2, cy = z.y + z.h / 2;
        const inScope = (typeof pointInAnalysisScope === 'function')
          ? pointInAnalysisScope(cx, cy) : null;
        out.push({ id, cx: +cx.toFixed(2), cy: +cy.toFixed(2),
          rotation: z.rotation || 0, inScope,
          isMovableCandidate: movableIds.includes(id) });
      }
      return out;
    }, MOVABLE_TOOL_IDS);
    // Annotate whether each zone actually moved on Apply.
    const movedIds = new Set(applyMoves.map(m => m.id));
    for (const zc of notchClass) zc.moved = movedIds.has(zc.id);
    results.notchClassification = notchClass;
    const movableInNotch = notchClass.filter(z => z.isMovableCandidate && z.inScope === false);
    const movedInNotch    = movableInNotch.filter(z => z.moved);
    results.movableToolsInNotch = movableInNotch;
    // Assertion: no MOVED movable tool may sit in the notch (would be a footInside gap).
    results.checks.noMovedToolInNotch = movedInNotch.length === 0;
    console.log(`Post-apply notch classification (${notchClass.length} zones):`);
    for (const zc of notchClass) {
      const tag = zc.id === FLOOR_ID ? 'floor' :
        (zc.isMovableCandidate ? (zc.moved ? 'movable/moved' : 'movable/UNMOVED') : 'fixed/other');
      console.log(`  ${zc.id.padEnd(12)} center=(${zc.cx}, ${zc.cy}) rot=${zc.rotation}  inScope=${zc.inScope}  [${tag}]${zc.inScope === false ? '  <-- IN NOTCH' : ''}`);
    }
    if (movableInNotch.length === 0) {
      console.log('ASSERT PASS: no movable tool center sits in the notch after Apply.');
    } else {
      console.log(`ASSERT: ${movableInNotch.length} movable tool(s) with center in notch: ` +
        movableInNotch.map(z => `${z.id}(moved=${z.moved})`).join(', '));
      console.log(movedInNotch.length === 0
        ? '  -> all are UNMOVED (excluded by _scInScope at baseline); no footInside/AABB gap triggered.'
        : `  -> ${movedInNotch.length} were MOVED yet landed in notch — live Weakness #3 AABB-sampling gap.`);
    }

    /* ── 1d. Restore (Run 1) — assert EXACT equality to pre-run ───────────── */
    await page.locator('#mosRestoreBtn').click();
    await page.waitForTimeout(300);
    const snapRestore1 = await captureZones(page);
    results.snapshots.afterRestore1 = snapRestore1;
    const restore1Diff = exactZoneDiff(snap0, snapRestore1);
    const exactRestore1 = restore1Diff.length === 0;
    results.moves.restore1Diff = restore1Diff;
    results.checks.exactRestoreAfterRestore = exactRestore1;
    console.log(`Exact restore (Run 1): ${exactRestore1 ? 'YES — field-by-field identical' : 'NO'}`);
    if (!exactRestore1) for (const d of restore1Diff) console.log('  DRIFT: ' + d);

    /* ── 1e. Run MOSA again (no reload); apply a member; Restore ──────────── */
    await page.locator('#simMosaBtn').click();
    let table2TimedOut = false;
    try {
      // Restore button already exists from run 1; wait for a *fresh* render by
      // polling until the front table has apply buttons again after re-render.
      await page.waitForSelector('[data-mosa-idx]', { timeout: 120000 });
    } catch (e) { table2TimedOut = true; }
    results.checks.frontier2Rendered = !table2TimedOut;

    // State at the start of the second run (what run-2 Restore should return to).
    const snapPreRun2 = await captureZones(page);
    results.snapshots.preRun2 = snapPreRun2;

    await page.locator('[data-mosa-idx="0"]').click();
    await page.waitForTimeout(300);
    await page.locator('#mosRestoreBtn').click();
    await page.waitForTimeout(300);
    const snapRestore2 = await captureZones(page);
    results.snapshots.afterRestore2 = snapRestore2;

    const restore2MatchesPreRun2 = zonesExactlyEqual(snapPreRun2, snapRestore2);
    const restore2MatchesOriginal = zonesExactlyEqual(snap0, snapRestore2);
    results.checks.run2RestoreMatchesPreRun2  = restore2MatchesPreRun2;
    results.checks.run2RestoreMatchesOriginal = restore2MatchesOriginal;
    results.restoreSemantics = {
      matchesStartOfSecondRun: restore2MatchesPreRun2,
      matchesOriginalPreFirstRun: restore2MatchesOriginal,
      answer: restore2MatchesPreRun2
        ? (restore2MatchesOriginal
            ? 'Restore returns to the layout as it stood at the START OF THE SECOND RUN. Because run-1 Restore was exact, that state is identical to the original pre-first-run layout, so both comparisons pass. The operative semantic is start-of-second-run (each run re-snapshots on start).'
            : 'Restore returns to the layout as it stood at the START OF THE SECOND RUN (which differed from the original pre-first-run layout).')
        : 'Restore did NOT return to the start-of-second-run layout — unexpected; see snapshots.',
    };
    console.log('1e Restore semantics: ' + results.restoreSemantics.answer);

    /* ── 1f. Legacy #optimizeLayoutBtn — auto-accept dialog, capture console ─ */
    const consoleLenBefore = results.allConsoleMessages.length;
    const dialogsBefore     = results.dialogs.length;
    console.log('Clicking #optimizeLayoutBtn…');
    await page.locator('#optimizeLayoutBtn').click();
    // Poll for the confirm dialog to be captured (accepted) — up to 30 s.
    const optStart = Date.now();
    while (results.dialogs.length === dialogsBefore && Date.now() - optStart < 30000) {
      await page.waitForTimeout(200);
    }
    await page.waitForTimeout(500);
    const optimizerCompleted = results.dialogs.length > dialogsBefore;
    results.checks.optimizerCompleted = optimizerCompleted;
    results.optimizeConsole = results.allConsoleMessages.slice(consoleLenBefore);
    console.log(`Legacy optimizer dialog fired: ${optimizerCompleted}`);
    for (const d of results.dialogs.slice(dialogsBefore))
      console.log(`  [${d.type}] ${d.message.replace(/\n/g, ' ').slice(0, 160)}`);
    console.log(`Legacy optimizer console messages: ${results.optimizeConsole.length}`);
    for (const e of results.optimizeConsole)
      console.log(`  [${e.type}] ${e.text.slice(0, 160)}`);

    await page.screenshot({ path: join(SHOTS_DIR, '03-final.png'), fullPage: false });
    console.log('Shot: 03-final.png');

    /* ── Console error/warning filter (our modules) ───────────────────────── */
    const ourErrors   = results.consoleErrors.filter(isOurMessage);
    const ourWarnings = results.consoleWarnings.filter(isOurMessage);
    const thirdParty  = results.allConsoleMessages.filter(e =>
      (e.type === 'error' || e.type === 'warning') && !isOurMessage(e));
    results.ourModuleErrors   = ourErrors;
    results.ourModuleWarnings = ourWarnings;
    results.thirdPartyNoise   = thirdParty;
    results.checks.zeroOurModuleErrorsOrWarnings = (ourErrors.length === 0 && ourWarnings.length === 0);
    console.log(`Our-module errors: ${ourErrors.length}, warnings: ${ourWarnings.length}. Third-party/favicon noise (excluded): ${thirdParty.length}.`);

    /* ── Overall gate ─────────────────────────────────────────────────────── */
    const required = [
      'pageLoaded',
      'mosaOptimizeLoaded',
      'browserEnforcesPolygon',
      'frontNonEmpty',
      'positionsChangedAfterApply',
      'exactRestoreAfterRestore',
      'noMovedToolInNotch',
      'optimizerCompleted',
      'zeroOurModuleErrorsOrWarnings',
    ];
    results.pass = required.every(k => results.checks[k] === true);
    results.requiredChecks = required;

  } catch (err) {
    results.error      = err.message;
    results.errorStack = err.stack;
    console.error('GATE 1 SCRIPT ERROR:', err.message);
    if (err.stack) console.error(err.stack.split('\n').slice(0, 8).join('\n'));
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.close();
  }

  /* ── Record shot file sizes ────────────────────────────────────────────── */
  for (const name of ['00-before.png', '01-front.png', '02-applied.png', '03-final.png']) {
    const p = join(SHOTS_DIR, name);
    results.shots[name] = existsSync(p) ? statSync(p).size : null;
  }

  return results;
}

/* ─── Run + report ─────────────────────────────────────────────────────────── */

const results = await runGate1();

writeFileSync(join(RESULTS_DIR, 'gate1.json'), JSON.stringify(results, null, 2), 'utf8');

const line = '='.repeat(64);
console.log('\n' + line);
console.log('GATE 1 RESULT: ' + (results.pass ? 'PASS' : 'FAIL') + '  (config: ' + results.config + ')');
console.log(line);

console.log('\nPASS CRITERIA (all required):');
const critLabels = {
  pageLoaded:                        'page loaded + modules present',
  mosaOptimizeLoaded:                'mosaOptimize present',
  browserEnforcesPolygon:            'browser enforces 6-vertex L-polygon (notch excluded)',
  frontNonEmpty:                     'non-empty frontier table',
  positionsChangedAfterApply:        'at least one zone moved on Apply',
  exactRestoreAfterRestore:          'exact restore in 1d',
  noMovedToolInNotch:                'no MOVED movable tool center in notch (footInside holds)',
  optimizerCompleted:                'legacy optimizer completed in 1f',
  zeroOurModuleErrorsOrWarnings:     'zero console errors/warnings from our modules',
};
for (const k of (results.requiredChecks || Object.keys(critLabels))) {
  const v = results.checks[k];
  console.log(`  [${v === true ? 'PASS' : 'FAIL'}] ${critLabels[k] || k}`);
}

console.log('\nALL CHECKS:');
for (const [k, v] of Object.entries(results.checks)) {
  const icon = v === true ? 'PASS' : v === false ? 'FAIL' : '····';
  console.log(`  ${icon}  ${k}`);
}

if (results.mosaTable) {
  console.log('\nFRONTIER TABLE JSON (verbatim):');
  console.log(JSON.stringify(results.mosaTable, null, 2));
}

console.log('\nPRE-RUN POSITION SNAPSHOT (JSON):');
console.log(JSON.stringify(results.snapshots.preRun, null, 2));

console.log('\nPOST-APPLY POSITION SNAPSHOT (JSON):');
console.log(JSON.stringify(results.snapshots.afterApply, null, 2));

console.log('\nAPPLY MOVES (stage-% terms):');
console.log(JSON.stringify(results.moves.applyMoves, null, 2));

console.log('\nPOST-APPLY NOTCH CLASSIFICATION (zone centers vs enforced L-polygon):');
if (results.notchClassification) {
  console.log(JSON.stringify(results.notchClassification, null, 2));
  const inNotch = (results.movableToolsInNotch || []);
  console.log('  movable tools with center in notch: ' +
    (inNotch.length === 0 ? 'none' : inNotch.map(z => `${z.id}(moved=${z.moved})`).join(', ')));
  console.log('  ASSERT noMovedToolInNotch = ' + results.checks.noMovedToolInNotch +
    ' (no MOVED movable tool may sit in the notch)');
}

console.log('\n1d EXACT-RESTORE ASSERTION:');
console.log('  exactRestoreAfterRestore = ' + results.checks.exactRestoreAfterRestore);
console.log('  diff = ' + JSON.stringify(results.moves.restore1Diff || []));

console.log('\n1e DOUBLE-RUN RESTORE SEMANTICS:');
console.log('  ' + (results.restoreSemantics ? results.restoreSemantics.answer : 'n/a'));

console.log('\nSHOT FILE SIZES:');
for (const [name, size] of Object.entries(results.shots))
  console.log(`  ${name}: ${size == null ? 'MISSING' : size + ' bytes'}`);

console.log('\nVERBATIM CONSOLE LOG (' + results.allConsoleMessages.length + ' messages, severity-tagged):');
if (results.allConsoleMessages.length === 0) {
  console.log('  (no console output captured)');
} else {
  for (const e of results.allConsoleMessages)
    console.log(`  [${e.type}] ${e.text}${e.url ? '  (' + e.url.split('/').pop() + (e.line != null ? ':' + e.line : '') + ')' : ''}`);
}

console.log('\nTHIRD-PARTY / FAVICON NOISE (excluded from gate, printed for transparency):');
if (!results.thirdPartyNoise || results.thirdPartyNoise.length === 0) console.log('  (none)');
else for (const e of results.thirdPartyNoise) console.log(`  [${e.type}] ${e.text}`);

if (results.error) console.log('\nScript error: ' + results.error);

console.log('\n' + line);
process.exit(results.pass ? 0 : 1);
