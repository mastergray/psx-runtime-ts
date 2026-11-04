// Dependencies:
import {
    DEFAULT_GAMEPAD_BUTTON_MAP,
    DEFAULT_KEYBOARD_MAP,
} from "../src/index.js";
import { isUiStoredControlProfile } from "./types.js"; // Validates browser-local profiles before applying them

// Type dependencies:
import type {
    ControllerPort,     // Physical player port receiving a keyboard or gamepad binding
    GamepadButtonMap,   // Device-specific physical-button override
    GamepadButtonMaps,  // All device-specific physical-button overrides
    KeyboardMap,        // Browser keyboard-code mapping applied to the runtime
    PsxButton,          // Logical PlayStation button represented by one table row
    PsxConsole,         // Runtime receiving live input configuration changes
} from "../src/index.js";
import type {
    UiBindingCaptureBaseline, // Initial pressed-button snapshot for fresh-input detection
    UiControlBindingView,     // Retained binding-table cells and capture action
    UiControlCapture,         // Active binding or gamepad-assignment capture
    UiControlProfileLoadStatus, // Browser-profile load outcome rendered to the user
    UiControlSettingsConfig,  // Browser dependencies supplied by the application
    UiGamepadAssignment,      // Connected device assigned to one physical port
    UiStoredControlProfile,   // Versioned browser-local control profile
} from "./types.js";

const CONTROL_PROFILE_STORAGE_KEY = "psx-runtime:ui:controls";
const PORTS = Object.freeze([1, 2] as const);
const CONTROL_DEFINITIONS: ReadonlyArray<{ readonly button: PsxButton; readonly label: string }> = Object.freeze([
    { button: "up", label: "D-pad up" },
    { button: "down", label: "D-pad down" },
    { button: "left", label: "D-pad left" },
    { button: "right", label: "D-pad right" },
    { button: "cross", label: "Cross" },
    { button: "circle", label: "Circle" },
    { button: "square", label: "Square" },
    { button: "triangle", label: "Triangle" },
    { button: "l1", label: "L1" },
    { button: "r1", label: "R1" },
    { button: "l2", label: "L2" },
    { button: "r2", label: "R2" },
    { button: "start", label: "Start" },
    { button: "select", label: "Select" },
    { button: "l3", label: "L3" },
    { button: "r3", label: "R3" },
]);

/**
 *
 * Class
 *
 */

// Owns persistent two-player keyboard and gamepad configuration for the production interface.
export default class ControlSettings {

    /* Instance Fields */
    private readonly _document: Document; // Production document containing System Controls elements
    private readonly _storage: Storage | null; // Browser-local persistence boundary
    private readonly _gamepadAssignments: Record<ControllerPort, UiGamepadAssignment | null> = { 1: null, 2: null }; // Live devices by player
    private readonly _gamepadPortPreferences: Record<string, ControllerPort> = Object.create(null) as Record<string, ControllerPort>; // Preferred player by device ID
    private readonly _gamepadButtonMaps: Record<string, GamepadButtonMap> = Object.create(null) as Record<string, GamepadButtonMap>; // Device-specific button overrides
    private readonly _leftStickDpad: Record<ControllerPort, boolean> = { 1: false, 2: false }; // Digital-game compatibility by player
    private readonly _bindingViews: Record<ControllerPort, Map<PsxButton, UiControlBindingView>> = { 1: new Map(), 2: new Map() }; // Rendered binding rows
    private _keyboardMap: KeyboardMap = DEFAULT_UI_KEYBOARD_MAP; // Current complete two-player keyboard mapping
    private _runtime: PsxConsole | null = null; // Runtime receiving current mappings and assignments
    private _capture: UiControlCapture | null = null; // Active fresh-input capture

    // CONSTRUCTOR :: uiControlSettingsConfig -> controlSettings
    // Retains browser dependencies; initialize performs DOM and storage work.
    constructor(config: UiControlSettingsConfig) {
        this._document = config.document;
        this._storage = config.storage;
    }

    /**
     *
     * Properties
     *
     */

