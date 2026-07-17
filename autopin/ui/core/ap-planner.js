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
// Settle-time appeal signal: Breathtaking/Charming thresholds live in
// GameInfo.GlobalParameters -- same source the base game's own Appeal lens
// reads (base-standard ui/lenses/layer/general-appeal-layer.js).
import { getGlobalParamNumber } from '/core/ui/utilities/utilities-data.js';

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

// ---- Lifetime sequence planning (M2) ------------------------------------
// When true, planCity replaces the capped waves above with a SINGLE beam over
// the whole current-age pool, scoring each placement by its raw value times a
// time discount (gamma^slotTime). This makes tile choices for deep-tech
// buildings visible to the placement of early ones (endgame-aware layout),
// while the discount naturally orders now-buildable buildings to the front and
// tech-gated ones to the back — as one contiguous, build-order-valid sequence.
// Set false to fall straight back to the wave planner (identical to M1).
const USE_LIFETIME_SEQUENCE = true;
// Per-build-slot discount. A pin coming online ~slotTime slots from now is
// worth gamma^slotTime of its raw value. Lower = more myopic (favor now).
const LIFETIME_GAMMA = 0.92;
// How many pins the single sequence places. Kept near the old wave total
// (8+3+3) for now; windowed pinning of a longer plan is M3.
const LIFETIME_BUDGET = 16;
// Tiles the settlement doesn't own yet are further off — add this many slots
// of delay to placements on them, so the plan front-loads owned tiles and
// treats unowned ones as "grow here, then build". A simple stand-in for the
// full acquisition model in M3.
const UNOWNED_SLOT_PENALTY = 2;
// Map techDistance {0,1,2} -> estimated build-slots until unlock. This is the
// coarse clock: the finer node-cost/science-rate ETA (design M0/R2) needs
// GameInfo tables not yet verified from inside the game, so the sequence runs
// on buckets by default and sharpens later without changing the algorithm.
const TECH_DIST_SLOTS = [0, 3, 8];
// Tech-aware contiguity: a bridge tile the lifetime beam hasn't actually
// built yet (a planned-but-tech-gated pin) may only count as "urban" for a
// candidate building if that pin's own tech distance is <= the candidate's.
// Without this, the beam happily routes a buildable-now building's tile
// through a bridge that needs research the player doesn't have — the bug
// this exists to close. Real, already-built urban tiles always count
// (see isUrbanReachable). Only affects the USE_LIFETIME_SEQUENCE beam;
// false reproduces the exact previous (tech-blind) contiguity check.
const TECH_AWARE_CONTIGUITY = true;

// ---- Windowed lifetime plan (M3) ----------------------------------------
// The lifetime sequence is computed in full and STORED, but only a near-term
// window (plus permanent anchors) is physically pinned, so the map isn't
// buried by a whole age of tacks. F3 recomputes: already-built buildings drop
// out of the candidate pool automatically, so the window advances on its own.
// Hard cap on how many buildings the sequence plans (was LIFETIME_BUDGET).
const LIFETIME_MAX_PINS = 30;
// Stop extending the sequence once the best next building adds less than this
// (discounted) score — the plan's length becomes data-driven rather than a
// flat budget. 0 disables the floor (plan to the hard cap).
const LIFETIME_MARGINAL_FLOOR = 0.75;
// How many buildings from the front of the (unbuilt) sequence to physically
// pin. Anchors below are pinned regardless of position.
const WINDOW_SIZE = 8;
// Ageless buildings are permanent (never overbuilt), so their placement is
// forever — pin them even when they sit deep in the sequence, so the reserved
// tile is visible now. (Wonders are always pinned in their own phase.)
const PIN_AGELESS_ANCHORS = true;
// Plan-stability bias. On re-plan (F3), a building scored on the SAME tile it
// occupied in the stored plan gets this bonus, so a new layout has to beat the
// old placement by more than a rounding error to move it. Keeps quarters from
// teleporting across the city on every regenerate.
const STABILITY_BONUS = 1.5;

// ---- Endgame-aware placement & polish (M4) ------------------------------
// Permanence premium: Ageless and unique buildings are placed forever (never
// overbuilt, can't be rebuilt elsewhere), so their placement value is scaled by
// this — they win the best tiles over throwaway current-age buildings. 1 = off.
const PERMANENCE_PREMIUM = 1.15;
// Overbuild-fodder bias: a non-permanent (current-age, non-unique) building on
// an adjacency-rich tile is worth a little extra, because next age's building
// overbuilds it in place and inherits the tile's adjacencies (for the Meiji
// endgame this is the actual win condition). Added as this fraction of the
// placement's own adjacency value. Small on purpose; 0 = off. Validate the
// magnitude in-game before leaning on it.
const FODDER_ADJACENCY_FRACTION = 0.15;
// Local-search relocation polish: after the beam, try swapping the tiles of
// building pairs and keep swaps that raise total placement value. Catches the
// residue greedy/beam leaves. Optimizes the raw per-tile proxy (no mutual-
// adjacency/discount), so it only applies strict improvements and any imperfect
// tile self-heals on the next F3. false = skip the pass.
const ENABLE_RELOCATION_PASS = true;

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
// Bridge exception to the floor above: when this city has a genuine
// contiguity gap (some candidate tile isn't reachable through the urban
// network yet), a placement-agnostic warehouse building that's buildable
// RIGHT NOW (tech distance 0) is let into the pool even if it misses
// WAREHOUSE_MIN_SCORE — it's the cheapest legal way to urbanize a stepping-
// stone tile, which a tech-gated (unresearched) building can no longer do
// once contiguity is tech-aware (see TECH_AWARE_CONTIGUITY). Set false to
// go back to the plain floor with no exception.
const WAREHOUSE_BRIDGE_ENABLE = true;

// Line-order gateway bonus. A "base" building that still has unplaced higher-
// tier siblings in its yield-class line (e.g. Library while Academy is
// unbuilt) gets this much extra score per gated successor, so the base wins a
// budget slot and actually unlocks the upgrade — instead of both losing the
// race and leaving the science quarter empty. Pairs with the hard line-order
// gate in beamSearch (which prevents the *orphan upgrade*, e.g. Academy with
// no Library). Set to 0 to keep only the hard gate.
const GATEWAY_BONUS = 2;

// Beam search tuning. BEAM_WIDTH = 1 degenerates to plain greedy.
const BEAM_WIDTH = 3;      // partial layouts kept alive per round
const BEAM_EXTENSIONS = 6; // best extensions considered per layout per round
const ID_AUTOPIN = "AUTOPIN_PINS";
const KEY_PIN_LIST = "list";      // physically placed pins (window + anchors) — what F4 clears
const KEY_SETTLE_LIST = "settle"; // suggested city-center tacks
const KEY_PLAN_FULL = "planfull"; // full ordered lifetime plan (metadata, incl. unpinned tail)

// Settlement suggestion tuning.
const MIN_SETTLE_DISTANCE = 4;   // plots from any existing/suggested center
const SETTLE_SEARCH_RADIUS = 7;  // how far from existing centers to search
const SETTLE_FINALISTS = 8;      // candidates that get full plan-value scoring
const SETTLE_SUGGESTIONS = 3;    // city-center tacks to place
const SETTLE_PLAN_ROUNDS = 4;    // buildings in the hypothetical plan

