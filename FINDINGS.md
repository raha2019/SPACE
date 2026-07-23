# SPACE — Validation Findings

Results from headless validation (seed 0x4D524443, 4000 iterations, real MRDC 2323
geometry). **Final freeze (Phase 2d):** both feasibility AND the objective grids respect the
6-vertex L-polygon. Companion to MOSA_DESIGN.md, BUGS.md, and tools/mosa_validate.mjs.

---

## Phase 2d Baseline — MRDC 2323, objective-grid-corrected FINAL FREEZE (2026-07-08)

**Stage:** 96.6 ft × 88.6 ft bounding box. 6-vertex L-shaped polygon.
Shoelace area = 6278.76 sf (matches layout.json stated value of 6275 sf; Δ = 0.06%).
Source: GT MRDC drawing 1615813303111-2nd_floor_MRDC__3_.pdf, scale 9 pts/ft.

**Feasibility** is enforced against the polygon (Phase 2c: `getAnalysisRooms()`=1 room, 6
vertices; `pointInAnalysisScope(47.5,83)=false`, `(41.5,60)=false`, `(20,20)=true`,
`(50,52)=true`). **Objective grids** now also respect the polygon (Phase 2d): the excluded SE
notch is filled by a structural wall (`notch_mrdc2323`, rect x∈[40.994,100]%, y∈[54.853,100]%,
`subtype=wall`, `blocksMovement=true`, added as data — no engine edit). Grid probes: open notch
cells `(60,80)`/`(80,90)` flip walkable→blocked (`0→1`) in the ADA and egress grids and gain a
35 dB STC barrier; interior cells `(70,30)`/`(10,90)` unchanged.

| Objective | Baseline | Knee | Best front member | Change at knee |
|-----------|----------|------|-------------------|----------------|
| ADA (violation fraction) | 13.83% | 13.21% | 12.42% | −4.5% relative |
| Egress (travel objective) | 42.75% | 41.25% | 41.00% | −3.5% relative |
| Noise (energy exposure)   | 39.10%† | 25.12% | 16.89% | −35.8% relative† |
| Scalar (equal weights)    | 31.89%† | 26.53% | — | — |

†Noise baseline is the 10-seed stability mean (range 37.01–41.41%; canonical-seed value 40.59%).
Scalar uses stability mean for noise. Noise improvement at knee = (39.10 − 25.12) / 39.10.

Pareto front: **18 solutions**, all 18 dominate the baseline at the canonical seed (18/18).
Infeasible rate: **50.6%** (2025 / 4000 iterations) — unchanged vs the 2024 of Phase 2c (+1 move):
footInside already excluded the notch from feasibility, so the objective correction did not move
the feasible region. The baseline objective vector DID move (10.37/30.25/41.68 → 13.83/42.75/40.59)
because the ADA/egress/noise GRIDS now exclude/attenuate the notch (see the before/after below).
Canary: **PASS** — ada/egress within ±5 pp of pinned; noise within ±6.40 pp of stability mean (spread 4.40 pp + 2 pp margin).
Archive non-domination invariant: **PASS**.

### Objective before/after (Phase 2c bounding-box grids → Phase 2d L-room grids)

