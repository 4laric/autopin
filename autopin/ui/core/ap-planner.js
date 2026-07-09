/**
 * AutoPin planner.
 *
 * Greedy adjacency-maximizing building placement and settlement suggestions,
 * built on top of wltk's Detailed Map Tacks (DMT). All validation, yield math,
 * storage and rendering is delegated to DMT:
 *   - score candidates  -> MapTackYield.getYieldDetails(x, y, type)
 *   - legality checks   -> MapTackValidator.isValid(x, y, type)
 *   - place a pin       -> engine.trigger("AddMapTackRequest", mapTackData)
 *   - remove a pin      -> engine.trigger("RemoveMapTackRequest", mapTackData)
 *
 * Hotkeys (rebindable in Options -> Keyboard+Mouse):
 *   F3 - generate building pins for all of your cities (and DMT city-center tacks)
 *   F6 - suggest settlement locations (places ranked city-center tacks)
 *   F4 - clear all pins previously placed by AutoPin
 */
import MapTackStore from '/detailed-map-tacks/ui/map-tack-core/dmt-map-tack-store.js';
import MapTackUtils from '/detailed-map-tacks/ui/map-tack-core/dmt-map-tack-utils.js';
import MapTackValidator from '/detailed-map-tacks/ui/map-tack-core/dmt-map-tack-validator.js';
import MapTackYield from '/detailed-map-tacks/ui/map-tack-core/dmt-map-tack-yield.js';
import { ConstructibleClassType, ExcludedItems } from '/detailed-map-tacks/ui/map-tack-core/dmt-map-tack-constants.js';
import TraitModifier from '/detailed-map-tacks/ui/map-tack-core/modifier/dmt-trait-modifier.js';
import TreeModifier from '/detailed-map-tacks/ui/map-tack-core/modifier/dmt-tree-modifier.js';
import MapTackModifier from '/detailed-map-tacks/ui/map-tack-core/dmt-map-tack-modifier.js';
import { Catalog } from '/detailed-map-tacks/ui/map-tack-core/dmt-utility-serialize.js';
import { ComponentID } from '/core/ui/utilities/utilities-component-id.js';

const CITY_RADIUS = 3;
const MAX_BUILDINGS_PER_CITY = 8;
const MAX_WONDERS_PER_CITY = 2;

// Tech-horizon planning: distance 0 = buildable now, 1 = one completed
// research away, 2 = deeper in the current age.
// Wonders use MAX_TECH_DISTANCE; buildings are planned in expanding waves.
const MAX_TECH_DISTANCE = 1;

// Building waves: each wave widens the tech horizon and plans another batch
// of pins. Candidates that missed a budget carry forward, so the pool only
// ever expands as the plan iterates outward from the core (contiguity keeps
// later, deeper-tech waves on the spatial frontier).
// ownedOnly waves only use tiles the settlement already owns — "buildable
// right now" means the tile too, not just the tech. Later waves may pin
// unclaimed tiles: those pins mean "grow this direction, then build".
const PLAN_WAVES = [
    { maxTechDistance: 0, budget: 8, ownedOnly: true },  // core: buildable right now
    { maxTechDistance: 1, budget: 3, ownedOnly: false }, // frontier: one research away
    { maxTechDistance: Infinity, budget: 3, ownedOnly: false }, // horizon: rest of the age
];

// Wonder-ambition damper: every wonder pinned during one generate run
// multiplies the score of subsequent wonder candidates by this factor
// (0.8^n after n wonders). You can't realistically race 10 wonders at once —
// later cities only pin wonders that are exceptional. Set to 1 to disable.
// Buildings are NOT damped: every city legitimately wants its own barracks.
const WONDER_DAMPING = 0.8;
// A wonder pin must clear this (damped) score to be placed at all. This is
// what gives the damper teeth: as wonders stack up, marginal ones stop
// clearing the bar and later cities pin fewer (or none).
const WONDER_MIN_SCORE = 6;
// Placement-agnostic buildings (granary, saw pit — no adjacency bonuses)
// only enter a city's pool when their warehouse yields there (computed from
// the game's Warehouse_YieldChanges data — DMT doesn't model these) clear
// this floor.
const WAREHOUSE_MIN_SCORE = 3;

// Beam search tuning. BEAM_WIDTH = 1 degenerates to plain greedy.
const BEAM_WIDTH = 3;      // partial layouts kept alive per round
const BEAM_EXTENSIONS = 6; // best extensions considered per layout per round
const ID_AUTOPIN = "AUTOPIN_PINS";
const KEY_PIN_LIST = "list";
const KEY_SETTLE_LIST = "settle";

// Settlement suggestion tuning.
const MIN_SETTLE_DISTANCE = 4;   // plots from any existing/suggested center
const SETTLE_SEARCH_RADIUS = 7;  // how far from existing centers to search
const SETTLE_FINALISTS = 8;      // candidates that get full plan-value scoring
const SETTLE_SUGGESTIONS = 3;    // city-center tacks to place
const SETTLE_PLAN_ROUNDS = 4;    // buildings in the hypothetical plan

// Yield weights used for scoring. Tweak to taste.
const YIELD_WEIGHTS = {
    YIELD_FOOD: 1,
    YIELD_PRODUCTION: 1.1,
    YIELD_GOLD: 0.8,
    YIELD_SCIENCE: 1.2,
    YIELD_CULTURE: 1.2,
    YIELD_HAPPINESS: 0.9,
    YIELD_DIPLOMACY: 0.9,
};

class AutoPinPlannerSingleton {
    static getInstance() {
        if (!AutoPinPlannerSingleton.singletonInstance) {
            AutoPinPlannerSingleton.singletonInstance = new AutoPinPlannerSingleton();
        }
        return AutoPinPlannerSingleton.singletonInstance;
    }
    constructor() {
        this.catalog = new Catalog("APN");
        this.runWonderCount = 0;
        this.selectedCityID = null;
        engine.whenReady.then(() => { this.onReady(); });
    }
    onReady() {
        window.addEventListener("hotkey-autopin-generate", this.generate.bind(this));
        window.addEventListener("hotkey-autopin-settle", this.suggestSettlements.bind(this));
        window.addEventListener("hotkey-autopin-clear", this.clearAll.bind(this));
        // The game fires CitySelectionChanged on the engine bus when a city is
        // selected/opened (getHeadSelectedCity() is null from this detached
        // hotkey handler). Cache the id so F3 can target that city.
        engine.on('CitySelectionChanged', this.onCitySelectionChanged.bind(this));
    }

    /**
     * Print a start banner for one hotkey run. Every AutoPin line already
     * carries the `[AutoPin]` prefix (greppable in the game's UI/script log);
     * this banner adds an ISO timestamp and a short random id so a single run
     * can be isolated at a glance, even in a busy shared log.
     */
    runBanner(kind) {
        const ts = new Date().toISOString();
        this.runId = Math.random().toString(36).slice(2, 8);
        console.error(`[AutoPin] ===== BEGIN ${kind} ${ts} id=${this.runId} =====`);
    }
    runBannerEnd(kind) {
        console.error(`[AutoPin] ===== END ${kind} id=${this.runId} =====`);
    }

