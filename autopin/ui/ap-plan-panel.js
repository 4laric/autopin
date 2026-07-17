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
        + `● buildable now · ○ waiting (bridge/tech) · ★ anchor — F7 or Esc to close</div>`;
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
    const root = document.body || document.documentElement;
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
    // Click-to-close: a raw Esc keydown doesn't reach us in Coherent, so give
    // the panel its own button.
    const closeBtn = document.createElement("div");
    closeBtn.textContent = "✕";
    Object.assign(closeBtn.style, {
        position: "absolute", top: "8px", right: "12px",
        cursor: "pointer", opacity: "0.7", fontSize: "16px"
    });
    closeBtn.addEventListener("click", close);
    panelEl.appendChild(closeBtn);
    root.appendChild(panelEl);
    console.error(`[AutoPin] plan panel toggled OPEN (root=${root === document.body ? "body" : "documentElement"}, isConnected=${panelEl.isConnected}).`);
}

// Wire to AutoPin's own bound hotkey (F7) via the HotkeyManager chain in
// ap-hotkey-manager.js -> sendHotkeyEvent -> this window event. Raw keydown on
// window does NOT fire for unbound keys in Civ's Coherent input, which is why
// the earlier direct-keydown approach never triggered.
let lastToggleAt = 0;
engine.whenReady.then(() => {
    window.addEventListener("hotkey-autopin-panel", () => {
        // Debounce: F7 can arrive via both the input-action hotkey AND the
        // ap-planner keydown fallback — ignore a second trigger within 300ms so
        // the panel doesn't open-then-immediately-close on one press.
        const now = Date.now();
        if (now - lastToggleAt < 300) {
            return;
        }
        lastToggleAt = now;
        toggle();
    });
    console.error("[AutoPin] plan panel ready — press F7 to toggle.");
});
