/**
 * AutoPin hotkey hook.
 * Chains onto the core HotkeyManager the same way DMT does — each mod wraps
 * the previous handleInput, so this coexists with DMT's hotkeys.
 */
import HotkeyManager from '/core/ui/input/hotkey-manager.js';

engine.whenReady.then(() => {
    const prevHandleInput = HotkeyManager.handleInput;

    HotkeyManager.handleInput = function (...args) {
        const [inputEvent] = args;
        const status = inputEvent?.detail?.status;
        if (status == InputActionStatuses.FINISH) {
            const name = inputEvent.detail.name;
            switch (name) {
                case "autopin-generate":
                case "autopin-clear":
                case "autopin-settle":
                case "autopin-panel":
                    HotkeyManager.sendHotkeyEvent(name);
                    return false;
            }
        }
        return prevHandleInput.apply(this, args);
    };
});
