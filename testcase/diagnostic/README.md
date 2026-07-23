# SPACE/MOSA Diagnostic Fixture

A floor plan the system has **never seen** (not MRDC 2323), built so every current v2
capability is exercised and every result is **hand-checkable against an answer key**. Use it to
run a live diagnostic of the whole v2 pipeline, and to load the same plan into the v1 app.

## The finding first: one file cannot drive both paths

**The v1 app and the v2 stack have diverged into incompatible formats.** A single JSON cannot
drive both, so this directory ships **two** fixtures:

| | v2 stack (`v2/*.mjs`) | v1 app (`v1/index.html` Import wizard) |
|---|---|---|
| File | `diagnostic-plan.v2.json` | `diagnostic-project.app.json` + `diagnostic-floorplan.svg` |
| Schema | `schema/space-project.v2.json` (2.1.0) | `{kind, elementDefs[], zones{}, regions[]}` |
| Room geometry | `room.polygonPct` + `structuralGeometry.walls/doors` (data) | **only the floorplan image**; scale from a 2-point calibration |
| Zones | detected from the wall graph | not represented (shown as colored `regions` shades only) |
| Machine attributes | hazards, clearance zones, amenity links, occupancy, power | **none** — just `id/label/risk/cat/w/h/dba_active` |

The app reads none of the v2 schema; the v2 stack reads none of the app's image/calibration. This
is a real architectural gap, not a packaging choice — it is reported here rather than papered over.

### What the app fixture LOSES vs the v2 fixture (lost-in-translation list)

- **Interior zone walls + the bridge door** — the app has no wall/door data model; they exist only
  as lines in the floorplan image.
- **The 3-zone partition as data** — zones A/B/C survive only as `regions` color shades and as
  pixels in the image; the app cannot compute per-zone areas or detect the unreachable zone.
- **All hazard flags** (`dustProducing`, `sparkSource`, `hotWork`, `wetProcess`, `flammable`, …).
- **All clearance zones** (kickback cone, infeed/outfeed corridors, operator envelopes, …).
- **All amenity links** (welding→fire extinguisher, grinder→eyewash, …) — the app has no linkage model.
- **Occupancy** (`operatorCount`, `personSpaceAreaUnits`, …).
- The intentional **ADA pinch** and **unreachable zone C** survive only as geometry a human must
  read off the image; the app cannot flag them from data.
- Exits are the one thing that translates: the v2 `exit-to-outside` doors become `cat:"exit"`
  elements (`exitA`, `exitB`). The interior **bridge** door has no app representation.

## How to run the v2 diagnostic

```bash
node v2/run-diagnostic.mjs
```

Runs the full pipeline in order — **schema validation → zone detection → geometry validation →
blocker translation → per-zone simulation → generalized MOSA (3 engine objectives) →
frontier/knee** — plus amenity-linkage and prohibited-adjacency checks over the E1 attributes, and
prints PASS/FAIL per expectation (expected vs computed). It does **not** stop on the first failure.
Expected result: **25 PASS / 0 FAIL**.

## How to load the app fixture in the browser

1. Open `v1/index.html` in a browser. Click **Import Project**.
2. **Floorplan image:** choose `testcase/diagnostic/diagnostic-floorplan.svg`.
3. **Scale calibration:** the image has two red markers on the top edge — **A** (left, 0 ft) and
   **B** (right, 60 ft), exactly 900 px apart. Click **A**, then **B**, and enter **60** with unit
   **ft**. This yields **15 px/ft** every time (deterministic).
4. **Project JSON:** choose `testcase/diagnostic/diagnostic-project.app.json`.

The app will show the 12 elements (8 machines, 2 amenities, 2 exits) at their positions with the 3
zone shades. Remember: the app sees none of the hazards/clearances/links/walls above.

## Answer key (human-readable)

**Geometry** — room 60 × 40 ft with a 15 × 12 ft SE notch:
- Total room area **2,220 ft²**. Zone count **3**.
- Zone A (top-left) **750 ft²**, reachable (exit A + bridge).
- Zone B (right) **1,020 ft²**, reachable (exit B + bridge).
- Zone C (bottom-left) **450 ft²**, **UNREACHABLE** — no door; excluded from the building aggregate.
- Doors: **2 exit-to-outside** (exitA, exitB) + **1 interior-bridge** (A↔B).

**Amenity links** (straight-line center-to-center; the true travel distance is longer, so a
violation is conservative):
- `weld → fireExtinguisher` ≈ 8.2 ft < 30 → **SATISFIED** (NFPA 10).
- `laser → fireExtinguisher` ≈ 18.2 ft < 30 → **SATISFIED** (NFPA 10).
- `wjet → eyewash` ≈ 41.9 ft < 55 → **SATISFIED** (ANSI Z358.1).
- `grind → eyewash` ≈ 59.0 ft > 55 → **VIOLATED** (ANSI Z358.1). ← the deliberate violation.
- Other library links (dust collection, fume hood, flammables cabinet) have no amenity of that type
  placed → reported **UNSATISFIABLE** (informational, not a failure).

**Prohibited adjacencies** (hazard-separation matrix, within 10 ft):
- `sander × elec` — dust-producing next to dust-sensitive (≈ 6.6 ft).
- `weld × tsaw` — spark source next to dust producer (≈ 4.9 ft).
- `grind × laser` — hot-work next to spark/dust (≈ 7.6 ft). **This one the diagnostic surfaced; the
  initial hand-analysis missed it** — a small demonstration that the fixture's checker is doing real work.

**Simulations** (what they should catch):
- **ADA:** a deliberate **~2 ft (< 36 in) pinch** between `tsaw` (y 8–10 ft) and `wjet` (y 12–14 ft)
  across the bridge→exitB path. Per-zone ADA non-compliance is **> 0** in the reachable zones (~0.19).
- **Egress:** the deliberate egress problem is **zone C having no exit** — it is detected as
  unreachable and **excluded from the aggregate**; zones A and B seed egress from their exits and the
  bridge and report a defined egress in [0,1].
- **MOSA:** the generalized 3-objective driver returns a **non-empty, mutually non-dominated**
  Pareto front, deterministic across runs at the fixed seed. *Note:* whole-stage MOSA does not see the
  v2 structural doors (there are no `cat:"exit"` machines), so its seed **egress reads 0.5** (the
  unreachable artifact); the **per-zone sim** is the egress-aware path. This is expected, and is itself
  a documented consequence of the app/v2 divergence.
- **Frontier:** `presentFront` returns a defined knee, origin-knee, and a per-objective best.

The machine-readable answer key lives at **`meta.expectations`** inside `diagnostic-plan.v2.json`
(not at the top level: the v2 schema's top level is `additionalProperties:false`, so an extra
top-level key would fail validation — `meta` is `additionalProperties:true` and is the correct home
for an answer key. A small note on schema strictness.)

## Files

| File | Purpose |
|---|---|
| `diagnostic-plan.v2.json` | The v2 fixture (schema 2.1.0) + the `meta.expectations` answer key. |
| `diagnostic-project.app.json` | The degraded v1-import fixture (elementDefs + positions + regions). |
| `diagnostic-floorplan.svg` | Floorplan drawn to 15 px/ft with the A→B = 60 ft calibration markers. |
| `../../v2/run-diagnostic.mjs` | The runner (loads the v2 fixture, runs the pipeline, checks the answer key). |

Nothing here modifies any engine file, the v2 seam, the frozen project, or any frozen artifact; the
frozen WSC pin and all suites (V0, G1, G2, G3, O1, E1) still reproduce.
