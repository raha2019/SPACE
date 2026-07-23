# Tool-Adjacency Objective — v2 Phase N1

The capability GT MechE asked for: **can two machines sit next to each other?** Built-in defaults
from safety standards, per-pair user override, grounded in Systematic Layout Planning (SLP). It
becomes a first-class MOSA objective (`adjacency`) via the O1 registry. There is no external ground
truth for the *weights*, so the decisions below are the definition; each is justified. No code was
written until this document was complete.

**Correctness bar.** The frozen WSC pin reproduces bit-for-bit and every prior suite passes. No
engine file is modified; adjacency is a pure-geometry objective (machine positions + types + hazard
flags), so its evaluate needs no engine call.

---

## (a) Relationship encoding — grounded in SLP / CORELAP

Every machine-type pair carries one of four levels. They map onto Muther's SLP **REL chart** (A, E,
I, O, U, X) and CORELAP's Total Closeness Rating, so the model sits on established facility-layout
literature:

| N1 level | SLP REL letter | CORELAP closeness value | meaning | **penalty weight** |
|---|---|---|---|---|
| `SYNERGISTIC` | **A / E** (closeness important) | 6 / 5 | want them adjacent (workflow) | **1** |
| `NEUTRAL` | **U** (unimportant) | 2 | no constraint | **0** |
| `DISCOURAGED` | **X** (undesirable) | 1 | prefer separation (mild hazard) | **3** |
| `PROHIBITED` | **X⁺** (extremely undesirable / code) | — | must separate (code) | **10** |

