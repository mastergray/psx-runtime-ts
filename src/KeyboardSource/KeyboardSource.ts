// Dependencies:
import PsxRuntimeError from "../PsxRuntimeError/PsxRuntimeError.js";    // Reports invalid configuration and destroyed lifecycle use
import { isKeyboardSourceConfig } from "./types.js";                   // Validates targets, maps, and analog settings

// Type dependencies:
import type {
    PsxAxisControl,        // Analog axis target produced by keyboard emulation
    PsxButtonControl,      // Digital control target produced by a mapped key
    Unsubscribe,           // Tick-listener cleanup retained while attached
} from "../shared.types.js";
import type {
    KeyboardAnalogBinding,     // Axis direction associated with one key code
    KeyboardEventLike,         // Minimal key event consumed by the source
    KeyboardMap,               // Key-code-to-digital-control mapping
    KeyboardSourceConfig,      // Injected input, target, mapping, and ramp configuration
} from "./types.js";

export const DEFAULT_KEYBOARD_MAP: KeyboardMap = Object.freeze({        // Built-in port-one desktop keyboard layout
    ArrowUp: frozenControl(1, "up"),
    ArrowDown: frozenControl(1, "down"),
    ArrowLeft: frozenControl(1, "left"),
    ArrowRight: frozenControl(1, "right"),
    KeyZ: frozenControl(1, "cross"),
    KeyX: frozenControl(1, "circle"),
    KeyA: frozenControl(1, "square"),
    KeyS: frozenControl(1, "triangle"),
    KeyQ: frozenControl(1, "l1"),
    KeyW: frozenControl(1, "r1"),
    Digit1: frozenControl(1, "l2"),
    Digit2: frozenControl(1, "r2"),
    Enter: frozenControl(1, "start"),
    ShiftRight: frozenControl(1, "select"),
});

/**
 *
 * Type Declarations
 *
 */

// TYPE :: keyboardAnalogBinding & {sequence:NUMBER}
// Held analog key annotated for deterministic last-input ownership.
interface HeldAnalog extends KeyboardAnalogBinding {
    readonly sequence: number;        // Monotonic press order used to select the effective direction
}

/**
 *
 * Class
 *
 */

// Converts mapped browser keyboard events into one isolated PSX input channel.
export default class KeyboardSource {

    /* Instance Fields */
    private readonly _input: KeyboardSourceConfig["input"];               // Shared input aggregator receiving this source channel
    private readonly _target: KeyboardSourceConfig["target"];             // Event target supplying key and blur events
    private readonly _visibilityTarget: NonNullable<KeyboardSourceConfig["visibilityTarget"]>; // Visibility source used for forced release
    private readonly _map: KeyboardMap;                                    // Digital mapping keyed by KeyboardEvent.code
    private readonly _analog: Readonly<Record<string, KeyboardAnalogBinding>>; // Optional analog bindings keyed by code
    private readonly _ramp: number;                                        // Axis delta applied on every core tick
    private readonly _channel;                                             // Isolated ownership channel in the shared input aggregator
    private readonly _pressed = new Set<string>();                         // Mapped key codes currently held
    private readonly _analogHeld = new Map<string, HeldAnalog>();          // Held analog bindings with ownership order
    private readonly _axisValues = new Map<string, { control: PsxAxisControl; value: number }>(); // Current emulated axes
    private _sequence = 0;                                                 // Monotonic analog press sequence
    private _unsubscribeTick: Unsubscribe | null = null;                   // Tick-listener cleanup while attached
    private _attached = false;                                             // Whether browser listeners are installed
    private _enabled = true;                                               // Whether mapped events may reach the channel
    private _destroyed = false;                                            // Whether lifecycle ownership has ended
    private readonly _keydown = (event: KeyboardEventLike): void => this._key(event, true);  // Stable keydown listener
    private readonly _keyup = (event: KeyboardEventLike): void => this._key(event, false);   // Stable keyup listener
    private readonly _blur = (): void => this._releaseHeld();                              // Releases held input on focus loss
    private readonly _visibility = (): void => {                                            // Releases held input when the page hides
        if (this._visibilityTarget.visibilityState === undefined
            || this._visibilityTarget.visibilityState === "hidden") this._releaseHeld();
    };

    // CONSTRUCTOR :: keyboardSourceConfig -> keyboardSource
    // Validates the source configuration and creates its isolated input channel.
    constructor(config: KeyboardSourceConfig) {
        if (!isKeyboardSourceConfig(config)) throw invalid("KeyboardSource config is invalid.", config);
        this._input = config.input;
        this._target = config.target;
        this._visibilityTarget = config.visibilityTarget ?? config.target;
        this._map = config.map ?? DEFAULT_KEYBOARD_MAP;
        this._analog = config.analog?.bindings ?? {};
        this._ramp = config.analog?.rampPerTick ?? 0.125;
        this._channel = this._input.createChannel();
    }

    /**
     *
     * Properties
     *
     */

    // GETTER :: VOID -> BOOLEAN
    // Reports whether browser listeners are attached.
    get isAttached(): boolean {
        return this._attached;
    }

