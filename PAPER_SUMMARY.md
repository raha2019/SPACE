# SPACE — Paper-Ready Summary (WSC poster freeze)

Georgia Tech MATRIX Lab / PRISM — Invention Studio Layout Optimization
Seed: 0x4D524443 | Iterations: 4,000 | **Final frozen pin (objective-grid-corrected): 2026-07-08**

**Geometry:** both feasibility (footInside) and objective evaluation (ADA/egress/noise grids)
now respect the real 6-vertex L-polygon; the excluded SE notch is represented as a structural
wall so the objective grids treat it as blocked/attenuated, not usable floor.

---

## Geometry and Validation Setup

The Invention Studio occupies a portion of the Marcus MRDC Building, Room 2323, on the
Georgia Tech campus. The room geometry was traced from architectural drawing
1615813303111-2nd_floor_MRDC__3_.pdf at a scale of 9 pixels per foot, yielding a
bounding box of 96.6 ft × 88.6 ft. The usable floor area follows an L-shaped polygon
with six vertices (origin at NW corner, x = east, y = south, units = feet):

    (0, 0), (96.6, 0), (96.6, 48.6), (39.6, 48.6), (39.6, 88.6), (0, 88.6)

Shoelace area: 6,278.76 sf. The SE notch spans x > 39.6 ft, y > 48.6 ft (x > 40.994%,
y > 54.853% in stage coordinates). **Feasibility is enforced against the 6-vertex
L-polygon.** The harness registers the L-shaped floor as an analysis room after building
the zone state, so `getAnalysisRooms()` returns exactly one room (6 vertices, shoelace
area 6,278.76 sf at the active scale) and `pointInAnalysisScope()`/`footInside()` reject
placements in the notch. Probe evidence (Phase 2c): `pointInAnalysisScope(47.5, 83)` (SE
notch) = **false**, `(41.5, 60)` (just past the x-edge) = **false**, `(20, 20)` (NW arm)
= **true**, `(50, 52)` (right arm, below the y-edge) = **true** — all four match the
drawing.

**Objective grids also respect the polygon (final freeze).** Feasibility alone was not
enough: `evaluateLayout`'s ADA, egress, and noise grids originally iterated the full bounding
box, so the notch counted as usable floor in the *reported* objectives. The excluded notch is
now filled by a structural wall (`notch_mrdc2323`, rect x∈[40.994, 100]%, y∈[54.853, 100]%,
`subtype=wall`, `blocksMovement=true`) added purely as data — no engine file changed. The
existing grid builders then treat those cells the same way they treat any wall: ADA and egress
mark them blocked, noise rasterizes them into the STC grid. Grid probes confirm it — the open
notch cells `(60, 80)` and `(80, 90)` flip from walkable to blocked (`0→1`) in both the ADA and
egress grids and gain a 35 dB STC barrier, while interior cells `(70, 30)` and `(10, 90)` are
unchanged.

Validation harness: tools/mosa_validate.mjs, run in a Node.js vm context, both feasibility and
objective grids polygon-correct. Determinism confirmed: three independent runs at the pinned
seed (4,000 iters each) produce bit-for-bit identical output at full IEEE-754 precision
(SEEDVEC_JSON: ada=0.13827363048035732, egress=0.4275, noise=0.40589569160997735). The archive
satisfies the Pareto non-domination invariant (verified algorithmically after each run).

**Feasibility was essentially unchanged by this correction.** footInside (Phase 2c) already
excluded the notch from feasibility, so the wall's collision effect is only the 0.3%-inset
boundary sliver: the infeasible-move rate is 50.6% before and after (2024 → 2025 moves, +1 of
4,000). The objective values moved because the *grids* changed, not because the feasible region
changed.

---

## Baseline Configuration

The baseline represents the current default Invention Studio layout imported from
default-configuration.json. Objective values are evaluated by sim_eval.js without
running the optimizer.

| Objective              | Symbol | Baseline value (objective grids over the real L-room) |
|------------------------|--------|-----------------------------------------|
| ADA violation fraction | f_ada  | 13.83% (seed-independent)               |
| Egress travel objective| f_eg   | 42.75% (seed-independent)               |
| Noise energy objective | f_ns   | 39.10% mean (range 37.01–41.41%, sd 1.23 pp across 10 seeds) |
| Equal-weight scalar    | f_s    | 31.89% (using noise mean)               |

