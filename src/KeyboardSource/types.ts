// Dependencies:
import {
    isPsxAxisControl,      // Validates analog bindings
    isPsxButtonControl,    // Validates digital mappings
} from "../shared.types.js";
import { isPsxInputLike } from "../PsxInput/types.js";    // Validates the input coordinator boundary

// Type dependencies:
import type {
    PsxAxisControl,      // Port and analog-axis target
    PsxButtonControl,    // Port and digital-button target
} from "../shared.types.js";
import type { PsxInputLike } from "../PsxInput/types.js"; // Input surface receiving keyboard state

/**
 *
 * Type Declarations
 *
 */

// INTERFACE :: {code:STRING, preventDefault:(VOID -> VOID)}
// Minimal browser keyboard event consumed by mapped controls.
export interface KeyboardEventLike {
    readonly code: string;    // Layout-independent KeyboardEvent.code value
    preventDefault(): void;   // Suppresses browser behavior for owned keys
}

// INTERFACE :: keyboard, blur, and visibility listener operations
// Event target supplying key transitions and forced-release lifecycle events.
export interface KeyboardEventTargetLike {
    readonly visibilityState?: string;    // Current document visibility when available
    addEventListener(type: "keydown" | "keyup", listener: (event: KeyboardEventLike) => void): void;       // Installs one key listener
    addEventListener(type: "blur", listener: () => void): void;                                             // Installs focus-loss release
    addEventListener(type: "visibilitychange", listener: () => void): void;                                 // Installs visibility release
    removeEventListener(type: "keydown" | "keyup", listener: (event: KeyboardEventLike) => void): void;    // Removes one key listener
    removeEventListener(type: "blur", listener: () => void): void;                                          // Removes focus-loss release
    removeEventListener(type: "visibilitychange", listener: () => void): void;                              // Removes visibility release
}

// INTERFACE :: {visibilityState:STRING?, addEventListener:("visibilitychange", (VOID -> VOID) -> VOID), removeEventListener:("visibilitychange", (VOID -> VOID) -> VOID)}
// Optional separate visibility boundary used when the key target is not a document.
export interface KeyboardVisibilityTargetLike {
    readonly visibilityState?: string;                                                    // Current document visibility
    addEventListener(type: "visibilitychange", listener: () => void): void;              // Installs visibility release
    removeEventListener(type: "visibilitychange", listener: () => void): void;           // Removes visibility release
}

// INTERFACE :: {control:psxAxisControl, direction:-1|1}
// One key's target axis and full-scale direction.
export interface KeyboardAnalogBinding {
    readonly control: PsxAxisControl;    // Physical port and axis driven by the key
    readonly direction: -1 | 1;          // Negative or positive full-scale target
}

// INTERFACE :: {bindings:ARRAY<STRING, keyboardAnalogBinding>, rampPerTick:NUMBER?}
// Analog key bindings and deterministic per-frame ramp rate.
export interface KeyboardAnalogConfig {
    readonly bindings: Readonly<Record<string, KeyboardAnalogBinding>>; // KeyboardEvent.code to axis direction
    readonly rampPerTick?: number;                                      // Axis delta per core tick; defaults to 0.2
}

// TYPE :: ARRAY<STRING, psxButtonControl>
// KeyboardEvent.code values mapped to digital PSX controls.
export type KeyboardMap = Readonly<Record<string, PsxButtonControl>>;

// INTERFACE :: {input:psxInputLike, target:keyboardEventTargetLike, visibilityTarget:keyboardVisibilityTargetLike?, map:keyboardMap?, analog:keyboardAnalogConfig?}
// Dependencies and mappings for one keyboard input source.
export interface KeyboardSourceConfig {
    readonly input: PsxInputLike;                                   // Shared coordinator receiving an isolated channel
    readonly target: KeyboardEventTargetLike;                       // Key and focus event source
    readonly visibilityTarget?: KeyboardVisibilityTargetLike;      // Optional separate document visibility source
    readonly map?: KeyboardMap;                                     // Digital mapping; defaults to the built-in layout
    readonly analog?: KeyboardAnalogConfig;                         // Optional keyboard-driven analog emulation
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
// True when value supplies listener installation and removal operations.
const isTarget = (value: unknown): value is KeyboardEventTargetLike => isObject(value)
    && typeof value.addEventListener === "function" && typeof value.removeEventListener === "function";

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value maps non-empty key codes to valid digital controls.
export const isKeyboardMap = (value: unknown): value is KeyboardMap => isObject(value)
    && Object.entries(value).every(([code, control]) => code.length > 0 && isPsxButtonControl(control));

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value supplies valid analog bindings and an optional bounded ramp rate.
const isAnalog = (value: unknown): value is KeyboardAnalogConfig => {
    if (!isObject(value) || !isObject(value.bindings)) return false;
    if (value.rampPerTick !== undefined
        && (typeof value.rampPerTick !== "number" || !Number.isFinite(value.rampPerTick)
            || value.rampPerTick <= 0 || value.rampPerTick > 1)) return false;
    return Object.entries(value.bindings).every(([code, binding]) => code.length > 0
        && isObject(binding) && isPsxAxisControl(binding.control)
        && (binding.direction === -1 || binding.direction === 1));
};

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value supplies a coordinator, event boundaries, and valid optional mappings.
export function isKeyboardSourceConfig(value: unknown): value is KeyboardSourceConfig {
    return isObject(value) && isPsxInputLike(value.input) && isTarget(value.target)
        && (value.visibilityTarget === undefined || isTarget(value.visibilityTarget))
        && (value.map === undefined || isKeyboardMap(value.map))
        && (value.analog === undefined || isAnalog(value.analog));
}