    // GETTER :: VOID -> BOOLEAN
    // Reports whether mapped events are currently forwarded.
    get enabled(): boolean {
        return this._enabled;
    }

    // SETTER :: BOOLEAN -> VOID
    // Enables or disables forwarding and releases held input when disabled.
    set enabled(value: boolean) {
        this._assertLive();
        if (typeof value !== "boolean") throw invalid("KeyboardSource enabled must be boolean.", value);
        if (value === this._enabled) return;
        this._enabled = value;
        if (!value) this._releaseHeld();
    }

    /**
     *
     * Instance Methods
     *
     */

    // METHOD :: VOID -> VOID
    // Installs browser listeners and the core-tick analog ramp.
    attach(): void {
        this._assertLive();
        if (this._attached) return;
        this._target.addEventListener("keydown", this._keydown);
        this._target.addEventListener("keyup", this._keyup);
        this._target.addEventListener("blur", this._blur);
        this._visibilityTarget.addEventListener("visibilitychange", this._visibility);
        this._unsubscribeTick = this._input.onTick(() => this._tick());
        this._attached = true;
    }

    // METHOD :: VOID -> VOID
    // Removes browser listeners and releases every held control.
    detach(): void {
        if (!this._attached) return;
        this._target.removeEventListener("keydown", this._keydown);
        this._target.removeEventListener("keyup", this._keyup);
        this._target.removeEventListener("blur", this._blur);
        this._visibilityTarget.removeEventListener("visibilitychange", this._visibility);
        this._unsubscribeTick?.();
        this._unsubscribeTick = null;
        this._attached = false;
        this._releaseHeld();
    }

    // METHOD :: VOID -> VOID
    // Detaches, destroys the channel, and permanently ends ownership.
    destroy(): void {
        if (this._destroyed) return;
        this.detach();
        this._channel.destroy();
        this._destroyed = true;
    }

    /**
     *
     * Private Methods
     *
     */

    // METHOD :: keyboardEventLike, BOOLEAN -> VOID
    // Applies one mapped key transition to digital and analog state.
    private _key(event: KeyboardEventLike, pressed: boolean): void {
        if (!this._attached || !this._enabled) return;
        const digital = this._map[event.code];
        const analog = this._analog[event.code];
        if (digital === undefined && analog === undefined) return;
        event.preventDefault();
        if (pressed) {
            if (this._pressed.has(event.code)) return;
            this._pressed.add(event.code);
            if (digital !== undefined) this._channel.press(digital);
            if (analog !== undefined) this._analogHeld.set(event.code, { ...analog, sequence: ++this._sequence });
        } else {
            if (!this._pressed.delete(event.code)) return;
            if (digital !== undefined) this._channel.release(digital);
            if (analog !== undefined) this._analogHeld.delete(event.code);
        }
    }

    // METHOD :: VOID -> VOID
    // Advances every emulated axis by one deterministic core tick.
    private _tick(): void {
        if (!this._attached || !this._enabled) return;
        const keys = new Set<string>([
            ...this._axisValues.keys(),
            ...[...this._analogHeld.values()].map(({ control }) => axisKey(control)),
        ]);
        for (const key of [...keys].sort()) {
            const held = [...this._analogHeld.values()]
                .filter(({ control }) => axisKey(control) === key)
                .sort((left, right) => right.sequence - left.sequence)[0];
            const previous = this._axisValues.get(key);
            const control = held?.control ?? previous?.control;
            if (control === undefined) continue;
            const target = held?.direction ?? 0;
            const current = previous?.value ?? 0;
            const value = current < target
                ? Math.min(target, current + this._ramp)
                : Math.max(target, current - this._ramp);
            if (value !== current) this._channel.setAxis(control, value);
            if (value === 0 && target === 0) this._axisValues.delete(key);
            else this._axisValues.set(key, { control, value });
        }
    }

    // METHOD :: VOID -> VOID
    // Clears local ownership and releases the complete input channel.
    private _releaseHeld(): void {
        this._pressed.clear();
        this._analogHeld.clear();
        this._axisValues.clear();
        this._channel.releaseAll();
    }

    // METHOD :: VOID -> VOID
    // Rejects operations after destruction.
    private _assertLive(): void {
        if (this._destroyed) throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.DESTROYED,
            message: "KeyboardSource has been destroyed.",
        });
    }
}

/**
 *
 *  Helper Functions
 *
 */

// HELPER :: NUMBER, psxButton -> psxButtonControl
// Creates one immutable default digital control.
function frozenControl(port: 1 | 2, button: PsxButtonControl["button"]): PsxButtonControl {
    return Object.freeze({ port, button });
}

// HELPER :: STRING, UNKNOWN -> psxRuntimeError
// Creates one invalid-configuration error.
const invalid = (message: string, data: unknown): PsxRuntimeError => new PsxRuntimeError({
    code: PsxRuntimeError.CODE.INVALID_CONFIG,
    message,
    data,
});

// HELPER :: psxAxisControl -> STRING
// Produces the canonical ownership key for one controller axis.
const axisKey = ({ port, axis }: PsxAxisControl): string => `${port}:${axis}`;
