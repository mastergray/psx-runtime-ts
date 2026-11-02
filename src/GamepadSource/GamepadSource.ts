// Dependencies:
import PsxRuntimeError from "../PsxRuntimeError/PsxRuntimeError.js";    // Reports invalid configuration and destroyed lifecycle use
import { isGamepadSourceConfig } from "./types.js";                    // Validates assignments, provider, scheduler, and mapping options

// Type dependencies:
import type {
    ControllerPort,      // Physical PSX port receiving one assigned browser pad
    PsxAxis,             // Closed set of DualShock analog axes
    PsxAxisControl,      // Axis event forwarded to the input aggregator
    PsxButton,           // Closed set of digital PSX buttons
    PsxButtonControl,    // Digital event forwarded to the input aggregator
    PsxRumbleEvent,      // Strong and weak motor command from the core
    Unsubscribe,         // Cleanup returned by the rumble listener
} from "../shared.types.js";
import type {
    GamepadButtonMaps,       // Per-device digital overrides applied during polling
    GamepadLike,             // Minimal standard-layout browser gamepad snapshot
    GamepadSourceConfig,     // Injected input, provider, scheduler, and assignments
} from "./types.js";

/**
 *
 * Type Declarations
 *
 */

// TYPE :: {index:NUMBER, port:controllerPort, channel:psxInputChannel, active:map, axes:map, pad:gamepadLike?}
// Runtime state for one browser-index-to-controller-port assignment.
interface Assignment {
    readonly index: number;                                                      // Browser Gamepad API index to poll
    readonly port: ControllerPort;                                               // PSX port receiving this device
    readonly channel: ReturnType<GamepadSourceConfig["input"]["createChannel"]>; // Isolated ownership channel
    readonly active: Map<string, PsxButtonControl>;                              // Digital controls held on the previous poll
    readonly axes: Map<PsxAxis, number>;                                         // Last forwarded value for each analog axis
    pad: GamepadLike | null;                                                     // Connected device used for rumble and disconnect release
}

const BUTTONS: ReadonlyArray<readonly [number, PsxButton]> = [    // Standard-layout indices for PSX digital controls
    [0, "cross"], [1, "circle"], [2, "square"], [3, "triangle"],
    [4, "l1"], [5, "r1"], [6, "l2"], [7, "r2"],
    [8, "select"], [9, "start"], [10, "l3"], [11, "r3"],
    [12, "up"], [13, "down"], [14, "left"], [15, "right"],
];

export const DEFAULT_GAMEPAD_BUTTON_MAP: Readonly<Record<PsxButton, number>> = Object.freeze( // Public standard digital layout
    Object.fromEntries(BUTTONS.map(([index, button]) => [button, index])) as Record<PsxButton, number>,
);

const AXES: ReadonlyArray<readonly [number, PsxAxis]> = [         // Standard-layout indices for DualShock axes
    [0, "left-x"], [1, "left-y"], [2, "right-x"], [3, "right-y"],
];

// METHOD :: UNKNOWN -> psxRuntimeError
// Creates one invalid gamepad-source configuration error.
const invalid = (data: unknown): PsxRuntimeError => new PsxRuntimeError({
    code: PsxRuntimeError.CODE.INVALID_CONFIG,
    message: "GamepadSource config is invalid.",
    data,
});

// METHOD :: gamepadLike, NUMBER, NUMBER -> BOOLEAN
// Applies digital and trigger thresholds to one physical button.
const buttonDown = (pad: GamepadLike, index: number, triggerThreshold: number): boolean => {
    const button = pad.buttons[index];
    if (button === undefined) return false;
    return button.pressed || button.value >= (index === 6 || index === 7 ? triggerThreshold : 0.5);
};

// METHOD :: NUMBER, NUMBER -> NUMBER
// Clamps and rescales one raw axis outside the configured dead zone.
const normalizedAxis = (value: number, deadZone: number): number => {
    if (!Number.isFinite(value)) return 0;
    const clamped = Math.max(-1, Math.min(1, value));
    const magnitude = Math.abs(clamped);
    if (magnitude <= deadZone) return 0;
    return Math.sign(clamped) * (magnitude - deadZone) / (1 - deadZone);
};

/**
 *
 * Class
 *
 */

// Polls assigned standard gamepads into isolated PSX input channels and rumble feedback.
export default class GamepadSource {

