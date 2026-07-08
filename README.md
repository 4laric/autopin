# AutoPin — automatic building placement pins for Civilization VII

Plans optimal building placement in your cities and drops map tacks for it, so you can follow the plan as you play. Spiritual successor to Civ 6's *Mega Auto Pins*, built on top of [wltk's Detailed Map Tacks](https://forums.civfanatics.com/resources/wltks-detailed-map-tacks.32126/) (DMT), which is a **required dependency**.

## Hotkeys (rebindable in Options → Keyboard+Mouse)

| Key | Action |
|-----|--------|
| F3  | Generate building pins. **With a city selected, re-plans just that city**; with nothing selected, plans all your cities (and DMT city-center tacks) |
| F6  | Suggest settlement locations (places up to 3 ranked city-center tacks) |
| F4  | Clear all pins previously placed by AutoPin |

Regenerating (F3 or F6) first clears that feature's previous pins, then re-plans against the current map state. Pins you placed by hand are never touched. Delete suggested city-center tacks you don't like — F3 plans buildings around the ones you keep.

By the Exploration Age a full-map F3 pass gets unwieldy (too many cities and tiles). To re-plan just one city after a tech unlock or layout change, **select that city first, then press F3** — only the selected city's pins are recomputed and every other city's plan is left intact. F3 with no city selected still does the full-map pass.

## How it works

For each city (real cities plus planned settlements marked with a DMT city-center tack):

1. Collects candidate plots within radius 3, skipping plots owned by other players.
2. Builds a candidate pool: current-age + ageless buildings with adjacency bonuses, plus your civ's unique buildings — excluding anything already built or pinned there.
3. Urban contiguity: per Civ 7's rules, new urban tiles must touch the city center or an existing urban district. Planned tacks count as urban, so each committed pin unlocks its neighbors for the next round and plans grow outward like real cities. (Farms and other rural improvements don't block urbanization — buildings replace them — but resource tiles can't be urbanized and are excluded by DMT's validator.)
4. Greedy optimization: each round scores every (building, plot) pair using DMT's yield engine (base + bonus + adjacency yields, adjacencies weighted 1.25×, per-yield weights configurable in `ui/core/ap-planner.js`), then commits the best. Because DMT folds existing tacks into plot details, later rounds automatically see planned quarters and adjacency chains.
5. Tech horizon: buildings you can construct right now are planned first and claim the city core; buildings one completed research away get up to 3 extra pins that — thanks to contiguity — fan outward from the committed core. Deeper tech is ignored until you get closer (re-run F3 after unlocks). Tune with `MAX_TECH_DISTANCE` and `MAX_NEXT_TECH_BUILDINGS`.
6. Mutual adjacency: each candidate's score also includes the yield delta it grants to already-placed neighboring tacks (quarter formation, adjacency chains). Computed by temporarily inserting the candidate into DMT's in-memory tack cache and re-running DMT's yield engine on the neighbors — the persistent store is never touched.

## Settlement suggestions (F6)

Unlike the game's settler lens, which scores what a tile gives you on settle day, AutoPin scores what the location becomes. Two stages: first a cheap heuristic (fresh water, coast/navigable-river access, mountains, nearby resources) filters plots in rings 4–7 around your empire down to 8 finalists; then each finalist is scored by hypothetically founding the city there (cache-only city-center tack) and running the real building optimizer for 4 rounds — the settle spot's value is the value of the best city you could build on it. The top 3, spaced at least 4 plots apart, get city-center tacks.
4. Places up to 8 building pins per city via DMT's pin system, so they render, validate, and update exactly like hand-placed tacks.

## Integration with DMT

AutoPin contains no pin rendering, storage, validation, or yield logic of its own — it drives DMT through its public surface:

- `MapTackYield.getYieldDetails(x, y, type)` — scoring
- `MapTackValidator.isValid(x, y, type)` — legality
- `engine.trigger("AddMapTackRequest" / "RemoveMapTackRequest", mapTackData)` — placement
- Its own `Catalog("APN")` store — remembers which pins it placed, for clean regeneration

Load order is guaranteed by the `detailed-map-tacks` dependency in `autopin.modinfo`; DMT modules are imported from `/detailed-map-tacks/...` (the game mounts each mod at `fs://game/<mod-id>/`).

## Install

Copy the `autopin/` folder into your Civ 7 Mods directory
(`%LOCALAPPDATA%\Firaxis Games\Sid Meier's Civilization VII\Mods`),
next to your DMT install. Enable both mods in Additional Content.

## Known limitations

- Greedy, not global: each pin is the best choice at the moment it's placed, not necessarily part of the best overall layout.
- Improvements and warehouse-type buildings without adjacencies aren't planned. Wonders are planned (up to 2 per city, placed after buildings so they gravitate toward planned quarters), but wonders already completed by other civs aren't detected until visible on your map.
- Doesn't account for buildings' placement unlock requirements beyond age/obsolescence, or per-city building limits beyond what DMT's validator enforces.