    // GETTER :: VOID -> keyboardMap
    // Returns the current immutable two-player keyboard mapping for runtime construction.
    get keyboardMap(): KeyboardMap { return this._keyboardMap; }

    // GETTER :: VOID -> gamepadButtonMaps
    // Returns device-specific gamepad mappings for runtime construction.
    get gamepadButtonMaps(): GamepadButtonMaps { return this._gamepadButtonMaps; }

    // GETTER :: VOID -> ARRAY<controllerPort, BOOLEAN>
    // Returns per-player left-stick D-pad compatibility for runtime construction.
    get leftStickDpad(): Readonly<Record<ControllerPort, boolean>> { return this._leftStickDpad; }

    /**
     *
     * Instance Methods
     *
     */

    // METHOD :: VOID -> VOID
    // Loads the stored profile, builds both player tables, and binds capture controls.
    initialize(): void {
        const loaded = loadControlProfile(this._storage);
        if (loaded.profile !== null) this._applyStoredProfile(loaded.profile);
        this._initializeBindingTables();
        this._bindDocument();
        this._selectPlayer(1);
        this._syncGamepads();
        this._renderBindings();
        this._renderProfileStatus(loaded.status);
    }

    // METHOD :: psxConsole -> VOID
    // Attaches the initialized mappings and current device assignments to one runtime.
    attachRuntime(runtime: PsxConsole): void {
        this._runtime = runtime;
        runtime.setKeyboardMap(this._keyboardMap);
        for (const [id, map] of Object.entries(this._gamepadButtonMaps)) runtime.setGamepadButtonMap(id, map);
        for (const port of PORTS) runtime.setLeftStickDpad(port, this._leftStickDpad[port]);
        this._syncGamepads();
        for (const port of PORTS) {
            const assignment = this._gamepadAssignments[port];
            if (assignment !== null) runtime.bindGamepad(assignment.index, port);
        }
    }

    // METHOD :: STRING? -> VOID
    // Cancels any active input capture and optionally reports the reason on its player panel.
    cancelCapture(message?: string, state: "idle" | "working" | "success" | "error" = "idle"): void {
        const capture = this._capture;
        if (capture === null) return;
        browserWindow(this._document).cancelAnimationFrame(capture.frame);
        this._capture = null;
        this._renderBindings();
        if (message !== undefined) this._bindingStatus(capture.port, message, state);
    }

    // METHOD :: VOID -> VOID
    // Reconciles connected standard gamepads with stored player preferences and live runtime bindings.
    syncGamepads(): void { this._syncGamepads(); }

    // METHOD :: uiStoredControlProfile -> VOID
    // Copies one validated stored profile into mutable page-owned control state.
    private _applyStoredProfile(profile: UiStoredControlProfile): void {
        this._keyboardMap = frozenKeyboardMap(profile.keyboard);
        for (const [id, map] of Object.entries(profile.gamepads)) {
            this._gamepadButtonMaps[id] = Object.freeze({ ...map });
        }
        Object.assign(this._gamepadPortPreferences, profile.gamepadPorts ?? {});
        Object.assign(this._leftStickDpad, profile.leftStickDpad ?? {});
    }

    // METHOD :: VOID -> VOID
    // Binds player tabs, assignment actions, reset actions, compatibility toggles, and capture events.
    private _bindDocument(): void {
        for (const port of PORTS) {
            element<HTMLButtonElement>(this._document, `controls-player-tab-${port}`).addEventListener("click", () => {
                this._selectPlayer(port);
            });
            element<HTMLButtonElement>(this._document, `assign-gamepad-${port}`).addEventListener("click", () => {
                if (this._capture?.kind === "assignment" && this._capture.port === port) {
                    this.cancelCapture("Gamepad assignment cancelled.");
                } else {
                    this._beginCapture({ kind: "assignment", port });
                }
            });
            element<HTMLInputElement>(this._document, `left-stick-dpad-${port}`).addEventListener("change", () => {
                const enabled = element<HTMLInputElement>(this._document, `left-stick-dpad-${port}`).checked;
                this._leftStickDpad[port] = enabled;
                this._runtime?.setLeftStickDpad(port, enabled);
                this._persistProfile();
                this._bindingStatus(
                    port,
                    enabled ? "The left stick now also controls the D-pad." : "Left-stick D-pad compatibility is off.",
                    "success",
                );
            });
            element<HTMLButtonElement>(this._document, `reset-player-mapping-${port}`).addEventListener("click", () => {
                this._resetPlayer(port);
            });
        }
        element<HTMLButtonElement>(this._document, "reset-all-mappings").addEventListener("click", () => {
            this._resetAll();
        });
        const view = browserWindow(this._document);
        view.addEventListener("keydown", (event) => this._captureKeyboard(event), true);
        view.addEventListener("gamepadconnected", () => this._syncGamepads());
        view.addEventListener("gamepaddisconnected", () => this._syncGamepads());
    }