    /* Instance Fields */
    private readonly _input: GamepadSourceConfig["input"];                         // Shared input aggregator receiving pad channels
    private readonly _provider: GamepadSourceConfig["provider"];                   // Injectable Gamepad API snapshot provider
    private readonly _scheduler: GamepadSourceConfig["scheduler"];                 // Animation-frame scheduling boundary
    private readonly _target: GamepadSourceConfig["target"];                       // Blur and visibility event target
    private readonly _deadZone: number;                                             // Center magnitude ignored for every axis
    private readonly _triggerThreshold: number;                                     // Analog trigger value considered pressed
    private readonly _invertAxes: NonNullable<GamepadSourceConfig["invertAxes"]>;   // Per-axis inversion flags
    private readonly _buttonMaps: GamepadButtonMaps;                                // Device-ID-keyed digital overrides
    private readonly _rumbleEnabled: boolean;                                       // Whether core rumble may reach actuators
    private readonly _assignments: Assignment[];                                    // Stable browser-index-to-port state
    private _frameHandle: number | null = null;                                     // Scheduled poll handle
    private _unsubscribeRumble: Unsubscribe | null = null;                          // Core-rumble listener cleanup
    private _attached = false;                                                       // Whether event listeners and polling are active
    private _enabled = true;                                                         // Whether connected pads may forward input
    private _destroyed = false;                                                      // Whether lifecycle ownership has ended
    private readonly _frame = (): void => {                                          // Stable scheduled polling callback
        this._frameHandle = null;
        if (!this._attached || !this._enabled || this._destroyed) return;
        this._poll();
        this._schedule();
    };
    private readonly _blur = (): void => this._releaseAll();                        // Releases all controls on focus loss
    private readonly _visibility = (): void => {                                     // Releases all controls when the page hides
        if (this._target.visibilityState === undefined || this._target.visibilityState === "hidden") this._releaseAll();
    };

    // CONSTRUCTOR :: gamepadSourceConfig -> gamepadSource
    // Validates configuration and creates one isolated channel per assigned port.
    constructor(config: GamepadSourceConfig) {
        if (!isGamepadSourceConfig(config)) throw invalid(config);
        this._input = config.input;
        this._provider = config.provider;
        this._scheduler = config.scheduler;
        this._target = config.target;
        this._deadZone = config.deadZone ?? 0.2;
        this._triggerThreshold = config.triggerThreshold ?? 0.5;
        this._invertAxes = config.invertAxes ?? {};
        this._buttonMaps = config.buttonMaps ?? {};
        this._rumbleEnabled = config.rumble ?? true;
        this._assignments = Object.entries(config.assignments)
            .map(([index, port]) => ({
                index: Number(index),
                port,
                channel: this._input.createChannel(),
                active: new Map(),
                axes: new Map(),
                pad: null,
            }))
            .sort((left, right) => left.port - right.port);
    }

    /**
     *
     * Properties
     *
     */

    // GETTER :: VOID -> BOOLEAN
    // Reports whether event listeners and polling are attached.
    get isAttached(): boolean {
        return this._attached;
    }

    // GETTER :: VOID -> BOOLEAN
    // Reports whether connected pads are currently forwarded.
    get enabled(): boolean {
        return this._enabled;
    }

    // SETTER :: BOOLEAN -> VOID
    // Enables polling or cancels it and releases all controls.
    set enabled(value: boolean) {
        this._assertLive();
        if (typeof value !== "boolean") throw invalid(value);
        if (value === this._enabled) return;
        this._enabled = value;
        if (value) {
            if (this._attached) this._schedule();
        } else {
            this._cancel();
            this._releaseAll();
        }
    }

    // GETTER :: VOID -> [{index:NUMBER, port:controllerPort, id:STRING?}]
    // Returns immutable assignment and current device identity snapshots.
    get players(): ReadonlyArray<{ readonly index: number; readonly port: ControllerPort; readonly id: string | null }> {
        return Object.freeze(this._assignments.map(({ index, port, pad }) =>
            Object.freeze({ index, port, id: pad?.id ?? null })));
    }

    /**
     *
     * Instance Methods
     *
     */

    // METHOD :: VOID -> VOID
    // Installs lifecycle listeners, rumble forwarding, and polling.
    attach(): void {
        this._assertLive();
        if (this._attached) return;
        this._target.addEventListener("blur", this._blur);
        this._target.addEventListener("visibilitychange", this._visibility);
        this._unsubscribeRumble = this._input.onRumble((event) => this._rumble(event));
        this._attached = true;
        if (this._enabled) this._schedule();
    }

    // METHOD :: VOID -> VOID
    // Removes listeners, cancels polling, and releases all controls.
    detach(): void {
        if (!this._attached) return;
        this._cancel();
        this._target.removeEventListener("blur", this._blur);
        this._target.removeEventListener("visibilitychange", this._visibility);
        this._unsubscribeRumble?.();
        this._unsubscribeRumble = null;
        this._attached = false;
        this._releaseAll();
    }

