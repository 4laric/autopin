// Tests for AutoPin's pure decision logic, run against the REAL ap-planner.js
// via the harness. Run: `node test/planner.test.mjs` from the repo root.
//
// These cover the logic that's actually had bugs — ranking, the tech-aware
// contiguity/reach gate, line-ordering, current-turn placeability. They mock
// only the game APIs each method touches. Add a case here whenever a bug is
// found in pure logic; it's a second to run and catches regressions the
// in-game deploy-and-eyeball loop can't.
import { loadPlanner } from './harness.mjs';

// --- game API mocks ---------------------------------------------------------
const DirectionTypes = {
    DIRECTION_NORTHEAST: 0, DIRECTION_EAST: 1, DIRECTION_SOUTHEAST: 2,
    DIRECTION_SOUTHWEST: 3, DIRECTION_WEST: 4, DIRECTION_NORTHWEST: 5,
};
const HEX = [[0, 1], [1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1]];
const GameplayMap = {
    getAdjacentPlotLocation({ x, y }, dir) { const [dx, dy] = HEX[dir]; return { x: x + dx, y: y + dy }; },
    getIndexFromXY(x, y) { return y * 1000 + x; },
};
// GameInfo.Constructibles must be iterable (getBuildingCost) AND have .lookup
// (constructibleHash). Tests mutate it before constructing a planner.
function constructiblesTable(rows) {
    return Object.assign([...rows], {
        lookup(type) { return this.find(c => c.ConstructibleType === type); },
    });
}
const GameInfo = { Constructibles: constructiblesTable([]), Constructible_Adjacencies: [], Yields: [] };

const mod = loadPlanner({
    imports: { Catalog: class { getObject() { return { read: () => '[]', write: () => {} }; } } },
    globals: { GameInfo, GameplayMap, Players: {}, GameContext: {}, DirectionTypes },
});
const P = () => new mod.AutoPinPlannerSingleton();

