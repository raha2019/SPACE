# SPACE Optimizer Design

## What this document is

This document describes the stochastic multi-objective facility layout optimizer built on top of the SPACE simulation layer. It is intended to survive a technical question from a faculty advisor or competition judge. It explains the problem framing, the method, the objective vector, how uncertainty is handled, what novelty the work claims, and where the known limitations are.

---

## The facility layout problem

Arranging equipment in a shared workspace so that safety, accessibility, and acoustic conditions are simultaneously good is a combinatorial optimization problem. The formal version is called the Facility Layout Problem. Given N elements each with a fixed footprint and a set of pairwise interaction costs, find the assignment of elements to positions that minimizes total cost. The FLP is NP-hard in general even for small N, which means no polynomial-time exact algorithm is known. For a makerspace with roughly 15 movable equipment zones, exact enumeration is computationally infeasible.

The Invention Studio has an additional constraint that most classical FLP formulations do not consider: the objectives are not just pairwise interaction distances but are regulatory compliance metrics computed over the full spatial geometry of the layout. ADA corridor width violations depend on the BFS distance transform of the entire occupancy grid. NFPA egress travel distance depends on a multi-source BFS from all exit zones. OSHA noise exposure depends on inverse-square-law propagation from all active sources simultaneously. None of these reduce to a pairwise matrix. They must be computed by running the simulation models on each candidate layout.

---

## Why simulated annealing fits

Simulated annealing (SA) is a metaheuristic that works by iteratively proposing random moves, accepting improvements immediately, and accepting worsening moves with a probability that decreases over time according to a temperature schedule. This makes SA a good fit here for three reasons.

First, SA makes no assumptions about the objective landscape. The ADA, egress, and noise objectives are non-convex, non-differentiable functions of the layout. Gradient-based methods cannot be applied. SA explores the landscape without needing gradients.

Second, SA is simple to audit. The move set, the acceptance criterion, and the temperature schedule are all explicit named constants in the code. A reviewer can see exactly what the algorithm does.

Third, SA can escape local optima. A layout that looks locally good for egress might be globally worse because it crowds ADA-sensitive corridors. The stochastic acceptance of worsening moves (early in the run, when temperature is high) gives the search a chance to cross these local optima barriers.

The alternative metaheuristics for this problem class are genetic algorithms and particle swarm optimization. Both are defensible. SA was chosen because it is simpler to implement correctly, easier to reason about for a single-solution search, and the existing literature on SA for the FLP is well-developed, making the method easy to contextualize for an academic audience.

---

## The objective vector

The optimizer minimizes a three-component objective vector over the space of valid layouts.

The ADA component measures the fraction of walkable grid cells that fail the 36-inch minimum corridor width check defined in ADA Standards for Accessible Design 2010 Section 402.2. A walkable cell fails if its BFS distance to the nearest obstacle (wall or equipment zone boundary) corresponds to a corridor half-width below 18 inches, which is computed on a 0.5 ft grid. The value is bounded in [0, 1], where 0 means no corridor violations and 1 means every walkable cell is below the minimum. A door-width penalty term adds 0.13 (2 points out of 15 maximum) per door that falls below the ADA minimum clear opening width.

The egress component averages two sub-terms. The first is the maximum BFS travel distance from any free cell to the nearest exit, normalized by the NFPA 101 sprinklered limit of 200 ft (NFPA 101 2021 Section 7.6.1). The second is the exit capacity shortfall normalized by the total estimated occupant load; if exits are sufficient for the occupant count, this sub-term is zero. Both sub-terms are bounded in [0, 1].

The noise component is the fraction of grid cells (at 2 ft resolution) at or above the OSHA 85 dBA action level (OSHA 29 CFR 1910.95(a)). Each cell's estimated level is the Monte Carlo mean over 25 iterations of the inverse-square-law propagation model from all active noise sources, with wall crossings attenuated at STC 35 times 0.5 dB per crossing.

The MOSA acceptance criterion does not collapse the three components into a weighted scalar. Instead, a candidate move is accepted if it does not worsen any objective relative to the current solution (delta = 0), or probabilistically when it does worsen at least one: the Boltzmann factor exp(-delta / T), where delta is the sum of positive per-objective deteriorations. This preserves the three-dimensional structure of the objective space rather than imposing an arbitrary weighting. A non-dominated archive of up to 12 solutions is maintained throughout the search. When the archive reaches capacity, the member with the lowest crowding distance is dropped to keep the retained solutions spread across the frontier rather than clustered in one region.

---

## How uncertainty enters

Two of the three objectives are deterministic for a fixed layout. ADA uses BFS on a deterministic occupancy grid. Egress uses BFS on a deterministic obstacle grid. Given the same zone positions, these produce the same values on every call.

The noise objective is stochastic. Each zone has a `schedule_prob` property representing the probability that the machine is running during a given observation window. The Monte Carlo accumulator draws each machine on or off per iteration, giving a distribution of received levels across the space. The mean of that distribution is used as the noise score.

During the SA search, the noise evaluation uses 25 Monte Carlo iterations per candidate layout to keep evaluation time acceptable. This introduces variance of roughly 1 to 2 dB in the estimated noise score for a typical layout with 8 active sources at representative schedule probabilities. This variance is tolerable for a metaheuristic search because the acceptance criterion already incorporates randomness through the Boltzmann factor.

