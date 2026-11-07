// Type dependencies:
import type {
    ControllerPort,       // Physical controller port receiving touch controls
    PsxAxis,              // Analog axes driven by the two virtual sticks
    PsxButton,            // Digital controls exposed by the touch surface
    PsxControllerType,    // Active emulated controller shape for the selected port
} from "../src/shared.types.js";
import type {
    PsxInputChannel,      // Isolated ownership channel held by the touch surface
    PsxInputLike,         // Active session input coordinator accepting the channel
} from "../src/PsxInput/types.js";

/**
 *
 * Type Declarations
 *
 */

// TYPE :: "left"|"right"
// One virtual analog stick and its corresponding pair of PlayStation axes.
type StickName = "left" | "right";

// TYPE :: "up"|"down"|"left"|"right"
// Digital direction emitted by rolling movement over the virtual D-pad.
type Direction = "up" | "down" | "left" | "right";

// INTERFACE :: {root:htmlElement, target:window?, document:document?}
// DOM and lifecycle boundaries required by the framework-free controller.
export interface TouchControllerConfig {
    readonly root: HTMLElement;       // Semantic controller root containing data-bound controls
    readonly target?: Window;         // Focus-loss boundary; defaults to the current window
    readonly document?: Document;     // Visibility-loss boundary; defaults to the current document
}

// INTERFACE :: {element:htmlButtonElement, button:psxButton}
// One active pointer and the digital control it owns.
interface ButtonPointer {
    readonly element: HTMLButtonElement;    // Button retaining visual pressed state
    readonly button: PsxButton;             // PlayStation control held by the pointer
}

// INTERFACE :: {element:htmlElement, pointer:NUMBER?}
// Pointer ownership for one virtual analog stick.
interface StickState {
    readonly element: HTMLElement;    // Stick surface used for geometry and visual displacement
    pointer: number | null;            // Captured pointer identity, or null while centered
}

/**
 *
 * Class
 *
 */

// Routes a semantic browser multi-touch controller through one isolated PSX input channel.
export default class TouchController {

    /* Instance Fields */
    private readonly _root: HTMLElement;                                      // Controller DOM root
    private readonly _target: Window;                                         // Window focus lifecycle boundary
    private readonly _document: Document;                                     // Page visibility lifecycle boundary
    private readonly _cleanup: Array<() => void> = [];                         // Installed DOM-listener removals
    private readonly _dpad: HTMLElement;                                      // Rolling multi-direction surface
    private readonly _sticks: Record<StickName, StickState>;                   // Independent virtual analog sticks
    private readonly _buttonPointers = new Map<number, ButtonPointer>();       // Active digital pointers by identity
    private readonly _buttonHolders = new Map<PsxButton, Set<number>>();       // Pointer owners grouped by control
    private readonly _dpadHeld = new Set<Direction>();                         // Effective directions held by the D-pad pointer
    private _input: PsxInputLike | null = null;                                // Active input coordinator
    private _channel: PsxInputChannel | null = null;                           // Touch-owned source channel
    private _dpadPointer: number | null = null;                                // Captured rolling D-pad pointer
    private _port: ControllerPort = 1;                                         // Physical port receiving controls
    private _controllerType: PsxControllerType = "digital";                   // Visible digital or DualShock shape
    private _enabled = false;                                                  // Whether pointer input may acquire controls
    private _destroyed = false;                                                // Terminal lifecycle guard

    // CONSTRUCTOR :: touchControllerConfig -> touchController
    // Binds the semantic controller elements without requiring a UI framework.
    constructor(config: TouchControllerConfig) {
        if (!(config.root instanceof HTMLElement)) throw new TypeError("TouchController requires an HTML root.");
        this._root = config.root;
        this._target = config.target ?? window;
        this._document = config.document ?? document;
        this._dpad = queryRequired<HTMLElement>(this._root, "[data-touch-dpad]");
        this._sticks = {
            left: { element: queryRequired(this._root, '[data-touch-stick="left"]'), pointer: null },
            right: { element: queryRequired(this._root, '[data-touch-stick="right"]'), pointer: null },
        };
        this._bindButtons();
        this._bindDpad();
        this._bindStick("left");
        this._bindStick("right");
        this._listen(this._target, "blur", () => this.releaseAll());
        this._listen(this._document, "visibilitychange", () => {
            if (this._document.visibilityState !== "visible") this.releaseAll();
        });
        this._listen(this._root, "contextmenu", (event) => event.preventDefault());
        this._applyState();
    }

    /**
     *
     * Properties
     *
     */

