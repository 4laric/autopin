/**
 * Makes AutoPin's input actions visible in Options -> Keyboard+Mouse.
 * Custom mod actions don't appear in the keyboard-mapping editor by default;
 * this mirrors DMT's editor decorator.
 */
export class AP_EditorKeyboardMappingDecorator {

    constructor(component) {
        this.component = component;
    }

    beforeAttach() {
        this.addAction("autopin-generate", InputContext.World);
        this.addAction("autopin-settle", InputContext.World);
        this.addAction("autopin-clear", InputContext.World);
    }

    afterAttach() {
    }

    beforeDetach() {
    }

    afterDetach() {
    }
    // Taken from the original addActionsForContext function.
    addAction(actionIdString, inputContext) {
        const actionId = Input.getActionIdByName(actionIdString);
        if (!actionId) {
            return;
        }
        if (this.component.mappingDataMap.has(actionId)) {
            // This action has already been added. Skip it!
            return;
        }
        this.component.actionContainer.appendChild(this.component.createActionEntry(actionId, inputContext));
    }
}

Controls.decorate('editor-keyboard-mapping', (component) => new AP_EditorKeyboardMappingDecorator(component));