However, variance in the noise objective can corrupt dominance comparisons within the MOSA archive. The same physical layout evaluated twice might score differently, causing it to pass or fail a dominance check inconsistently. To prevent this, the optimizer replaces Math.random with a seeded deterministic PRNG (Mulberry32, seeded from the constant MOSA_NOISE_SEED) for the full duration of each run. Because the same draw sequence is used for every layout evaluation within a run, the noise score for a given zone configuration is bit-for-bit identical every time that configuration is evaluated during that run. This is a standard variance-reduction technique, not a workaround: it decouples objective noise from search randomness. The display-layer noise simulation (runNoiseCheck, 500 iterations) always uses the real Math.random, which is restored after the SA loop completes.

The archive members and baseline reported to the user reflect the scores computed under the seeded PRNG. Actual display values from runNoiseCheck may differ by 1 to 2 dB due to the reduced iteration count used during search.

---

## How Pareto optimality is defined here

A layout A Pareto-dominates layout B if A is no worse than B on all three objectives and strictly better on at least one. The Pareto front is the set of all layouts that are not dominated by any other feasible layout. In general, the Pareto front contains many layouts that represent different trade-offs, for example a layout with excellent ADA compliance but higher noise exposure versus one with lower noise but marginal egress.

The current implementation uses dominance-based acceptance in the SA loop and maintains a non-dominated archive throughout the search. On each step, the accepted move updates the current solution, and the solution's objective vector is inserted into the archive if no existing member dominates it. Archive members that the new solution dominates are pruned. When the archive reaches capacity (12 members), the member with the lowest crowding distance is dropped, keeping the archive spread across the frontier rather than clustered.

The result is not a single optimized layout but a set of layouts representing different trade-offs. One archive member might achieve excellent ADA compliance at the cost of higher noise exposure; another might prioritize egress clearance. These are shown together in the results panel as a compact table and an ADA-vs-Noise scatter plot with egress encoded as dot opacity. The user selects which trade-off to apply. The default selection is the archive member with the highest crowding distance, the most representative point of the frontier spread, and clicking any row or dot switches the ghost overlay to that solution before the user commits.

The `evalDominates` function in sim_eval.js computes strict Pareto dominance. The `evalObjective` function and EVAL_WEIGHTS constant remain in sim_eval.js and are available for backward compatibility but are not used by the optimizer's acceptance or selection logic.

---

## Novelty statement

The Facility Layout Problem has been studied for decades. The specific contribution here is not a new algorithm. The contribution is a regulatory multi-objective formulation applied to a real makerspace under operational uncertainty, integrated with a descriptive-to-prescriptive pipeline in a live browser tool.

Concretely: prior FLP work typically uses distance-weighted pairwise interaction costs. This formulation uses grid-based compliance metrics derived from ADA, NFPA 101, and OSHA standards, computed by physically-grounded simulation models (BFS distance transform, multi-source BFS travel distance, Monte Carlo acoustic propagation). The uncertainty enters through real machine scheduling probabilities rather than through parameter noise added artificially. The tool is not a standalone optimizer; it sits inside a layout editor that can export to a project file, compare alternatives, and show the analysis to a non-expert in plain English. This integration is the novelty claim.

A reviewer familiar with the FLP literature will recognize that the underlying SA is standard. The claim to make to that reviewer is: the contribution is in the formulation and the pipeline, not the search algorithm.

---

## Known limitations

The noise model uses inverse-square-law propagation with wall crossings counted along Bresenham lines. This does not model room reflections, reverberation time, HVAC background noise, or the difference between A-weighted and C-weighted levels. The dBA values assigned to each zone in the demo file are engineering estimates, not measurements from the actual space. Results should be treated as a relative ranking tool, not an acoustic prediction.

The ADA model approximates corridor width using a BFS distance transform on an occupancy grid. It does not model slopes, reach ranges, protruding objects at head height, or restroom compliance. It will over-flag narrow but physically passable gaps if the grid resolution cannot distinguish them.

The SA optimizer can find local optima that are not globally optimal. The 500-iteration run with the default cooling schedule is calibrated to find a meaningfully better layout on a typical 15-element makerspace in under 5 seconds in a modern browser. It is not a guarantee of global optimality.

Fixed elements (entrance, main desk, emergency exits) are not moved by the optimizer. Structural walls and doors are also fixed. The optimizer only relocates equipment zones that are not locked in the transform panel. Layouts with many locked elements give the optimizer less freedom and will see smaller improvements.

The optimizer does not enforce minimum clearance between elements as a hard constraint. It relies on the ADA objective to penalize crowded configurations. A layout that achieves a low ADA score while technically having overlapping zones is possible if the overlap is small and the corridor cells elsewhere are wide. Rahul's feasibility gate in scoring.js will flag overlapping zones as critical issues after the layout is applied.

The ghost overlay shows suggested positions for movable zones. It does not modify any scoring state. Rahul's evaluation runs only when the user clicks Apply Suggested Layout, which triggers evaluate() and render() through the same path as manual drag-and-drop.