    // METHOD :: VOID -> VOID
    // Builds one binding row per logical PlayStation button for both players.
    private _initializeBindingTables(): void {
        for (const port of PORTS) {
            const body = element<HTMLTableSectionElement>(this._document, `control-bindings-${port}`);
            for (const { button: psxButton, label } of CONTROL_DEFINITIONS) {
                const row = this._document.createElement("tr");
                const control = this._document.createElement("th");
                control.scope = "row";
                control.textContent = label;
                const keyboard = this._document.createElement("td");
                keyboard.id = `control-keyboard-${port}-${psxButton}`;
                const gamepad = this._document.createElement("td");
                gamepad.id = `control-gamepad-${port}-${psxButton}`;
                const action = this._document.createElement("td");
                const change = this._document.createElement("button");
                change.type = "button";
                change.id = `change-control-${port}-${psxButton}`;
                change.className = "binding-change";
                change.addEventListener("click", () => {
                    if (this._capture?.kind === "binding" && this._capture.port === port
                        && this._capture.button === psxButton) {
                        this.cancelCapture("Binding change cancelled.");
                    } else {
                        this._beginCapture({ kind: "binding", port, button: psxButton });
                    }
                });
                action.append(change);
                row.append(control, keyboard, gamepad, action);
                body.append(row);
                this._bindingViews[port].set(psxButton, { keyboard, gamepad, change });
            }
        }
    }

    // METHOD :: controllerPort -> VOID
    // Displays one player mapping panel and updates tab semantics.
    private _selectPlayer(port: ControllerPort): void {
        this.cancelCapture();
        for (const candidate of PORTS) {
            const selected = candidate === port;
            const tab = element<HTMLButtonElement>(this._document, `controls-player-tab-${candidate}`);
            tab.setAttribute("aria-selected", String(selected));
            tab.tabIndex = selected ? 0 : -1;
            element<HTMLElement>(this._document, `controls-player-panel-${candidate}`).hidden = !selected;
        }
    }

    // METHOD :: VOID -> VOID
    // Renders assigned devices, compatibility toggles, and every keyboard/gamepad binding.
    private _renderBindings(): void {
        for (const port of PORTS) {
            const pad = this._assignedPad(port);
            this._setText(`assigned-gamepad-${port}`, pad === null ? "No connected gamepad" : gamepadName(pad));
            element<HTMLInputElement>(this._document, `left-stick-dpad-${port}`).checked = this._leftStickDpad[port];
            const assigning = this._capture?.kind === "assignment" && this._capture.port === port;
            const assign = element<HTMLButtonElement>(this._document, `assign-gamepad-${port}`);
            assign.textContent = assigning ? "Cancel" : "Change";
            assign.dataset.capturing = String(assigning);
            for (const { button: psxButton } of CONTROL_DEFINITIONS) {
                const view = this._bindingViews[port].get(psxButton)!;
                view.keyboard.textContent = keyLabel(keyboardCodeFor(this._keyboardMap, port, psxButton));
                view.gamepad.textContent = gamepadButtonLabel(gamepadButtonFor(this._gamepadButtonMaps, pad?.id ?? null, psxButton));
                const capturing = this._capture?.kind === "binding" && this._capture.port === port
                    && this._capture.button === psxButton;
                view.change.textContent = capturing ? "Cancel" : "Change";
                view.change.dataset.capturing = String(capturing);
            }
        }
    }