| Objective | Before | After | Δ | Why it moved (or didn't) |
|-----------|--------|-------|---|--------------------------|
| ADA | 10.37% | 13.83% | +3.46 pp | Notch cells left the ADA walkable-area denominator; failing cells are a larger fraction of the *real* floor. |
| Egress | 30.25% | 42.75% | +12.50 pp | The as-is `exitS` sits inside the notch; walling it off isolates that exit, leaving `exitN` as the only usable one → max travel distance rises. |
| Noise | 41.68% | 40.59% | −1.09 pp | The notch wall (35 dB STC) attenuates propagation into/through the notch, removing some action cells. The noise metric's denominator is the full grid by design, so this is attenuation, not exclusion. |
| Infeasible | 50.6% (2024) | 50.6% (2025) | +1 move | footInside already handled feasibility; the wall's only collision effect is the 0.3%-inset boundary sliver. The front change (10→18) is driven by the objective correction (worse, more realistic baseline → more headroom), not feasibility. |

---

## Gate 1 — Browser Behavior Notes

Gate 1 re-run 2026-07-08 under the **objective-grid-corrected MRDC 2323 configuration** (via
`tools/verify_phase1.mjs`, which serves the repo on a local port, seeds `localStorage` from the real
bundle + configuration + `mrdc2323-scale.json` **including the L-shaped floor room AND the SE-notch
wall**, and drives the page with Playwright/Chromium). Result: **PASS** on all nine required criteria —
page + modules loaded, **browser enforces the 6-vertex L-polygon** (`getAnalysisRooms()`=1, 6 vertices,
`inScope(47.5,83)=false`, `inScope(20,20)=true`), non-empty frontier (browser MOSA is unseeded, so front
size varies run-to-run — 7 members this run), 13 zones moved on Apply, exact field-by-field restore
(`diff = []`), **no moved movable tool center in the notch**, legacy optimizer completed (dialog fired —
see the score-0 note below), and **zero console errors or warnings from our modules**. The browser
baseline row now reads **ADA 13.83% / egress 42.75%** (matching the harness's corrected seed-independent
values exactly), confirming the browser session carries the notch blocker in its objective grids.
Artifacts: `shots/00-before.png`,
`shots/01-front.png`, `shots/02-applied.png`, `shots/03-final.png`, `results/gate1.json`.

**Enforcement side-effect in the browser (real, not a bug to fix here):** with the polygon active,
`_scTools()` filters candidate tools by `_scInScope()` (center in scope). The default position of `xr`
(center 47.5, 83) is inside the SE notch, so the browser drops `xr` from the movable set entirely — the
browser optimizes 13 of the 14 tools, and `xr` stays stranded at its notch default. The headless harness
does not hit this because it passes an explicit `movableIds` list (all 14), so it optimizes `xr` out of
the notch. The post-apply notch classification confirms only `xr` (movable, **un-moved**) and `exitS`
(fixed) have centers in the notch; **no MOVED tool lands in the notch** (`footInside` samples the AABB
center, so any placed tool clears it). This is the practical face of Known Weakness #3: notch-default
positions are handled by silent exclusion (browser) or by optimization away (harness), not by repair of
the source data.

### Double-run Restore semantics
Each MOSA run snapshots the pre-run layout at the moment it starts (inside `_runMosa`); clicking
Restore reverts to **that run's** snapshot. So a second run's Restore lands on the layout as it stood
at the **start of the second run** — which equals the original pre-first-run layout only because run 1's
Restore was exact. Gate 1 (2026-07-07) confirmed `run2RestoreMatchesPreRun2: true` and
`run2RestoreMatchesOriginal: true`; the operative semantic is start-of-second-run, and demos should not
assume a second Restore reaches back past an intervening run.

---

## Resolved Assumptions

### [A1] RESOLVED — Real MRDC 2323 stage scale (and, as of Phase 2c, enforced)
- **Was:** placeholder 100 ft × 75 ft stage; absolute ADA egress distances and noise
  propagation distances were ungrounded.
- **Now:** 96.6 ft × 88.6 ft bounding box; L-polygon injected as a structural floor element
  AND re-registered in `state.zones` after the harness rebuild, so `getAnalysisRooms()`
  returns the room and `pointInAnalysisScope`/`footInside` use the true 6-vertex shape, not
  the bounding rectangle. (Phase 2b caveat retracted — see the "Notch enforcement" resolution below.)
- **Source file:** `testcase/hub/mrdc2323-scale.json` (derived from `testcase/hub_real/layout.json`).
- **Cross-check:** shoelace area 6278.76 sf vs. architectural stated value 6275 sf (0.06% Δ).

### [A2] RESOLVED — Per-tool noise levels
- **Was:** proxy formula `70 + 5 × risk_score` dB.
- **Now:** literature-derived `dba_active` values per tool from NIOSH/OSHA 3740 and
  published measurement studies. Sources cited in `dba_source` fields in `default-elements.json`.

---

## Known Weaknesses

### Known Weakness #1 — Door locations unverified
The `testcase/hub_real/layout.json` contains four door entries, all with
`"verified": false`. Door positions are inferred from the architectural drawing and have
not been confirmed against the current physical layout. ADA door-width checks and egress
grid exits depend on these coordinates. **Impact:** egress path length and ADA accessibility
scores carry positional uncertainty for exit zones. **Action:** field-verify door coordinates
before citing egress/ADA absolute values in a published report.

### Known Weakness #2 — BUG #3 and BUG #4 still open
ADA door-width checks and egress grid exit creation use a `cat`-based detection schema
(imported default bundles) that does not recognize Element Builder doors and exits
(`elementClass + subtype`). See BUGS.md for full description. These bugs are intentionally
left open in Phase 1; they do not affect the MOSA optimization objective values for the
default-configuration testcase, which uses imported bundle elements.

### Known Weakness #3 — Initial zone positions inside the SE L-notch — CONSTRAINT ENFORCED (Phase 2c); source data still uncorrected
Several zones in `default-configuration.json` are placed in the SE notch of the L-shaped
floor (x > 40.99%, y > 54.85% in stage coordinates). Under Phase 2c enforcement the harness
classifies the as-is baseline as: **fully in notch** — `exitS` (center 94.75, 83.25),
`xr` (center 47.50, 83.00); **partially in notch** — `craftland`, `corridor`, `connector`,
`rightOpen` (2 of 5 AABB samples each). `exitS` being an emergency exit stranded outside the
usable polygon is the most notable data-quality issue: the default positions were laid out on
the full rectangle and predate the L-polygon.

**Empirical result of enforcement (Phase 2c Gate 1 + harness):**
- **Harness** passes an explicit `movableIds` list (all 14 tools), so it optimizes `xr` and
  every other movable tool *out* of the notch; `footInside` (which samples the AABB center)
  guarantees no placed tool keeps a notch center. The 50.6% infeasible rate reflects the notch
  now binding.
- **Browser** selects movables via `_scTools() → _scInScope()`, which drops any tool whose
  *current* center is in the notch. So the browser silently excludes `xr` from optimization and
  leaves it at its notch default (13 of 14 tools optimized). Post-apply classification confirms
  **no MOVED tool sits in the notch**; only `xr` (movable, un-moved) and `exitS` (fixed) do.
- **AABB-sampling gap:** the specific footInside gap (a tool with center in-scope but a corner in
  the notch, or vice-versa) was **not** reproduced — no moved tool landed in the notch in either
  run. The gap remains theoretically open but is unobserved here.

**Still not fixed (deliberately):** the notch-occupying **default positions** in
`default-configuration.json` are a real-world data-quality observation about the as-is layout,
not corrected this phase. Correcting them (or dropping `exitS`/`xr` notch placements) is a
data change, separate from the constraint-enforcement fix.

> **Supersedes the Phase 2b correction:** the earlier note said the notch was *not* enforced
> because the harness wiped the floor zone from `state.zones` at `mosa_validate.mjs:214`. Phase 2c
> fixes exactly that — the floor room is re-registered after the rebuild, so
> `getAnalysisRooms()`=1 and `pointInAnalysisScope(47.5,83)=false`. The "Notch enforcement" item
> under Out-of-scope observations is now **RESOLVED** (see below).

---

## Robustness Notes

Phase 0 (placeholder 100 × 75 ft, 1120 iters, seed 0x4D524443):

| Objective | Phase 0 baseline | Phase 1 baseline | Change |
|-----------|-----------------|-----------------|--------|
| ADA       | 11.49%          | 10.37%          | −1.12 pp (larger stage, better spread) |
| Egress    | 29.75%          | 30.25%          | +0.50 pp (longer travel in real 96.6 ft stage) |
| Noise     | 45.63%          | 41.68%          | −3.95 pp (real tool dBA vs. proxy) |

Infeasible rate: 42.5% (Phase 0, placeholder) → 39.8% (Phase 1, bounding box, notch NOT
enforced) → **50.6% (Phase 2c, notch enforced)**. The Phase 1→2c rise is the direct signature
of the polygon constraint becoming binding: moves into the SE notch that previously passed are
now rejected.

Cross-seed robustness table (4,000 iterations each, **objective-grid-corrected**; canonical
re-run confirms bit-for-bit determinism):

| Seed | Front | Dom/Total | Baseline ADA | Baseline Egress | Baseline Noise | Best Noise↓ | Knee Noise | Infeas% | Canary |
|------|-------|-----------|-------------|-----------------|----------------|-------------|-----------|---------|--------|
| 0x4D524443 (canonical) | 18 | 18/18 | 13.83% | 42.75% | 40.59% | 58.4% | 25.12% | 50.6% | PASS |
| 0x0001                 | 7  | 7/7   | 13.83% | 42.75% | 38.91% | 59.7% | 18.23% | 51.3% | PASS |
| 0xBEEF                 | 4  | 4/4   | 13.83% | 42.75% | 37.01% | 65.1% | 15.06% | 50.8% | PASS |

Qualitative story under the corrected grids: dominating fraction **100% at every seed**, large
best-member noise reduction (**≥ 50%** at every seed, 58.4–65.1%), and infeasible rate near 50%
at every seed (50.6–51.3%). Front size ranges **4–18**. GATE 2 (cross_seed_check.mjs): PASS —
canonical re-run bit-for-bit identical, canary PASS on all three seeds.

### Known Weakness #4 — Noise baseline is seed-dependent — RESOLVED-AT-REPORTING-LAYER (Phase 2b)

ADA and egress objective values for the initial configuration are seed-independent
(deterministic BFS and grid checks). The noise objective still draws from the seeded PRNG
during the initial layout evaluation (`evaluateLayout`'s 25-draw Monte Carlo). The
underlying MC-in-baseline coupling is **unchanged by design in this phase** — no scoring,
sim, or optimizer code was touched. The weakness is resolved at the harness/reporting layer:

- **Characterization:** the baseline noise objective is now evaluated under **10 documented
  seeds** (0x4D524443, 0x0001, 0xBEEF, 0xCAFE, 0x1234, 0x5678, 0x9ABC, 0xDEF0, 0x2323,
  0x6275) in a PRNG-isolated pass that runs before the main optimization. Result:
  mean **39.10%**, min 37.01%, max 41.41%, sd 1.23 pp, **spread 4.40 pp** (under the Phase 2d
  corrected grids). ADA (13.83%) and egress (42.75%) are identical across all 10 seeds
  (confirmed). Data pinned in `tools/baseline-mrdc2323.json → noise_stability`.
- **Reporting rule:** cite noise **improvements** against the stability mean (39.10%); cite
  **determinism / exact reproducibility** against the pinned canonical-seed value (40.59%).
- **Canary hardening:** the noise canary references the stability **mean** with tolerance
  = observed **spread + 2 pp margin** (both computed from the stability data, not hardcoded),
  giving an effective noise tolerance of **±6.40 pp** (spread 4.40 + 2). ADA and egress keep the
  exact-value ±5 pp check. The effective noise tolerance is printed in every validation run.
- **PRNG isolation proof:** the stability pass saves/restores `Math.random` and `state.zones`;
  the main run re-seeds `Math.random = _harnessLCG(0x4D524443)` fresh immediately before
  `mosaOptimize`. Three consecutive `npm run validate` runs are bit-for-bit identical with the
  final pin, canary PASS on all three — the pass does not perturb the main run.

**Phase 2d update:** unlike Phase 2c, the 10-seed noise stability values **did change** here
(mean 39.90% → 39.10%, spread 5.26 → 4.40 pp), because the notch wall attenuates propagation in
the noise grid. ADA/egress remain seed-independent (now 13.83%/42.75%). Canary noise tolerance
recomputed to ±6.40 pp.

**Not done (deliberately):** making the noise MC deterministic in `sim_noise`/`sim_eval`
(would change the pinned vector; out of scope).

Determinism (final freeze): three independent `npm run validate` runs at seed 0x4D524443
produce bit-for-bit identical output, canary PASS on all three — the harness is deterministic
per seed at full IEEE-754 precision (canonical SEEDVEC_JSON: ada=0.13827363048035732,
egress=0.4275, noise=0.40589569160997735).

---

## Key Interpretive Notes

**Noise dominates the optimization opportunity.** Against the 10-seed stability mean
(39.10%), the noise objective drops to ≈16.89% at the best front member — a 56.8% reduction
(−58.4% against the pinned single-seed 40.59%). At the knee, noise drops 35.8% relative to
the mean while ADA improves 4.5% and egress improves 3.5%. This reflects the strong spatial
dependence of noise propagation: moving loud tools away from workstations has a large
nonlinear effect, while egress is now bounded by the single usable exit (exitN).

**All 18 front members dominate the baseline at the canonical seed (18/18).** The default
Invention Studio layout is not Pareto-optimal under the three objectives — every solution the
optimizer found at the pinned seed is strictly better on at least one objective without being
worse on any. Across robustness seeds the dominating fraction varies (see the corrected
cross-seed table); the canonical-seed result is the pinned claim.

**Egress improvement is bounded.** The best egress improvement (4.1%) reflects that exit
locations are fixed. With the as-is `exitS` walled off inside the notch (Phase 2d), egress
relies on the single north exit (`exitN`), so moving workstations has limited effect on the
maximum travel distance to it. Exit placement becomes user-configurable in v2.

---

## Out-of-scope observations

1. **Notch — RESOLVED for BOTH feasibility (Phase 2c) and objectives (Phase 2d).**
   *Feasibility (2c):* the harness re-registers the L-floor zone after the `state.zones` rebuild
   (it was previously dropped), so `getAnalysisRooms()`=1 and `pointInAnalysisScope`/`footInside`
   exclude the notch. *Objectives (2d):* the objective grids in `evaluateLayout` still iterated the
   full bounding box, counting the notch as usable floor; fixed by adding a structural wall
   (`notch_mrdc2323`) filling the notch as data, so the existing ADA/egress grid builders mark those
   cells blocked and `sim_noise` rasterizes them into the STC grid — no engine edit. Verified with
   grid probes (open notch cells flip `0→1`, interior cells unchanged, STC `0→35`). Combined effect:
   baseline moved 10.37/30.25/41.68 → 13.83/42.75/40.59, front 10 → 18 (18/18 at canonical seed);
   infeasible unchanged at 50.6% (footInside already handled feasibility). Final pin in
   `tools/baseline-mrdc2323.json`; the Phase 2c and Phase 1 pins are preserved in the supersession chain.

2. **Browser MOSA is non-deterministic by default.** The interactive app calls
   `mosaOptimize()` without `opts.seed` unless `state.mosaSeed` is set, so its front varies
   run-to-run (uses live `Math.random`). This is by design for interactive use, but means a live
   demo will not reproduce the pinned front. If a deterministic demo is wanted, set `state.mosaSeed`.

3. **Legacy `#optimizeLayoutBtn` reports score 0/100 under enforcement (constrained, not fixed).**
   With the L-floor room registered, the legacy auto-arrange optimizer (`optimize.js` → `scoring.js`
   via `state.score`) reports the current layout's score as **0/100** and finds no improvement
   ("no better arrangement found"), whereas in the Phase 2b bounding-box config it reported
   "score 79 → 97/100". This is a scoring interaction in the constrained `scoring.js`/`optimize.js`
   path (the weighted score collapses to 0 once the analysis scope is the L-polygon), **not** a
   seeding artifact — in the same session the MOSA baseline read ADA 13.83% / egress 42.75% exactly,
   confirming the state is seeded correctly. The **MOSA research pipeline is unaffected** (valid
   non-empty browser front, 18-member front in the headless harness). The legacy optimizer is a separate
   Phase-1 auto-arrange placeholder, not the research artifact; investigating its scoring under
   enforcement touches constrained files and is deferred.

4. **Browser drops notch-default tools from optimization.** `_scTools() → _scInScope()` excludes
   any tool whose current center is in the notch, so the browser optimizes 13 of 14 tools and leaves
   `xr` at its notch default. The headless harness (explicit `movableIds`) optimizes all 14. Neither
   is a bug to fix here; both are downstream of the as-is notch default positions (Weakness #3).

5. **BUG #3 / BUG #4 remain open** (ADA door-width and egress exit detection use a `cat`-based
   schema that does not recognize Element Builder `elementClass + subtype` doors/exits). Untouched
   this phase; they do not affect the default-configuration MOSA objectives, which use bundle
   elements with correct `cat` fields.