// Independent-power spacing. The game's min-settlement-distance rule counts
// independent villages/encampments the same as real cities, but their
// location is sometimes NOT yet revealed to the player, and settling next to
// one can be a deliberate, valid play (clear it, then found) rather than a
// mistake. Kept as its OWN knob (default equal to MIN_SETTLE_DISTANCE) so it
// can be relaxed independently of real-city spacing without touching that
// constant. Lower it to let candidates land closer to unseen independents;
// DMT's validator still blocks a plot actually sitting ON a village tile.
const IP_SETTLE_SPACING = MIN_SETTLE_DISTANCE;

// Expansion-room scoring (cheapSettleScore): how far out to look for open,
// claimable land when rewarding "room to grow". Wider than the CITY_RADIUS
// working ring on purpose -- this rewards FRONTIER, not just the first-ring
// tiles cheapSettleScore already scores directly.
const EXPANSION_SEARCH_RADIUS = 4;
// Weight per open (unowned-or-ours, non-water, non-mountain) tile found
// within EXPANSION_SEARCH_RADIUS -- plain room to grow into later.
const EXPANSION_OPEN_TILE_WEIGHT = 0.5;
// Extra weight per resource tile found on that open land -- future
// improvements worth claiming, on top of plain room.
const EXPANSION_RESOURCE_WEIGHT = 1;

// Natural Wonder / appeal scoring (cheapSettleScore). Natural Wonders are a
// big one-time win (huge yields/adjacency, can't be missed later), so they
// get a large flat weight; Breathtaking/Charming appeal tiles get a smaller
// per-tile nudge.
const WONDER_APPEAL_SEARCH_RADIUS = 3;
const NATURAL_WONDER_WEIGHT = 12;      // per Natural Wonder tile in radius
const BREATHTAKING_APPEAL_WEIGHT = 4;  // per Breathtaking-appeal tile in radius
const CHARMING_APPEAL_WEIGHT = 1.5;    // per Charming-appeal tile in radius
// Fallback appeal thresholds if GameInfo.GlobalParameters lookup fails --
// approximate vanilla values so the signal degrades gracefully instead of
// going to zero.
const FALLBACK_BREATHTAKING_APPEAL = 3;
const FALLBACK_CHARMING_APPEAL = 1;