    // METHOD :: binding-or-assignment capture request -> VOID
    // Starts fresh-input polling after recording all currently held gamepad buttons.
    private _beginCapture(request: { readonly kind: "assignment"; readonly port: ControllerPort }
        | { readonly kind: "binding"; readonly port: ControllerPort; readonly button: PsxButton }): void {
        this.cancelCapture();
        const baseline = new Map<number, UiBindingCaptureBaseline>();
        for (const pad of connectedStandardGamepads(this._document)) baseline.set(pad.index, gamepadBaseline(pad));
        this._capture = { ...request, baseline, frame: 0 };
        this._bindingStatus(
            request.port,
            request.kind === "binding"
                ? "Press a keyboard key or gamepad button. Escape or Cancel stops capture."
                : "Press a button on the gamepad to assign. Escape or Cancel stops capture.",
            "working",
        );
        this._renderBindings();
        this._capture.frame = browserWindow(this._document).requestAnimationFrame(() => this._pollCapture());
    }

    // METHOD :: VOID -> VOID
    // Polls connected devices until one newly pressed button satisfies the active capture.
    private _pollCapture(): void {
        const capture = this._capture;
        if (capture === null) return;
        for (const pad of connectedStandardGamepads(this._document)) {
            let baseline = capture.baseline.get(pad.index);
            if (baseline === undefined) {
                baseline = gamepadBaseline(pad);
                capture.baseline.set(pad.index, baseline);
            }
            for (let index = 0; index < pad.buttons.length; index++) {
                const pressed = pad.buttons[index]!.pressed || pad.buttons[index]!.value >= 0.5;
                if (baseline.buttons[index] === true) {
                    if (!pressed) baseline.buttons[index] = false;
                } else if (pressed) {
                    if (capture.kind === "assignment") this._assignGamepad(capture.port, pad);
                    else this._moveGamepadBinding(capture.port, capture.button, pad, index);
                    return;
                }
            }
        }
        capture.frame = browserWindow(this._document).requestAnimationFrame(() => this._pollCapture());
    }

    // METHOD :: keyboardEvent -> VOID
    // Captures a layout-independent keyboard code or cancels on Escape.
    private _captureKeyboard(event: KeyboardEvent): void {
        const capture = this._capture;
        if (capture === null) return;
        if (event.key === "Escape") {
            event.preventDefault();
            event.stopImmediatePropagation();
            this.cancelCapture("Input capture cancelled.");
            return;
        }
        if (capture.kind !== "binding" || event.code.length === 0) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        this._moveKeyboardBinding(capture.port, capture.button, event.code);
    }

    // METHOD :: controllerPort, psxButton, STRING -> VOID
    // Moves one keyboard code to one logical control while preserving uniqueness.
    private _moveKeyboardBinding(port: ControllerPort, psxButton: PsxButton, code: string): void {
        this._keyboardMap = frozenKeyboardMap(Object.fromEntries(Object.entries(this._keyboardMap)
            .filter(([candidateCode, control]) => candidateCode !== code
                && !(control.port === port && control.button === psxButton))
            .concat([[code, { port, button: psxButton }]])));
        this._runtime?.setKeyboardMap(this._keyboardMap);
        this._persistProfile();
        this.cancelCapture(`${keyLabel(code)} assigned to ${controlLabel(psxButton)}.`, "success");
    }

