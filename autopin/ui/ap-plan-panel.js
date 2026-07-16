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
    for (const [city, recs] of byCity) {
        recs.sort((a, b) => a.order - b.order);
        html += `<div style="margin:10px 0 4px;font-weight:600;color:#cfe;">City @ ${city}</div>`;
        html += `<ol style="margin:0;padding-left:20px;line-height:1.5;">`;
        for (const r of recs) {
            const when = r.eta > 0 ? `+${r.eta}` : "now";
            // ★ = pinned anchor, ● = pinned (window), ○ = planned tail (not pinned)
            const mark = r.pinned ? (r.anchor ? "★" : "●") : "○";
            html += `<li><span style="color:#ffd479;">${mark}</span> ${shortName(r.type)} `
                + `<span style="opacity:0.55;font-size:12px;">(${r.x},${r.y}) · ${when}</span></li>`;
        }
        html += `</ol>`;
    }
    html += `<div style="margin-top:10px;opacity:0.5;font-size:12px;">`
        + `★ anchor · ● pinned · ○ planned — F7 or Esc to close</div>`;
    return html;
}

function close() {
    if (panelEl) {
        panelEl.remove();
        panelEl = null;
    }
}

function toggle() {
    if (panelEl) {
        close();
        return;
    }
    panelEl = document.createElement("div");
    panelEl.innerHTML = buildHtml();
    Object.assign(panelEl.style, {
        position: "fixed", top: "80px", right: "24px",
        width: "330px", maxHeight: "72vh", overflowY: "auto",
        background: "rgba(10,20,35,0.95)", color: "#e8e8e8",
        font: "14px 'Segoe UI', sans-serif", padding: "14px 16px",
        border: "1px solid #3a5a80", borderRadius: "8px",
        zIndex: "99999", boxShadow: "0 6px 28px rgba(0,0,0,0.55)"
    });
    document.body.appendChild(panelEl);
}

// Capture-phase so it works even while a game panel is focused (same trick
// ap-planner uses for F3/F4/F6). F7 toggles; Esc closes when open.
window.addEventListener("keydown", (e) => {
    const key = e?.key || e?.code;
    if (key == "F7") {
        try { e.preventDefault(); e.stopPropagation(); } catch (_) { /* ignore */ }
        toggle();
    } else if (key == "Escape" && panelEl) {
        close();
    }
}, true);

console.error("[AutoPin] plan panel ready — press F7 to toggle.");
