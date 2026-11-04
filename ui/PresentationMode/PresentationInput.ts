// Dependencies:
import MenuGestureDetector from "./MenuGestureDetector.js"; // Detects the L3 + R3 rising edge independently of focus input

// Type dependencies:
import type { UiMenuGestureSample, UiPresentationInputConfig } from "./types.js";

const MENU_GESTURE_BUTTONS = Object.freeze([10, 11]);
const ACTIVATION_BUTTONS = Object.freeze([0, 1, 10, 11]);
const PAD_BUTTONS = Object.freeze({ cross: 0, circle: 1, up: 12, down: 13, left: 14, right: 15 });
const AXIS_THRESHOLD = 0.62;
const FIRST_REPEAT_MS = 330;
const REPEAT_MS = 125;

/**
 *
 * Type Declarations
 *
 */

// TYPE :: "up"|"down"|"left"|"right"
// Direction interpreted from a standard gamepad or keyboard arrow.
type NavigationDirection = "up" | "down" | "left" | "right";

// INTERFACE :: {cross:BOOLEAN, circle:BOOLEAN, up:BOOLEAN, down:BOOLEAN, left:BOOLEAN, right:BOOLEAN}
// Merged logical navigation state across connected standard gamepads.
interface NavigationState {
    readonly cross: boolean;
    readonly circle: boolean;
    readonly up: boolean;
    readonly down: boolean;
    readonly left: boolean;
    readonly right: boolean;
}

/**
 *
 * Class
 *
 */

// Owns controller-first focus, keyboard parity, and menu gestures for Presentation mode.
export default class PresentationInput {

    /* Instance Fields */
    private readonly _document: Document;                                  // Focus and keyboard owner
    private readonly _root: HTMLElement;                                   // Presentation menu root
    private readonly _gestureTarget: HTMLElement;                          // Two-finger gesture surface
    private readonly _getGamepads: UiPresentationInputConfig["getGamepads"]; // Browser pad provider
    private readonly _scheduler: UiPresentationInputConfig["scheduler"];   // Poll scheduler and clock
    private readonly _onToggle: UiPresentationInputConfig["onToggle"];     // Menu gesture receiver
    private readonly _onBack: UiPresentationInputConfig["onBack"];         // Circle/back receiver
    private readonly _onAdjust: UiPresentationInputConfig["onAdjust"];     // Inline selector receiver
    private readonly _gesture = new MenuGestureDetector(MENU_GESTURE_BUTTONS); // L3 + R3 edge detector
    private _active = false;                                                // Whether Presentation input is polling
    private _menuOpen = false;                                              // Whether navigation owns the pads
    private _frame: number | null = null;                                   // Pending animation frame
    private _previous: NavigationState = emptyNavigationState();            // Prior merged buttons for rising edges
    private _heldDirection: NavigationDirection | null = null;              // Direction currently repeating
    private _nextRepeatAt = 0;                                              // Earliest repeat timestamp
    private readonly _heldKeys = new Set<string>();                         // Keyboard activation keys awaiting physical release

    // CONSTRUCTOR :: uiPresentationInputConfig -> presentationInput
    // Retains browser input boundaries and installs keyboard/touch listeners.
    constructor(config: UiPresentationInputConfig) {
        this._document = config.document;
        this._root = config.root;
        this._gestureTarget = config.gestureTarget;
        this._getGamepads = config.getGamepads;
        this._scheduler = config.scheduler;
        this._onToggle = config.onToggle;
        this._onBack = config.onBack;
        this._onAdjust = config.onAdjust;
        const view = browserWindow(this._document);
        view.addEventListener("keydown", this._keyDown, true);
        view.addEventListener("keyup", this._keyUp, true);
        this._gestureTarget.addEventListener("touchstart", this._touchStart, { passive: false });
    }

    /**
     *
     * Properties
     *
     */

    // GETTER :: VOID -> BOOLEAN
    // Reports whether Presentation gestures are active.
    get active(): boolean { return this._active; }