    // METHOD :: controllerPort, psxButton, GAMEPAD, NUMBER -> VOID
    // Moves one physical gamepad button to one logical control and assigns that device to the player.
    private _moveGamepadBinding(port: ControllerPort, psxButton: PsxButton, pad: Gamepad, index: number): void {
        const current = Object.hasOwn(this._gamepadButtonMaps, pad.id) ? this._gamepadButtonMaps[pad.id]! : {};
        const next: Partial<Record<PsxButton, number | null>> = { ...current };
        for (const { button: candidate } of CONTROL_DEFINITIONS) {
            if (candidate !== psxButton
                && gamepadButtonFor(this._gamepadButtonMaps, pad.id, candidate) === index) next[candidate] = null;
        }
        next[psxButton] = index;
        this._gamepadButtonMaps[pad.id] = Object.freeze(next);
        this._runtime?.setGamepadButtonMap(pad.id, this._gamepadButtonMaps[pad.id]!);
        this._assignGamepad(port, pad, false);
        this._persistProfile();
        this.cancelCapture(
            `${gamepadButtonLabel(index)} on ${gamepadName(pad)} assigned to ${controlLabel(psxButton)}.`,
            "success",
        );
    }

    // METHOD :: controllerPort, GAMEPAD, BOOLEAN? -> VOID
    // Assigns a device to one player, swapping the prior device when it belonged to the other player.
    private _assignGamepad(port: ControllerPort, pad: Gamepad, finish = true): void {
        const otherPort: ControllerPort = port === 1 ? 2 : 1;
        const previous = this._gamepadAssignments[port];
        const other = this._gamepadAssignments[otherPort];
        const selected = { index: pad.index, id: pad.id };
        const selectedWasOther = other?.index === pad.index && other.id === pad.id;
        const next: Record<ControllerPort, UiGamepadAssignment | null> = {
            1: this._gamepadAssignments[1],
            2: this._gamepadAssignments[2],
        };
        next[port] = selected;
        if (selectedWasOther) next[otherPort] = previous;
        this._gamepadPortPreferences[pad.id] = port;
        if (selectedWasOther && previous !== null) this._gamepadPortPreferences[previous.id] = otherPort;
        this._applyGamepadAssignments(next);
        this._persistProfile();
        this._renderBindings();
        if (finish) this.cancelCapture(`${gamepadName(pad)} assigned to Player ${port}.`, "success");
    }

    // METHOD :: controllerPort -> VOID
    // Restores default keyboard, assigned-device, and compatibility mappings for one player.
    private _resetPlayer(port: ControllerPort): void {
        this.cancelCapture();
        const defaults = Object.entries(DEFAULT_UI_KEYBOARD_MAP).filter(([, control]) => control.port === port);
        const defaultCodes = new Set(defaults.map(([code]) => code));
        this._keyboardMap = frozenKeyboardMap(Object.fromEntries(Object.entries(this._keyboardMap)
            .filter(([code, control]) => control.port !== port && !defaultCodes.has(code))
            .concat(defaults)));
        this._runtime?.setKeyboardMap(this._keyboardMap);
        const pad = this._assignedPad(port);
        if (pad !== null) {
            delete this._gamepadButtonMaps[pad.id];
            this._runtime?.setGamepadButtonMap(pad.id, null);
        }
        this._leftStickDpad[port] = false;
        this._runtime?.setLeftStickDpad(port, false);
        this._persistProfile();
        this._renderBindings();
        this._bindingStatus(port, `Player ${port} mappings restored to defaults.`, "success");
    }

    // METHOD :: VOID -> VOID
    // Restores all mappings, compatibility flags, and device preferences to defaults.
    private _resetAll(): void {
        this.cancelCapture();
        this._keyboardMap = DEFAULT_UI_KEYBOARD_MAP;
        this._runtime?.setKeyboardMap(this._keyboardMap);
        for (const id of Object.keys(this._gamepadButtonMaps)) {
            delete this._gamepadButtonMaps[id];
            this._runtime?.setGamepadButtonMap(id, null);
        }
        for (const id of Object.keys(this._gamepadPortPreferences)) delete this._gamepadPortPreferences[id];
        for (const port of PORTS) {
            this._leftStickDpad[port] = false;
            this._runtime?.setLeftStickDpad(port, false);
        }
        this._applyGamepadAssignments({ 1: null, 2: null });
        this._syncGamepads();
        removeStoredControlProfile(this._storage);
        this._setStorageStatus("Default mappings restored; the stored control profile was removed.", "success");
        for (const port of PORTS) this._bindingStatus(port, "Default mappings restored.", "success");
        this._renderBindings();
    }

