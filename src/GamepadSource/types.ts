// Dependencies:
import {
    isFrameScheduler,    // Validates the animation-frame scheduling boundary
    isPsxAxis,           // Validates per-axis inversion keys
    isPsxButton,         // Validates remapped digital button keys
} from "../shared.types.js";
import { isPsxInputLike } from "../PsxInput/types.js";    // Validates the input coordinator boundary

// Type dependencies:
import type {
    ControllerPort,    // Physical PSX controller port
    FrameScheduler,    // Animation-frame scheduling boundary
    PsxAxis,           // Closed set of DualShock axes
    PsxButton,         // Closed set of PSX digital buttons
} from "../shared.types.js";
import type { PsxInputLike } from "../PsxInput/types.js";  // Input surface receiving gamepad state

/**
 *
 * Type Declarations
 *
 */

// INTERFACE :: {pressed:BOOLEAN, value:NUMBER}
// Minimal browser gamepad button state consumed during polling.
export interface GamepadButtonLike {
    readonly pressed: boolean;    // Browser digital pressed flag
    readonly value: number;       // Analog magnitude used for trigger thresholds
}

// INTERFACE :: {playEffect:("dual-rumble", {duration:NUMBER, strongMagnitude:NUMBER, weakMagnitude:NUMBER} -> PROMISE(UNKNOWN)), reset:(VOID -> PROMISE(UNKNOWN))?}
// Minimal dual-rumble actuator surface used for feedback and disconnect cleanup.
export interface GamepadHapticActuatorLike {
    playEffect(type: "dual-rumble", parameters: {
        readonly duration: number;
        readonly strongMagnitude: number;
        readonly weakMagnitude: number;
    }): Promise<unknown>;          // Starts one bounded strong and weak motor effect
    reset?(): Promise<unknown>;    // Stops active effects when supported
}

// INTERFACE :: {id:STRING, index:NUMBER, connected:BOOLEAN, mapping:STRING, axes:[NUMBER], buttons:[gamepadButtonLike], vibrationActuator:gamepadHapticActuatorLike?}
// Standard-layout browser gamepad snapshot sampled by the source.
export interface GamepadLike {
    readonly id: string;                                              // Stable browser device identity used for remapping
    readonly index: number;                                           // Browser Gamepad API slot
    readonly connected: boolean;                                      // Whether the device remains available
    readonly mapping: string;                                         // Required standard-layout identifier
    readonly axes: ReadonlyArray<number>;                              // Raw analog axis values
    readonly buttons: ReadonlyArray<GamepadButtonLike>;                // Raw digital and trigger button values
    readonly vibrationActuator?: GamepadHapticActuatorLike | null;     // Optional dual-rumble output
}

// INTERFACE :: {getGamepads:(VOID -> [gamepadLike?])}
// Injectable browser gamepad snapshot provider.
export interface GamepadProviderLike {
    getGamepads(): ReadonlyArray<GamepadLike | null>;    // Returns current devices indexed by browser slot
}

// INTERFACE :: {visibilityState:STRING?, addEventListener:(STRING, (VOID -> VOID) -> VOID), removeEventListener:(STRING, (VOID -> VOID) -> VOID)}
// Focus and visibility event target used to force control release.
export interface GamepadEventTargetLike {
    readonly visibilityState?: string;                                                     // Current document visibility when available
    addEventListener(type: "blur" | "visibilitychange", listener: () => void): void;      // Installs one release trigger
    removeEventListener(type: "blur" | "visibilitychange", listener: () => void): void;   // Removes one release trigger
}

// TYPE :: ARRAY<psxButton, NUMBER|NULL>
// Partial digital layout override; NULL deliberately leaves one PSX button unbound.
export type GamepadButtonMap = Readonly<Partial<Record<PsxButton, number | null>>>;

// TYPE :: ARRAY<STRING, gamepadButtonMap>
// Device-ID-keyed digital mappings retained across browser sessions.
export type GamepadButtonMaps = Readonly<Record<string, GamepadButtonMap>>;

// INTERFACE :: {input:psxInputLike, provider:gamepadProviderLike, scheduler:frameScheduler, target:gamepadEventTargetLike, assignments:ARRAY<NUMBER, controllerPort>, deadZone:NUMBER?, triggerThreshold:NUMBER?, invertAxes:ARRAY<psxAxis, BOOLEAN>?, buttonMaps:gamepadButtonMaps?, rumble:BOOLEAN?}
// Dependencies and options for one polling gamepad source.
export interface GamepadSourceConfig {
    readonly input: PsxInputLike;                                     // Shared coordinator receiving isolated player channels
    readonly provider: GamepadProviderLike;                           // Device snapshots sampled every animation frame
    readonly scheduler: FrameScheduler;                               // Polling scheduler
    readonly target: GamepadEventTargetLike;                          // Focus and visibility release boundary
    readonly assignments: Readonly<Record<number, ControllerPort>>;   // Browser index to unique PSX port mapping
    readonly deadZone?: number;                                       // Ignored analog center magnitude; defaults to 0.2
    readonly triggerThreshold?: number;                               // Analog trigger press threshold; defaults to 0.5
    readonly invertAxes?: Readonly<Partial<Record<PsxAxis, boolean>>>; // Optional per-axis direction inversion
    readonly buttonMaps?: GamepadButtonMaps;                           // Optional device-specific digital mappings
    readonly rumble?: boolean;                                        // Whether core rumble reaches browser actuators
}

/**
 *
 * Type Predicates
 *
 */

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value is a non-null object suitable for structural inspection.
const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null;

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value is finite and in the inclusive-zero, exclusive-one range.
const inUnitRange = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 && value < 1;

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value maps known PSX buttons to non-negative indices or explicit NULL bindings.
export const isGamepadButtonMap = (value: unknown): value is GamepadButtonMap => isObject(value)
    && Object.entries(value).every(([button, index]) => isPsxButton(button)
        && (index === null || (typeof index === "number" && Number.isSafeInteger(index) && index >= 0)));

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value maps non-empty browser device identities to valid digital mappings.
export const isGamepadButtonMaps = (value: unknown): value is GamepadButtonMaps => isObject(value)
    && Object.entries(value).every(([id, map]) => id.trim().length > 0 && isGamepadButtonMap(map));

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value supplies valid polling boundaries, unique port assignments, and bounded options.
export function isGamepadSourceConfig(value: unknown): value is GamepadSourceConfig {
    if (!isObject(value) || !isPsxInputLike(value.input) || !isObject(value.provider)
        || typeof value.provider.getGamepads !== "function" || !isFrameScheduler(value.scheduler)
        || !isObject(value.target) || typeof value.target.addEventListener !== "function"
        || typeof value.target.removeEventListener !== "function" || !isObject(value.assignments)
        || (value.deadZone !== undefined && !inUnitRange(value.deadZone))
        || (value.triggerThreshold !== undefined && !inUnitRange(value.triggerThreshold))
        || (value.buttonMaps !== undefined && !isGamepadButtonMaps(value.buttonMaps))
        || (value.rumble !== undefined && typeof value.rumble !== "boolean")) return false;
    const ports = new Set<number>();
    for (const [index, port] of Object.entries(value.assignments)) {
        if (!/^\d+$/u.test(index) || (port !== 1 && port !== 2) || ports.has(port)) return false;
        ports.add(port);
    }
    return ports.size > 0 && (value.invertAxes === undefined || (isObject(value.invertAxes)
        && Object.entries(value.invertAxes).every(([axis, invert]) => isPsxAxis(axis)
            && typeof invert === "boolean")));
}