    // SETTER :: BOOLEAN -> VOID
    // Starts or stops gamepad polling and releases retained edges.
    set active(value: boolean) {
        if (this._active === value) return;
        this._active = value;
        if (value) this._schedule();
        else this._stop();
    }

    // GETTER :: VOID -> BOOLEAN
    // Reports whether the controller currently navigates the menu.
    get menuOpen(): boolean { return this._menuOpen; }

    // SETTER :: BOOLEAN -> VOID
    // Changes navigation ownership and focuses the first TV action on open.
    set menuOpen(value: boolean) {
        this._menuOpen = value;
        this._previous = emptyNavigationState();
        this._heldDirection = null;
        if (value) this.focusFirst("actions");
        else this._clearPadFocus();
    }

    /**
     *
     * Instance Methods
     *
     */

    // METHOD :: "actions"|"content"? -> VOID
    // Focuses the first enabled Presentation action in one column or the entire menu.
    focusFirst(column?: "actions" | "content"): void {
        const candidates = focusableElements(this._root).filter((candidate) =>
            column === undefined || candidate.dataset.presentationColumn === column);
        if (candidates[0] !== undefined) this._focus(candidates[0]);
    }

    // METHOD :: VOID -> VOID
    // Removes browser listeners and permanently stops polling.
    destroy(): void {
        this._stop();
        const view = browserWindow(this._document);
        view.removeEventListener("keydown", this._keyDown, true);
        view.removeEventListener("keyup", this._keyUp, true);
        this._gestureTarget.removeEventListener("touchstart", this._touchStart);
    }

    // METHOD :: NUMBER? -> PROMISE(VOID)
    // Waits for menu activation buttons and keys to release before gameplay input reattaches.
    waitForActivationRelease(timeoutMs = 1_500): Promise<void> {
        const started = this._scheduler.now();
        return new Promise((resolve) => {
            const inspect = (): void => {
                const padsNeutral = connectedStandardGamepads(this._getGamepads()).every((pad) =>
                    ACTIVATION_BUTTONS.every((index) => !pressed(pad, index)));
                if ((padsNeutral && this._heldKeys.size === 0) || this._scheduler.now() - started >= timeoutMs) {
                    resolve();
                } else {
                    this._scheduler.request(inspect);
                }
            };
            inspect();
        });
    }

    // METHOD :: VOID -> VOID
    // Schedules one poll while Presentation input remains active.
    private _schedule(): void {
        if (!this._active || this._frame !== null) return;
        this._frame = this._scheduler.request(this._poll);
    }

    // METHOD :: VOID -> VOID
    // Cancels polling and clears every edge/repeat state.
    private _stop(): void {
        if (this._frame !== null) this._scheduler.cancel(this._frame);
        this._frame = null;
        this._gesture.reset();
        this._previous = emptyNavigationState();
        this._heldDirection = null;
        this._heldKeys.clear();
        this._clearPadFocus();
    }

    // METHOD :: VOID -> VOID
    // Samples menu gestures continuously and focus navigation while the menu is open.
    private readonly _poll = (): void => {
        this._frame = null;
        if (!this._active) return;
        const pads = connectedStandardGamepads(this._getGamepads());
        const samples: UiMenuGestureSample[] = pads.map((pad) => ({
            id: `${pad.index}:${pad.id}`,
            buttons: pad.buttons.map((button) => button.pressed || button.value >= 0.5),
        }));
        if (this._gesture.sample(samples).length > 0
            && this._document.querySelector('[data-capturing="true"]') === null) {
            this._onToggle();
            this._previous = emptyNavigationState();
            this._heldDirection = null;
            this._schedule();
            return;
        }
        if (this._menuOpen) this._navigate(mergedNavigationState(pads));
        this._schedule();
    };