// Yield weights used for scoring. Tweak to taste.
//
// Tuned for THE TENURE TRACK (Confucius / Han->Ming->Meiji, peaceful science
// on Deity). The engine is: cram specialists into high-adjacency science
// quarters (Keju = +2 Science/specialist), grow tall to place more of them,
// and stay Happy enough on Deity to keep hiring. So:
//   - SCIENCE dominates placement: build science-adjacency quarters, and
//     settle where the best science city can be built (F6 uses this too).
//   - FOOD is elevated: growth events are how specialists get placed, and
//     specialists eat 2/4/6 food each. Food is the fuel, not an afterthought.
//   - HAPPINESS is elevated: on Deity you get no happiness handout, and a
//     specialist city that tips Unhappy stops the whole engine. Keep it high.
//   - DIPLOMACY nudged up: your defense runs on Influence (War Support peace),
//     so influence-yielding placements have real value in this build.
//   - CULTURE / GOLD deprioritized: culture only paces civics here, and the
//     build buys almost nothing with gold.
// Original balanced defaults, for a quick revert:
//   FOOD 1, PRODUCTION 1.1, GOLD 0.8, SCIENCE 1.2, CULTURE 1.2,
//   HAPPINESS 0.9, DIPLOMACY 0.9
const YIELD_WEIGHTS = {
    YIELD_FOOD: 1.3,
    YIELD_PRODUCTION: 1.0,
    YIELD_GOLD: 0.6,
    YIELD_SCIENCE: 1.9,
    YIELD_CULTURE: 0.9,
    YIELD_HAPPINESS: 1.2,
    YIELD_DIPLOMACY: 1.0,
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
        // Cached id of the last selected city (upstream): getHeadSelectedCity()
        // reads null from the detached hotkey handler, so we track it via the
        // CitySelectionChanged event instead.
        this.selectedCityID = null;
        // Per-city map of base-building -> number of gated upgrades still in
        // play, read by evaluatePlacements for the gateway bonus. Set at the
        // top of planCity, cleared where non-plan scoring runs (settlements).
        this.gatewayCount = null;
        // Per-city map of type -> {x,y} from the stored plan, read by
        // evaluatePlacements for the plan-stability bias (M3). Same lifecycle.
        this.priorAssignment = null;
        // Per-city set of Ageless/unique building types, read by
        // evaluatePlacements for the permanence premium (M4). Same lifecycle.
        this.premiumTypes = null;
        engine.whenReady.then(() => { this.onReady(); });
    }
    onReady() {
        window.addEventListener("hotkey-autopin-generate", () => this.runAction("generate"));
        window.addEventListener("hotkey-autopin-settle", () => this.runAction("settle"));
        window.addEventListener("hotkey-autopin-clear", () => this.runAction("clear"));
        // The game fires CitySelectionChanged on the engine bus when a city is
        // selected/opened (getHeadSelectedCity() is null from this detached
        // hotkey handler). Cache the id so F3 can target that city.
        engine.on('CitySelectionChanged', this.onCitySelectionChanged.bind(this));
        // Fallback so the hotkeys work even while a modal screen (e.g. the city
        // production panel) is open and consuming the game's input actions:
        // a capture-phase DOM keydown listener runs before the screen handlers.
        window.addEventListener("keydown", this.onKeyDown.bind(this), true);
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

    /**
     * Debounced dispatch shared by the input-action hotkeys and the DOM keydown
     * fallback, so one keypress that arrives via both paths only runs once.
     */
    runAction(name) {
        const now = Date.now();
        if (this._lastAction && this._lastAction.name == name && (now - this._lastAction.t) < 400) {
            return;
        }
        this._lastAction = { name, t: now };
        if (name == "generate") { this.generate(); }
        else if (name == "clear") { this.clearAll(); }
        else if (name == "settle") { this.suggestSettlements(); }
    }
    /**
     * Capture-phase keydown fallback. The input-action system doesn't deliver
     * our hotkeys while a modal screen (the city production panel) is focused,
     * because that screen consumes input first. Catching keydown in the capture
     * phase lets F3/F4/F6 work there too. Uses the default keys.
     */
    onKeyDown(e) {
        const key = e?.key || e?.code;
        const map = { F3: "generate", F4: "clear", F6: "settle" };
        const action = map[key];
        if (!action) {
            return;
        }
        try { e.preventDefault(); e.stopPropagation(); } catch (_) { /* ignore */ }
        this.runAction(action);
    }
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
        // Prior full plans (per city, tagged cx,cy) drive the stability bias so
        // re-planning keeps quarters put. Built buildings have already dropped
        // out of the candidate pool, so the window advances on its own.
        const priorFull = this.loadPinList(KEY_PLAN_FULL);
        const pinned = [];
        const full = [];
        const usedWonders = new Set(); // wonders are one-per-world
        // Every plan center at once, so each city can be planned only on the
        // tiles it "owns" (is nearest to). Without this, cities within ~6 tiles
        // share overlapping radius-3 pools and double-plan the same plots.
        const centers = this.getPlanCenters();
        for (const center of centers) {
            const others = centers.filter(o => !(o.x == center.x && o.y == center.y));
            const prior = priorFull.filter(p => p.cx == center.x && p.cy == center.y);
            const res = this.planCity(center, usedWonders, others, prior);
            pinned.push(...res.pinned);
            full.push(...res.full);
        }
        this.savePinList(KEY_PIN_LIST, pinned);
        this.savePinList(KEY_PLAN_FULL, full);
        console.error(`[AutoPin] placed ${pinned.length} pins from a ${full.length}-step plan.`);
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
        const oldFull = this.loadPinList(KEY_PLAN_FULL);
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
        // Prior full plan for THIS city (by its cx,cy tag) feeds the stability
        // bias; other cities' stored plans are preserved untouched.
        const prior = oldFull.filter(p => p.cx == center.x && p.cy == center.y);
        const keptFull = oldFull.filter(p => !(p.cx == center.x && p.cy == center.y));
        const res = this.planCity(center, usedWonders, others, prior);
        this.savePinList(KEY_PIN_LIST, [...kept, ...res.pinned]);
        this.savePinList(KEY_PLAN_FULL, [...keptFull, ...res.full]);
        console.error(`[AutoPin] re-planned selected city: ${res.pinned.length} pins from ${res.full.length} planned.`);
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
            // Settlement scoring reuses the placement scorer but isn't a city
            // plan — make sure no stale per-city bias (gateway bonus, stability
            // bias, permanence premium) from a prior planCity run bleeds into it.
            this.gatewayCount = null;
            this.priorAssignment = null;
            this.premiumTypes = null;
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
        // Drop the stored lifetime plan too (metadata only — no physical tacks),
        // so a fresh F3 starts clean with no stability bias toward the old plan.
        this.savePinList(KEY_PLAN_FULL, []);
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
    planCity(center, usedWonders = new Set(), otherCenters = [], priorPlan = null) {
        // pinned = records we physically drop tacks for (window + anchors);
        // full = the whole ordered plan (incl. the unpinned tail), stored for
        // resync and the build-order log.
        const pinned = [];
        const full = [];
        const plots = this.getCandidatePlots(center, otherCenters);
        if (plots.length == 0) {
            return { pinned, full };
        }
        // Plan-stability bias: reuse the same tile for the same building unless
        // a new layout beats it by more than STABILITY_BONUS (M3).
        this.priorAssignment = this.buildPriorAssignment(priorPlan);
        // Phase 1: buildings, planned in waves with an expanding tech horizon.
        // Wave 1 (buildable now) claims the core; later waves widen the pool
        // and — thanks to contiguity — fan outward from what's committed.
        // Unplaced candidates carry forward into later waves.
        let remaining = this.getCandidateBuildings(plots, center);
        // Yield-class "lines": order base -> upgrade within a yield (Library
        // before Academy) so the planner never pins an upgrade whose base it
        // skipped. `predecessorsOf` is the hard gate (no orphan upgrades);
        // `gatewayCount` biases a base to actually get placed so its upgrade
        // can unlock. Both are computed once from the full candidate set.
        const predecessorsOf = this.buildLinePredecessors(remaining);
        this.gatewayCount = this.buildGatewayCount(predecessorsOf);
        // Permanence premium set (M4): Ageless + active-unique buildings, which
        // get the best tiles because their placement is forever.
        this.premiumTypes = this.buildPremiumTypes(remaining);
        // Diagnostic: dist 0 = buildable now (core wave), >=1 = tech horizon.
        console.error(`[AutoPin] ${center.x},${center.y} building dists: `
            + remaining.map(c => `${c.type}=${c.dist}`).join(", "));
        const lineLog = [...predecessorsOf.entries()]
            .filter(([, preds]) => preds.length)
            .map(([t, preds]) => `${t}<-[${preds.join(",")}]`).join("; ");
        console.error(`[AutoPin] ${center.x},${center.y} building lines: ${lineLog || "none"}`);
        // Diagnostic: for each tile that already holds a building (the center's
        // Palace included), report whether DMT's validator would accept ANOTHER
        // building there. Tells us if the "won't complete quarters on occupied
        // tiles" symptom is DMT gating (valid=false) vs. our own logic.
        this.logOccupiedTileDiagnostic(center, plots, remaining.map(c => c.type));
        // Per-type ETA (build-slots to unlock) — also used to tag stored records.
        const etaSlots = new Map();
        for (const c of remaining) {
            etaSlots.set(c.type, TECH_DIST_SLOTS[c.dist] ?? TECH_DIST_SLOTS[TECH_DIST_SLOTS.length - 1]);
        }
        // Tech-aware contiguity inputs (see isUrbanReachable/beamSearch):
        // - distByType: each candidate's own tech distance, so the beam can
        //   look a PLANNED pin's distance up by type without recomputing
        //   techDistance() (which reads tree node state) every round.
        // - realDistrictByKey: a snapshot of REAL district state taken NOW,
        //   before any hypothetical planning work starts this call — anything
        //   already built is buildable now by definition, so it always counts
        //   as a bridge regardless of what we're about to plan. Must be taken
        //   before beamSearch starts hypothetically inserting pins, since DMT
        //   can't tell "really built" from "hypothetically inserted for
        //   scoring" apart once that starts.
        const distByType = new Map();
        for (const c of remaining) {
            distByType.set(c.type, c.dist);
        }
        const realDistrictByKey = new Map();
        for (const p of plots) {
            const details = MapTackUtils.getRealizedPlotDetails(p.x, p.y);
            if (details?.district) {
                realDistrictByKey.set(`${p.x},${p.y}`, details.district);
            }
        }
        // Phase 1: build the ordered building layout.
        let layout;
        if (USE_LIFETIME_SEQUENCE) {
            // M2/M3: one discounted sequence over the whole current-age pool,
            // grown until the marginal building stops being worth it (or the
            // hard cap). The beam applies gamma^slotTime so the layout is
            // globally optimized but ordered by when each piece can be built.
            const discountCfg = {
                etaSlots, gamma: LIFETIME_GAMMA, unownedPenalty: UNOWNED_SLOT_PENALTY,
                // Gated by TECH_AWARE_CONTIGUITY so the fix can be switched
                // off without touching beamSearch/evaluatePlacements: when
                // false, beamSearch sees no realDistrictByKey and falls back
                // to the exact previous (tech-blind) reachability check.
                distByType: TECH_AWARE_CONTIGUITY ? distByType : null,
                realDistrictByKey: TECH_AWARE_CONTIGUITY ? realDistrictByKey : null,
            };
            const pool = remaining.map(c => c.type);
            layout = this.beamSearch(
                pool, plots, Math.min(pool.length, LIFETIME_MAX_PINS),
                predecessorsOf, new Set(), discountCfg, LIFETIME_MARGINAL_FLOOR);
            // M4 polish: local-search relocation swaps over the finished layout.
            layout = this.relocationPass(layout);
        } else {
            // Legacy wave planner (M1). Types placed in earlier waves count as
            // satisfied predecessors for later waves (a Library placed in wave 1
            // unlocks Academy in wave 2).
            layout = [];
            const cityPlaced = new Set();
            for (const wave of PLAN_WAVES) {
                const pool = remaining.filter(c => c.dist <= wave.maxTechDistance).map(c => c.type);
                if (pool.length == 0) {
                    continue;
                }
                const wavePlots = wave.ownedOnly ? plots.filter(p => p.owned) : plots;
                if (wavePlots.length == 0) {
                    continue;
                }
                const waveLayout = this.beamSearch(
                    pool, wavePlots, Math.min(pool.length, wave.budget), predecessorsOf, cityPlaced);
                const placedTypes = new Set();
                for (const pin of waveLayout) {
                    layout.push(pin);
                    placedTypes.add(pin.type);
                    cityPlaced.add(pin.type);
                }
                remaining = remaining.filter(c => !placedTypes.has(c.type));
            }
        }
        // Windowed pinning (M3): physically pin only the first WINDOW_SIZE of
        // the (all-unbuilt) sequence, plus Ageless anchors anywhere in it. The
        // whole sequence is recorded in `full` for storage and the log.
        // Windowing is a lifetime-plan feature: with the toggle off, the legacy
        // wave planner pins every one of its (already small) set, as before.
        const windowLimit = USE_LIFETIME_SEQUENCE ? WINDOW_SIZE : Infinity;
        let order = 0;
        for (const pin of layout) {
            const anchor = PIN_AGELESS_ANCHORS && this.isAgelessType(pin.type);
            const doPin = order < windowLimit || anchor;
            const rec = {
                x: pin.x, y: pin.y, type: pin.type,
                order, eta: etaSlots.get(pin.type) ?? 0,
                anchor, pinned: doPin, cx: center.x, cy: center.y
            };
            if (doPin) {
                this.placePin(pin);
                pinned.push(rec);
            }
            full.push(rec);
            order++;
        }
        // Phase 2: wonders. Placed after buildings so mutual adjacency pulls
        // them next to planned quarters (every building gains adjacency from
        // wonders), and their own terrain adjacencies still count. Wonders are
        // few and permanent, so they're always pinned (natural anchors).
        const wonderPool = this.getCandidateWonders(plots, usedWonders, center);
        let wondersRemaining = Math.min(wonderPool.length, MAX_WONDERS_PER_CITY);
        while (wondersRemaining > 0 && wonderPool.length > 0) {
            const best = this.findBestPlacement(wonderPool, plots);
            if (!best || best.score < WONDER_MIN_SCORE) {
                break; // nothing left that justifies a wonder race
            }
            this.placePin(best);
            const rec = {
                x: best.x, y: best.y, type: best.type,
                order: order++, eta: 0, anchor: true, pinned: true, cx: center.x, cy: center.y
            };
            pinned.push(rec);
            full.push(rec);
            usedWonders.add(best.type);
            wonderPool.splice(wonderPool.indexOf(best.type), 1);
            wondersRemaining--;
        }
        this.logBuildOrder(center, full);
        // Don't leak this city's per-plan biases into the next city / settle scan.
        this.priorAssignment = null;
        this.premiumTypes = null;
        return { pinned, full };
    }
    findBestPlacement(pool, plots, useMutual = true) {
        return this.evaluatePlacements(pool, plots, useMutual, 1)[0] ?? null;
    }
    /**
     * Score every legal (type, plot) pair against the current (possibly
     * hypothetical) map state and return the top `topM`, best first.
     */
    evaluatePlacements(pool, plots, useMutual = true, topM = 1, scoreAdjust = null, reach = null) {
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
            // the (planned) urban network are placeable this round. In
            // tech-aware mode (`reach` supplied) reachability also depends on
            // the candidate TYPE's own tech distance (see isUrbanReachable),
            // so it's computed per distinct distance seen in `pool` rather
            // than once for the whole pool — memoized, since there are only
            // ever 3 distinct distances (0/1/2).
            const reachableCache = new Map();
            const reachablePlotsFor = (type) => {
                if (!reach) {
                    let cached = reachableCache.get("legacy");
                    if (!cached) {
                        cached = plots.filter(p => this.isUrbanReachable(p));
                        reachableCache.set("legacy", cached);
                    }
                    return cached;
                }
                const dist = reach.distByType?.get(type) ?? 0;
                let cached = reachableCache.get(dist);
                if (!cached) {
                    cached = plots.filter(p => this.isUrbanReachable(p, { ...reach, dist }));
                    reachableCache.set(dist, cached);
                }
                return cached;
            };
            for (const type of pool) {
                const reachablePlots = reachablePlotsFor(type);
                const typeDist = reach ? (reach.distByType?.get(type) ?? 0) : undefined;
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
                    // M4 permanence premium: scale a permanent (Ageless/unique)
                    // building's value up so it wins the best tiles; otherwise
                    // add the small overbuild-fodder bias so a throwaway building
                    // still gravitates to adjacency-rich tiles a future age can
                    // inherit. Applied to the placement VALUE, before the
                    // behavioral nudges below.
                    if (this.premiumTypes?.has(type)) {
                        score *= PERMANENCE_PREMIUM;
                    } else if (FODDER_ADJACENCY_FRACTION > 0) {
                        score += FODDER_ADJACENCY_FRACTION * this.adjacencyMagnitude(yieldDetails);
                    }
                    // Gateway bonus: bias a base building that still has unplaced
                    // higher-tier siblings so it gets placed and unlocks its
                    // upgrade (pairs with the line-order gate in beamSearch).
                    const gatewayN = this.gatewayCount?.get(type);
                    if (gatewayN) {
                        score += GATEWAY_BONUS * gatewayN;
                    }
                    // Plan-stability bias (M3): reward keeping a building on the
                    // tile it held in the stored plan, so re-planning doesn't
                    // shuffle quarters around for a negligible gain.
                    const prior = this.priorAssignment?.get(type);
                    if (prior && prior.x == plot.x && prior.y == plot.y) {
                        score += STABILITY_BONUS;
                    }
                    // Wonder-ambition damper: each wonder already planned this
                    // run raises the bar for the next one.
                    if (this.runWonderCount > 0
                        && MapTackUtils.getConstructibleClassType(type) == ConstructibleClassType.WONDER) {
                        score *= Math.pow(WONDER_DAMPING, this.runWonderCount);
                    }
                    // Lifetime time-discount (M2), applied last so it wraps the
                    // full raw score and BEFORE the top-M truncation below.
                    if (scoreAdjust) {
                        score = scoreAdjust(type, score, plot);
                    }
                    // Tech distance tag (tech-aware contiguity, see beamSearch):
                    // carried on the result so a pin built from it can report
                    // its own tech distance to LATER rounds' reachability
                    // checks without recomputing techDistance() every round.
                    results.push({ x: plot.x, y: plot.y, type, validStatus, yieldDetails, score, dist: typeDist });
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
    beamSearch(pool, plots, budget, predecessorsOf = null, cityPlaced = null, discountCfg = null, marginalFloor = 0) {
        let beam = [{ pins: [], poolLeft: pool, total: 0 }];
        let bestComplete = beam[0];
        let prevBestTotal = 0; // best total after the previous round, for the floor
        for (let round = 0; round < budget; round++) {
            const nextStates = new Map();
            for (const state of beam) {
                // Line-order gate: only offer a building once every cheaper-to-
                // unlock sibling in its yield-class line is already placed (in
                // this layout or an earlier wave). This is what stops an upgrade
                // (Academy) from being pinned without its base (Library).
                const allowedPool = this.filterByLineOrder(
                    state.poolLeft, state.pins, predecessorsOf, cityPlaced);
                if (allowedPool.length == 0) {
                    continue; // nothing legal to extend this layout with yet
                }
                // Lifetime discount (M2): a placement entering at sequence
                // position `pos` is worth gamma^max(pos+acqDelay, techEta) of
                // its raw score. Built per state so `pos` reflects this layout's
                // length; applied inside evaluatePlacements BEFORE it truncates
                // to the top extensions, so a now-buildable pin can rightly beat
                // a fatter-but-distant one for an early slot. null => no discount
                // (wave planner and non-plan callers score raw, exactly as before).
                let scoreAdjust = null;
                if (discountCfg) {
                    const pos = state.pins.length;
                    scoreAdjust = (type, raw, plot) => {
                        const acq = (plot && plot.owned === false) ? discountCfg.unownedPenalty : 0;
                        const eta = discountCfg.etaSlots.get(type) ?? 0;
                        const slotTime = Math.max(pos + acq, eta);
                        return raw * Math.pow(discountCfg.gamma, slotTime);
                    };
                }
                // Tech-aware contiguity (see isUrbanReachable): only built when
                // discountCfg carries the tech-distance/real-district snapshot
                // (i.e. TECH_AWARE_CONTIGUITY is on and we're in the lifetime
                // beam); null for the legacy wave planner, which then falls
                // straight back to the old tech-blind reachability check.
                // `pinDistByKey` is THIS layout's own planned pins (state.pins),
                // keyed by tile, each tagged with its own tech distance — a
                // later candidate can only bridge through one whose distance is
                // <= its own.
                let reach = null;
                if (discountCfg?.realDistrictByKey) {
                    const pinDistByKey = new Map();
                    for (const p of state.pins) {
                        pinDistByKey.set(`${p.x},${p.y}`, p.dist ?? discountCfg.distByType?.get(p.type) ?? 0);
                    }
                    reach = {
                        distByType: discountCfg.distByType,
                        realDistrictByKey: discountCfg.realDistrictByKey,
                        pinDistByKey
                    };
                }
                // Apply this layout's pins so scoring sees them.
                const handles = state.pins.map(p => this.hypotheticalInsert(p.x, p.y, p.type, p.validStatus));
                let exts;
                try {
                    exts = this.evaluatePlacements(allowedPool, plots, true, BEAM_EXTENSIONS, scoreAdjust, reach);
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
            // Marginal-value floor (M3): if the best layout this round grew by
            // less than the floor, the next building isn't worth planning —
            // stop and let the sequence length be data-driven. Guarded so the
            // wave planner and undiscounted callers (floor 0) are unaffected.
            if (marginalFloor > 0) {
                const gain = beam[0].total - prevBestTotal;
                prevBestTotal = beam[0].total;
                if (gain < marginalFloor) {
                    break;
                }
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
    isUrbanReachable(plot, reach = null) {
        const key = `${plot.x},${plot.y}`;
        if (reach) {
            // Tech-aware mode (lifetime beam only). A candidate of tech
            // distance reach.dist may treat a tile as urban via a PLANNED pin
            // only if that pin's own tech distance is <= reach.dist — i.e. the
            // bridge unlocks no later than the building leaning on it. Real,
            // already-built district state (snapshotted before this planCity
            // call started any hypothetical work) always counts, since it's
            // buildable now by definition. We can't ask DMT live for "real-
            // only" state here, because this beam state's own pins are
            // hypothetically inserted into DMT's cache for scoring.
            const ownReal = reach.realDistrictByKey.get(key);
            if (ownReal == "DISTRICT_URBAN" || ownReal == "DISTRICT_CITY_CENTER") {
                return true;
            }
            const ownPinDist = reach.pinDistByKey.get(key);
            if (ownPinDist !== undefined && ownPinDist <= reach.dist) {
                return true;
            }
            return this.getHexNeighbors(plot.x, plot.y).some(loc => {
                const nKey = `${loc.x},${loc.y}`;
                const nReal = reach.realDistrictByKey.get(nKey);
                if (nReal == "DISTRICT_CITY_CENTER" || nReal == "DISTRICT_URBAN" || nReal == "DISTRICT_WONDER") {
                    return true;
                }
                const nPinDist = reach.pinDistByKey.get(nKey);
                return nPinDist !== undefined && nPinDist <= reach.dist;
            });
        }
        // Legacy path (no reach info): any placed tack — this run's or real —
        // counts as urban, exactly as before TECH_AWARE_CONTIGUITY.
        // An already-urban tile (a building sits there) can take its second
        // building, and the city center can take a building to form the capital
        // quarter — both are directly reachable.
        const own = MapTackUtils.getRealizedPlotDetails(plot.x, plot.y);
        if (own?.district == "DISTRICT_URBAN" || own?.district == "DISTRICT_CITY_CENTER") {
            return true;
        }
        const neighbors = MapTackUtils.getAdjacentPlotDetails(plot.x, plot.y) || [];
        return neighbors.some(p => {
            const d = p?.details?.district;
            return d == "DISTRICT_CITY_CENTER" || d == "DISTRICT_URBAN" || d == "DISTRICT_WONDER";
        });
    }
    /**
     * The 6 neighbor coordinates of a hex plot, via the game's own grid API
     * (GameplayMap), not DMT — the tech-aware contiguity check (above) needs
     * to know WHICH specific neighboring tile might be bridging, not just
     * "is some neighbor urban", so it can look that tile's planned pin up by
     * coordinate in reach.pinDistByKey.
     */
    getHexNeighbors(x, y) {
        const dirs = [
            DirectionTypes.DIRECTION_NORTHEAST, DirectionTypes.DIRECTION_EAST,
            DirectionTypes.DIRECTION_SOUTHEAST, DirectionTypes.DIRECTION_SOUTHWEST,
            DirectionTypes.DIRECTION_WEST, DirectionTypes.DIRECTION_NORTHWEST,
        ];
        const out = [];
        for (const dir of dirs) {
            try {
                const loc = GameplayMap.getAdjacentPlotLocation({ x, y }, dir);
                if (loc) {
                    out.push(loc);
                }
            } catch (e) { /* defensive: skip on API hiccup */ }
        }
        return out;
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
     * type -> {x,y} from a stored plan (records tagged with cx,cy for this
     * city), for the plan-stability bias. Null/empty prior -> null (no bias),
     * so a first-time plan behaves exactly as before.
     */
    buildPriorAssignment(priorPlan) {
        if (!priorPlan || priorPlan.length == 0) {
            return null;
        }
        const map = new Map();
        for (const r of priorPlan) {
            if (r && r.type) {
                map.set(r.type, { x: r.x, y: r.y });
            }
        }
        return map.size ? map : null;
    }

    /**
     * Is this building Ageless (permanent, never overbuilt)? Ageless placements
     * are pinned as anchors even when deep in the sequence. Falls back to false
     * if DMT's helper isn't available.
     */
    isAgelessType(type) {
        try {
            return typeof MapTackUtils.isAgeless == "function" && MapTackUtils.isAgeless(type);
        } catch (e) {
            return false;
        }
    }

    /**
     * Types that get the permanence premium (M4): Ageless candidates plus the
     * civ's active unique buildings — placements you make once and keep. Built
     * once per city plan.
     */
    buildPremiumTypes(candidates) {
        const set = new Set();
        for (const c of candidates) {
            if (this.isAgelessType(c.type)) {
                set.add(c.type);
            }
        }
        try {
            for (const e of GameInfo.Buildings) {
                if (e.TraitType && e.TraitType != "TRAIT_LEADER_MINOR_CIV"
                    && TraitModifier.isTraitActive(e.TraitType)) {
                    set.add(e.ConstructibleType);
                }
            }
        } catch (e) { /* no trait data -> Ageless-only premium */ }
        return set;
    }

    /**
     * Weighted magnitude of a placement's adjacency yields — a proxy for how
     * adjacency-rich its tile is, used for the overbuild-fodder bias (M4).
     */
    adjacencyMagnitude(yieldDetails) {
        let m = 0;
        for (const y of (yieldDetails?.adjacencies || [])) {
            m += Math.abs((y.amount || 0) * (YIELD_WEIGHTS[y.type] ?? 1));
        }
        return m;
    }

    /**
     * Local-search polish (M4): given the finished building layout, try swapping
     * the tiles of building pairs and keep any swap that raises total placement
     * value, re-validating both new (tile, building) pairs. Building SEQUENCE
     * (build order) is untouched — only which tile each building sits on can
     * change — so the discounted ordering the beam chose is preserved. Scores
     * the raw per-tile proxy (no mutual-adjacency/discount), so it only takes
     * strict improvements; a swap also refreshes the pin's cached validStatus/
     * yieldDetails so the placed tack renders correctly.
     */
    relocationPass(layout) {
        if (!ENABLE_RELOCATION_PASS || !layout || layout.length < 2) {
            return layout;
        }
        const pins = layout.map(p => ({ ...p }));
        const scoreCache = new Map();
        const scoreAt = (type, x, y) => {
            const key = `${type}@${x},${y}`;
            if (scoreCache.has(key)) {
                return scoreCache.get(key);
            }
            let s;
            try {
                s = this.scoreYields(MapTackYield.getYieldDetails(x, y, type));
                if (this.premiumTypes?.has(type)) {
                    s *= PERMANENCE_PREMIUM;
                }
            } catch (e) {
                s = -Infinity;
            }
            scoreCache.set(key, s);
            return s;
        };
        const validAt = (type, x, y) => {
            try {
                const v = MapTackValidator.isValid(x, y, type);
                return v.isValid && !v.preventPlacement;
            } catch (e) {
                return false;
            }
        };
        let improved = 0;
        MapTackUtils.togglePlotDetailsCache(true);
        try {
            for (let i = 0; i < pins.length; i++) {
                for (let j = i + 1; j < pins.length; j++) {
                    const a = pins[i], b = pins[j];
                    if (a.x == b.x && a.y == b.y) {
                        continue; // same tile (a quarter) — nothing to swap
                    }
                    const cur = scoreAt(a.type, a.x, a.y) + scoreAt(b.type, b.x, b.y);
                    const swapped = scoreAt(a.type, b.x, b.y) + scoreAt(b.type, a.x, a.y);
                    if (swapped > cur + 1e-6
                        && validAt(a.type, b.x, b.y) && validAt(b.type, a.x, a.y)) {
                        const ax = a.x, ay = a.y;
                        a.x = b.x; a.y = b.y; b.x = ax; b.y = ay;
                        // Refresh cached render data for the new tiles.
                        try {
                            a.validStatus = MapTackValidator.isValid(a.x, a.y, a.type);
                            a.yieldDetails = MapTackYield.getYieldDetails(a.x, a.y, a.type);
                            b.validStatus = MapTackValidator.isValid(b.x, b.y, b.type);
                            b.yieldDetails = MapTackYield.getYieldDetails(b.x, b.y, b.type);
                        } catch (e) { /* leave stale render data if the API errors */ }
                        improved++;
                    }
                }
            }
        } finally {
            MapTackUtils.togglePlotDetailsCache(false);
        }
        if (improved) {
            console.error(`[AutoPin] relocation pass: applied ${improved} swap(s).`);
        }
        return pins;
    }

    /**
     * Diagnostic (no behavior): for every candidate tile that already holds at
     * least one building — the city center's Palace included — log whether DMT's
     * validator will accept a further building there, testing the first pool type
     * that reports a verdict. If occupied tiles come back valid=false, DMT is
     * gating quarter-completion; if valid=true, the gap is our placement logic.
     */
    logOccupiedTileDiagnostic(center, plots, poolTypes) {
        try {
            let occupied = 0, acceptSecond = 0, centerVerdict = "n/a";
            for (const plot of plots) {
                const details = MapTackUtils.getRealizedPlotDetails(plot.x, plot.y);
                const built = details?.constructibles || [];
                if (built.length == 0) {
                    continue;
                }
                occupied++;
                let accepts = false;
                for (const type of poolTypes) {
                    let v;
                    try { v = MapTackValidator.isValid(plot.x, plot.y, type); } catch (e) { continue; }
                    accepts = v.isValid && !v.preventPlacement;
                    break; // one representative verdict per tile is enough
                }
                if (accepts) { acceptSecond++; }
                if (plot.isCenter) { centerVerdict = accepts ? "accepts a building" : "full/blocked"; }
            }
            console.error(`[AutoPin] ${center.x},${center.y} occupied-tile check: `
                + `${occupied} occupied, ${acceptSecond} accept another building; center ${centerVerdict}.`);
        } catch (e) {
            console.error(`[AutoPin] occupied-tile diagnostic failed: ${e}`);
        }
    }

    /**
     * Print the lifetime sequence as a readable, ordered build order — the
     * cheapest "whole-plan view" (design §5.3). Each entry shows when it comes
     * online (`now` / `+N` slots) and whether it's physically pinned this pass
     * (`pin`) or held in the stored tail (`plan`); anchors are marked `*`.
     */
    logBuildOrder(center, full) {
        const line = full.map((r, i) => {
            const when = r.eta > 0 ? `+${r.eta}` : "now";
            const tag = r.pinned ? (r.anchor ? "pin*" : "pin") : "plan";
            return `${i + 1}. ${r.type} @ (${r.x},${r.y}) [${when},${tag}]`;
        }).join(" · ");
        const pinnedCount = full.filter(r => r.pinned).length;
        console.error(`[AutoPin] ${center.x},${center.y} build order (${full.length}, ${pinnedCount} pinned): ${line || "empty"}`);
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
        // Swept using IP_SETTLE_SPACING (the distance actually enforced
        // against independents below), not MIN_SETTLE_DISTANCE, so the two
        // knobs stay consistent if IP_SETTLE_SPACING is retuned.
        const sweepRadius = SETTLE_SEARCH_RADIUS + IP_SETTLE_SPACING;
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
        // planned centers, AND independent-power villages. Real settlements
        // use MIN_SETTLE_DISTANCE; independents use the separately-tunable
        // IP_SETTLE_SPACING (see its declaration for why) — this does NOT
        // hard-forbid settling near independents, it's just the default
        // spacing, and it can be relaxed without touching real-city spacing.
        const cityAnchors = [
            ...centers,
            ...this.getAllSettlementLocations()
        ];
        const independentAnchors = this.getIndependentSettlementLocations(centers);
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
                // Respect spacing against real settlements...
                if (cityAnchors.some(c => this.plotDistance(loc.x, loc.y, c.x, c.y) < MIN_SETTLE_DISTANCE)) {
                    continue;
                }
                // ...and independents, at the separately-tunable distance.
                if (independentAnchors.some(c => this.plotDistance(loc.x, loc.y, c.x, c.y) < IP_SETTLE_SPACING)) {
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
        // Expansion room: open, claimable land further out — reward frontier
        // spots with space to grow over ones hemmed in by water/mountains/
        // borders. See expansionRoomScore for the exact criteria.
        score += this.expansionRoomScore(c);
        // Natural Wonders and high-appeal (Breathtaking/Charming) tiles
        // nearby. See wonderAppealScore for the exact criteria/sources.
        score += this.wonderAppealScore(c);
        return score;
    }
    /**
     * Expansion-room signal: counts open, claimable land in a radius wider
     * than cheapSettleScore's own rings (EXPANSION_SEARCH_RADIUS vs. the
     * 1-ring/2-ring checks above) — room this city could actually grow into
     * and claim later, not just its immediate tile yields. A tile counts as
     * "room" if it's not someone else's territory and isn't water/mountain;
     * resource tiles on that open land count extra since they're the tiles
     * worth planting improvements on once claimed. Candidates hemmed in by
     * water, mountains, or a neighbor's borders naturally score lower here
     * because fewer open tiles exist to count.
     */
    expansionRoomScore(c) {
        let score = 0;
        try {
            const localPlayerID = GameContext.localPlayerID;
            const plotIndices = GameplayMap.getPlotIndicesInRadius(c.x, c.y, EXPANSION_SEARCH_RADIUS) || [];
            for (const plotIndex of plotIndices) {
                const loc = GameplayMap.getLocationFromIndex(plotIndex);
                if (loc.x == c.x && loc.y == c.y) {
                    continue; // the center tile itself isn't "room to grow into"
                }
                // Someone else's territory isn't claimable room.
                try {
                    const owner = GameplayMap.getOwner(loc.x, loc.y);
                    if (owner != null && owner != -1 && owner != localPlayerID) {
                        continue;
                    }
                } catch (e) { /* unowned/fogged is fine — still claimable */ }
                // Water isn't ownable/workable land for this signal.
                try {
                    if (GameplayMap.isWater && GameplayMap.isWater(loc.x, loc.y)) {
                        continue;
                    }
                } catch (e) { /* fine */ }
                const d = MapTackUtils.getRealizedPlotDetails(loc.x, loc.y);
                if (d?.terrain == "TERRAIN_MOUNTAIN") {
                    continue; // unworkable, doesn't count as room
                }
                score += EXPANSION_OPEN_TILE_WEIGHT;
                if (d?.resource) {
                    score += EXPANSION_RESOURCE_WEIGHT;
                }
            }
        } catch (e) {
            console.error(`[AutoPin] expansionRoomScore failed: ${e}`);
        }
        return score;
    }
    /**
     * Natural Wonder + high-appeal ("Breathtaking"/"Charming") signal near a
     * candidate.
     *
     * CONFIRMED: `details.isNaturalWonder` on DMT's realized plot details is
     * already relied on elsewhere in this file (matchesWarehouseCondition's
     * "NaturalWonder" condition), and the engine's own
     * `GameplayMap.isNaturalWonder(x, y)` is used throughout shipped
     * base-standard code — checked both ways here so either source missing
     * still lets the other work.
     *
     * BEST-EFFORT / NOT LIVE-VERIFIED: `GameplayMap.getAppeal(x, y)` and the
     * Breathtaking/Charming thresholds (GlobalParameters
     * APPEAL_FOR_DOUBLE_HAPPINESS_TILE_YIELD / APPEAL_FOR_HAPPINESS_TILE_YIELD)
     * are exactly what base-standard's own Appeal lens uses
     * (ui/lenses/layer/general-appeal-layer.js), confirmed BY READING SHIPPED
     * GAME CODE, not by running in-game. Wrapped independently of the wonder
     * check and fails safe (falls back to 0 appeal bonus) if unavailable.
     */
    wonderAppealScore(c) {
        let score = 0;
        try {
            const plotIndices = GameplayMap.getPlotIndicesInRadius(c.x, c.y, WONDER_APPEAL_SEARCH_RADIUS) || [];
            // Read thresholds once per call rather than per tile.
            let breathtakingThreshold = FALLBACK_BREATHTAKING_APPEAL;
            let charmingThreshold = FALLBACK_CHARMING_APPEAL;
            try {
                const bt = getGlobalParamNumber("APPEAL_FOR_DOUBLE_HAPPINESS_TILE_YIELD");
                const ct = getGlobalParamNumber("APPEAL_FOR_HAPPINESS_TILE_YIELD");
                if (Number.isFinite(bt) && bt > -1) { breathtakingThreshold = bt; }
                if (Number.isFinite(ct) && ct > -1) { charmingThreshold = ct; }
            } catch (e) { /* keep fallback thresholds */ }
            for (const plotIndex of plotIndices) {
                const loc = GameplayMap.getLocationFromIndex(plotIndex);
                // Natural Wonder proximity — checked two ways since either
                // source could be absent depending on load order/DMT version.
                let isWonder = false;
                try {
                    const d = MapTackUtils.getRealizedPlotDetails(loc.x, loc.y);
                    isWonder = !!d?.isNaturalWonder;
                } catch (e) { /* fine */ }
                if (!isWonder) {
                    try {
                        isWonder = !!(GameplayMap.isNaturalWonder && GameplayMap.isNaturalWonder(loc.x, loc.y));
                    } catch (e) { /* fine */ }
                }
                if (isWonder) {
                    score += NATURAL_WONDER_WEIGHT;
                    continue; // don't also double-count this tile's appeal below
                }
                // Best-effort appeal read — guarded independently so a
                // missing/renamed API only drops this bonus, not the wonder one.
                try {
                    if (GameplayMap.getAppeal) {
                        const appeal = GameplayMap.getAppeal(loc.x, loc.y);
                        if (appeal >= breathtakingThreshold) {
                            score += BREATHTAKING_APPEAL_WEIGHT;
                        } else if (appeal >= charmingThreshold) {
                            score += CHARMING_APPEAL_WEIGHT;
                        }
                    }
                } catch (e) { /* appeal API unavailable — skip this tile's appeal bonus */ }
            }
        } catch (e) {
            console.error(`[AutoPin] wonderAppealScore failed: ${e}`);
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
            // The city center itself IS a build tile in Civ 7: the Palace shares
            // the tile and one more building can join it to form the capital
            // quarter — prime specialist real estate. Include it (DMT's validator
            // still gates whether a building slot is actually free), rather than
            // skipping it as this planner did since inception.
            const isCenter = (x == center.x && y == center.y);
            // Nearest-center ownership: when other plan centers exist, only keep
            // a plot if THIS center is the closest to it. This partitions the
            // overlap zone between adjacent cities so no tile is planned twice.
            // The center always belongs to itself, so it's exempt.
            if (!isCenter && otherCenters.length && !this.plotBelongsToCenter(x, y, center, otherCenters)) {
                continue;
            }
            // Skip plots owned by someone else; remember which ones are ours.
            let owned = isCenter; // we always own our own city center
            if (!isCenter) {
                try {
                    const owner = GameplayMap.getOwner(x, y);
                    if (owner != null && owner != -1 && owner != localPlayerID) {
                        continue;
                    }
                    owned = owner == localPlayerID;
                } catch (e) { /* unowned/fogged plots are fine to plan on */ }
            }
            plots.push({ x, y, owned, isCenter });
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
        // Types already realized (built or pinned) on these plots, including the
        // city center tile — buildings like the monument often live in the
        // center's slots, and those types must be excluded from candidates so we
        // don't re-plan them. (The center is now also a placement candidate for
        // its free quarter slot; plots already includes it, hence the dedupe.)
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
        // Bridging exception input: does this city currently have a
        // contiguity gap — a candidate tile the (tech-blind) reachability
        // check can't yet reach? If every tile is already reachable there's
        // nothing to bridge, so the warehouse floor stays as-is. Cheap: one
        // short-circuiting pass over `plots`, reusing the existing (legacy-
        // mode) isUrbanReachable — this runs once, before any beam/plan work,
        // so there's no hypothetical-pin contamination to worry about here.
        const hasContiguityGap = WAREHOUSE_BRIDGE_ENABLE && plots.some(p => !this.isUrbanReachable(p));
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
                const dist = this.techDistance(type);
                // Bridge exception (see hasContiguityGap above): a buildable-
                // now (dist 0) placement-agnostic building may still enter
                // the pool below the floor when there's a contiguity gap to
                // bridge — it's the cheapest legal way to urbanize a
                // stepping-stone tile, and unlike a tech-gated building it can
                // actually be built today. Deeper-tech warehouse buildings get
                // no exception: they can't bridge anything sooner than a
                // regular building could.
                const bridgeEligible = hasContiguityGap && dist == 0;
                if (ws < WAREHOUSE_MIN_SCORE && !bridgeEligible) {
                    warehouseRejects.push(`${type}=${ws.toFixed(1)}`);
                    continue;
                }
                candidates.push({ type, dist });
                continue;
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

    /* --------------------------------------------------- building lines (M1) */

    /**
     * Group candidate buildings into yield-class "lines" and return, for each
     * building, the list of same-line siblings that should be built BEFORE it
     * (its lower-ranked predecessors). Rank within a line is by unlock order
     * (tech distance), then by adjacency strength (weaker = base = earlier),
     * then by type name for determinism. A building with no predecessors maps
     * to an empty array. Only candidate types are considered, so a base that's
     * already built (and thus excluded from candidates) is never a predecessor
     * and never blocks its upgrade.
     *
     * Fails soft: if yield-class data can't be read, buildings are unclassified,
     * no lines form, and planning behaves exactly as before.
     */
    buildLinePredecessors(candidates) {
        const map = new Map();
        for (const c of candidates) {
            map.set(c.type, []);
        }
        try {
            const byClass = new Map();
            const info = new Map(); // type -> { dist, strength }
            for (const c of candidates) {
                const cls = this.getBuildingYieldClass(c.type);
                if (!cls) {
                    continue; // unclassified -> its own singleton, no ordering
                }
                info.set(c.type, {
                    dist: c.dist,
                    cost: this.getBuildingCost(c.type),
                    strength: this.getAdjacencyStrength(c.type)
                });
                if (!byClass.has(cls)) {
                    byClass.set(cls, []);
                }
                byClass.get(cls).push(c.type);
            }
            for (const [, types] of byClass) {
                if (types.length < 2) {
                    continue; // a lone building in its class needs no ordering
                }
                types.sort((a, b) => {
                    const ia = info.get(a), ib = info.get(b);
                    if (ia.dist != ib.dist) {
                        return ia.dist - ib.dist;         // unlocks earlier -> base
                    }
                    // Production cost is the reliable base-vs-upgrade signal when
                    // tech distance ties (e.g. both unresearched at game start):
                    // the cheaper building is the base. Adjacency "strength" is
                    // NOT — it mis-ranked Academy under Library in live logs, so
                    // it's only a last resort when costs are equal/unavailable.
                    if (ia.cost != ib.cost) {
                        return ia.cost - ib.cost;         // cheaper -> base
                    }
                    if (ia.strength != ib.strength) {
                        return ia.strength - ib.strength; // weaker -> base
                    }
                    return a < b ? -1 : 1;                // deterministic tiebreak
                });
                // Every earlier-ranked sibling is a predecessor (build the
                // whole line as a contiguous prefix, weakest first).
                for (let i = 0; i < types.length; i++) {
                    map.set(types[i], types.slice(0, i));
                }
            }
        } catch (e) {
            console.error(`[AutoPin] line build failed (planning falls back to unordered): ${e}`);
        }
        return map;
    }

    /**
     * Inverse of buildLinePredecessors: how many gated successors each base
     * building has. Drives the gateway bonus in evaluatePlacements.
     */
    buildGatewayCount(predecessorsOf) {
        const count = new Map();
        for (const preds of predecessorsOf.values()) {
            for (const p of preds) {
                count.set(p, (count.get(p) || 0) + 1);
            }
        }
        return count;
    }

    /**
     * Drop from `pool` any building whose line-predecessors aren't all placed
     * yet — in this layout (`pins`) or in an earlier wave (`cityPlaced`). With
     * no line data this returns the pool unchanged.
     */
    filterByLineOrder(pool, pins, predecessorsOf, cityPlaced) {
        if (!predecessorsOf) {
            return pool;
        }
        const placed = new Set(pins.map(p => p.type));
        if (cityPlaced) {
            for (const t of cityPlaced) {
                placed.add(t);
            }
        }
        return pool.filter(type => {
            const preds = predecessorsOf.get(type);
            if (!preds || preds.length == 0) {
                return true;
            }
            return preds.every(p => placed.has(p));
        });
    }

    /**
     * Dominant yield type of a building, used to bucket it into a line. Reads
     * the building's adjacency yields first (this is what actually separates a
     * Library from a Granary), then base yields as a fallback. Returns null if
     * nothing is readable — the caller treats null as "unclassified".
     *
     * Column names for these GameInfo tables are assumptions (Constructible_
     * Adjacencies.YieldType / .YieldChange, Constructible_YieldChanges.*); if
     * they're wrong, classification yields null everywhere and lines simply
     * don't form. The per-city "building lines:" console log makes that visible.
     */
    getBuildingYieldClass(type) {
        if (!this._yieldClassCache) {
            this._yieldClassCache = new Map();
        }
        if (this._yieldClassCache.has(type)) {
            return this._yieldClassCache.get(type);
        }
        const totals = new Map();
        const add = (yt, amt) => {
            if (!yt) {
                return;
            }
            totals.set(yt, (totals.get(yt) || 0) + (Number(amt) || 0));
        };
        try {
            for (const a of (GameInfo.Constructible_Adjacencies || [])) {
                if (a.ConstructibleType == type) {
                    add(a.YieldType, a.YieldChange ?? 1);
                }
            }
        } catch (e) { /* table/column absent -> fall through */ }
        if (totals.size == 0) {
            try {
                for (const y of (GameInfo.Constructible_YieldChanges || [])) {
                    if (y.ConstructibleType == type) {
                        add(y.YieldType, y.YieldChange);
                    }
                }
            } catch (e) { /* no base-yield table -> unclassified */ }
        }
        let best = null, bestAmt = -Infinity;
        for (const [yt, amt] of totals) {
            if (amt > bestAmt) {
                bestAmt = amt;
                best = yt;
            }
        }
        this._yieldClassCache.set(type, best);
        return best;
    }

    /**
     * Total magnitude of a building's adjacency yields — a proxy for "how
     * strong" it is, used only to order same-unlock-distance siblings so the
     * weaker one ranks as the base.
     */
    getAdjacencyStrength(type) {
        let s = 0;
        try {
            for (const a of (GameInfo.Constructible_Adjacencies || [])) {
                if (a.ConstructibleType == type) {
                    s += Math.abs(Number(a.YieldChange ?? 1));
                }
            }
        } catch (e) { /* no adjacency data -> strength 0 */ }
        return s;
    }

    /**
     * Base production cost of a building from GameInfo.Constructibles, memoized.
     * Used to rank base-vs-upgrade within a yield-class line (cheaper = base).
     * Returns 0 if the Cost column isn't readable, in which case ranking falls
     * back to the adjacency-strength tiebreak.
     */
    getBuildingCost(type) {
        if (!this._costCache) {
            this._costCache = new Map();
            try {
                for (const e of (GameInfo.Constructibles || [])) {
                    this._costCache.set(e.ConstructibleType, Number(e.Cost) || 0);
                }
            } catch (e) { /* no Constructibles table -> all costs 0 */ }
        }
        return this._costCache.get(type) || 0;
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