    /* ---------------------------------------------------------- entry points */

    generate() {
        this.runBanner("generate");
        try {
            // With a city selected, re-plan just that city; otherwise, all.
            const selected = this.getSelectedCityCenter();
            if (selected) {
                console.error(`[AutoPin] selected city detected at ${selected.x},${selected.y} — planning that city only.`);
                this.generateForCenter(selected);
            } else {
                console.error("[AutoPin] no city selected — planning all cities. (Select a city banner first to re-plan just one.)");
                this.generateForAll();
            }
        } catch (e) {
            console.error(`[AutoPin] generate failed: ${e}\n${e?.stack}`);
        } finally {
            this.runBannerEnd("generate");
        }
    }
    generateForAll() {
        // Regenerate from a clean slate so plans reflect the current map.
        this.clearPins(KEY_PIN_LIST);
        this.runWonderCount = 0; // wonder-ambition damper resets per run
        const placed = [];
        const usedWonders = new Set(); // wonders are one-per-world
        // Every plan center at once, so each city can be planned only on the
        // tiles it "owns" (is nearest to). Without this, cities within ~6 tiles
        // share overlapping radius-3 pools and double-plan the same plots.
        const centers = this.getPlanCenters();
        for (const center of centers) {
            const others = centers.filter(o => !(o.x == center.x && o.y == center.y));
            placed.push(...this.planCity(center, usedWonders, others));
        }
        this.savePinList(KEY_PIN_LIST, placed);
        console.error(`[AutoPin] placed ${placed.length} building pins.`);
    }
    /**
     * Re-plan a single city: clear only ITS old AutoPin pins (within the city
     * radius), keep every other city's plan intact, and seed the wonder
     * damper and used-wonder set from the pins that remain.
     */
    generateForCenter(center) {
        const centers = this.getPlanCenters();
        const others = centers.filter(o => !(o.x == center.x && o.y == center.y));
        const old = this.loadPinList(KEY_PIN_LIST);
        // "Mine" = pins on tiles this city owns (is nearest to). Using nearest-
        // center ownership rather than a raw radius means re-planning one city
        // never clears a neighbor's pins that merely fall inside our radius.
        const isMine = pin => this.plotBelongsToCenter(pin.x, pin.y, center, others)
            && this.plotDistance(pin.x, pin.y, center.x, center.y) <= CITY_RADIUS;
        for (const pin of old.filter(isMine)) {
            const existing = MapTackStore.retrieveMapTacks(pin.x, pin.y);
            if (existing.some(m => m.type == pin.type)) {
                engine.trigger("RemoveMapTackRequest", { x: pin.x, y: pin.y, type: pin.type });
            }
        }
        const kept = old.filter(pin => !isMine(pin));
        const keptWonders = kept.filter(pin =>
            MapTackUtils.getConstructibleClassType(pin.type) == ConstructibleClassType.WONDER);
        this.runWonderCount = keptWonders.length;
        const usedWonders = new Set(keptWonders.map(pin => pin.type));
        const placed = this.planCity(center, usedWonders, others);
        this.savePinList(KEY_PIN_LIST, [...kept, ...placed]);
        console.error(`[AutoPin] re-planned selected city: ${placed.length} pins.`);
    }
    /**
     * Center of the currently selected city, or null if none.
     *
     * getHeadSelectedCity() returns null when called from this detached global
     * hotkey handler, so the reliable signal is the CitySelectionChanged engine
     * event (payload { cityID }) which we cache in this.selectedCityID. Resolve
     * that id to a location via Cities.get, falling back to matching our own
     * city list, and to a live getHeadSelectedCity() read if the cache is empty.
     */
    getSelectedCityCenter() {
        try {
            let id = this.selectedCityID;
            if (!id) {
                const live = UI?.Player?.getHeadSelectedCity?.();
                if (live) { id = live; }
            }
            const invalid = !id
                || (typeof ComponentID !== "undefined" && ComponentID?.isValid && !ComponentID.isValid(id));
            if (invalid) {
                return null;
            }
            // Documented accessor first.
            if (typeof Cities !== "undefined" && Cities?.get) {
                const loc = Cities.get(id)?.location;
                if (loc) {
                    console.error(`[AutoPin] resolved selected city via Cities.get -> ${loc.x},${loc.y}`);
                    return { x: loc.x, y: loc.y };
                }
            }
            // Fallback: match our own city list by owner+id.
            const player = Players.get(GameContext.localPlayerID);
            const cities = player?.Cities?.getCities?.() || [];
            for (const city of cities) {
                const cid = city?.id;
                const match = cid && (
                    (typeof ComponentID !== "undefined" && ComponentID?.isMatch?.(cid, id))
                    || (cid.id === id.id && cid.owner === id.owner)
                );
                if (match && city.location) {
                    console.error(`[AutoPin] resolved selected city via player city list -> ${city.location.x},${city.location.y}`);
                    return { x: city.location.x, y: city.location.y };
                }
            }
            console.error("[AutoPin] a city id is selected but could not be resolved to a location.");
        } catch (e) {
            console.error(`[AutoPin] selected-city detection failed: ${e}\n${e?.stack}`);
        }
        return null;
    }
    /**
     * Track the selected city via the engine's CitySelectionChanged event
     * (payload { cityID }) — the same signal the game's own city screens use.
     * Store a valid id; clear on deselection so F3 with no city plans all.
     */
    onCitySelectionChanged(data) {
        try {
            const cityID = data?.cityID;
            const valid = cityID
                && (typeof ComponentID === "undefined"
                    || !ComponentID?.isValid
                    || ComponentID.isValid(cityID));
            this.selectedCityID = valid ? cityID : null;
            console.error(`[AutoPin] CitySelectionChanged -> ${JSON.stringify(this.selectedCityID)}`);
        } catch (e) {
            console.error(`[AutoPin] CitySelectionChanged handler error: ${e}`);
        }
    }
    suggestSettlements() {
        this.runBanner("settle");
        try {
            this.clearPins(KEY_SETTLE_LIST);
            const cityCenterType = this.getCityCenterType();
            if (!cityCenterType) {
                console.error("[AutoPin] no city-center building type found.");
                return;
            }
            const centers = this.getPlanCenters();
            const candidates = this.getSettleCandidates(centers);
            // Stage 1: cheap terrain/resource score, keep the best few.
            MapTackUtils.togglePlotDetailsCache(true);
            let finalists;
            try {
                for (const c of candidates) {
                    c.cheapScore = this.cheapSettleScore(c);
                }
                candidates.sort((a, b) => b.cheapScore - a.cheapScore);
                finalists = candidates.slice(0, SETTLE_FINALISTS);
            } finally {
                MapTackUtils.togglePlotDetailsCache(false);
            }
            // Stage 2: value of the best building plan around each finalist.
            // Existing centers are passed so a candidate only scores the tiles
            // it would actually own (not ones nearer an existing city).
            for (const c of finalists) {
                c.planValue = this.planValueAt(c, cityCenterType, centers);
            }
            finalists.sort((a, b) => b.planValue - a.planValue);
            // Pick suggestions, keeping them apart from each other.
            const chosen = [];
            for (const c of finalists) {
                if (chosen.length >= SETTLE_SUGGESTIONS) {
                    break;
                }
                if (chosen.every(o => this.plotDistance(c.x, c.y, o.x, o.y) >= MIN_SETTLE_DISTANCE)) {
                    chosen.push(c);
                }
            }
            const placed = [];
            for (const c of chosen) {
                const validStatus = MapTackValidator.isValid(c.x, c.y, cityCenterType);
                const yieldDetails = MapTackYield.getYieldDetails(c.x, c.y, cityCenterType);
                engine.trigger("AddMapTackRequest", {
                    x: c.x, y: c.y, type: cityCenterType,
                    classType: MapTackUtils.getConstructibleClassType(cityCenterType),
                    validStatus, yieldDetails
                });
                placed.push({ x: c.x, y: c.y, type: cityCenterType });
            }
            this.savePinList(KEY_SETTLE_LIST, placed);
            console.error(`[AutoPin] suggested ${placed.length} settlement locations (from ${candidates.length} candidates).`);
        } catch (e) {
            console.error(`[AutoPin] settle suggestion failed: ${e}\n${e?.stack}`);
        } finally {
            this.runBannerEnd("settle");
        }
    }
    clearAll() {
        this.clearPins(KEY_PIN_LIST);
        this.clearPins(KEY_SETTLE_LIST);
    }
    clearPins(listKey) {
        try {
            const pins = this.loadPinList(listKey);
            for (const pin of pins) {
                // Only remove if a matching tack still exists (player may have deleted/edited).
                const existing = MapTackStore.retrieveMapTacks(pin.x, pin.y);
                if (existing.some(m => m.type == pin.type)) {
                    engine.trigger("RemoveMapTackRequest", { x: pin.x, y: pin.y, type: pin.type });
                }
            }
            this.savePinList(listKey, []);
        } catch (e) {
            console.error(`[AutoPin] clear failed: ${e}\n${e?.stack}`);
        }
    }