    // METHOD :: navigationState -> VOID
    // Applies rising-edge actions and timed directional repeat to the current focus.
    private _navigate(state: NavigationState): void {
        if (state.cross && !this._previous.cross) this._activateFocused();
        if (state.circle && !this._previous.circle) this._onBack();
        const direction = navigationDirection(state);
        const now = this._scheduler.now();
        if (direction === null) {
            this._heldDirection = null;
        } else if (direction !== this._heldDirection) {
            this._move(direction);
            this._heldDirection = direction;
            this._nextRepeatAt = now + FIRST_REPEAT_MS;
        } else if (now >= this._nextRepeatAt) {
            this._move(direction);
            this._nextRepeatAt = now + REPEAT_MS;
        }
        this._previous = state;
    }

    // METHOD :: navigationDirection -> VOID
    // Moves within a column, crosses columns, or changes a focused inline selector.
    private _move(direction: NavigationDirection): void {
        const candidates = focusableElements(this._root);
        if (candidates.length === 0) return;
        const focused = this._document.activeElement instanceof HTMLElement
            && candidates.includes(this._document.activeElement)
            ? this._document.activeElement
            : null;
        if (focused === null) {
            this._focus(candidates[0]!);
            return;
        }
        const setting = focused.dataset.presentationAdjust;
        if ((direction === "left" || direction === "right") && setting !== undefined) {
            this._onAdjust(setting, direction === "left" ? -1 : 1);
            return;
        }
        const column = focused.dataset.presentationColumn;
        if ((direction === "left" || direction === "right") && column !== undefined) {
            const targetColumn = direction === "right" ? "content" : "actions";
            if (column !== targetColumn) {
                const target = candidates.find((candidate) => candidate.dataset.presentationColumn === targetColumn);
                if (target !== undefined) this._focus(target);
                return;
            }
        }
        if (direction !== "up" && direction !== "down") return;
        const inColumn = candidates.filter((candidate) => candidate.dataset.presentationColumn === column);
        const index = inColumn.indexOf(focused);
        if (index < 0) return;
        const step = direction === "up" ? -1 : 1;
        this._focus(inColumn[(index + step + inColumn.length) % inColumn.length]!);
    }

    // METHOD :: VOID -> VOID
    // Clicks the currently focused Presentation action.
    private _activateFocused(): void {
        const focused = this._document.activeElement;
        if (focused instanceof HTMLButtonElement && !focused.disabled) focused.click();
    }

    // METHOD :: HTMLElement -> VOID
    // Marks controller focus without changing layout.
    private _focus(target: HTMLElement): void {
        this._clearPadFocus();
        target.dataset.padFocus = "true";
        target.focus({ preventScroll: true });
        target.scrollIntoView({ block: "nearest", inline: "nearest" });
    }

    // METHOD :: VOID -> VOID
    // Clears controller-only focus decoration from every prior target.
    private _clearPadFocus(): void {
        for (const target of this._root.querySelectorAll<HTMLElement>('[data-pad-focus="true"]')) {
            delete target.dataset.padFocus;
        }
    }

    // METHOD :: keyboardEvent -> VOID
    // Gives arrows, Enter, and Escape the same Presentation semantics as a gamepad.
    private readonly _keyDown = (event: KeyboardEvent): void => {
        if (!this._active || event.defaultPrevented) return;
        if (event.key === "Escape" || event.key === "Enter" || event.key === " ") this._heldKeys.add(event.key);
        if (event.key === "Escape") {
            event.preventDefault();
            this._onToggle();
            return;
        }
        if (!this._menuOpen) return;
        const direction = keyboardDirection(event.key);
        if (direction !== null) {
            event.preventDefault();
            this._move(direction);
        } else if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            this._activateFocused();
        } else if (event.key === "Backspace") {
            event.preventDefault();
            this._onBack();
        }
    };

    // METHOD :: keyboardEvent -> VOID
    // Releases one retained keyboard activation key for the gameplay reattachment gate.
    private readonly _keyUp = (event: KeyboardEvent): void => {
        this._heldKeys.delete(event.key);
    };

    // METHOD :: touchEvent -> VOID
    // Toggles the Presentation menu on a two-finger touch.
    private readonly _touchStart = (event: TouchEvent): void => {
        if (!this._active || event.touches.length !== 2) return;
        event.preventDefault();
        this._onToggle();
    };
}

