# AutoPin: Whole-City Lifetime Planning — Design

*Grounded in `autopin/ui/core/ap-planner.js` and `README.md` as they exist today. Every claim about game data that can't be verified from inside the mod is flagged.*

---

## 0. What the code actually does today (verified)

- **Planning horizon:** `PLAN_WAVES` (ap-planner.js:44–48) runs three waves: tech-distance 0 on owned tiles (budget 8), distance ≤1 on any tile (budget 3), then distance ≤∞ *within the current age* (budget 3). "The rest of the age" already leaks in via wave 3 — but with a budget of 3 pins and no ordering semantics. `MAX_BUILDINGS_PER_CITY = 8` (line 29) is actually dead — the wave budgets (8+3+3=14) govern.
- **Tech awareness:** `techDistance()` buckets into {0, 1, 2} from progression-node state. It cannot see *how deep* — Mathematics-next-turn and end-of-age both read as "2" (or 1 if the node is OPEN). There is no notion of *when*.
- **Placement:** `beamSearch()`, width 3, 6 extensions/round, over `evaluatePlacements()` which scores weighted yields + warehouse value + mutual-adjacency delta − urbanize opportunity cost, with urban contiguity enforced per-round via `isUrbanReachable()`. Crucially, **the beam already produces an ordered sequence** in which every pin was reachable given its predecessors — the order is just thrown away when pins are committed.
- **No chain/sequence semantics:** `getCandidateBuildings()` treats every building as an independent scoring atom. The Academy/Library incident is documented in the code itself — DMT's `isConstructibleUnlocked` only reports true at `FULLY_UNLOCKED`, so the buildable Library read as locked, tied with the actually-locked Academy, and the Academy's fatter adjacencies won the budget slot. The node-state fix is already in, but it fixes the *symptom* (misclassified distance), not the *concept* (the planner has no idea these two buildings are related).

---

## 1. Modeling "chains": what Civ 7's data actually says (and doesn't)

The design depends on this, so: **Civ 7 almost certainly has no hard Library→Academy prerequisite.** Unlike Civ 6 (`BuildingPrereqs` table), Civ 7's Academy unlocks from Mathematics alone and is buildable in a city with no Library. What Civ 7 *does* have is three softer structures the planner should model:

1. **Yield-class ladders** — within an age, each yield has an early cheap building and a later stronger one (Library@Writing → Academy@Mathematics for science). The "chain" is *unlock-order within a class*, not a prereq edge. Skipping the base is legal but strategically nonsense: zero science infrastructure until Mathematics.
2. **Quarter pairing** — two buildings on one urban tile form a quarter; the natural endgame is Library+Academy sharing a tile (or adjacent tiles feeding one adjacency web). The mutual-adjacency machinery already values this; it just never *insists* on it.
3. **Cross-age overbuild chains** — non-Ageless buildings decay at age turnover and become overbuild fodder; Ageless buildings are permanent. This is the real "upgrade" mechanic in Civ 7, and it's about *tiles*, not building identities.

### Data sources, with confidence labels

| What | Where | Confidence |
|---|---|---|
| Building list, class, age | `GameInfo.Constructibles` (`ConstructibleType`, `ConstructibleClass`, `Age`) — used at line 1186 | **Verified in code** |
| Adjacency defs | `GameInfo.Constructible_Adjacencies` — line 1181 | **Verified in code** |
| Constructible → tree node mapping | `TreeModifier.constructibleNode[type]` | **Verified in code** (DMT side assumed) |
| Node state | `Game.ProgressionTrees.getNodeState(playerID, nodeType)` | **Verified in code** |
| Node *costs and prereq edges* (needed for real depth/ETA) | `GameInfo.ProgressionTreeNodes` (cost), plus a prereq-edge table — name unknown, plausibly `ProgressionTreeNodePrereqs` | **ASSUMPTION — verify** |
| Ageless flag, yield-class tags | Likely `GameInfo.TypeTags` + `GameInfo.Tags` (e.g. `AGELESS`, `SCIENCE`) | **ASSUMPTION — verify** |
| Hard building prereqs | A Civ-6-style `BuildingPrereqs` table | **Probably doesn't exist** — design must not depend on it |

**Concrete first task:** add a one-time probe in the mod's existing diagnostic style (it already dumps `UI.Player` method surfaces) that logs `Object.keys(GameInfo).filter(k => /Prereq|Progression|Tag|Unlock|Overbuild/i.test(k))` and samples a few rows. One F3 press in-game settles every ASSUMPTION row above. Do this before writing any chain code.

### The chain abstraction

Introduce a `BuildingLine` derived at runtime:

```
line = { yieldClass: "SCIENCE", members: [ {type, unlockDepth, ageless}... ] sorted by unlockDepth }
```