    /* ------------------------------------------------------------- planning */

    /**
     * Plan centers = real cities owned by the local player, plus any DMT
     * city-center map tacks (planned settlements).
     */
    getPlanCenters() {
        const centers = [];
        const seen = new Set();
        const addCenter = (x, y) => {
            const key = `${x}-${y}`;
            if (!seen.has(key)) {
                seen.add(key);
                centers.push({ x, y });
            }
        };
        // Real cities.
        try {
            const player = Players.get(GameContext.localPlayerID);
            const cities = player?.Cities?.getCities?.() || [];
            for (const city of cities) {
                const loc = city?.location;
                if (loc) {
                    addCenter(loc.x, loc.y);
                }
            }
        } catch (e) {
            console.error(`[AutoPin] failed to enumerate cities: ${e}`);
        }
        // Planned settlements (DMT city-center tacks).
        for (const plot of MapTackUtils.getCityCenterMapTackPlots()) {
            addCenter(plot.x, plot.y);
        }
        return centers;
    }

    /**
     * Greedy optimizer for one city: each round, evaluate every remaining
     * (building, plot) pair and commit the highest-scoring one. Because DMT's
     * getRealizedPlotDetails folds already-placed map tacks into plot details,
     * every subsequent round automatically sees planned quarters/adjacencies.
     */
    planCity(center, usedWonders = new Set(), otherCenters = []) {
        const placed = [];
        const plots = this.getCandidatePlots(center, otherCenters);
        if (plots.length == 0) {
            return placed;
        }
        // Phase 1: buildings, planned in waves with an expanding tech horizon.
        // Wave 1 (buildable now) claims the core; later waves widen the pool
        // and — thanks to contiguity — fan outward from what's committed.
        // Unplaced candidates carry forward into later waves.
        let remaining = this.getCandidateBuildings(plots, center);
        // Diagnostic: dist 0 = buildable now (core wave), >=1 = tech horizon.
        // If an upgrade you can't build yet shows =0 here, it will wrongly
        // compete with its available base — that's the bug this guards against.
        console.error(`[AutoPin] ${center.x},${center.y} building dists: `
            + remaining.map(c => `${c.type}=${c.dist}`).join(", "));
        for (const wave of PLAN_WAVES) {
            const pool = remaining.filter(c => c.dist <= wave.maxTechDistance).map(c => c.type);
            if (pool.length == 0) {
                continue;
            }
            const wavePlots = wave.ownedOnly ? plots.filter(p => p.owned) : plots;
            if (wavePlots.length == 0) {
                continue;
            }
            const layout = this.beamSearch(pool, wavePlots, Math.min(pool.length, wave.budget));
            const placedTypes = new Set();
            for (const pin of layout) {
                this.placePin(pin);
                placed.push({ x: pin.x, y: pin.y, type: pin.type });
                placedTypes.add(pin.type);
            }
            remaining = remaining.filter(c => !placedTypes.has(c.type));
        }
        // Phase 2: wonders. Placed after buildings so mutual adjacency pulls
        // them next to planned quarters (every building gains adjacency from
        // wonders), and their own terrain adjacencies still count.
        const wonderPool = this.getCandidateWonders(plots, usedWonders, center);
        let wondersRemaining = Math.min(wonderPool.length, MAX_WONDERS_PER_CITY);
        while (wondersRemaining > 0 && wonderPool.length > 0) {
            const best = this.findBestPlacement(wonderPool, plots);
            if (!best || best.score < WONDER_MIN_SCORE) {
                break; // nothing left that justifies a wonder race
            }
            this.placePin(best);
            placed.push({ x: best.x, y: best.y, type: best.type });
            usedWonders.add(best.type);
            wonderPool.splice(wonderPool.indexOf(best.type), 1);
            wondersRemaining--;
        }
        return placed;
    }
    findBestPlacement(pool, plots, useMutual = true) {
        return this.evaluatePlacements(pool, plots, useMutual, 1)[0] ?? null;
    }
    /**
     * Score every legal (type, plot) pair against the current (possibly
     * hypothetical) map state and return the top `topM`, best first.
     */
    evaluatePlacements(pool, plots, useMutual = true, topM = 1) {
        const results = [];
        // Baseline scores of existing tacks, memoized for this pass.
        const baselineScores = new Map();
        // Cost of urbanizing each plot (rural yields destroyed), memoized.
        const urbanizeCosts = new Map();
        // Warehouse yields per type (settlement-wide, tile-independent), memoized.
        const warehouseScores = new Map();
        // Plot-details cache is safe within a single evaluation pass (the map
        // tack store doesn't change while we only read). mutualAdjacencyDelta
        // flushes it around hypothetical insertions.
        MapTackUtils.togglePlotDetailsCache(true);
        try {
            // Urban contiguity: cities grow outward, so only tiles touching
            // the (planned) urban network are placeable this round.
            const reachablePlots = plots.filter(p => this.isUrbanReachable(p));
            for (const type of pool) {
                for (const plot of reachablePlots) {
                    const validStatus = MapTackValidator.isValid(plot.x, plot.y, type);
                    if (!validStatus.isValid || validStatus.preventPlacement) {
                        continue;
                    }
                    const yieldDetails = MapTackYield.getYieldDetails(plot.x, plot.y, type);
                    let score = this.scoreYields(yieldDetails);
                    // Warehouse yields (granary & co) — same on every tile,
                    // but they make the building competitive at all.
                    let warehouseScore = warehouseScores.get(type);
                    if (warehouseScore === undefined) {
                        warehouseScore = this.getWarehouseScore(type, plots);
                        warehouseScores.set(type, warehouseScore);
                    }
                    score += warehouseScore;
                    if (useMutual) {
                        // Mutual adjacency: value this pin adds to already-placed neighbors.
                        score += this.mutualAdjacencyDelta(plot, type, validStatus, baselineScores);
                    }
                    // Opportunity cost: placing a building on a rural tile
                    // destroys its improvement — subtract the yields the tile
                    // currently produces (a garden that nets +1 food -2 gold
                    // over a farm shouldn't score like +4 food gross).
                    const plotKey = `${plot.x}-${plot.y}`;
                    let urbanizeCost = urbanizeCosts.get(plotKey);
                    if (urbanizeCost === undefined) {
                        urbanizeCost = this.getUrbanizeCost(plot);
                        urbanizeCosts.set(plotKey, urbanizeCost);
                    }
                    score -= urbanizeCost;
                    // Wonder-ambition damper: each wonder already planned this
                    // run raises the bar for the next one.
                    if (this.runWonderCount > 0
                        && MapTackUtils.getConstructibleClassType(type) == ConstructibleClassType.WONDER) {
                        score *= Math.pow(WONDER_DAMPING, this.runWonderCount);
                    }
                    results.push({ x: plot.x, y: plot.y, type, validStatus, yieldDetails, score });
                }
            }
        } finally {
            MapTackUtils.togglePlotDetailsCache(false);
        }
        results.sort((a, b) => b.score - a.score);
        return results.slice(0, topM);
    }
    /**
     * Beam search over partial layouts. Keeps BEAM_WIDTH candidate layouts
     * alive; each round every layout is hypothetically applied to DMT's cache
     * and extended with its BEAM_EXTENSIONS best placements. Layouts that are
     * permutations of the same pin set collapse into one state. Returns the
     * pin list of the best layout found.
     */
    beamSearch(pool, plots, budget) {
        let beam = [{ pins: [], poolLeft: pool, total: 0 }];
        let bestComplete = beam[0];
        for (let round = 0; round < budget; round++) {
            const nextStates = new Map();
            for (const state of beam) {
                // Apply this layout's pins so scoring sees them.
                const handles = state.pins.map(p => this.hypotheticalInsert(p.x, p.y, p.type, p.validStatus));
                let exts;
                try {
                    exts = this.evaluatePlacements(state.poolLeft, plots, true, BEAM_EXTENSIONS);
                } finally {
                    for (const h of handles.reverse()) {
                        this.hypotheticalRemove(h);
                    }
                }
                for (const ext of exts) {
                    const pins = [...state.pins, ext];
                    const key = pins.map(p => `${p.x},${p.y},${p.type}`).sort().join("|");
                    const total = state.total + ext.score;
                    const existing = nextStates.get(key);
                    if (!existing || total > existing.total) {
                        nextStates.set(key, {
                            pins,
                            poolLeft: state.poolLeft.filter(t => t != ext.type),
                            total
                        });
                    }
                }
            }
            if (nextStates.size == 0) {
                break; // no layout can be extended further
            }
            beam = [...nextStates.values()].sort((a, b) => b.total - a.total).slice(0, BEAM_WIDTH);
            if (beam[0].total > bestComplete.total) {
                bestComplete = beam[0];
            }
        }
        return bestComplete.pins;
    }
    /**
     * Urban contiguity rule (Civ 7): new urban tiles must be adjacent to the
     * city center or an existing urban district. Planned tacks count — DMT
     * realizes tack tiles as urban districts — so plans grow outward from the
     * center exactly like real cities, and each committed pin unlocks its
     * neighbors for the next round.
     */
    isUrbanReachable(plot) {
        // A tile that is already (planned) urban can take its second building.
        const own = MapTackUtils.getRealizedPlotDetails(plot.x, plot.y);
        if (own?.district == "DISTRICT_URBAN") {
            return true;
        }
        const neighbors = MapTackUtils.getAdjacentPlotDetails(plot.x, plot.y) || [];
        return neighbors.some(p => {
            const d = p?.details?.district;
            return d == "DISTRICT_CITY_CENTER" || d == "DISTRICT_URBAN" || d == "DISTRICT_WONDER";
        });
    }
    /**
     * How much would placing `type` at `plot` improve the yields of existing
     * valid map tacks around it (quarter formation, adjacency chains)?
     *
     * Computed by temporarily inserting the candidate into DMT's in-memory
     * tack cache and re-running DMT's own yield engine on the neighbors —
     * no adjacency math is duplicated here. The persistent store is never
     * touched; only the cache reference is swapped and restored.
     */
    mutualAdjacencyDelta(plot, type, validStatus, baselineScores) {
        // Neighbor tacks whose yields could change (adjacent plots only —
        // adjacency bonuses never reach further than one tile).
        const neighborStructs = MapTackUtils.getAdjacentMapTackStructs(plot.x, plot.y, false);
        const neighbors = [];
        for (const struct of neighborStructs) {
            for (const tack of (struct.mapTackList || [])) {
                if (tack.validStatus?.isValid) {
                    neighbors.push(tack);
                }
            }
        }
        if (neighbors.length == 0) {
            return 0;
        }
        // Baselines (memoized per round, computed against the unmodified cache).
        for (const tack of neighbors) {
            const key = `${tack.x}-${tack.y}-${tack.type}`;
            if (!baselineScores.has(key)) {
                baselineScores.set(key, this.scoreYields(MapTackYield.getYieldDetails(tack.x, tack.y, tack.type)));
            }
        }
        const hypo = this.hypotheticalInsert(plot.x, plot.y, type, validStatus);
        let delta = 0;
        try {
            for (const tack of neighbors) {
                const key = `${tack.x}-${tack.y}-${tack.type}`;
                const newScore = this.scoreYields(MapTackYield.getYieldDetails(tack.x, tack.y, tack.type));
                delta += newScore - baselineScores.get(key);
            }
        } finally {
            this.hypotheticalRemove(hypo);
        }
        return delta;
    }
    scoreYields(yieldDetails) {
        let score = 0;
        const addYields = (list, weightFactor) => {
            for (const y of (list || [])) {
                score += (y.amount || 0) * (YIELD_WEIGHTS[y.type] ?? 1) * weightFactor;
            }
        };
        addYields(yieldDetails.base, 1);
        addYields(yieldDetails.bonus, 1);
        // Adjacencies scale as the city grows; weight them up slightly.
        addYields(yieldDetails.adjacencies, 1.25);
        return score;
    }
    placePin(best) {
        const mapTackData = {
            x: best.x,
            y: best.y,
            type: best.type,
            classType: MapTackUtils.getConstructibleClassType(best.type),
            validStatus: best.validStatus,
            yieldDetails: best.yieldDetails
        };
        engine.trigger("AddMapTackRequest", mapTackData);
        // Feed the wonder-ambition damper.
        if (mapTackData.classType == ConstructibleClassType.WONDER) {
            this.runWonderCount++;
        }
    }