/**
 *
 *  Helper Functions
 *
 */

// HELPER :: DOCUMENT -> WINDOW
// Returns the owning browser window required for global keyboard events.
const browserWindow = (document: Document): Window => {
    if (document.defaultView === null) throw new Error("Presentation input requires a browser Window.");
    return document.defaultView;
};

// HELPER :: [GAMEPAD?] -> [GAMEPAD]
// Retains connected standard-layout gamepads in browser index order.
const connectedStandardGamepads = (pads: ReadonlyArray<Gamepad | null>): ReadonlyArray<Gamepad> =>
    [...pads].filter((pad): pad is Gamepad => pad !== null && pad.connected && pad.mapping === "standard")
        .sort((left, right) => left.index - right.index);

// HELPER :: [GAMEPAD] -> navigationState
// Merges standard D-pad, left-stick, Cross, and Circle state across connected pads.
const mergedNavigationState = (pads: ReadonlyArray<Gamepad>): NavigationState => ({
    cross: pads.some((pad) => pressed(pad, PAD_BUTTONS.cross)),
    circle: pads.some((pad) => pressed(pad, PAD_BUTTONS.circle)),
    up: pads.some((pad) => pressed(pad, PAD_BUTTONS.up) || (pad.axes[1] ?? 0) <= -AXIS_THRESHOLD),
    down: pads.some((pad) => pressed(pad, PAD_BUTTONS.down) || (pad.axes[1] ?? 0) >= AXIS_THRESHOLD),
    left: pads.some((pad) => pressed(pad, PAD_BUTTONS.left) || (pad.axes[0] ?? 0) <= -AXIS_THRESHOLD),
    right: pads.some((pad) => pressed(pad, PAD_BUTTONS.right) || (pad.axes[0] ?? 0) >= AXIS_THRESHOLD),
});

// HELPER :: GAMEPAD, NUMBER -> BOOLEAN
// True when one physical button is materially pressed.
const pressed = (pad: Gamepad, index: number): boolean => {
    const button = pad.buttons[index];
    return button !== undefined && (button.pressed || button.value >= 0.5);
};

// HELPER :: VOID -> navigationState
// Produces a released navigation state for edge detection.
const emptyNavigationState = (): NavigationState => ({
    cross: false, circle: false, up: false, down: false, left: false, right: false,
});

// HELPER :: navigationState -> navigationDirection?
// Selects one deterministic direction from the merged state.
const navigationDirection = (state: NavigationState): NavigationDirection | null => {
    if (state.up && !state.down) return "up";
    if (state.down && !state.up) return "down";
    if (state.left && !state.right) return "left";
    if (state.right && !state.left) return "right";
    return null;
};

// HELPER :: STRING -> navigationDirection?
// Maps keyboard arrow names to Presentation navigation directions.
const keyboardDirection = (key: string): NavigationDirection | null => key === "ArrowUp"
    ? "up"
    : key === "ArrowDown"
        ? "down"
        : key === "ArrowLeft"
            ? "left"
            : key === "ArrowRight" ? "right" : null;

// HELPER :: HTMLElement -> [HTMLElement]
// Returns enabled visible focus targets in document order.
const focusableElements = (root: HTMLElement): HTMLElement[] =>
    [...root.querySelectorAll<HTMLElement>("[data-presentation-focus]")].filter((candidate) => {
        if (candidate.closest("[hidden]") !== null) return false;
        if (candidate.closest("[inert]") !== null) return false;
        if ((candidate instanceof HTMLButtonElement || candidate instanceof HTMLSelectElement) && candidate.disabled) return false;
        return browserWindow(candidate.ownerDocument).getComputedStyle(candidate).display !== "none";
    });