- `yieldClass` from tags if available; **fallback:** classify by the dominant yield type across the building's `Constructible_Adjacencies` + base yields (data the mod already reads). This fallback needs zero new tables and is robust to the prereq-table question.
- **Planner rule (the invariant that kills the embarrassment):** *a building may only be scheduled after every cheaper-to-unlock member of its line that isn't already built/pinned in this city.* Not "can't be placed" — "can't be placed **first**." Base+upgrade become an ordered unit: when the beam considers the Academy, the Library is either already in the sequence or gets pulled in as a forced predecessor, and the pair's placement is scored jointly (they'll usually want the same tile or adjacent tiles).

---

## 2. Sequencing: from waves to a lifetime build order

The waves were an approximation of a thing the beam search can compute natively: **an ordered sequence**. Replace the wave loop with a single beam run over the full current-age pool, and change the objective from *sum of scores* to *time-discounted sum*:

```
value(sequence) = Σ_i  score(pin_i) × γ^t(i)
```

where `t(i)` is the estimated turn pin *i* comes online, in units of "build slots":

```
t(i) = max( queuePosition(i) × avgBuildTurns,  techETA(pin_i) )
```

- **`techETA`** = cumulative science cost of unresearched nodes on the path to the pin's unlock node ÷ player's science per turn. Node costs from `GameInfo.ProgressionTreeNodes` (flagged); science rate from the player stats API (**verify the exact call** — `player.Stats.getNetYield?`). **Fallback if costs are unreachable:** use graph depth (number of unresearched prereq nodes) × a constant. Even that is a massive upgrade over the 0/1/2 bucket.
- **`γ`** ≈ 0.9–0.95 per build-slot. This single number *replaces* the wave structure: buildable-now buildings naturally dominate the front (their yields compound over more turns), deep-tech buildings slot in later — but their *tiles* are chosen now, with full knowledge of the endgame layout, because the beam scores the whole sequence.

**Why this beats a literal two-pass "design endgame, then derive order":** a pure endgame-first pass can produce layouts with no valid construction order (the contiguity-critical inner tile assigned to a deep-tech building strands every earlier outer pin). The beam *is* a sequencer — every extension is checked reachable given its predecessors (`isUrbanReachable` already does this), so **every layout it emits comes with a valid build order for free**. You get endgame-aware placement without the repair problem, by making the endgame visible to the sequencer rather than the sequence derivable from the endgame.

Two amendments so ordering respects unlocks:

1. **Soft, not hard:** an extension whose `techETA` exceeds the current sequence position is penalized via `γ^t`, not banned — but a pin can never precede its line-predecessor (§1 rule).
2. **Don't predict the player's research path.** `techETA` assumes shortest-path-to-node, which is wrong the moment you detour for Masonry because a neighbor is massing. Fine: the plan is a *standing recommendation*, cheap to regenerate, and F3-per-city already exists as the refresh gesture. Goal: re-running F3 after a detour produces a *stable* plan (same tiles, reshuffled order), not a different city — see §5.

**Add a cheap polish pass:** after the beam finishes, try single-pin relocations/swaps that preserve order-feasibility and keep any that improve total discounted value. Catches greedy+beam's classic failure (early pin locks a key tile) for one extra evaluation sweep.

---

## 3. Modeling the growing city

Split every forward-looking quantity into *knowable now* vs *assume-and-declare*:

| Quantity | Knowable | Assumption |
|---|---|---|
| Tile ownership growth | Current owner (`GameplayMap.getOwner`); nearest-center partition already resolves inter-city contention | **Assume all radius-3 "owned" (nearest-center) tiles are acquired by end of age**, except tiles currently owned by another player (already excluded). The `ownedOnly` flag becomes an ordering input: unowned tiles get `+acquisitionDelay` added to `t(i)`, so pins there drift later — the current "grow this direction, then build" semantics, now in the objective rather than wave gating. |
| Urban-tile availability | Contiguity fully modeled — pins realize as urban in DMT (`isUrbanReachable`), so the projected urban network *is* the plan | None needed. This part the codebase already does right. |
| Building slots | 2 buildings per urban tile (DMT validator enforces per-tile capacity); slot supply = 2 × urban tiles in plan | **Assume no population gate on district count** (Civ 7 gates specialists by pop, not districts — **verify**). Plan length: extend the sequence until marginal discounted value < a floor (reuse the `WONDER_MIN_SCORE` pattern). |
| Rural opportunity cost over time | `getUrbanizeCost` reads *today's* tile yields | Slight overcharge for late pins (that farm would've been replaced anyway) — acceptable; optionally discount the cost by the same `γ^t`. |
| Cross-age future | Ageless flag; overbuild rules | **Don't plan next-age buildings** (see R1). Instead encode two *placement biases*: (a) **permanence premium** — Ageless/unique buildings get a small score multiplier since placement is forever; (b) **fodder placement** — low-value aged buildings preferentially fill high-adjacency tiles so next age's overbuild replacements inherit great spots. For the Meiji endgame in the Tenure Track build this is literally the win condition (Goisshin pays science per overbuild) — so fodder placement is a feature, not a hack. |

---

## 4. The optimization problem, restated

**From:** maximize Σ score(pin) over ≤14 pins, tech-distance ≤ current wave, greedy-committed per wave.
**To:** maximize Σ score(pin)·γ^t(pin) over an ordered sequence filling the projected slot budget, subject to (a) urban contiguity at each prefix, (b) line-order (§1), (c) per-tile capacity and DMT validity.

