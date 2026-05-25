# MODULES.md

Simulation module documentation for SPACE v1.
All three modules are preliminary research tools. Outputs are not for regulatory use.

---

## 1. ADA Compliance Validator (`v1/js/sim_ada.js`)

### Methodology

The ADA validator estimates whether circulation paths in the layout meet minimum width
requirements from the ADA Standards for Accessible Design (2010) and ANSI A117.1-2017.

The core algorithm is a BFS distance transform on a discretized occupancy grid. The stage
is divided into cells at ADA_GRID_RES_FT = 0.5 ft resolution. Each cell is classified as
blocked (equipment zone or structural wall) or free (passable). The BFS seeds from all
blocked cells and stage boundaries, propagating outward. Each free cell receives its
distance to the nearest obstacle in grid cells. This value approximates the inscribed
circle radius at that point, which is equivalent to half the local corridor width.

A cell whose inscribed circle radius is less than ADA_MIN_CORRIDOR_CELLS fails the
accessible route check, because the full corridor would be narrower than
ADA_MIN_CORRIDOR_WIDTH_IN = 36 inches. Cells between the minimum and preferred threshold
(ADA_MIN_PRIMARY_CORRIDOR_IN = 44 inches) are flagged as marginal.

Door width checks compare each structural door element's smaller dimension against
ADA_MIN_DOOR_WIDTH_IN = 32 inches (or 36 inches for exit doors).

### Assumptions and Limitations

- Zones are treated as axis-aligned rectangles. Rotated zones are not correctly modeled.
- The method approximates corridor width via the inscribed circle, not the true swept-path width. This underestimates clearance in diagonal paths.
- Slopes, ramps, reach ranges, protruding objects, signage, and restroom requirements are not modeled.
- ADA compliance requires certified access consultant review and field measurement. This tool identifies candidate problem areas only.

### Canvas Overlay

- Green: meets preferred width (44 in clear)
- Yellow/amber: meets ADA minimum (36 in) but not preferred
- Red: below ADA minimum corridor width

### Applicable Standards

- ADA Standards for Accessible Design (2010), Sections 402, 404, 305, 304
- ANSI A117.1-2017

---

## 2. Egress / Fire Analyzer (`v1/js/sim_egress.js`)

### Methodology

The egress analyzer computes travel distance from every accessible floor cell to the
nearest exit using multi-source BFS on a 1 ft resolution grid (EGRESS_GRID_RES_FT = 1.0).

Exit zones (elements with cat = "exit") are seeded at distance 0. The BFS propagates
through all non-obstacle cells. Equipment zones and structural walls block propagation.
Corridor and open-area zones remain traversable. The resulting distance map gives the
minimum travel distance in feet for any starting location.

Occupant load is estimated by dividing the total gross floor area by
NFPA_OCCUPANT_LOAD_FACTOR_MAKERSPACE = 50 sq ft per person, consistent with NFPA 101
Table 7.3.1.2 for industrial occupancy (the applicable classification for a makerspace
with active fabrication equipment).

Exit capacity is the sum of all exit door clear widths divided by
NFPA_EXIT_WIDTH_PER_OCCUPANT_IN = 0.2 inches per occupant, per NFPA 101 Section 7.3.3.1.

Dead-end detection uses a heuristic: any free cell with exactly one traversable neighbor
is a dead-end terminus. The BFS distance of that cell approximates how far back a person
must travel before finding a choice of two paths. This is a conservative overestimate of
the true dead-end corridor length (it includes the distance to the exit, not just the
dead-end branch length).

### Assumptions and Limitations

- Sprinklered occupancy is assumed. The unsprinklered travel distance limit is 100 ft.
- Door swing direction is not modeled.
- Stairwells, elevator lobbies, and smoke compartments are not modeled.
- The BFS does not account for exit discharge conditions or occupant merge flow.
- Occupant load assumes uniform distribution. Concentrated use areas may require a
  different load factor.
- This analysis informs preliminary layout decisions only. Egress design requires review
  by a licensed fire protection engineer.

### Canvas Overlay

- Blue: exit zone
- Green: low travel distance (below 50% of limit)
- Yellow to orange: moderate travel distance (50 to 100% of limit)
- Red: exceeds NFPA_MAX_TRAVEL_DISTANCE_FT = 200 ft
- Purple: unreachable from any exit

