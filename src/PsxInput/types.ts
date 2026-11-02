// Dependencies:
import { isPsxSession } from "../shared.types.js";    // Validates the session supplied to the coordinator

// Type dependencies:
import type {
    Listener,            // Observer accepted by tick and rumble streams
    PsxAxisControl,      // Port and analog-axis coordinate
    PsxButtonControl,    // Port and digital-button coordinate
    PsxMachineInfo,      // Active session identity exposed through the input surface
    PsxRumbleEvent,      // Strong and weak motor output from the core
    PsxSession,          // Session receiving effective input state
    Unsubscribe,         // Cleanup returned by event subscriptions
} from "../shared.types.js";

/**
 *
 * Type Declarations
 *
 */

// INTERFACE :: {session:psxSession}
// Dependency required to create an input coordinator.
export interface PsxInputConfig {
    readonly session: PsxSession;    // Live session receiving controls and supplying events
}

// INTERFACE :: {press:(psxButtonControl -> VOID), release:(psxButtonControl -> VOID), setAxis:(psxAxisControl, NUMBER -> VOID), releaseAll:(VOID -> VOID), destroy:(VOID -> VOID)}
// Isolated ownership handle for one keyboard, gamepad, or direct input source.
export interface PsxInputChannel {
    press(control: PsxButtonControl): void;               // Acquires one digital control
    release(control: PsxButtonControl): void;             // Releases one digital control
    setAxis(control: PsxAxisControl, value: number): void; // Publishes one normalized analog value
    releaseAll(): void;                                   // Releases every control owned by this channel
    destroy(): void;                                      // Releases all state and closes the channel
}

// INTERFACE :: {machine:psxMachineInfo, createChannel:(VOID -> psxInputChannel), onTick:(listener -> unsubscribe), onRumble:(listener -> unsubscribe)}
// Input surface consumed by browser keyboard and gamepad sources.
export interface PsxInputLike {
    readonly machine: PsxMachineInfo;                              // Active machine timing and controller capabilities
    createChannel(): PsxInputChannel;                              // Creates one independently releasable ownership channel
    onTick(listener: Listener<void>): Unsubscribe;                 // Subscribes to completed emulation ticks
    onRumble(listener: Listener<PsxRumbleEvent>): Unsubscribe;     // Subscribes to controller motor output
}

/**
 *
 * Type Predicates
 *
 */

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value contains a structurally valid PSX session.
export function isPsxInputConfig(value: unknown): value is PsxInputConfig {
    return typeof value === "object" && value !== null
        && isPsxSession((value as { session?: unknown }).session);
}

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value exposes every isolated input-channel operation.
export function isPsxInputChannel(value: unknown): value is PsxInputChannel {
    if (typeof value !== "object" || value === null) return false;
    const channel = value as Partial<PsxInputChannel>;
    return typeof channel.press === "function" && typeof channel.release === "function"
        && typeof channel.setAxis === "function" && typeof channel.releaseAll === "function"
        && typeof channel.destroy === "function";
}

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value exposes machine metadata, channel creation, tick events, and rumble events.
export function isPsxInputLike(value: unknown): value is PsxInputLike {
    if (typeof value !== "object" || value === null) return false;
    const input = value as Partial<PsxInputLike>;
    return typeof input.machine === "object" && input.machine !== null
        && typeof input.createChannel === "function" && typeof input.onTick === "function"
        && typeof input.onRumble === "function";
}