**Two scales, deliberately opposite.** CORELAP's closeness values rank *desirability of being close*
(A highest); N1's penalty weights rank *severity of being wrongly placed* (PROHIBITED highest). The
SLP letters ground the qualitative levels; the penalty weights are a separate, justified severity
ordering: **PROHIBITED : DISCOURAGED : SYNERGISTIC = 10 : 3 : 1**. A code violation (fire/OSHA)
dominates a preference (≈3×), and a preference to separate slightly outweighs a workflow convenience
(3× vs 1×) because a hazard-avoidance default should not be cancelled by a nicety. `NEUTRAL` = 0
contributes nothing. (SLP's finer letters E/I/O are reserved for future sub-levels.)

**Symmetry.** Relationships are **symmetric by default** — a hot-work/dust hazard between A and B is
mutual, and workflow adjacency is bidirectional. An **asymmetric** case (rare; e.g. "A must be
downstream of B") is representable as a `directed: true` entry, which writes only the ordered `(a,b)`
cell; the reverse `(b,a)` falls back through the precedence chain. All rule-derived hazard defaults
are symmetric.

## (b) Where defaults come from — two sources, both provenance-tagged

**1. Rule-derived from E1 hazard flags** — so any machine, including a user-invented one, gets
sensible relationships automatically. Each rule is data in `v2/adjacency-defaults.json` with a
`provenance` clause:

| # | predicate (unordered) | level | required sep | provenance |
|---|---|---|---|---|
| R1 | (`sparkSource`∨`hotWork`) × `dustProducing` | PROHIBITED | **35 ft** | NFPA 51B §5.6 + OSHA 1910.252(a) (hot work, 35 ft combustible clearance); NFPA 664 (wood dust is combustible) |
| R2 | (`sparkSource`∨`hotWork`) × `flammable` | PROHIBITED | **35 ft** | NFPA 51B §5.6, OSHA 1910.252(a); NFPA 30 (flammable liquids) |
| R3 | (`sparkSource`∨`hotWork`) × `dustCollection`* | PROHIBITED | **35 ft** | NFPA 51B; NFPA 664 (dust-collection systems) |
| R4 | (`sparkSource`∨`hotWork`) × `flammableTextile`* | PROHIBITED | **35 ft** | NFPA 51B; textile-distance = design assumption |
| R5 | `sprayFinishing`* × (`sparkSource`∨`hotWork`) | PROHIBITED | **20 ft** | NFPA 33 §6, OSHA 1910.107(c) (spray finishing, 20 ft from ignition) |
| R6 | `wetProcess` × `dustSensitive` | PROHIBITED | **10 ft** | OSHA 1910.303(b)/1910.305(j) (electrical in wet locations); `dustSensitive`→electronics proxy and 10 ft are **design assumptions** |
| R7 | `dustProducing` × `dustSensitive` | DISCOURAGED | **10 ft** | design assumption (dust contamination); NFPA 664 context |
| R8 | `vibrationSource` × `vibrationSensitive` | DISCOURAGED | **10 ft** | design assumption (precision/metrology) |

\* `dustCollection`, `flammableTextile`, `sprayFinishing` are **extension flags** beyond E1's eight —
no library machine sets them today (so R3–R5 are inert), but the rules exist so a user who marks a
spray booth or dust collector gets correct standards behavior. This is flagged in LIMITS.

**2. Explicit pairwise defaults** — override the rule-derived layer for named type pairs, including
`SYNERGISTIC` workflow chains (SLP adjacency), also in `v2/adjacency-defaults.json` with provenance
(all "design assumption (SLP workflow adjacency)"): rough→precision (`bandSaw`↔`tableSaw`),
breakdown→assembly (`tableSaw`↔`assemblyTable`), assembly→finishing (`assemblyTable`↔`sander`),
print→post-process (`printer3d`↔`sander`), PCB mill near electronics (`cncMill`↔`electronicsBench`).

**No entry lacks provenance** — a specific clause where one exists, or the literal `"design
assumption"` where none does. §5 tallies the ratio.

## (c) User override + precedence + conflict resolution

A project may set any pair to any level via `project.adjacency` (schema §2), each with its own
`provenance` note. **Precedence order (highest first):**

1. **user override** (`project.adjacency` entry for the exact type pair)
2. **explicit default** (`v2/adjacency-defaults.json` `pairs` entry)
3. **rule-derived** (hazard-flag rules R1–R8)
4. **NEUTRAL** (nothing applies)

**Conflicting rules — most severe wins.** When a pair triggers several hazard rules at once (e.g.
`sander` (dustProducing) × `electronicsBench` (hotWork **and** dustSensitive) fires R1 *prohibited*
**and** R7 *discouraged*), the resolved level is the **most severe** (PROHIBITED > DISCOURAGED >
SYNERGISTIC > NEUTRAL), and its required separation is the **maximum** among the firing rules of that
level (most conservative). Justification: a safety default must be **conservative** — if any standard
says "prohibited, 35 ft," a milder contamination preference cannot soften it. The diagnostic's answer
key labels `sander×elec` as "dust × dustSensitive"; N1 correctly escalates it to PROHIBITED via
hotWork × dustProducing — reported as a reconciliation finding, not hidden.

## (d) Distance function

**Edge-to-edge**, not center-to-center. A 35 ft hot-work clearance is a clearance between the nearest
points of the two pieces of equipment, not their centroids — a large machine's center can be 35 ft
away while its edge is 20 ft away and still igniting dust. Distance is the minimum gap between the two
machines' **rotation-aware axis-aligned footprints** (0 if they overlap), computed in **real units
(feet)** by converting stage-% via `room.scale` (`x_ft = x% · widthUnits/100`, `y_ft = y% ·
heightUnits/100`). (The diagnostic runner used center-to-center at a flat 10 ft; N1's edge-to-edge +
per-rule standards distance is more physical — a reconciliation difference, noted.)

**Penalty per pair** (CORELAP's "closeness weight × distance dependence", reformulated to a *bounded*
linear shortfall so the objective normalizes cleanly to [0,1] and has no 1/d singularity at d=0):

- **Separation types (PROHIBITED, DISCOURAGED)** — want `d ≥ D_req`:
  `penalty = weight · modeMult · max(0, (D_req − d)) / D_req`
  → **0 when `d ≥ D_req`**, rising linearly to `weight·modeMult` at `d = 0`.
- **Synergy type (SYNERGISTIC)** — want `d ≤ D_ideal` (adjacent, `D_ideal = 5 ft`):
  `penalty = weight · modeMult · min(1, max(0, d − D_ideal) / D_span)` (`D_span = 30 ft`)
  → **0 when `d ≤ 5 ft`**, rising as they move apart. So getting **closer lowers the penalty** —
  synergy is *rewarded*, not merely tolerated (fixture c asserts this sign).

`weight` is the level's penalty weight (a); `modeMult` is the severity multiplier (e).

## (e) Severity mode — score-only in N1, hard-reject deferred to R1

Each relationship carries `mode` ∈ {`strict`, `advisory`}. Both contribute a penalty; **strict is
weighted far more heavily: `modeMult` = strict → 5, advisory → 1.** Default modes: PROHIBITED →
`strict`, DISCOURAGED/SYNERGISTIC → `advisory` (user-overridable). A PROHIBITED-strict pair at `d=0`
scores `10·5 = 50`; a DISCOURAGED-advisory pair scores at most `3·1 = 3` — strict violations dominate.

**Boundary (stated explicitly):** N1 **scores only**. It does **not** hard-reject any layout; a
strict-PROHIBITED violation raises the objective but never makes a layout infeasible. Turning strict
into a **hard feasibility constraint** (rejecting the move in the SA loop / MOSA feasibility gate) is
**Phase R1**. The `mode` field and the strict/advisory weighting are designed so R1 can promote
`strict` to a hard constraint **without redesigning the model** — only the feasibility gate changes.

## (f) Normalization

MOSA minimizes on [0,1]. The objective is the total weighted violation over a worst-case reference:

```
adjacency_objective = clamp( Σ_pairs penalty(pair) / referenceTotal , 0, 1 )
referenceTotal      = Σ_{non-neutral pairs}  (weight · modeMult)     // every constrained pair at MAX violation
```

`referenceTotal` is the penalty if **every** constrained pair were maximally violated (a PROHIBITED
pair overlapping, a SYNERGISTIC pair maximally far). Therefore the objective is **exactly 0 when
every pair is at or beyond its required separation** (all penalties 0) and **rises as violations
accumulate**, reaching 1 only in the degenerate everything-maximally-violated layout. If there are no
non-neutral pairs, the objective is 0 (nothing to violate).

**Composition across zones.** Adjacency is **building-wide** over all machine *pairs* — a hazard
relationship is between two machines, not within one zone, and two incompatible machines in different
zones separated only by open space are still a real hazard. This differs from A1/G3's per-zone sum
(active-users is per-zone occupancy; adjacency is pairwise-geometric). The alternative — scoring only
same-zone pairs — is **rejected** because N1 does not model the wall between zones as a separation
substitute (that is a documented LIMIT, §5); counting cross-zone pairs is the conservative choice
until walls-as-separation is modeled.

---

# LIMITS (Task 5)

## Provenance tally — how much authority the tool can claim

Of the **13 built-in default entries** (8 hazard rules + 5 workflow pairs):

| class | count | which |
|---|---|---|
| **standards-cited** | **4** (~31%) | R1, R2, R3 (NFPA 51B / OSHA 1910.252 / NFPA 664/30 — hot-work & spark vs dust/flammable), R5 (NFPA 33 / OSHA 1910.107 — spray) |
| **design-assumption** | **9** (~69%) | R4 (textile distance), R6 (wet↔electronics proxy + distance), R7, R8 (dust/vibration DISCOURAGED distances), and all 5 SYNERGISTIC workflow pairs |

Compared to E1's **40 : 309 (~11.5%)** standards-cited ratio, N1 is **~31% standards-cited** —
higher, because the phase's core (the PROHIBITED fire/hot-work rules) *is* the part codes govern.

**What this means in front of a fire marshal / EHS reviewer.** The **PROHIBITED hot-work and spark
rules and their separation distances are code-backed**: 35 ft cites **NFPA 51B §5.6 + OSHA
1910.252(a)** (with **NFPA 664** for combustible wood dust and **NFPA 30** for flammables), and 20 ft
cites **NFPA 33 / OSHA 1910.107**. Those are defensible as written. **Everything else is engineering
judgment:** the relative **penalty weights** (10 : 3 : 1), the **strict ×5** multiplier, the
**DISCOURAGED / SYNERGISTIC distances** (10 / 5 / 30 ft), the **wet→electronics proxy** (R6 keys on
`dustSensitive` because E1 has no electrical flag), and every **SLP workflow synergy**. Present the
prohibited-hazard layer as standards compliance; present the weighting and the soft layer as the
tool's judgment, not code.

## What this phase does NOT do

- **Scores, does not hard-reject.** A strict-PROHIBITED violation raises the objective but never makes
  a layout infeasible. Turning `strict` into a hard feasibility constraint (rejecting the SA move) is
  **Phase R1**; the `mode` field and strict/advisory weighting are designed so R1 changes only the
  feasibility gate, not the model.
- **Distance is a simple geometric separation — no intervening walls/partitions.** N1 measures raw
  edge-to-edge distance. Real standards frequently permit a **fire-resistant barrier as a substitute
  for distance** (e.g. NFPA 51B allows a fire-resistant wall instead of 35 ft), which N1 does not
  model — so a welder and a saw separated by a rated wall are still penalized by raw distance. This is
  a **known gap**. The current workaround is a **user override** to `NEUTRAL` with a provenance note
  ("fire-rated wall installed"), demonstrated in fixture (d) and auditable via `overridesApplied`.
  Modeling walls-as-separation is future work (it needs the V1 structural geometry cross-referenced
  against each pair's line of separation).
- **Zone walls do not partition the objective.** Adjacency is scored building-wide over all machine
  pairs (a cross-zone hazard is real without a modeled wall) — the same geometry-only limitation.

## Defensible-but-surprising results (reported, not hidden)

- **N1 found 7 violations in the diagnostic that its answer key did not list.** The key used a flat
  10 ft center-to-center "any-incompatibility" heuristic; N1 uses the **35 ft NFPA standards distance
  edge-to-edge**, so it correctly flags pairs 10–35 ft apart (weld×laser, tsaw×laser, weld×grind,
  tsaw×grind, sander×weld, elec×tsaw) plus the SYNERGISTIC p3d×sander being 9.9 ft apart (synergy
  unmet, a "too-far" entry, not a hazard). All defensible — the key was conservative-lower-bound; N1
  is standards-accurate.
- **`sander × elec` escalates the key's label.** The key calls it "dust × dustSensitive"
  (DISCOURAGED); N1 resolves it **PROHIBITED** because `electronicsBench` also carries `hotWork`
  (soldering iron), firing R1 (hot work × combustible dust). Most-severe-wins — the soldering iron is
  minor hot work, so a reviewer might downgrade it, but the conservative default is defensible.
- **Extension flags are inert today.** R3 (`dustCollection`), R4 (`flammableTextile`), R5
  (`sprayFinishing`) never fire because no library machine sets those flags — the rules exist so a
  user-invented spray booth or dust collector gets correct standards behavior, but the library's
  21 machines don't exercise them.
- **The five-objective trade-off is real but noisy.** The best-adjacency layout **cost active-users**
  (0.878 → 0.913 shortfall — separating hazardous machines consumes packable floor area), but the
  across-front correlation is weak (r ≈ +0.19); adjacency aligns more cleanly with **noise**
  (r ≈ +0.35 — spreading loud machines apart lowers both). So "safer costs capacity" holds at the
  extreme member but is not a strong monotone relationship across the whole front — unlike A1's sharp
  r ≈ −0.90 capacity-vs-ADA tension.