### Applicable Standards

- NFPA 101 Life Safety Code, 2021 edition, Chapter 7

---

## 3. Noise / Acoustic Monte Carlo Simulator (`v1/js/sim_noise.js`)

### Methodology

The noise simulator estimates mean steady-state sound pressure levels across the floor
using a Monte Carlo approach with NOISE_MC_ITERATIONS = 500 trials.

In each trial, each noise source zone is independently active with probability
schedule_prob (a per-zone property). Received SPL at each grid cell is computed using
the inverse square law:

    received_dB = source_dba_active - 20 * log10(max(d, 1 ft))

where d is the Euclidean distance from source center to cell center. Wall attenuation
is added by counting wall crossings on the direct path using Bresenham's line algorithm
and applying a reduction of NOISE_WALL_STC * 0.5 dB per crossing. This approximates
transmission loss through a single interior partition (STC 35, consistent with a
standard metal stud and drywall assembly).

Multiple sources are summed in linear scale (power addition) at each cell. The
accumulator across all trials is averaged, then converted back to dB. An ambient floor
of NOISE_AMBIENT_DBA = 40 dB is added to the mean linear power before the final
conversion, preventing log(0) and representing background HVAC and ambient noise.

Wall attenuation precomputation (performed once before the Monte Carlo loop) separates
the deterministic geometry from the stochastic scheduling. This reduces the per-iteration
cost from O(sources x cells x Bresenham length) to O(sources x cells).

### Assumptions and Limitations

- Room reflections and reverberation are not modeled. This underestimates SPL in
  reflective environments such as concrete-floor makerspaces by approximately 3 to 6 dB.
- Source directivity is not modeled. All sources radiate omnidirectionally.
- The model uses A-weighted dBA levels directly without frequency spectrum analysis.
  Actual noise exposure depends on frequency content and the weighting filters of
  measurement instrumentation.
- HVAC noise contribution beyond the ambient floor is not modeled.
- Hearing protector attenuation factors (NRR) are not applied. The map shows unprotected
  exposure levels.
- Wall attenuation using STC * 0.5 is a broadband approximation. Actual insertion loss
  depends on wall construction, flanking paths, and frequency spectrum.
- Noise sources must be tagged with dba_active (machine SPL at 1 meter) and
  schedule_prob. Zones without these properties are treated as non-emitters.

### Canvas Overlay

- Green: below 70 dBA (low noise)
- Yellow: 70 to 85 dBA (moderate, noticeable)
- Orange: 85 to 90 dBA (exceeds OSHA action level, hearing conservation program required)
- Red: above 90 dBA (exceeds OSHA PEL, engineering controls required)

### Applicable Standards

- OSHA 29 CFR 1910.95 Occupational Noise Exposure
- NIOSH Criteria for a Recommended Standard: Occupational Noise Exposure (1998)

---

## Zone Properties for Simulations

Custom elements can carry these properties (set in Element Builder or in a JSON elements
bundle). Properties are read from the zone definition, not the zone state.

| Property | Type | Used by | Description |
|---|---|---|---|
| `dba_active` | number | Noise | Machine sound level at 1 meter (dBA). |
| `schedule_prob` | number 0-1 | Noise | Fraction of time the machine is running. |
| `accessible` | boolean | ADA (future) | Zone needs an ADA-accessible approach path. |
| `cat` | string | ADA, Egress | Category: "exit", "corridor", "structural-wall", etc. |

---

## Regulatory Disclaimer

All simulation outputs are preliminary model estimates intended to support layout
exploration and early-stage design iteration. They are not substitutes for:

- Licensed fire protection engineering review (egress)
- Certified access consultant review (ADA)
- Industrial hygiene measurement and assessment (noise)
- Building code authority review and permitting

Threshold values used in this tool are sourced from publicly available standards for
informational purposes. Their application to any specific facility requires professional
judgment and jurisdictional verification.

---

## Running Tests

Open `tests/index.html` in any modern browser. No server or build tool is required.
Tests exercise the pure computation functions of each module against stub state. They
do not require a floor plan image, calibrated scale, or network access.
