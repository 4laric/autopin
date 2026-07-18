/**
 * AutoPin plan panel (MVP).
 *
 * A lightweight, self-contained floating panel that lists AutoPin's stored
 * build plan — the same information ap-planner.js prints to the console as
 * "build order", but readable in-game. Toggled with F7.
 *
 * This is deliberately a plain-DOM panel rather than a full Controls.define /
 * ContextManager screen: it's the smallest thing that surfaces the plan
 * reliably. The "proper" version would appropriate the advisor-council
 * ScreenFrame (base-standard/ui-next/screens/advisor-council/); this MVP proves
 * the content first. Reads the same Catalog("APN") store the planner writes.
 */
import { Catalog } from '/detailed-map-tacks/ui/map-tack-core/dmt-utility-serialize.js';

const CATALOG = "APN";
const OBJECT = "AUTOPIN_PINS";
const KEY_PLAN_FULL = "planfull";

let panelEl = null;
// When set to {x,y}, the panel shows only that city's plan (the city just
// planned via F3); null shows every city's plan, grouped.
let filterCity = null;

function readPlan() {
    try {
        const raw = new Catalog(CATALOG).getObject(OBJECT).read(KEY_PLAN_FULL);
        return JSON.parse(raw) || [];
    } catch (e) {
        return [];
    }
}

// BUILDING_LIBRARY -> "library"; WONDER_MENAGERIE -> "menagerie" (its cyan
// anchor dot marks it as a wonder; the ✦ glyph is tofu in Coherent's font).
function shortName(type) {
    const t = String(type || "");
    if (t.startsWith("WONDER_")) {
        return t.replace(/^WONDER_/, "").replace(/_/g, " ").toLowerCase();
    }
    return t.replace(/^BUILDING_/, "").replace(/_/g, " ").toLowerCase();
}

function buildHtml() {
    const plan = readPlan();
    // Narrow to the selected / just-planned city when we have one.
    const records = filterCity
        ? plan.filter(r => r.cx == filterCity.x && r.cy == filterCity.y)
        : plan;
    const byCity = new Map();
    for (const r of records) {
        const key = `${r.cx},${r.cy}`;
        if (!byCity.has(key)) {
            byCity.set(key, []);
        }
        byCity.get(key).push(r);
    }
    // Title lives in the header row (renderInto), so content starts at the body.
    let html = "";
    if (byCity.size == 0) {
        html += filterCity
            ? `<div style="opacity:0.7;">No plan for this city yet — press F3 with it selected.</div>`
            : `<div style="opacity:0.7;">No plan stored yet. Select a city and press F3.</div>`;
    }
    // Coherent's font only renders the filled circle (&#9679;), not ★/○/✕, so
    // we distinguish states by COLOR of the same dot: gold = buildable this
    // turn, cyan = permanent anchor, grey = waiting on a bridge or tech.
    const DOT = "&#9679;";
    const colorFor = (r) => r.anchor ? "#8fd0ff" : (r.placeableNow ? "#ffd479" : "#7a8a99");
    for (const [city, recs] of byCity) {
        recs.sort((a, b) => a.order - b.order);
        if (byCity.size > 1) {
            html += `<div style="margin:10px 0 4px;font-weight:600;color:#cfe;">City @ ${city}</div>`;
        }
        for (const r of recs) {
            const when = r.eta > 0 ? `+${r.eta}` : "now";
            html += `<div style="margin:3px 0;">`
                + `<span style="color:${colorFor(r)};">${DOT}</span> ${shortName(r.type)} `
                + `<span style="opacity:0.5;font-size:12px;">(${r.x},${r.y}) &middot; ${when}</span></div>`;
        }
    }
    html += `<div style="margin-top:12px;opacity:0.6;font-size:12px;border-top:1px solid #2a3a4a;padding-top:6px;">`
        + `<span style="color:#ffd479;">${DOT}</span> now &nbsp;`
        + `<span style="color:#7a8a99;">${DOT}</span> waiting &nbsp;`
        + `<span style="color:#8fd0ff;">${DOT}</span> anchor<br>F3 refreshes &middot; CLOSE button dismisses</div>`;
    return html;
}

function close() {
    if (panelEl) {
        panelEl.remove();
        panelEl = null;
    }
}