    /**
     * Warehouse yield definitions per constructible (granary's "+food from
     * farms in this settlement" and friends), cached from the game database.
     * Missing tables degrade to an empty cache (score 0).
     */
    getWarehouseDefs(type) {
        if (!this.warehouseDefs) {
            this.warehouseDefs = new Map();
            try {
                for (const e of (GameInfo.Constructible_WarehouseYields || [])) {
                    const def = GameInfo.Warehouse_YieldChanges?.lookup?.(e.YieldChangeId);
                    if (!def) {
                        continue;
                    }
                    const list = this.warehouseDefs.get(e.ConstructibleType) || [];
                    list.push({ id: e.YieldChangeId, requiresActivation: e.RequiresActivation, def });
                    this.warehouseDefs.set(e.ConstructibleType, list);
                }
            } catch (e) {
                console.error(`[AutoPin] warehouse cache failed: ${e}`);
            }
            // One-time health check: if either table is missing or empty, the
            // whole warehouse component silently scores 0 (its fail-soft paths
            // swallow the problem). Surface it so a wrong table/column name is
            // obvious in the console.
            const linkRows = (GameInfo.Constructible_WarehouseYields || []).length;
            console.error(`[AutoPin] warehouse data: `
                + `Constructible_WarehouseYields=${GameInfo.Constructible_WarehouseYields ? linkRows + " rows" : "MISSING"}, `
                + `Warehouse_YieldChanges=${GameInfo.Warehouse_YieldChanges ? "present" : "MISSING"}, `
                + `resolved defs for ${this.warehouseDefs.size} constructibles.`);
        }
        return this.warehouseDefs.get(type) || [];
    }
    /**
     * Weighted warehouse value of this building for the city: sum of its
     * warehouse yield changes over the settlement's owned tiles.
     */
    getWarehouseScore(type, plots) {
        const defs = this.getWarehouseDefs(type);
        if (defs.length == 0) {
            return 0;
        }
        let score = 0;
        try {
            for (const plot of plots) {
                if (plot.owned === false) {
                    continue; // only tiles the settlement actually works
                }
                const details = MapTackUtils.getRealizedPlotDetails(plot.x, plot.y);
                if (!details) {
                    continue;
                }
                for (const d of defs) {
                    // Only drop an activation-gated yield when the helper
                    // EXISTS and says it's locked. If DMT doesn't expose the
                    // helper, `?.` returns undefined and the old `!undefined`
                    // test skipped EVERY activation yield — assume unlocked
                    // instead so those buildings can still qualify.
                    if (d.requiresActivation
                        && typeof MapTackModifier.isAdjacencyUnlocked == "function"
                        && !MapTackModifier.isAdjacencyUnlocked(d.id)) {
                        continue;
                    }
                    if (this.matchesWarehouseCondition(d.def, details)) {
                        score += (d.def.YieldChange || 0) * (YIELD_WEIGHTS[d.def.YieldType] ?? 1);
                    }
                }
            }
        } catch (e) { /* fail soft: no warehouse component */ }
        return score;
    }
    /**
     * Does a tile satisfy a Warehouse_YieldChanges row's condition? Columns
     * we can't evaluate are ignored; a row must match at least one condition
     * we CAN check to count.
     */
    matchesWarehouseCondition(def, details) {
        let matched = false;
        // Warehouse yield rows name their conditions with an `InCity` suffix
        // (the bonus applies to matching tiles anywhere in the settlement),
        // e.g. `ConstructibleInCity=IMPROVEMENT_PASTURE`. Older/other rows may
        // use `InTile`; accept either.
        const cond = (base) => def[base + "InCity"] ?? def[base + "InTile"];

        const terrain = cond("Terrain");
        if (terrain) {
            if (details.terrain != terrain) { return false; }
            matched = true;
        }
        const biome = cond("Biome");
        if (biome) {
            if (details.biome != biome) { return false; }
            matched = true;
        }
        const feature = cond("Feature");
        if (feature) {
            if (details.feature != feature) { return false; }
            matched = true;
        }
        const featureClass = cond("FeatureClass");
        if (featureClass) {
            if (MapTackUtils.getFeatureClassType(details.feature) != featureClass) { return false; }
            matched = true;
        }
        if (cond("Lake")) {
            if (!details.isLake) { return false; }
            matched = true;
        }
        if (cond("NavigableRiver")) {
            if (details.terrain != "TERRAIN_NAVIGABLE_RIVER") { return false; }
            matched = true;
        }
        if (cond("MinorRiver") || cond("River")) {
            if (!details.isRiver) { return false; }
            matched = true;
        }
        if (cond("NaturalWonder")) {
            if (!details.isNaturalWonder) { return false; }
            matched = true;
        }
        const resource = cond("Resource");
        if (resource) {
            // May be a specific resource type or a boolean "any resource".
            if (resource === true) {
                if (!details.resource) { return false; }
            } else if (details.resource != resource) {
                return false;
            }
            matched = true;
        }
        const constructible = cond("Constructible");
        if (constructible) {
            if (!details.constructibles?.includes(constructible)) { return false; }
            matched = true;
        }
        const district = cond("District");
        if (district) {
            if (details.district != district) { return false; }
            matched = true;
        }
        return matched;
    }
    /**
     * Weighted yields lost by urbanizing this plot. Non-zero only for rural
     * tiles (existing improvement gets replaced). Tiles already urban —
     * really or in the plan — cost nothing extra: the loss was charged to the
     * first pin.
     */
    getUrbanizeCost(plot) {
        const details = MapTackUtils.getRealizedPlotDetails(plot.x, plot.y);
        if (details?.district != "DISTRICT_RURAL") {
            return 0;
        }
        let cost = 0;
        for (const y of this.getCurrentPlotYields(plot.x, plot.y)) {
            cost += (y.amount || 0) * (YIELD_WEIGHTS[y.type] ?? 1);
        }
        return cost;
    }
    /**
     * The yields this plot currently produces, via the game's own yield
     * query. Returns [] if the API is unavailable (no cost applied).
     */
    getCurrentPlotYields(x, y) {
        const result = [];
        try {
            const plotIndex = GameplayMap.getIndexFromXY
                ? GameplayMap.getIndexFromXY(x, y)
                : GameplayMap.getIndexFromLocation({ x, y });
            const yields = GameplayMap.getYields(plotIndex, GameContext.localPlayerID) || [];
            for (const entry of yields) {
                if (Array.isArray(entry)) {
                    result.push({ type: entry[0], amount: entry[1] || 0 });
                } else if (entry && typeof entry == "object") {
                    result.push({ type: entry.type, amount: entry.amount ?? entry.value ?? 0 });
                }
            }
        } catch (e) { /* API unavailable — no opportunity cost */ }
        return result;
    }