    // METHOD :: VOID -> VOID
    // Detaches, destroys every channel, and permanently ends ownership.
    destroy(): void {
        if (this._destroyed) return;
        this.detach();
        this._assignments.forEach(({ channel }) => channel.destroy());
        this._destroyed = true;
    }

    /**
     *
     * Private Methods
     *
     */

    // METHOD :: VOID -> VOID
    // Requests one poll when attachment and lifecycle state permit it.
    private _schedule(): void {
        if (this._frameHandle !== null || !this._attached || !this._enabled || this._destroyed) return;
        this._frameHandle = this._scheduler.request(this._frame);
    }

    // METHOD :: VOID -> VOID
    // Cancels the outstanding poll callback.
    private _cancel(): void {
        if (this._frameHandle === null) return;
        this._scheduler.cancel(this._frameHandle);
        this._frameHandle = null;
    }

    // METHOD :: VOID -> VOID
    // Samples every assignment and handles connect or disconnect transitions.
    private _poll(): void {
        const pads = this._provider.getGamepads();
        for (const assignment of this._assignments) {
            const pad = pads[assignment.index];
            if (pad === null || pad === undefined || !pad.connected || pad.mapping !== "standard") {
                if (assignment.pad !== null) this._release(assignment);
                continue;
            }
            assignment.pad = pad;
            this._forwardButtons(assignment, pad);
            this._forwardAxes(assignment, pad);
        }
    }

    // METHOD :: assignment, gamepadLike -> VOID
    // Diffs mapped digital controls against the previous poll.
    private _forwardButtons(assignment: Assignment, pad: GamepadLike): void {
        const next = new Map<string, PsxButtonControl>();
        const buttonMap = Object.hasOwn(this._buttonMaps, pad.id) ? this._buttonMaps[pad.id] : undefined;
        for (const [defaultIndex, button] of BUTTONS) {
            const index = buttonMap?.[button] === undefined ? defaultIndex : buttonMap[button];
            if (index === null || index === undefined) continue;
            if (!buttonDown(pad, index, this._triggerThreshold)) continue;
            const control = { port: assignment.port, button } as const;
            next.set(button, control);
            if (!assignment.active.has(button)) assignment.channel.press(control);
        }
        for (const [button, control] of assignment.active) {
            if (!next.has(button)) assignment.channel.release(control);
        }
        assignment.active.clear();
        next.forEach((control, key) => assignment.active.set(key, control));
    }

    // METHOD :: assignment, gamepadLike -> VOID
    // Normalizes and forwards changed standard-layout axes.
    private _forwardAxes(assignment: Assignment, pad: GamepadLike): void {
        for (const [index, axis] of AXES) {
            let value = normalizedAxis(pad.axes[index] ?? 0, this._deadZone);
            if (this._invertAxes[axis] === true) value = -value;
            const previous = assignment.axes.get(axis);
            if ((previous === undefined && value === 0) || previous === value) continue;
            const control: PsxAxisControl = { port: assignment.port, axis };
            assignment.channel.setAxis(control, value);
            assignment.axes.set(axis, value);
        }
    }

    // METHOD :: assignment -> VOID
    // Stops rumble and releases all state owned by one assignment.
    private _release(assignment: Assignment): void {
        this._stopRumble(assignment.pad);
        assignment.channel.releaseAll();
        assignment.active.clear();
        assignment.axes.clear();
        assignment.pad = null;
    }

    // METHOD :: VOID -> VOID
    // Releases every assignment.
    private _releaseAll(): void {
        this._assignments.forEach((assignment) => this._release(assignment));
    }

    // METHOD :: psxRumbleEvent -> VOID
    // Forwards one core rumble event to the matching connected actuator.
    private _rumble(event: PsxRumbleEvent): void {
        if (!this._rumbleEnabled || !this._attached || !this._enabled) return;
        const pad = this._assignments.find(({ port }) => port === event.port)?.pad;
        const actuator = pad?.vibrationActuator;
        if (actuator === undefined || actuator === null) return;
        void actuator.playEffect("dual-rumble", {
            duration: 100,
            strongMagnitude: event.strong,
            weakMagnitude: event.weak,
        }).catch(() => undefined);
    }

    // METHOD :: gamepadLike? -> VOID
    // Stops any actuator effect for one disconnecting or released device.
    private _stopRumble(pad: GamepadLike | null): void {
        const reset = pad?.vibrationActuator?.reset;
        if (reset !== undefined) void reset.call(pad?.vibrationActuator).catch(() => undefined);
    }

    // METHOD :: VOID -> VOID
    // Rejects operations after destruction.
    private _assertLive(): void {
        if (this._destroyed) throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.DESTROYED,
            message: "GamepadSource has been destroyed.",
        });
    }
}