ADA and egress are exact, deterministic values (identical across all 10 evaluation
seeds). The noise objective is seed-dependent because `evaluateLayout`'s 25-draw Monte
Carlo runs under the harness PRNG; it is therefore reported as the 10-seed stability mean
(39.10%) with its range. For determinism and exact reproducibility claims, the pinned
single-run noise value is **40.59%** at the canonical seed 0x4D524443 (see Reproducibility).

These describe the **real L-room**: the excluded notch no longer counts as usable floor.
Relative to the earlier bounding-box objectives, ADA rose 10.37→13.83% (notch cells left the
walkable denominator), egress rose 30.25→42.75% (the as-is exitS lies inside the notch and is
walled off, leaving exitN as the effective exit), and noise fell 41.68→40.59% (the notch wall
attenuates propagation that previously crossed it). See the before/after in FINDINGS.md.

Per-tool noise levels (dba_active) are drawn from NIOSH/OSHA 3740 and published
field measurement literature, with source citations in default-elements.json.

---

## Multi-Objective Simulated Annealing (MOSA)

Optimizer: Pareto-archive SA (sim_mosa.js). Objectives: minimize {f_ada, f_eg, f_ns}
simultaneously. Archive: ε-dominance non-dominated set, capped at 40 members.
Neighborhood moves: translate, swap, rotate, nudge, mirror (zone-level).
Feasibility constraint: all five AABB corner/center samples must lie inside the analysis
scope (`pointInAnalysisScope` via `footInside`) — the enforced 6-vertex L-polygon — and not
collide with obstacles or other movables (which now include the notch wall).
PRNG: Mulberry32 seeded at 0x4D524443, globally patched before each run.
Temperature schedule: geometric cooling, T0 = 1.0, alpha = 0.9995,
T_min ≈ 5e-3 (final T at 4,000 iters: 4.996e-3).

Run statistics at 4,000 iterations (feasibility + objective grids polygon-correct):

    Accepted moves : 1,553
    Rejected moves :   422
    Infeasible     : 2,025  (50.6% infeasible rate; unchanged vs the 2,024 of Phase 2c)
    Total archived :    86  (non-dominated solutions seen over the run)
    Final archive  :    18  (Pareto front at termination)

---

## Pareto Front Results

Archive at termination (objective-grid-corrected): **18 solutions**.
All 18 solutions Pareto-dominate the baseline configuration (18/18 at the canonical seed).
The larger front vs. Phase 2c (10) follows from the more realistic — and worse — baseline:
more headroom, and an egress surface that now varies with exit routing.

Best single-objective improvement across all 18 front members:

| Objective | Baseline        | Best in front | Improvement |
|-----------|-----------------|---------------|-------------|
| ADA       | 13.83%          | 12.42%        | −10.2%      |
| Egress    | 42.75%          | 41.00%        | −4.1%       |
| Noise     | 39.10% (mean)   | 16.89%        | −56.8%      |

Noise improvement is cited against the 10-seed stability mean (39.10%); the best front
member's noise (≈16.89%) is the canonical-seed value. Against the pinned single-seed noise
(40.59%) the reduction is −58.4%. The noise objective has the largest headroom by a wide margin.
The egress improvement is bounded by exit locations; with the as-is exitS walled off inside the
notch, moving workstations has limited effect on maximum travel distance to the one usable exit.

---

## Knee Point (Balanced Trade-off Solution)

The knee was identified by min-max normalizing the 18 front members across each
objective, then selecting the solution with minimum Euclidean distance to the ideal
(all-zeros) point.

| Objective | Baseline       | Knee   | Absolute Δ | Relative Δ |
|-----------|----------------|--------|------------|------------|
| ADA       | 13.83%         | 13.21% | −0.62 pp   | −4.5%      |
| Egress    | 42.75%         | 41.25% | −1.50 pp   | −3.5%      |
| Noise     | 39.10% (mean)  | 25.12% | −13.98 pp  | −35.8%     |
| Scalar    | 31.89% (mean)  | 26.53% | −5.36 pp   | −16.8%     |