// Fill (or refill) a panel element with a header (title + close) and the plan.
function renderInto(el) {
    el.innerHTML = "";
    // Header row: title on the left, a REAL close button on the right. Both are
    // in the normal flow (flexbox) — unlike the old absolutely-positioned "X",
    // which sat at the panel's right edge and got clipped off-screen when the
    // panel hugged the viewport edge, so it couldn't be clicked. The button has
    // a generous hit area, pointer-events forced on, and both click + pointerdown
    // handlers (Coherent doesn't always deliver `click` to plain elements). The
    // log line confirms whether the activation even routes to us.
    const header = document.createElement("div");
    Object.assign(header.style, {
        display: "flex", alignItems: "center", justifyContent: "space-between",
        gap: "10px", marginBottom: "8px"
    });
    const title = document.createElement("div");
    title.textContent = "AutoPin — Build Plan";
    Object.assign(title.style, { fontWeight: "700", fontSize: "15px", color: "#8fd0ff" });
    const closeBtn = document.createElement("div");
    closeBtn.textContent = "CLOSE"; // word, not a glyph — Coherent's font has no ✕
    Object.assign(closeBtn.style, {
        cursor: "pointer", fontSize: "12px", fontWeight: "700", color: "#ffd479",
        background: "rgba(255,212,121,0.14)", border: "1px solid #6a5a30",
        borderRadius: "6px", padding: "7px 14px", userSelect: "none",
        pointerEvents: "auto", flex: "0 0 auto"
    });
    const doClose = (ev) => {
        if (ev) { ev.stopPropagation(); ev.preventDefault(); }
        console.error("[AutoPin] panel CLOSE activated.");
        close();
    };
    closeBtn.addEventListener("click", doClose);
    closeBtn.addEventListener("pointerdown", doClose);
    header.appendChild(title);
    header.appendChild(closeBtn);
    el.appendChild(header);
    const body = document.createElement("div");
    body.innerHTML = buildHtml();
    el.appendChild(body);
}

function open() {
    const root = document.body || document.documentElement;
    panelEl = document.createElement("div");
    Object.assign(panelEl.style, {
        position: "fixed", top: "80px", right: "40px",
        width: "330px", maxHeight: "72vh", overflowY: "auto",
        background: "rgba(10,20,35,0.95)", color: "#e8e8e8",
        font: "14px 'Segoe UI', sans-serif", padding: "14px 16px",
        border: "1px solid #3a5a80", borderRadius: "8px",
        zIndex: "99999", boxShadow: "0 6px 28px rgba(0,0,0,0.55)",
        // Force interactivity: if any ancestor UI layer defaults pointer-events
        // off, the CLOSE button would silently swallow no clicks.
        pointerEvents: "auto"
    });
    renderInto(panelEl);
    root.appendChild(panelEl);
    console.error(`[AutoPin] plan panel OPEN (root=${root === document.body ? "body" : "documentElement"}, isConnected=${panelEl.isConnected}).`);
}

// F7 (if it ever binds): open if closed, close if open.
function toggle() {
    if (panelEl) { close(); } else { open(); }
}

// F3 auto-show: open the panel, or refresh it in place if already open.
function refreshOrOpen() {
    if (panelEl) {
        renderInto(panelEl);
        console.error("[AutoPin] plan panel refreshed after generate.");
    } else {
        open();
    }
}

let lastToggleAt = 0;
engine.whenReady.then(() => {
    // F3 (generate) fires this after planning — the reliable trigger, since F3
    // is a registered hotkey. This is the main way the panel appears. The
    // planner passes the city it just planned so we show THAT city's plan
    // (detail.city null = generateForAll -> show every city, grouped).
    window.addEventListener("autopin-show-panel", (e) => {
        filterCity = e?.detail?.city ?? null;
        refreshOrOpen();
    });
    // F7 toggle, kept in case the input action ever registers. Raw keydown on
    // window does NOT fire for unbound keys in Civ's Coherent input, so this
    // only works if the bound-action path delivers it.
    window.addEventListener("hotkey-autopin-panel", () => {
        const now = Date.now();
        if (now - lastToggleAt < 300) {
            return; // debounce dual-path delivery
        }
        lastToggleAt = now;
        toggle();
    });
    console.error("[AutoPin] plan panel ready — appears after F3 (F7 toggles if bound).");
});