    // GETTER :: VOID -> controllerPort
    // Returns the physical port receiving touch input.
    get port(): ControllerPort { return this._port; }

    // SETTER :: controllerPort -> VOID
    // Changes the physical port after releasing all touch-owned controls.
    set port(value: ControllerPort) {
        this._assertLive();
        if (value !== 1 && value !== 2) throw new TypeError("TouchController port must be 1 or 2.");
        if (value === this._port) return;
        this.releaseAll();
        this._port = value;
        this._applyState();
    }

    // GETTER :: VOID -> psxControllerType
    // Returns the selected port's emulated controller shape.
    get controllerType(): PsxControllerType { return this._controllerType; }

    // SETTER :: psxControllerType -> VOID
    // Updates analog control visibility and releases sticks when unavailable.
    set controllerType(value: PsxControllerType) {
        this._assertLive();
        if (value !== "none" && value !== "digital" && value !== "dualshock") {
            throw new TypeError("TouchController controller type is invalid.");
        }
        if (value === this._controllerType) return;
        if (value !== "dualshock") {
            this._releaseStick("left");
            this._releaseStick("right");
        }
        this._controllerType = value;
        this._applyState();
    }

    // GETTER :: VOID -> BOOLEAN
    // Reports whether the surface currently accepts pointer input.
    get enabled(): boolean { return this._enabled; }

    // SETTER :: BOOLEAN -> VOID
    // Enables the surface or atomically releases it when suspended.
    set enabled(value: boolean) {
        this._assertLive();
        if (typeof value !== "boolean") throw new TypeError("TouchController enabled must be boolean.");
        if (value === this._enabled) return;
        if (!value) this.releaseAll();
        this._enabled = value;
        this._applyState();
    }

    /**
     *
     * Instance Methods
     *
     */

    // METHOD :: psxInputLike? -> VOID
    // Replaces the active session input and creates one isolated touch channel.
    attach(input: PsxInputLike | null): void {
        this._assertLive();
        if (input === this._input) return;
        this.detach();
        if (input === null) return;
        if (typeof input.createChannel !== "function") throw new TypeError("TouchController input is invalid.");
        this._input = input;
        this._channel = input.createChannel();
        this._applyState();
    }

    // METHOD :: VOID -> VOID
    // Releases and destroys the active touch input channel.
    detach(): void {
        if (this._destroyed) return;
        const channel = this._channel;
        this.releaseAll();
        this._channel = null;
        this._input = null;
        try { channel?.destroy(); }
        catch { /* The owning player may already have destroyed the coordinator. */ }
        this._applyState();
    }

    // METHOD :: VOID -> VOID
    // Clears every pointer, digital hold and analog axis owned by this surface.
    releaseAll(): void {
        if (this._destroyed) return;
        const channel = this._channel;
        this._channel = null;
        for (const pointerId of [...this._buttonPointers.keys()]) this._releaseButtonPointer(pointerId);
        this._releaseDpad();
        this._releaseStick("left");
        this._releaseStick("right");
        try {
            channel?.releaseAll();
            if (this._input !== null) this._channel = channel;
        } catch {
            this._input = null;
        }
        this._applyState();
    }

    // METHOD :: VOID -> VOID
    // Permanently removes DOM listeners and ends input ownership.
    destroy(): void {
        if (this._destroyed) return;
        this.detach();
        this._cleanup.splice(0).forEach((cleanup) => cleanup());
        this._destroyed = true;
    }

    /**
     *
     * Private Methods
     *
     */

    // METHOD :: VOID -> VOID
    // Installs independent pointer ownership on every semantic digital button.
    private _bindButtons(): void {
        this._root.querySelectorAll<HTMLButtonElement>("[data-touch-button]").forEach((element) => {
            const button = buttonFrom(element.dataset.touchButton);
            this._listen(element, "pointerdown", (raw) => {
                const event = raw as PointerEvent;
                if (!this._canInput() || this._buttonPointers.has(event.pointerId)
                    || [...this._buttonPointers.values()].some((pointer) => pointer.element === element)) return;
                event.preventDefault();
                capturePointer(element, event.pointerId);
                this._buttonPointers.set(event.pointerId, { element, button });
                const holders = this._buttonHolders.get(button) ?? new Set<number>();
                if (holders.size === 0) this._channel!.press({ port: this._port, button });
                holders.add(event.pointerId);
                this._buttonHolders.set(button, holders);
                element.dataset.pressed = "true";
            });
            for (const type of ["pointerup", "pointercancel", "lostpointercapture"] as const) {
                this._listen(element, type, (raw) => this._releaseButtonPointer((raw as PointerEvent).pointerId));
            }
        });
    }

