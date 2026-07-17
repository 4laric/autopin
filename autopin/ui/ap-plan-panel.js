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

function readPlan() {
    try {
        const raw = new Catalog(CATALOG).getObject(OBJECT).read(KEY_PLAN_FULL);
        return JSON.parse(raw) || [];
    } catch (e) {
        return [];
    }
}

// BUILDING_LIBRARY -> "Library"; WONDER_* gets a marker.
function shortName(type) {
    const t = String(type || "");
    if (t.startsWith("WONDER_")) {
        return "✦ " + t.replace(/^WONDER_/, "").replace(/_/g, " ").toLowerCase();
    }
    return t.replace(/^BUILDING_/, "").replace(/_/g, " ").toLowerCase();
}

function buildHtml() {
    const plan = readPlan();
    const byCity = new Map();
    for (const r of plan) {
        const key = `${r.cx},${r.cy}`;
        if (!byCity.has(key)) {
            byCity.set(key, []);
        }
        byCity.get(key).push(r);
    }
    let html = `<div style="font-weight:700;font-size:15px;margin-bottom:8px;color:#8fd0ff;">AutoPin — Build Plan</div>`;
    if (byCity.size == 0) {
        html += `<div style="opacity:0.7;">No plan stored yet. Select a city and press F3.</div>`;
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
        + `<span style="color:#8fd0ff;">${DOT}</span> anchor<br>F3 refreshes &middot; X closes</div>`;
    return html;
}

function close() {
    if (panelEl) {
        panelEl.remove();
        panelEl = null;
    }
}

// Fill (or refill) a panel element with the current plan + a close button.
function renderInto(el) {
    el.innerHTML = buildHtml();
    // Click-to-close: a raw Esc keydown doesn't reach us in Coherent, so give
    // the panel its own button.
    const closeBtn = document.createElement("div");
    closeBtn.textContent = "X"; // plain letter — Coherent's font has no ✕ glyph
    Object.assign(closeBtn.style, {
        position: "absolute", top: "6px", right: "12px",
        cursor: "pointer", opacity: "0.6", fontSize: "15px", fontWeight: "700"
    });
    closeBtn.addEventListener("click", close);
    el.appendChild(closeBtn);
}

function open() {
    const root = document.body || document.documentElement;
    panelEl = document.createElement("div");
    Object.assign(panelEl.style, {
        position: "fixed", top: "80px", right: "24px",
        width: "330px", maxHeight: "72vh", overflowY: "auto",
        background: "rgba(10,20,35,0.95)", color: "#e8e8e8",
        font: "14px 'Segoe UI', sans-serif", padding: "14px 16px",
        border: "1px solid #3a5a80", borderRadius: "8px",
        zIndex: "99999", boxShadow: "0 6px 28px rgba(0,0,0,0.55)"
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
    // is a registered hotkey. This is the main way the panel appears.
    window.addEventListener("autopin-show-panel", () => refreshOrOpen());
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