Tractability: `evaluatePlacements` is the inner loop — O(pool × reachablePlots) DMT yield calls plus neighbor deltas. Full-age pool is maybe 25–35 buildings vs today's ~10–15, rounds go from ~14 to ~25. Rough cost: **3–5× today's single-city run**, fine for F3-on-one-city (the reason the README already steers users there by Exploration). Keep `BEAM_WIDTH=3`; raising it buys less than discounting does. Two cheap wins if it drags: memoize `(type, plot)` base scores across rounds, and only re-evaluate plots within distance 1 of the last-committed pin (adjacency can't reach further — the code already knows this).

---

## 5. UX: plan far, pin near

The plan spans an age; the map shouldn't. AutoPin owns no rendering (all DMT), so work with what pins can express:

1. **Store the full ordered plan; pin a window.** Persist the whole sequence in the existing `Catalog("APN")` store (pin-list just needs an `order` field). Physically place tacks only for the next N steps (N≈8, configurable) **plus every "anchor"**: Ageless buildings, wonders, and any pin whose tile must be reserved for the plan to work. F3 becomes *advance/resync*: detect built pins, drop them from the sequence, pin the next window. Makes F3 idempotent-feeling instead of churn-y.
2. **Distinguish "build now" from "later" with what DMT gives you.** Pins for not-yet-unlocked buildings already render with DMT's invalid/warning styling — lean on that. A stronger cue (order badges over tack positions) is feasible later (the mod already ships a UI decorator for the options screen), but it's a v3 nicety, not a dependency.
3. **Emit the build order as text.** The mod already writes rich console diagnostics; promote the plan to a formatted per-city listing (`1. Library @ (14,22) — now · 2. Academy @ (14,22) — after Mathematics (~8t) · …`). Cheapest possible "whole-game view," costs one string-builder.
4. **Plan stability matters more than plan optimality for UX.** When re-running F3, diff against the stored plan and *keep prior tile assignments unless the new plan beats them by a threshold*. Nothing erodes trust like the science quarter teleporting across the river because a tiebreak flipped.

---

## 6. Incremental delivery

**M0 — probe (one evening).** GameInfo key/row dump (§1). Settles the prereq-table, TypeTags, node-cost, and science-rate unknowns. Also empirically answer: does `MapTackValidator.isValid` accept every current-age locked building? (Wave 3 pins suggest yes — confirm.)

**M1 — kill the Academy-without-Library class of bug (small, ship fast).** Build `BuildingLine`s from adjacency-yield classification + `techDistance`. Enforce the line-order rule inside the existing wave loop: when a deeper member enters a wave's pool, its unbuilt/unpinned shallower siblings enter too, and the sibling must be committed first (biased adjacent/same-tile via existing mutual-adjacency scoring). No architecture change; `PLAN_WAVES` untouched.

**M2 — real depth and time.** Replace the 0/1/2 `techDistance` with graph-depth/ETA over progression nodes. Replace waves with the single discounted-beam sequence (§2), same total pin budget initially. Store order in the catalog; print the build-order listing.

**M3 — growing-city projection + windowed pinning.** Acquisition-delay term for unowned tiles, slot-budget-driven plan length, marginal-value floor, F3-as-resync with plan diffing (§5).

**M4 — endgame polish.** Permanence premium, overbuild-fodder bias, local-search relocation pass, optional order-badge overlay.

Each milestone is independently shippable and revertible; M1 alone ends the embarrassment.

---

## 7. Risks & unknowns

- **R1 — DMT can't handle future ages.** `isCurrentAge` filtering exists for a reason; next-age buildings may be absent from validator/yield paths or score garbage. Mitigated by scoping "lifetime" to end-of-age with cross-age *biases* only (§3). Deliberate boundary.
- **R2 — Progression prereq/cost tables aren't exposed to UI-context JS.** Then `techETA` degrades to node-state buckets enriched by unlock-tree depth from DMT's `constructibleNode` map. The discounted objective survives; only its clock gets coarser. M0 tells us which world we're in.
- **R3 — tech path is player-dependent.** Unfixable and fine: ETA is a prior, F3 is the posterior update. Plan-stability diffing (§5.4) prevents the visible symptom.
- **R4 — greedy/beam lock-in on a bigger horizon.** A 25-pin discounted sequence gives early mistakes more room to hurt. Mitigations: line-pairing (forces orphaned upgrades out of existence), polish pass, and few anchors; everything else is re-plannable.
- **R5 — performance.** 3–5× single-city cost is acceptable; full-map F3 in late Exploration was already flagged impractical. If it bites, memoization and locality tricks in §4 are sitting right there.
- **R6 — yield-class fallback misclassifies oddballs** (multi-yield, warehouse types). Warehouse buildings already have their own gate (`WAREHOUSE_MIN_SCORE`); multi-yield dominant-yield classification errs toward *not* forcing a pairing, which fails safe.