    /* ------------------------------------------------- hypothetical inserts */

    /**
     * Insert a tack into DMT's in-memory cache only (persistent store is never
     * written) and flush the plot-details cache so reads see it. Returns a
     * handle for hypotheticalRemove.
     */
    hypotheticalInsert(x, y, type, validStatus) {
        const plotKey = MapTackStore.getMapTackKey(x, y);
        const originalList = MapTackStore.cacheMap[plotKey];
        MapTackStore.cacheMap[plotKey] = [...(originalList || []), {
            x, y, type,
            classType: MapTackUtils.getConstructibleClassType(type),
            validStatus, yieldDetails: {}
        }];
        MapTackUtils.togglePlotDetailsCache(true); // flush stale plot details
        return { plotKey, originalList };
    }
    hypotheticalRemove(hypo) {
        if (hypo.originalList === undefined) {
            delete MapTackStore.cacheMap[hypo.plotKey];
        } else {
            MapTackStore.cacheMap[hypo.plotKey] = hypo.originalList;
        }
        MapTackUtils.togglePlotDetailsCache(true); // flush again
    }

    /* ------------------------------------------------ settlement suggestion */

    /**
     * First building type flagged as a city center (CityCenterPriority > 0),
     * matching DMT's own isCityCenter test, preferring non-palace entries.
     */
    getCityCenterType() {
        let fallback = null;
        for (const e of GameInfo.Buildings) {
            if (e.CityCenterPriority > 0) {
                if (e.ConstructibleType != "BUILDING_PALACE") {
                    return e.ConstructibleType;
                }
                fallback = fallback || e.ConstructibleType;
            }
        }
        return fallback;
    }
    /**
     * Candidate settle plots: rings MIN_SETTLE_DISTANCE..SETTLE_SEARCH_RADIUS
     * around existing plan centers, unowned or own territory, legal for a
     * city-center tack per DMT's validator.
     */
    /**
     * Locations of every settlement on the map — all players, including AI
     * and independent powers. The game's minimum-distance rule counts them
     * all, not just ours.
     */
    getAllSettlementLocations() {
        const locations = [];
        try {
            const players = Players.getAlive?.() || Players.getEverAlive?.() || [];
            for (const player of players) {
                const cities = player?.Cities?.getCities?.() || [];
                for (const city of cities) {
                    if (city?.location) {
                        locations.push({ x: city.location.x, y: city.location.y });
                    }
                }
            }
        } catch (e) {
            console.error(`[AutoPin] failed to enumerate all settlements: ${e}`);
        }
        return locations;
    }
    /**
     * Villages/encampments of independent powers near the search area. The
     * game's settle-distance rule counts them, but they aren't cities (no
     * player.Cities entry), so find them by scanning tiles for their
     * village/encampment constructibles. Swept slightly wider than the search
     * radius so villages just outside it still enforce spacing.
     */
    getIndependentSettlementLocations(centers) {
        const found = [];
        const seen = new Set();
        const sweepRadius = SETTLE_SEARCH_RADIUS + MIN_SETTLE_DISTANCE;
        try {
            for (const center of centers) {
                const plotIndices = GameplayMap.getPlotIndicesInRadius(center.x, center.y, sweepRadius) || [];
                for (const plotIndex of plotIndices) {
                    const loc = GameplayMap.getLocationFromIndex(plotIndex);
                    const key = `${loc.x}-${loc.y}`;
                    if (seen.has(key)) {
                        continue;
                    }
                    seen.add(key);
                    const constructibles = MapTackUtils.getConstructiblesAtPlot(loc.x, loc.y) || [];
                    if (constructibles.some(c => typeof c == "string"
                        && (c.includes("VILLAGE") || c.includes("ENCAMPMENT")))) {
                        found.push({ x: loc.x, y: loc.y });
                    }
                }
            }
        } catch (e) {
            console.error(`[AutoPin] independent settlement sweep failed: ${e}`);
        }
        return found;
    }
    getSettleCandidates(centers) {
        const localPlayerID = GameContext.localPlayerID;
        // Spacing must respect every settlement on the map — AI cities, our
        // planned centers, AND independent-power villages (which aren't
        // cities and usually own only their own tile).
        const spacingAnchors = [
            ...centers,
            ...this.getAllSettlementLocations(),
            ...this.getIndependentSettlementLocations(centers)
        ];
        const seen = new Set();
        const candidates = [];
        for (const center of centers) {
            const plotIndices = GameplayMap.getPlotIndicesInRadius(center.x, center.y, SETTLE_SEARCH_RADIUS) || [];
            for (const plotIndex of plotIndices) {
                const loc = GameplayMap.getLocationFromIndex(plotIndex);
                const key = `${loc.x}-${loc.y}`;
                if (seen.has(key)) {
                    continue;
                }
                seen.add(key);
                // Respect settlement spacing against every anchor.
                if (spacingAnchors.some(c => this.plotDistance(loc.x, loc.y, c.x, c.y) < MIN_SETTLE_DISTANCE)) {
                    continue;
                }
                // Skip other players' territory.
                try {
                    const owner = GameplayMap.getOwner(loc.x, loc.y);
                    if (owner != null && owner != -1 && owner != localPlayerID) {
                        continue;
                    }
                } catch (e) { /* fine */ }
                // Skip unrevealed plots when the API is available.
                try {
                    if (GameplayMap.getRevealedState && GameplayMap.getRevealedState(localPlayerID, loc.x, loc.y) === 0) {
                        continue;
                    }
                } catch (e) { /* fine */ }
                candidates.push({ x: loc.x, y: loc.y });
            }
        }
        // Legality via DMT's validator (rejects water, mountains, natural wonders, ...).
        const cityCenterType = this.getCityCenterType();
        return candidates.filter(c => {
            const status = MapTackValidator.isValid(c.x, c.y, cityCenterType);
            return status.isValid && !status.preventPlacement;
        });
    }
    /**
     * Stage-1 heuristic: fresh water, coast/navigable river access, nearby
     * resources, workable land. All read from DMT's realized plot details.
     */
    cheapSettleScore(c) {
        let score = 0;
        const ring1 = MapTackUtils.getAdjacentPlotDetails(c.x, c.y) || [];
        for (const p of ring1) {
            const d = p?.details;
            if (!d) {
                continue;
            }
            if (d.isRiver) { score += 5; }               // fresh water / river adjacency
            if (d.isLake) { score += 4; }
            if (d.terrain == "TERRAIN_NAVIGABLE_RIVER") { score += 4; }
            if (d.terrain == "TERRAIN_COAST") { score += 2; }
            if (d.terrain == "TERRAIN_MOUNTAIN") { score += 1; } // adjacency fodder
            if (d.resource) { score += 3; }
        }
        // Resources in the wider workable area.
        const plotIndices = GameplayMap.getPlotIndicesInRadius(c.x, c.y, 2) || [];
        for (const plotIndex of plotIndices) {
            const loc = GameplayMap.getLocationFromIndex(plotIndex);
            const d = MapTackUtils.getRealizedPlotDetails(loc.x, loc.y);
            if (d?.resource) { score += 2; }
        }
        return score;
    }
    /**
     * Stage-2 score: hypothetically found the city (cache-only city-center
     * tack), run a short greedy building plan around it with the real
     * optimizer, and sum the plan's scores. "Settle where the best city can
     * be built", not "settle where today's tile yields are highest".
     */
    planValueAt(c, cityCenterType, otherCenters = []) {
        const validStatus = MapTackValidator.isValid(c.x, c.y, cityCenterType);
        const hypos = [this.hypotheticalInsert(c.x, c.y, cityCenterType, validStatus)];
        let total = 0;
        try {
            const plots = this.getCandidatePlots(c, otherCenters);
            const pool = this.getCandidateBuildings(plots, c).filter(b => b.dist == 0).map(b => b.type);
            for (let round = 0; round < SETTLE_PLAN_ROUNDS && pool.length > 0; round++) {
                const best = this.findBestPlacement(pool, plots, false);
                if (!best) {
                    break;
                }
                total += best.score;
                hypos.push(this.hypotheticalInsert(best.x, best.y, best.type, best.validStatus));
                pool.splice(pool.indexOf(best.type), 1);
            }
        } finally {
            // Unwind in reverse order to restore original cache lists.
            for (const hypo of hypos.reverse()) {
                this.hypotheticalRemove(hypo);
            }
        }
        return total;
    }
    plotDistance(x1, y1, x2, y2) {
        try {
            if (GameplayMap.getPlotDistance) {
                return GameplayMap.getPlotDistance(x1, y1, x2, y2);
            }
        } catch (e) { /* fall through */ }
        // Rough hex-grid approximation if the API is unavailable.
        return Math.max(Math.abs(x1 - x2), Math.abs(y1 - y2));
    }