    // METHOD :: VOID -> VOID
    // Installs rolling cardinal and diagonal input on the D-pad surface.
    private _bindDpad(): void {
        this._listen(this._dpad, "pointerdown", (raw) => {
            const event = raw as PointerEvent;
            if (!this._canInput() || this._dpadPointer !== null) return;
            event.preventDefault();
            this._dpadPointer = event.pointerId;
            capturePointer(this._dpad, event.pointerId);
            this._updateDpad(event);
        });
        this._listen(this._dpad, "pointermove", (raw) => this._updateDpad(raw as PointerEvent));
        for (const type of ["pointerup", "pointercancel", "lostpointercapture"] as const) {
            this._listen(this._dpad, type, (raw) => {
                if ((raw as PointerEvent).pointerId === this._dpadPointer) this._releaseDpad();
            });
        }
    }

    // METHOD :: stickName -> VOID
    // Installs clamped two-axis input on one virtual analog stick.
    private _bindStick(name: StickName): void {
        const state = this._sticks[name];
        this._listen(state.element, "pointerdown", (raw) => {
            const event = raw as PointerEvent;
            if (!this._canInput() || this._controllerType !== "dualshock" || state.pointer !== null) return;
            event.preventDefault();
            state.pointer = event.pointerId;
            capturePointer(state.element, event.pointerId);
            this._updateStick(name, event);
        });
        this._listen(state.element, "pointermove", (raw) => this._updateStick(name, raw as PointerEvent));
        for (const type of ["pointerup", "pointercancel", "lostpointercapture"] as const) {
            this._listen(state.element, type, (raw) => {
                if ((raw as PointerEvent).pointerId === state.pointer) this._releaseStick(name);
            });
        }
    }

    // METHOD :: NUMBER -> VOID
    // Releases one digital pointer and the button after its final pointer leaves.
    private _releaseButtonPointer(pointerId: number): void {
        const pointer = this._buttonPointers.get(pointerId);
        if (pointer === undefined) return;
        this._buttonPointers.delete(pointerId);
        const holders = this._buttonHolders.get(pointer.button);
        holders?.delete(pointerId);
        if (holders === undefined || holders.size === 0) {
            this._buttonHolders.delete(pointer.button);
            this._channel?.release({ port: this._port, button: pointer.button });
            pointer.element.dataset.pressed = "false";
        }
    }

    // METHOD :: pointerEvent -> VOID
    // Converts one captured D-pad coordinate into a rolling held-direction set.
    private _updateDpad(event: PointerEvent): void {
        if (event.pointerId !== this._dpadPointer) return;
        const next = directionsFor(this._dpad.getBoundingClientRect(), event.clientX, event.clientY);
        for (const direction of this._dpadHeld) {
            if (!next.has(direction)) this._channel?.release({ port: this._port, button: direction });
        }
        for (const direction of next) {
            if (!this._dpadHeld.has(direction)) this._channel?.press({ port: this._port, button: direction });
        }
        this._dpadHeld.clear();
        next.forEach((direction) => this._dpadHeld.add(direction));
        this._dpad.dataset.directions = [...next].sort().join(" ");
    }

    // METHOD :: VOID -> VOID
    // Releases all effective D-pad directions and pointer ownership.
    private _releaseDpad(): void {
        for (const direction of this._dpadHeld) {
            this._channel?.release({ port: this._port, button: direction });
        }
        this._dpadHeld.clear();
        this._dpadPointer = null;
        this._dpad.dataset.directions = "";
    }

    // METHOD :: stickName, pointerEvent -> VOID
    // Publishes clamped axes and visual displacement for one captured stick.
    private _updateStick(name: StickName, event: PointerEvent): void {
        const state = this._sticks[name];
        if (event.pointerId !== state.pointer) return;
        const value = stickValue(state.element.getBoundingClientRect(), event.clientX, event.clientY);
        const axes: readonly [PsxAxis, PsxAxis] = name === "left"
            ? ["left-x", "left-y"]
            : ["right-x", "right-y"];
        this._channel?.setAxis({ port: this._port, axis: axes[0] }, value.x);
        this._channel?.setAxis({ port: this._port, axis: axes[1] }, value.y);
        state.element.style.setProperty("--touch-stick-x", `${value.x * value.radius * .45}px`);
        state.element.style.setProperty("--touch-stick-y", `${value.y * value.radius * .45}px`);
    }