    // METHOD :: VOID -> VOID
    // Reconciles live devices with stored preferences, retained assignments, and available ports.
    private _syncGamepads(): void {
        const pads = connectedStandardGamepads(this._document);
        const next: Record<ControllerPort, UiGamepadAssignment | null> = { 1: null, 2: null };
        const claimed = new Set<number>();
        for (const pad of pads) {
            const preferred = this._gamepadPortPreferences[pad.id];
            if (preferred === undefined || next[preferred] !== null) continue;
            next[preferred] = { index: pad.index, id: pad.id };
            claimed.add(pad.index);
        }
        for (const port of PORTS) {
            const current = this._gamepadAssignments[port];
            if (next[port] !== null || current === null || claimed.has(current.index)) continue;
            const pad = pads.find((candidate) => candidate.index === current.index && candidate.id === current.id);
            if (pad === undefined) continue;
            next[port] = current;
            claimed.add(current.index);
        }
        for (const pad of pads) {
            if (claimed.has(pad.index)) continue;
            const port = PORTS.find((candidate) => next[candidate] === null);
            if (port === undefined) break;
            next[port] = { index: pad.index, id: pad.id };
            claimed.add(pad.index);
        }
        if (PORTS.some((port) => !sameAssignment(this._gamepadAssignments[port], next[port]))) {
            this._applyGamepadAssignments(next);
        }
        this._renderBindings();
    }

    // METHOD :: ARRAY<controllerPort, uiGamepadAssignment?> -> VOID
    // Releases changed runtime bindings, stores the new assignments, and attaches their replacements.
    private _applyGamepadAssignments(next: Readonly<Record<ControllerPort, UiGamepadAssignment | null>>): void {
        const previous: Readonly<Record<ControllerPort, UiGamepadAssignment | null>> = {
            1: this._gamepadAssignments[1],
            2: this._gamepadAssignments[2],
        };
        for (const port of PORTS) {
            const assignment = previous[port];
            if (assignment !== null && !sameAssignment(assignment, next[port])) {
                this._runtime?.bindGamepad(assignment.index, null);
            }
        }
        for (const port of PORTS) this._gamepadAssignments[port] = next[port];
        for (const port of PORTS) {
            const assignment = next[port];
            if (assignment !== null && !sameAssignment(previous[port], assignment)) {
                this._runtime?.bindGamepad(assignment.index, port);
            }
        }
    }

    // METHOD :: controllerPort -> GAMEPAD?
    // Resolves the currently assigned connected standard gamepad for one player.
    private _assignedPad(port: ControllerPort): Gamepad | null {
        const assignment = this._gamepadAssignments[port];
        if (assignment === null) return null;
        const pad = browserWindow(this._document).navigator.getGamepads()[assignment.index] ?? null;
        return pad !== null && pad.connected && pad.mapping === "standard" && pad.id === assignment.id ? pad : null;
    }

    // METHOD :: VOID -> VOID
    // Persists the complete current profile and reports browser-storage availability.
    private _persistProfile(): void {
        const profile: UiStoredControlProfile = {
            version: 1,
            keyboard: this._keyboardMap,
            gamepads: this._gamepadButtonMaps,
            gamepadPorts: this._gamepadPortPreferences,
            leftStickDpad: { ...this._leftStickDpad },
        };
        try {
            this._storage?.setItem(CONTROL_PROFILE_STORAGE_KEY, JSON.stringify(profile));
            this._setStorageStatus(
                this._storage === null
                    ? "Mappings changed for this page, but browser storage is unavailable."
                    : "Control mappings are stored in this browser and survive reloads.",
                this._storage === null ? "error" : "success",
            );
        } catch {
            this._setStorageStatus("Mappings changed for this page, but browser storage is unavailable.", "error");
        }
    }