    /* ----------------------------------------------------------- candidates */

    getCandidatePlots(center, otherCenters = []) {
        const plots = [];
        const localPlayerID = GameContext.localPlayerID;
        const plotIndices = GameplayMap.getPlotIndicesInRadius(center.x, center.y, CITY_RADIUS) || [];
        for (const plotIndex of plotIndices) {
            const loc = GameplayMap.getLocationFromIndex(plotIndex);
            const x = loc.x, y = loc.y;
            if (x == center.x && y == center.y) {
                continue; // city center itself
            }
            // Nearest-center ownership: when other plan centers exist, only keep
            // a plot if THIS center is the closest to it. This partitions the
            // overlap zone between adjacent cities so no tile is planned twice.
            if (otherCenters.length && !this.plotBelongsToCenter(x, y, center, otherCenters)) {
                continue;
            }
            // Skip plots owned by someone else; remember which ones are ours.
            let owned = false;
            try {
                const owner = GameplayMap.getOwner(x, y);
                if (owner != null && owner != -1 && owner != localPlayerID) {
                    continue;
                }
                owned = owner == localPlayerID;
            } catch (e) { /* unowned/fogged plots are fine to plan on */ }
            plots.push({ x, y, owned });
        }
        return plots;
    }

    /**
     * Does `center` own this plot — i.e. is it the nearest plan center to it?
     * Ties (equidistant plots) are broken deterministically by a coordinate
     * key so exactly one center claims each contested tile.
     */
    plotBelongsToCenter(x, y, center, otherCenters) {
        const dc = this.plotDistance(x, y, center.x, center.y);
        const cKey = center.y * 100000 + center.x;
        for (const o of otherCenters) {
            const d = this.plotDistance(x, y, o.x, o.y);
            if (d < dc) {
                return false;
            }
            if (d == dc && (o.y * 100000 + o.x) < cKey) {
                return false; // tie -> lower-keyed center wins
            }
        }
        return true;
    }