    // METHOD :: stickName -> VOID
    // Centers one stick and releases both axes.
    private _releaseStick(name: StickName): void {
        const state = this._sticks[name];
        state.pointer = null;
        const axes: readonly [PsxAxis, PsxAxis] = name === "left"
            ? ["left-x", "left-y"]
            : ["right-x", "right-y"];
        this._channel?.setAxis({ port: this._port, axis: axes[0] }, 0);
        this._channel?.setAxis({ port: this._port, axis: axes[1] }, 0);
        state.element.style.setProperty("--touch-stick-x", "0px");
        state.element.style.setProperty("--touch-stick-y", "0px");
    }

    // METHOD :: eventTarget, STRING, eventListener -> VOID
    // Installs one listener and records its exact cleanup operation.
    private _listen(target: EventTarget, type: string, listener: EventListener): void {
        target.addEventListener(type, listener, { passive: false });
        this._cleanup.push(() => target.removeEventListener(type, listener));
    }

    // METHOD :: VOID -> BOOLEAN
    // Reports whether a live channel may accept a new pointer.
    private _canInput(): boolean {
        return !this._destroyed && this._enabled && this._channel !== null
            && this._controllerType !== "none";
    }

    // METHOD :: VOID -> VOID
    // Reflects lifecycle, port and controller mode for CSS and accessibility.
    private _applyState(): void {
        this._root.dataset.active = String(this._enabled && this._channel !== null);
        this._root.dataset.port = String(this._port);
        this._root.dataset.controllerType = this._controllerType;
        this._root.setAttribute("aria-disabled", String(!this._enabled || this._channel === null));
    }

    // METHOD :: VOID -> VOID
    // Rejects mutations after terminal cleanup.
    private _assertLive(): void {
        if (this._destroyed) throw new Error("TouchController has been destroyed.");
    }
}

/**
 *
 *  Helper Functions
 *
 */

// HELPER :: htmlElement, STRING -> element
// Returns one required descendant or rejects an incomplete controller surface.
const queryRequired = <ElementType extends Element>(root: HTMLElement, selector: string): ElementType => {
    const value = root.querySelector<ElementType>(selector);
    if (value === null) throw new TypeError(`TouchController is missing ${selector}.`);
    return value;
};

// HELPER :: STRING? -> psxButton
// Validates one data-bound PlayStation digital control.
const buttonFrom = (value: string | undefined): PsxButton => {
    const buttons: ReadonlyArray<PsxButton> = [
        "up", "down", "left", "right", "triangle", "circle", "cross", "square",
        "l1", "r1", "l2", "r2", "start", "select", "l3", "r3",
    ];
    if (!buttons.includes(value as PsxButton)) throw new TypeError(`Invalid touch button: ${value ?? "missing"}.`);
    return value as PsxButton;
};

// HELPER :: domRect, NUMBER, NUMBER -> SET(direction)
// Maps one point over a square D-pad into zero, one or two adjacent directions.
const directionsFor = (rect: DOMRect, clientX: number, clientY: number): ReadonlySet<Direction> => {
    if (rect.width <= 0 || rect.height <= 0) return new Set();
    const x = (clientX - rect.left) / rect.width;
    const y = (clientY - rect.top) / rect.height;
    if (x < 0 || x >= 1 || y < 0 || y >= 1) return new Set();
    const directions = new Set<Direction>();
    if (x < 1 / 3) directions.add("left");
    if (x >= 2 / 3) directions.add("right");
    if (y < 1 / 3) directions.add("up");
    if (y >= 2 / 3) directions.add("down");
    return directions;
};

// HELPER :: domRect, NUMBER, NUMBER -> {x:NUMBER, y:NUMBER, radius:NUMBER}
// Normalizes and clamps one point to the unit circle of a virtual stick.
const stickValue = (
    rect: DOMRect,
    clientX: number,
    clientY: number,
): { readonly x: number; readonly y: number; readonly radius: number } => {
    const radius = Math.max(1, Math.min(rect.width, rect.height) / 2);
    let x = (clientX - (rect.left + rect.width / 2)) / radius;
    let y = (clientY - (rect.top + rect.height / 2)) / radius;
    const length = Math.hypot(x, y);
    if (length > 1) {
        x /= length;
        y /= length;
    }
    return { x, y, radius };
};

// HELPER :: htmlElement, NUMBER -> VOID
// Captures one pointer when supported without turning browser refusal into input failure.
const capturePointer = (element: HTMLElement, pointerId: number): void => {
    try { element.setPointerCapture(pointerId); } catch { /* pointer capture is best effort */ }
};