    // METHOD :: uiControlProfileLoadStatus -> VOID
    // Renders the initial persistence state after profile validation.
    private _renderProfileStatus(status: UiControlProfileLoadStatus): void {
        if (status === "loaded") this._setStorageStatus("Stored control mappings loaded from this browser.", "success");
        else if (status === "invalid") this._setStorageStatus("The stored control profile was invalid; default mappings are active.", "error");
        else if (status === "unavailable") this._setStorageStatus("Browser storage is unavailable; changes last only for this page.", "error");
        else this._setStorageStatus("Default mappings are active; changes will be stored in this browser.", "idle");
    }

    // METHOD :: controllerPort, STRING, uiFeedbackState -> VOID
    // Updates one player's live capture and mapping feedback.
    private _bindingStatus(port: ControllerPort, message: string, state: "idle" | "working" | "success" | "error"): void {
        const status = element<HTMLElement>(this._document, `control-binding-status-${port}`);
        status.textContent = message;
        status.dataset.state = state;
    }

    // METHOD :: STRING, uiFeedbackState -> VOID
    // Updates the profile persistence feedback shown below both player panels.
    private _setStorageStatus(message: string, state: "idle" | "working" | "success" | "error"): void {
        const status = element<HTMLElement>(this._document, "control-storage-status");
        status.textContent = message;
        status.dataset.state = state;
    }

    // METHOD :: STRING, STRING -> VOID
    // Writes safe text into one required controls element.
    private _setText(id: string, value: string): void {
        element<HTMLElement>(this._document, id).textContent = value;
    }
}

/**
 *
 *  Helper Functions
 *
 */

// HELPER :: keyboardMap -> keyboardMap
// Produces an immutable mapping with independently frozen control values.
const frozenKeyboardMap = (map: KeyboardMap): KeyboardMap => Object.freeze(Object.fromEntries(
    Object.entries(map).map(([code, control]) => [code, Object.freeze({ ...control })]),
));

// HELPER :: VOID -> keyboardMap
// Builds the production two-player default keyboard mapping.
const defaultUiKeyboardMap = (): KeyboardMap => frozenKeyboardMap({
    ...DEFAULT_KEYBOARD_MAP,
    KeyI: { port: 2, button: "up" },
    KeyK: { port: 2, button: "down" },
    KeyJ: { port: 2, button: "left" },
    KeyL: { port: 2, button: "right" },
    KeyN: { port: 2, button: "cross" },
    KeyM: { port: 2, button: "circle" },
    KeyV: { port: 2, button: "square" },
    KeyB: { port: 2, button: "triangle" },
    KeyU: { port: 2, button: "l1" },
    KeyO: { port: 2, button: "r1" },
    Digit7: { port: 2, button: "l2" },
    Digit8: { port: 2, button: "r2" },
    KeyP: { port: 2, button: "start" },
    KeyY: { port: 2, button: "select" },
});

const DEFAULT_UI_KEYBOARD_MAP = defaultUiKeyboardMap();

// HELPER :: uiControlSettingsConfig.document -> WINDOW
// Returns the document's owning browser window.
const browserWindow = (document: Document): Window => {
    if (document.defaultView === null) throw new Error("Control settings require a browser Window.");
    return document.defaultView;
};

// HELPER :: DOCUMENT, STRING -> HTMLElement
// Resolves one required controls element or reports a broken document contract.
const element = <T extends HTMLElement>(document: Document, id: string): T => {
    const value = document.querySelector(`#${id}`);
    if (value === null) throw new Error(`Missing production controls element: ${id}`);
    return value as T;
};

// HELPER :: STORAGE? -> {status:uiControlProfileLoadStatus, profile:uiStoredControlProfile?}
// Loads and validates one stored profile without allowing storage failures to block the application.
const loadControlProfile = (storage: Storage | null): {
    readonly status: UiControlProfileLoadStatus;
    readonly profile: UiStoredControlProfile | null;
} => {
    if (storage === null) return { status: "unavailable", profile: null };
    try {
        const source = storage.getItem(CONTROL_PROFILE_STORAGE_KEY);
        if (source === null) return { status: "defaults", profile: null };
        const profile: unknown = JSON.parse(source);
        return isUiStoredControlProfile(profile)
            ? { status: "loaded", profile }
            : { status: "invalid", profile: null };
    } catch {
        return { status: "unavailable", profile: null };
    }
};