// --- tiny assertion helpers -------------------------------------------------
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : (fail++, console.log('FAIL:', m)); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} (got ${JSON.stringify(a)})`);

// === reachableViaPlannedPin — tech-aware forward bridging ===================
// Regression home for the v24 bug where the tech-distance arg was undefined so
// the relaxation never fired.
{
    const p = P();
    const reach = { pinDistByKey: new Map([['5,6', 0], ['9,9', 2]]) };
    ok(p.reachableViaPlannedPin(5, 5, reach, 0) === true, 'adjacent dist-0 pin reaches a dist-0 building');
    ok(p.reachableViaPlannedPin(5, 6, reach, 0) === true, 'on a planned pin tile -> reachable');
    ok(p.reachableViaPlannedPin(9, 10, reach, 0) === false, 'dist-2 pin does NOT bridge a dist-0 building');
    ok(p.reachableViaPlannedPin(9, 10, reach, 2) === true, 'dist-2 pin bridges a dist-2 building');
    ok(p.reachableViaPlannedPin(5, 5, null, 0) === false, 'null reach -> false');
    ok(p.reachableViaPlannedPin(5, 5, reach, undefined) === false, 'undefined dist -> false (v24 bug guard)');
    ok(p.reachableViaPlannedPin(50, 50, reach, 0) === false, 'isolated tile -> not reachable');
}

// === buildLinePredecessors — base-before-upgrade via cost tiebreak ==========
{
    GameInfo.Constructibles = constructiblesTable([
        { ConstructibleType: 'BUILDING_LIBRARY', Cost: 100 },
        { ConstructibleType: 'BUILDING_ACADEMY', Cost: 200 },
    ]);
    GameInfo.Constructible_Adjacencies = [
        { ConstructibleType: 'BUILDING_LIBRARY', YieldType: 'YIELD_SCIENCE', YieldChange: 3 },
        { ConstructibleType: 'BUILDING_ACADEMY', YieldType: 'YIELD_SCIENCE', YieldChange: 2 },
    ];
    const p = P();
    const pre = p.buildLinePredecessors([
        { type: 'BUILDING_ACADEMY', dist: 0 }, { type: 'BUILDING_LIBRARY', dist: 0 },
    ]);
    eq(pre.get('BUILDING_ACADEMY'), ['BUILDING_LIBRARY'], 'Academy gated behind Library (same dist, cost tiebreak)');
    eq(pre.get('BUILDING_LIBRARY'), [], 'Library has no predecessor');
    // tech distance dominates cost: a cheaper-but-locked building is still later
    GameInfo.Constructibles = constructiblesTable([
        { ConstructibleType: 'A', Cost: 500 }, { ConstructibleType: 'B', Cost: 10 },
    ]);
    GameInfo.Constructible_Adjacencies = [
        { ConstructibleType: 'A', YieldType: 'YIELD_SCIENCE', YieldChange: 1 },
        { ConstructibleType: 'B', YieldType: 'YIELD_SCIENCE', YieldChange: 1 },
    ];
    const pre2 = P().buildLinePredecessors([{ type: 'A', dist: 0 }, { type: 'B', dist: 2 }]);
    eq(pre2.get('B'), ['A'], 'available A precedes locked B despite higher cost');
}

// === filterByLineOrder — the hard gate ======================================
{
    const p = P();
    const pre = new Map([['BUILDING_ACADEMY', ['BUILDING_LIBRARY']], ['BUILDING_LIBRARY', []]]);
    const pool = ['BUILDING_LIBRARY', 'BUILDING_ACADEMY'];
    eq(p.filterByLineOrder(pool, [], pre, new Set()), ['BUILDING_LIBRARY'], 'Academy blocked until Library placed');
    eq(p.filterByLineOrder(pool, [{ type: 'BUILDING_LIBRARY' }], pre, new Set()).sort(),
        ['BUILDING_ACADEMY', 'BUILDING_LIBRARY'], 'Academy unblocked once Library is a pin');
    eq(p.filterByLineOrder(pool, [], pre, new Set(['BUILDING_LIBRARY'])).sort(),
        ['BUILDING_ACADEMY', 'BUILDING_LIBRARY'], 'Academy unblocked when Library placed in an earlier wave');
}

// === buildGatewayCount — inverse of predecessors ============================
{
    const p = P();
    const pre = new Map([
        ['ACADEMY', ['LIBRARY']], ['OBSERVATORY', ['LIBRARY', 'ACADEMY']], ['LIBRARY', []],
    ]);
    const gw = p.buildGatewayCount(pre);
    ok(gw.get('LIBRARY') === 2, 'Library gateways 2 successors');
    ok(gw.get('ACADEMY') === 1, 'Academy gateways 1 successor');
    ok(!gw.get('OBSERVATORY'), 'top-tier gateways nothing');
}

// === isPlaceableNow — engine map exact, heuristic fallback ==================
{
    GameInfo.Constructibles = constructiblesTable([{ ConstructibleType: 'BUILDING_LIBRARY', $hash: 111 }]);
    const p = P();
    // engine map: LIBRARY legal only at plot index for (10,10)
    const placementMap = new Map([[111, new Map([[GameplayMap.getIndexFromXY(10, 10), 5]])]]);
    ok(p.isPlaceableNow('BUILDING_LIBRARY', 10, 10, placementMap, new Map()) === true, 'engine: legal tile -> placeable');
    ok(p.isPlaceableNow('BUILDING_LIBRARY', 11, 11, placementMap, new Map()) === false, 'engine: illegal tile -> not placeable');
    // building absent from engine data -> not placeable now
    ok(p.isPlaceableNow('BUILDING_MISSING', 10, 10, placementMap, new Map()) === false, 'engine: unknown building -> not placeable');
    // no engine map -> heuristic over real districts
    const districts = new Map([['5,5', 'DISTRICT_CITY_CENTER']]);
    ok(p.isPlaceableNow('BUILDING_LIBRARY', 5, 5, null, districts) === true, 'heuristic: on the city center -> placeable');
    ok(p.isPlaceableNow('BUILDING_LIBRARY', 5, 6, null, districts) === true, 'heuristic: adjacent to center -> placeable');
    ok(p.isPlaceableNow('BUILDING_LIBRARY', 40, 40, null, districts) === false, 'heuristic: far from any urban -> not placeable');
}

// === isEngineBuildable — the engine is the source of truth for candidacy =====
// Guards the University/Inn regression: a buildable building must be a candidate
// even when AutoPin's own heuristics would drop it.
{
    GameInfo.Constructibles = constructiblesTable([
        { ConstructibleType: 'BUILDING_UNIVERSITY', $hash: 42 },
        { ConstructibleType: 'BUILDING_FUTURE', $hash: 43 },
    ]);
    const p = P();
    ok(p.isEngineBuildable('BUILDING_UNIVERSITY') === false, 'no engine data -> not engine-buildable');
    // University has a legal tile in the engine data; FUTURE is present but empty.
    p.enginePlacement = new Map([[42, new Map([[7, 5]])], [43, new Map()]]);
    ok(p.isEngineBuildable('BUILDING_UNIVERSITY') === true, 'engine lists University with a legal tile -> candidate');
    ok(p.isEngineBuildable('BUILDING_FUTURE') === false, 'engine lists building but no legal tile -> not buildable now');
    ok(p.isEngineBuildable('BUILDING_UNKNOWN') === false, 'building not in engine data -> not buildable');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