Noise and scalar baselines use the 10-seed stability mean; the knee's noise (25.12%) is
the canonical-seed value. The knee still delivers the largest gain on noise while improving
ADA and egress, making it the operationally preferred solution under equal weights.

---

## Robustness

Cross-seed robustness verified at seeds 0x4D524443, 0x0001, 0xBEEF (4,000 iters each,
objective-grid-corrected). Each run is bit-for-bit deterministic (canonical re-run identical):

| Seed | Front | Dom/Total | Dom% | Bl. ADA | Bl. Egress | Bl. Noise | Best Noise↓ | Knee Noise | Infeas% | Canary |
|------|-------|-----------|------|---------|-----------|-----------|-------------|-----------|---------|--------|
| 0x4D524443 | 18 | 18/18 | 100% | 13.83% | 42.75% | 40.59% | 58.4% | 25.12% | 50.6% | PASS |
| 0x0001     | 7  | 7/7   | 100% | 13.83% | 42.75% | 38.91% | 59.7% | 18.23% | 51.3% | PASS |
| 0xBEEF     | 4  | 4/4   | 100% | 13.83% | 42.75% | 37.01% | 65.1% | 15.06% | 50.8% | PASS |

Pareto front size ranges from **4 to 18 members** across the tested robustness seeds
(4 at 0xBEEF, 7 at 0x0001, 18 at the canonical seed). Qualitative story under the corrected
grids: **100% of front members dominate the baseline at every tested seed**, **≥ 50% best-member
noise reduction at every seed** (58.4–65.1%), and the infeasible rate sits near 50% at every
seed (50.6–51.3%). Baseline ADA (13.83%) and egress (42.75%) are seed-independent; baseline noise
varies 37.01–40.59% across seeds (the seeded 25-draw noise MC).

Note: ADA and egress baselines are seed-independent (deterministic). The noise baseline
varies across seeds (mean 39.10%, range 37.01–41.41%, spread 4.40 pp over 10 documented
seeds, under the corrected grids) because `evaluateLayout`'s 25-draw Monte Carlo runs under
the seeded PRNG. Cite noise improvements against the stability mean (39.10%); cite determinism
against the pinned canonical-seed value (40.59%). See FINDINGS.md Known Weakness #4
(RESOLVED-AT-REPORTING-LAYER).

**Caveat (as-is exit placement).** The default exit positions reflect the as-is studio
configuration; the south exit (`exitS`) is recorded inside the excluded SE notch, so once the
notch is treated as non-room it is walled off and egress relies on the north exit. This raises
the egress objective and is a truthful depiction of the as-is data, not an artifact. Exit
placement becomes user-configurable in v2 (the seam already carries structural elements as data).

---

## Reproducibility

- **Headline run (determinism anchor):** seed 0x4D524443 ("MRDC"), 4,000 iterations.
  Exact objective vector, full IEEE-754 precision:
  ada = 0.13827363048035732, egress = 0.4275, noise = 0.40589569160997735.
  Three independent runs at this seed produce bit-for-bit identical output; the canary
  (tools/mosa_validate.mjs) re-checks this vector on every validation run.
- **Noise baseline characterization:** the noise objective is characterized over 10
  documented seeds (0x4D524443, 0x0001, 0xBEEF, 0xCAFE, 0x1234, 0x5678, 0x9ABC, 0xDEF0,
  0x2323, 0x6275): mean 39.10%, min 37.01%, max 41.41%, sd 1.23 pp, spread 4.40 pp. ADA
  (13.83%) and egress (42.75%) are identical across all 10 seeds. Full data in
  tools/baseline-mrdc2323.json → `noise_stability`.
- **Front-size range:** 4 to 18 Pareto-front members across the robustness seeds
  (4 at 0xBEEF; 7 at 0x0001; 18 at the canonical seed). Domination fraction 100% at every seed.
- **Seeding mechanisms:** the headless harness patches `Math.random` globally at the
  pinned seed before invoking `mosaOptimize`, whereas the optimizer's `opts.seed` API
  patches `Math.random` internally for the duration of the search; these are distinct
  seeding entry points, each individually deterministic under a fixed seed (the interactive
  app leaves the RNG unseeded by default, so its front is non-deterministic unless
  `state.mosaSeed` is set).

