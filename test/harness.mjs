// AutoPin test harness.
//
// Loads the REAL ap-planner.js with the game's APIs mocked, so tests exercise
// the actual shipped code — not a transcription that can drift from it. The
// planner references ~15 game objects (GameInfo, GameplayMap, DMT modules, ...)
// that only exist in-game; here we rewrite its `import`s to pull from a mock
// object and set the ambient globals on globalThis, then eval the source and
// hand back the class.
//
// Usage:
//   import { loadPlanner } from './harness.mjs';
//   const mod = loadPlanner({ imports: {...}, globals: {...} });
//   const p = new mod.AutoPinPlannerSingleton();   // fresh instance, no singleton
//
// The constructor's engine.whenReady promise never resolves, so onReady()
// (which wires window listeners) never runs — instances are inert and safe to
// poke at directly.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = process.env.AP_SRC || path.resolve(HERE, '../autopin/ui/core/ap-planner.js');

export function loadPlanner({ imports = {}, globals = {} } = {}) {
    let src = fs.readFileSync(SRC, 'utf8');
    // named imports:  import { A, B } from '...';  ->  const { A, B } = __IMP__;
    src = src.replace(/^\s*import\s*\{([^}]*)\}\s*from\s*['"][^'"]+['"];?\s*$/gm,
        (_m, names) => `const {${names}} = __IMP__;`);
    // default imports: import X from '...';        ->  const X = __IMP__.X;
    src = src.replace(/^\s*import\s+([A-Za-z_$][\w$]*)\s+from\s*['"][^'"]+['"];?\s*$/gm,
        (_m, name) => `const ${name} = __IMP__.${name};`);
    // drop the trailing `export { ... };`
    src = src.replace(/^\s*export\s*\{[^}]*\}\s*;?\s*$/gm, '');

    // Ambient globals for the class's bare references. Defaults keep the
    // constructor inert; callers override GameInfo/GameplayMap/etc. per test.
    const G = {
        console,
        engine: { whenReady: new Promise(() => {}), on() {}, trigger() {} },
        window: { addEventListener() {}, dispatchEvent() {} },
        GameInfo: {}, GameplayMap: {}, Players: {}, GameContext: {},
        DirectionTypes: {},
        ...globals,
    };
    for (const [k, v] of Object.entries(G)) {
        globalThis[k] = v;
    }

    const body = src + '\n;return { AutoPinPlannerSingleton, AutoPinPlanner };';
    const factory = new Function('__IMP__', body);
    return factory(imports);
}