    /**
     * Buildings worth planning: current-age or ageless, buildable, with at
     * least one adjacency definition (placement-sensitive), including the
     * player's unique buildings. Types already present (built or pinned)
     * within the candidate plots are skipped.
     */
    getCandidateBuildings(plots, center = null) {
        // Types already realized (built or pinned) on these plots. The city
        // center tile is included in this sweep — buildings like the monument
        // often live in the center's slots — even though it's never a
        // placement candidate itself.
        const usedTypes = new Set();
        const sweepPlots = center ? [center, ...plots] : plots;
        for (const plot of sweepPlots) {
            const details = MapTackUtils.getRealizedPlotDetails(plot.x, plot.y);
            for (const c of (details?.constructibles || [])) {
                usedTypes.add(c);
            }
        }
        // Unique-building bookkeeping (mirrors DMT's chooser logic).
        const inactiveUniques = new Set();
        const activeUniques = new Set();
        for (const e of GameInfo.Buildings) {
            if (e.TraitType && e.TraitType != "TRAIT_LEADER_MINOR_CIV") {
                if (TraitModifier.isTraitActive(e.TraitType)) {
                    activeUniques.add(e.ConstructibleType);
                } else {
                    inactiveUniques.add(e.ConstructibleType);
                }
            }
        }
        // Types with adjacency definitions are always placement-sensitive.
        const adjacencyTypes = new Set();
        for (const a of GameInfo.Constructible_Adjacencies) {
            adjacencyTypes.add(a.ConstructibleType);
        }
        const candidates = [];
        const warehouseRejects = [];
        for (const e of GameInfo.Constructibles) {
            const type = e.ConstructibleType;
            if (e.ConstructibleClass != ConstructibleClassType.BUILDING) {
                continue;
            }
            if (usedTypes.has(type) || ExcludedItems.has(type) || inactiveUniques.has(type)) {
                continue;
            }
            if (MapTackUtils.isCityCenter(type) || MapTackUtils.isObsolete(type)) {
                continue;
            }
            if (!MapTackUtils.isCurrentAge(type) && !MapTackUtils.isAgeless(type)) {
                continue;
            }
            if (MapTackUtils.isSlotless(type)) {
                continue; // walls etc. — no building slot, no urban district
            }
            // Placement-sensitive buildings (adjacencies or uniques) always
            // qualify. Placement-agnostic ones (granary, saw pit) must earn
            // the pin: their warehouse yields in THIS city have to clear the
            // floor. When they do, they compete on full score — and still
            // complete quarters / bridge the urban network like any building.
            if (!adjacencyTypes.has(type) && !activeUniques.has(type)) {
                const ws = this.getWarehouseScore(type, plots);
                if (ws < WAREHOUSE_MIN_SCORE) {
                    warehouseRejects.push(`${type}=${ws.toFixed(1)}`);
                    continue;
                }
            }
            candidates.push({ type, dist: this.techDistance(type) });
        }
        // Diagnostic: placement-agnostic buildings that failed the warehouse
        // floor, with their computed scores. A score of 0.0 means the
        // warehouse pipeline produced nothing (data/condition mismatch); a
        // small positive number means it worked but just missed the floor.
        if (warehouseRejects.length) {
            console.error(`[AutoPin] below warehouse floor (${WAREHOUSE_MIN_SCORE}): `
                + warehouseRejects.join(", "));
        }
        return candidates;
    }

