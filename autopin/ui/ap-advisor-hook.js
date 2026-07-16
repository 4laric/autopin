/**
 * AutoPin advisor hook.
 *
 * Replaces the game's per-item build recommendations in the Production Chooser
 * with AutoPin's own: any building that's in AutoPin's stored plan gets an
 * advisor "gem" badge, colored by what the building is FOR (science -> the
 * scientific gem, culture -> cultural, gold/food -> economic, everything else
 * -> military). We reuse all four native gem types purely as AutoPin markers;
 * the game's own recommendations are dropped, as requested.
 *
 * Mechanism: `AdvisorUtilities.getBuildRecommendationIcons(recommendations,
 * type)` is an exported property on a namespace object, and the production
 * chooser calls it through that object at render time — so reassigning it here
 * takes effect for every build item, with no new UI. See
 * base-standard/ui/tutorial/advisor-utilities.js and ui-next/components/
 * advisor-recommendation.js (the {class:"recommendation-*"} shape we return).
 */
import { AdvisorUtilities } from '/base-standard/ui/tutorial/advisor-utilities.js';
import { Catalog } from '/detailed-map-tacks/ui/map-tack-core/dmt-utility-serialize.js';

// AutoPin's plan store (mirrors ap-planner.js: Catalog("APN") ->
// object "AUTOPIN_PINS" -> key "planfull" holding the full ordered plan).
const CATALOG = "APN";
const OBJECT = "AUTOPIN_PINS";
const KEY_PLAN_FULL = "planfull";

// Dominant-yield -> native advisor gem css class.
const GEM_BY_YIELD = {
    YIELD_SCIENCE: "recommendation-scientific",
    YIELD_CULTURE: "recommendation-cultural",
    YIELD_GOLD: "recommendation-economic",
    YIELD_FOOD: "recommendation-economic",
    YIELD_PRODUCTION: "recommendation-military",
    YIELD_HAPPINESS: "recommendation-military",
    YIELD_DIPLOMACY: "recommendation-military",
};
const DEFAULT_GEM = "recommendation-scientific";

// Which gem to show for a building, by its dominant adjacency yield. Memoized.
const gemCache = new Map();
function gemForType(type) {
    if (gemCache.has(type)) {
        return gemCache.get(type);
    }
    const totals = new Map();
    try {
        for (const a of (GameInfo.Constructible_Adjacencies || [])) {
            if (a.ConstructibleType == type) {
                totals.set(a.YieldType, (totals.get(a.YieldType) || 0) + Math.abs(Number(a.YieldChange ?? 1)));
            }
        }
    } catch (e) { /* no adjacency data -> default gem */ }
    let best = null, bestAmt = -Infinity;
    for (const [y, v] of totals) {
        if (v > bestAmt) { bestAmt = v; best = y; }
    }
    const gem = GEM_BY_YIELD[best] || DEFAULT_GEM;
    gemCache.set(type, gem);
    return gem;
}

// Set of building types that appear anywhere in AutoPin's stored plan. Re-read
// at most once a second so the chooser's frequent re-renders stay cheap. (MVP:
// this is empire-wide, not per-open-city — a planned building shows its gem in
// any city's chooser. Per-city precision is a later refinement.)
let plannedCache = null;
let plannedAt = 0;
function plannedTypes() {
    const now = Date.now();
    if (plannedCache && (now - plannedAt) < 1000) {
        return plannedCache;
    }
    const set = new Set();
    try {
        const raw = new Catalog(CATALOG).getObject(OBJECT).read(KEY_PLAN_FULL);
        for (const rec of (JSON.parse(raw) || [])) {
            if (rec && rec.type) {
                set.add(rec.type);
            }
        }
    } catch (e) { /* no plan yet -> empty set */ }
    plannedCache = set;
    plannedAt = now;
    return set;
}

// The replacement. Game recommendations ignored entirely; AutoPin's plan wins.
AdvisorUtilities.getBuildRecommendationIcons = (_recommendations, type) => {
    return plannedTypes().has(type) ? [{ class: gemForType(type) }] : [];
};

console.error("[AutoPin] advisor hook installed — production chooser shows AutoPin plan gems.");