// HELPER :: STORAGE? -> VOID
// Removes the stored control profile when browser storage is available.
const removeStoredControlProfile = (storage: Storage | null): void => {
    try { storage?.removeItem(CONTROL_PROFILE_STORAGE_KEY); } catch { /* Page-local defaults still apply. */ }
};

// HELPER :: DOCUMENT -> [GAMEPAD]
// Returns connected standard-layout browser gamepads in API slot order.
const connectedStandardGamepads = (document: Document): ReadonlyArray<Gamepad> =>
    [...browserWindow(document).navigator.getGamepads()].filter((pad): pad is Gamepad =>
        pad !== null && pad.connected && pad.mapping === "standard");

// HELPER :: GAMEPAD -> uiBindingCaptureBaseline
// Captures currently held buttons so capture waits for a fresh press.
const gamepadBaseline = (pad: Gamepad): UiBindingCaptureBaseline => ({
    buttons: pad.buttons.map(({ pressed, value }) => pressed || value >= 0.5),
});

// HELPER :: GAMEPAD -> STRING
// Produces a readable connected-device label.
const gamepadName = (pad: Gamepad): string => pad.id.trim() || "Connected gamepad";

// HELPER :: uiGamepadAssignment?, uiGamepadAssignment? -> BOOLEAN
// True when two optional assignments identify the same browser device slot and identity.
const sameAssignment = (left: UiGamepadAssignment | null, right: UiGamepadAssignment | null): boolean =>
    left?.index === right?.index && left?.id === right?.id;

// HELPER :: keyboardMap, controllerPort, psxButton -> STRING?
// Finds the unique keyboard code currently assigned to one player control.
const keyboardCodeFor = (map: KeyboardMap, port: ControllerPort, psxButton: PsxButton): string | null =>
    Object.entries(map).find(([, control]) => control.port === port && control.button === psxButton)?.[0] ?? null;

// HELPER :: STRING? -> STRING
// Formats one browser KeyboardEvent.code for the mapping table.
const keyLabel = (code: string | null): string => {
    if (code === null) return "Unbound";
    const labels: Readonly<Record<string, string>> = {
        ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
        ControlLeft: "Left Ctrl", ControlRight: "Right Ctrl", ShiftLeft: "Left Shift",
        ShiftRight: "Right Shift", AltLeft: "Left Alt", AltRight: "Right Alt",
        Space: "Space", Enter: "Enter",
    };
    return labels[code] ?? code.replace(/^Key/u, "").replace(/^Digit/u, "").replace(/^Numpad/u, "Numpad ");
};

// HELPER :: gamepadButtonMaps, STRING?, psxButton -> NUMBER?
// Resolves a device override or the standard-layout default for one logical control.
const gamepadButtonFor = (maps: GamepadButtonMaps, id: string | null, psxButton: PsxButton): number | null => {
    if (id === null || !Object.hasOwn(maps, id) || maps[id]![psxButton] === undefined) {
        return DEFAULT_GAMEPAD_BUTTON_MAP[psxButton];
    }
    return maps[id]![psxButton] ?? null;
};

// HELPER :: NUMBER? -> STRING
// Formats one standard-layout physical gamepad index.
const gamepadButtonLabel = (index: number | null): string => {
    if (index === null) return "Unbound";
    const labels: Readonly<Record<number, string>> = {
        0: "A", 1: "B", 2: "X", 3: "Y", 4: "LB", 5: "RB", 6: "LT", 7: "RT",
        8: "Select", 9: "Start", 10: "L3", 11: "R3", 12: "D-pad up", 13: "D-pad down",
        14: "D-pad left", 15: "D-pad right",
    };
    return labels[index] ?? `Button ${index}`;
};

// HELPER :: psxButton -> STRING
// Returns the user-facing label for one logical control.
const controlLabel = (psxButton: PsxButton): string =>
    CONTROL_DEFINITIONS.find(({ button }) => button === psxButton)?.label ?? psxButton;