    /**
     * Wonders worth planning: current-age, not excluded, not already built or
     * pinned anywhere (wonders are one-per-world), and not planned for
     * another city in this run.
     */
    getCandidateWonders(plots, usedWonders, center = null) {
        const usedTypes = new Set();
        const sweepPlots = center ? [center, ...plots] : plots;
        for (const plot of sweepPlots) {
            const details = MapTackUtils.getRealizedPlotDetails(plot.x, plot.y);
            for (const c of (details?.constructibles || [])) {
                usedTypes.add(c);
            }
        }
        // Feasibility: wonders completed by ANY player are gone for good, and
        // distant-lands/homeland requirements are checked against where this
        // city actually is (DMT's validator doesn't cover these yet).
        const builtAnywhere = this.getBuiltWonderTypes();
        const distantLands = center ? this.isDistantLands(center.x, center.y) : null;
        const candidates = [];
        for (const e of GameInfo.Constructibles) {
            const type = e.ConstructibleType;
            if (e.ConstructibleClass != ConstructibleClassType.WONDER) {
                continue;
            }
            if (usedTypes.has(type) || ExcludedItems.has(type) || usedWonders.has(type)) {
                continue;
            }
            if (builtAnywhere.has(type)) {
                continue;
            }
            if (distantLands != null) {
                if (e.RequiresDistantLands && !distantLands) {
                    continue;
                }
                if (e.RequiresHomeland && distantLands) {
                    continue;
                }
            }
            if (MapTackUtils.isObsolete(type)) {
                continue;
            }
            if (!MapTackUtils.isCurrentAge(type) && !MapTackUtils.isAgeless(type)) {
                continue;
            }
            // Skip wonders already pinned anywhere on the map (hand-placed
            // plans included).
            if (MapTackUtils.getMapTackTypePlots(type).length > 0) {
                continue;
            }
            if (this.techDistance(type) > MAX_TECH_DISTANCE) {
                continue;
            }
            candidates.push(type);
        }
        return candidates;
    }

    /**
     * Wonder types already completed by ANY player (wonders are one-per-world
     * and lost to everyone once someone finishes them). Note: only completed
     * wonders are visible here — a rival mid-construction can't be detected.
     */
    getBuiltWonderTypes() {
        const built = new Set();
        try {
            const players = Players.getAlive?.() || Players.getEverAlive?.() || [];
            for (const player of players) {
                const constructibles = player?.Constructibles?.getConstructibles?.() || [];
                for (const c of constructibles) {
                    const def = GameInfo.Constructibles.lookup(c.type);
                    if (def?.ConstructibleClass == ConstructibleClassType.WONDER) {
                        built.add(def.ConstructibleType);
                    }
                }
            }
        } catch (e) {
            console.error(`[AutoPin] failed to enumerate built wonders: ${e}`);
        }
        return built;
    }
    /**
     * Is this plot in the local player's distant lands? Returns null when the
     * API isn't available, in which case the constraint is skipped.
     */
    isDistantLands(x, y) {
        try {
            const player = Players.get(GameContext.localPlayerID);
            if (typeof player?.isDistantLands == "function") {
                return player.isDistantLands({ x, y });
            }
        } catch (e) { /* unknown */ }
        return null;
    }
    /**
     * How far away is this constructible on the tech/civic tree?
     *   0 - buildable now (unlocked, or no prerequisite node at all)
     *   1 - its node is researchable right now (one completed research away)
     *   2 - deeper in the tree
     * Node-state classification is defensive: if the state enum doesn't have
     * the members we expect, distance-1 detection degrades gracefully to 2.
     */
    techDistance(type) {
        // Classify a constructible by how far off it is, driven by the state of
        // its prerequisite tree node. Observed node states (see debug dump):
        //   FULLY_UNLOCKED(5) / UNLOCKED(4) -> buildable NOW      -> 0
        //   OPEN(2) / IN_PROGRESS(3)        -> one research away  -> 1
        //   CLOSED(1) / INVALID(0)          -> deeper in the tree -> 2
        //
        // Crucial nuance: DMT's isConstructibleUnlocked only reports true at
        // FULLY_UNLOCKED, so a building that is already buildable at UNLOCKED
        // (e.g. Library once Writing is reached) reads as "not unlocked". We
        // therefore trust the raw node STATE, not isConstructibleUnlocked, to
        // decide distance-0 — otherwise the available base building ties with
        // its still-locked upgrade (Academy) and loses the limited budget.
        let unlocked;
        try {
            unlocked = TreeModifier.isConstructibleUnlocked(type);
        } catch (e) {
            unlocked = undefined;
        }
        if (unlocked === true) {
            return 0; // positively buildable now (fast path)
        }
        let nodes;
        try {
            nodes = TreeModifier.constructibleNode?.[type];
        } catch (e) {
            nodes = null;
        }
        if (!nodes || nodes.length == 0) {
            return 0; // no tech gate we can see -> ageless/base, buildable now
        }
        const S = (typeof ProgressionTreeNodeState != "undefined") ? ProgressionTreeNodeState : null;
        let best = 2; // assume deep until a node proves otherwise
        for (const nodeType of nodes) {
            let state;
            try {
                state = Game.ProgressionTrees.getNodeState(GameContext.localPlayerID, nodeType);
            } catch (e) {
                continue;
            }
            const d = this.nodeStateDistance(S, state);
            if (d < best) {
                best = d;
            }
            if (best == 0) {
                break;
            }
        }
        return best;
    }
    /**
     * Map a progression-tree node state to a planning distance. Prefers the
     * named enum members; falls back to the observed raw integers if the enum
     * object isn't exposed.
     */
    nodeStateDistance(S, state) {
        if (S) {
            if (state == S.NODE_STATE_UNLOCKED || state == S.NODE_STATE_FULLY_UNLOCKED) {
                return 0;
            }
            if (state == S.NODE_STATE_OPEN || state == S.NODE_STATE_IN_PROGRESS) {
                return 1;
            }
            return 2; // CLOSED / INVALID / anything else
        }
        // Raw fallback: 4=UNLOCKED, 5=FULLY_UNLOCKED, 2=OPEN, 3=IN_PROGRESS.
        if (state === 4 || state === 5) {
            return 0;
        }
        if (state === 2 || state === 3) {
            return 1;
        }
        return 2;
    }

    /* -------------------------------------------------------------- storage */

    loadPinList(listKey) {
        try {
            const obj = this.catalog.getObject(ID_AUTOPIN);
            return JSON.parse(obj.read(listKey)) || [];
        } catch (e) {
            return [];
        }
    }
    savePinList(listKey, pins) {
        const obj = this.catalog.getObject(ID_AUTOPIN);
        obj.write(listKey, JSON.stringify(pins));
    }
}

const AutoPinPlanner = AutoPinPlannerSingleton.getInstance();
export { AutoPinPlanner as default };