---

## Key Findings and Interpretation

1. **The current layout is improvable on all three safety objectives simultaneously.**
   At the canonical seed all 18 front members strictly dominate the baseline; across the
   robustness seeds 100% of front members do at every seed. The default layout is not
   Pareto-optimal — the optimizer consistently finds strictly better arrangements.

2. **Noise is the dominant optimization lever.** The 56.8% maximum noise reduction
   against the stability mean (58.4% vs. the pinned single-seed baseline; vs. 10.2% ADA,
   4.1% egress) reflects the strong spatial dependence of noise propagation: relocating
   loud machinery away from workstations has a large nonlinear effect on occupant exposure.

3. **Egress is bounded by exit placement.** The best egress improvement (4.1%) reflects that
   exit locations are fixed and that the as-is south exit lies inside the excluded notch, so
   egress relies on the single north exit. Moving workstations has limited effect on the
   maximum travel distance to it; exit placement becomes user-configurable in v2.

4. **The L-shaped geometry is respected by both feasibility and objectives.** Feasibility:
   the harness registers the L-floor as an analysis room, so `footInside → pointInAnalysisScope`
   rejects notch placements (infeasible rate 39.8% → 50.6% vs. the bounding box). Objectives:
   the notch is filled by a structural wall so the ADA/egress/noise grids treat it as
   blocked/attenuated (grid probes confirm the flip). This moved the baseline objective vector
   (10.37/30.25/41.68 → 13.83/42.75/40.59) and the front (10 → 18); the two effects are cleanly
   separated because the objective correction left the infeasible rate essentially unchanged
   (+1 move). Several baseline default positions sit in the notch (exitS and xr fully;
   craftland, corridor, connector, rightOpen partially) — an as-is data-quality issue in
   default-configuration.json, documented in FINDINGS.md, not silently corrected.

---

## Caveats and Limitations

- Door locations in testcase/hub_real/layout.json are marked "verified: false".
  ADA door-width and egress path calculations depend on these positions. Absolute
  values for ADA and egress objectives should be treated as approximate pending
  field verification.

- The analysis uses a simplified noise propagation model (point-source inverse-
  square-law with STC wall attenuation). Reverberation, equipment duty cycles, and
  simultaneous-use overlap are not modeled.

- BUG #3 (ADA door-width check) and BUG #4 (egress exit creation via Element Builder)
  are known open issues. They do not affect the MOSA results for the default-
  configuration testcase, which uses imported bundle elements with correct cat fields.

- Zone dimensions and the default zone configuration represent a computational
  approximation to the physical layout. Physical verification of zone positions and
  extents is required before using these results to justify physical changes.

- Several default positions in default-configuration.json fall inside the SE L-notch
  (exitS and xr fully; craftland, corridor, connector, rightOpen partially). This is an
  as-is data-quality issue in the source layout, documented in FINDINGS.md and not silently
  corrected. The optimizer handles it (harness moves such tools out of the notch; the browser
  drops them from its movable set via `_scInScope`), but the emergency-exit placement (exitS)
  in particular should be field-verified before any physical use.

---

## Files

| File | Contents |
|------|----------|
| testcase/hub/mrdc2323-scale.json | Real MRDC 2323 stage scale and L-polygon (provenance) |
| testcase/hub_real/layout.json | Room boundary vertices and door positions |
| tools/mosa_validate.mjs | Headless validation harness (vm context, canonical seed, polygon-enforced) |
| tools/baseline-mrdc2323.json | Polygon-enforced pin + supersession chain (Phase 1 bounding-box, Phase 0 placeholder) |
| tools/cross_seed_check.mjs | Cross-seed robustness check (3 seeds, bit-for-bit verification) |
| tools/verify_phase1.mjs | Gate 1 browser verification (Playwright, polygon-enforced seeding) |
| results/gate1.json | Gate 1 browser artifacts (enforced) |
| results/gate2.json | Cross-seed robustness table (enforced, 4000 iters, JSON) |
| FINDINGS.md | Known weaknesses, enforcement resolution, and interpretive notes |
