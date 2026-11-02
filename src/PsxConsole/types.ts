// Dependencies:
import { isPsxAdapter } from "../shared.types.js";                         // Validates the backend adapter supplied to init()
import {
    isPsxCanvasLike,       // Validates the display canvas boundary
    isPsxContainerLike,    // Validates the display container boundary
} from "../PsxDisplay/types.js";
import { isPsxGestureSourceLike } from "../PsxAudio/types.js";            // Validates the audio authorization event source
import { isGamepadSourceConfig } from "../GamepadSource/types.js";        // Validates gamepad dependencies after input injection
import { isKeyboardSourceConfig } from "../KeyboardSource/types.js";      // Validates keyboard dependencies after input injection
import {
    isPsxPlayerIntervalSchedulerLike,    // Validates optional card autosave timing
    isPsxPlayerStatus,                   // Validates composed player lifecycle state
    isPsxPlayerStorageLike,              // Validates optional cards and states persistence
} from "../PsxPlayer/types.js";

// Type dependencies:
import type {
    DiscSet,          // Normalized game content imported or loaded by the console
    PsxAdapter,       // Backend adapter used by the high-level factory
    PsxStartConfig,   // Complete player startup input
    Unsubscribe,      // Cleanup returned by player status observation
} from "../shared.types.js";
import type {
    PsxCanvasLike,       // Canvas presentation boundary
    PsxContainerLike,    // Responsive layout boundary
} from "../PsxDisplay/types.js";
import type { PsxGestureSourceLike } from "../PsxAudio/types.js";     // Event source used to authorize audio
import type { GamepadSourceConfig } from "../GamepadSource/types.js"; // Gamepad options before input and assignments are injected
import type { KeyboardSourceConfig } from "../KeyboardSource/types.js"; // Keyboard options before input is injected
import type { PsxInputLike } from "../PsxInput/types.js";             // Active player input exposed to browser sources
import type {
    PsxPlayerConfig,         // Player persistence and scheduler configuration shapes
    PsxPlayerStatus,         // Closed player lifecycle state
    PsxPlayerStorageLike,    // Cards and states persistence boundary
} from "../PsxPlayer/types.js";

/**
 *
 * Type Declarations
 *
 */

// INTERFACE :: blob & {name:STRING, webkitRelativePath:STRING?}
// Browser-selected file with optional directory-relative path metadata.
export interface PsxLocalFileLike extends Blob {
    readonly name: string;                   // Selected basename
    readonly webkitRelativePath?: string;    // Browser-provided directory-relative path
}

// INTERFACE :: {length:NUMBER, [NUMBER]:psxLocalFileLike, item:(NUMBER -> psxLocalFileLike?)?}
// Array-like browser file selection accepted without requiring the DOM FileList type.
export interface PsxFileListLike {
    readonly length: number;                                 // Number of selected files
    readonly [index: number]: PsxLocalFileLike;               // Indexed selected file
    item?(index: number): PsxLocalFileLike | null;            // Optional FileList-compatible lookup
}

// INTERFACE :: {gameId:STRING, entry:STRING?}
// Caller identity and optional explicit descriptor for a local selection.
export interface PsxLocalFilesConfig {
    readonly gameId: string;    // Non-empty display identity used before content addressing
    readonly entry?: string;    // Explicit CUE or M3U path when inference is ambiguous
}

// INTERFACE :: {status:psxPlayerStatus, input:psxInputLike?, start:(psxStartConfig -> PROMISE(VOID)), stop:(VOID -> PROMISE(VOID)), destroy:(VOID -> PROMISE(VOID)), on:("status", listener -> unsubscribe)}
// Player lifecycle surface composed by the browser console.
export interface PsxConsolePlayerLike {
    readonly status: PsxPlayerStatus;                                        // Current player lifecycle state
    readonly input: PsxInputLike | null;                                     // Active session input when running
    start(config: PsxStartConfig): Promise<void>;                            // Starts one session
    stop(): Promise<void>;                                                   // Stops the active session
    destroy(): Promise<void>;                                                // Ends player ownership
    on(type: "status", listener: (status: PsxPlayerStatus) => void): Unsubscribe; // Observes lifecycle changes
}

// INTERFACE :: {import:(discSet, {displayTitle:STRING?}? -> PROMISE({gameId:STRING})), get:(STRING -> PROMISE(discSet?))}
// Persistent game-library surface used by console import and startup flows.
export interface PsxConsoleGameStoreLike {
    import(game: DiscSet, options?: { readonly displayTitle?: string }): Promise<{ readonly gameId: string }>; // Audits and persists content
    get(gameId: string): Promise<DiscSet | null>;                                                                  // Loads content by stored identity
}

// INTERFACE :: {player:psxConsolePlayerLike, keyboard:keyboardSourceConfig?, gamepad:gamepadSourceConfig?, gameStore:psxConsoleGameStoreLike?}
// Direct console construction dependencies after display and player composition.
export interface PsxConsoleConfig {
    readonly player: PsxConsolePlayerLike;                                      // Player owned by the console
    readonly keyboard?: Omit<KeyboardSourceConfig, "input">;                    // Optional keyboard dependencies and mappings
    readonly gamepad?: Omit<GamepadSourceConfig, "input" | "assignments">;      // Optional gamepad polling dependencies
    readonly gameStore?: PsxConsoleGameStoreLike;                               // Optional persistent content library
}

// INTERFACE :: high-level browser console composition options
// Factory input used to create display, player, audio, persistence, and input composition.
export interface PsxConsoleInitConfig {
    readonly adapter: PsxAdapter;                                               // Backend used to start sessions
    readonly canvas: PsxCanvasLike;                                             // Video presentation surface
    readonly container: PsxContainerLike;                                       // Responsive display boundary
    readonly gestureSource: PsxGestureSourceLike;                               // Audio authorization event source
    readonly storage?: PsxPlayerStorageLike;                                    // Optional cards, firmware, and states persistence
    readonly profileId?: string;                                                // Persistence namespace required with storage
    readonly memoryCardIds?: PsxPlayerConfig["memoryCardIds"];                  // Persistent card identities by slot
    readonly intervalScheduler?: PsxPlayerConfig["intervalScheduler"];          // Optional autosave timer boundary
    readonly autoSaveIntervalMs?: number;                                       // Optional autosave interval override
    readonly keyboard?: Omit<KeyboardSourceConfig, "input">;                    // Optional keyboard configuration
    readonly gamepad?: Omit<GamepadSourceConfig, "input" | "assignments">;      // Optional gamepad configuration
    readonly gameStore?: PsxConsoleGameStoreLike;                               // Optional persistent game library
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
// True when value exposes the lifecycle and input surface required by the console.
const isPlayer = (value: unknown): value is PsxConsolePlayerLike => isObject(value)
    && isPsxPlayerStatus(value.status) && (value.input === null || isObject(value.input))
    && typeof value.start === "function" && typeof value.stop === "function"
    && typeof value.destroy === "function" && typeof value.on === "function";

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value exposes persistent game import and lookup operations.
const isGameStore = (value: unknown): value is PsxConsoleGameStoreLike => isObject(value)
    && typeof value.import === "function" && typeof value.get === "function";

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value is a bounded non-empty file selection with valid Blob entries.
export function isPsxFileListLike(value: unknown): value is PsxFileListLike {
    if (!isObject(value) || typeof value.length !== "number" || !Number.isSafeInteger(value.length)
        || value.length <= 0 || value.length > 64) return false;
    for (let index = 0; index < value.length; index++) {
        const file = typeof value.item === "function" ? value.item(index) : value[index];
        if (!(file instanceof Blob) || typeof (file as PsxLocalFileLike).name !== "string"
            || (file as PsxLocalFileLike).name.length === 0) return false;
    }
    return true;
}

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value supplies a non-empty game identity and optional non-empty entry path.
export function isPsxLocalFilesConfig(value: unknown): value is PsxLocalFilesConfig {
    return isObject(value) && typeof value.gameId === "string" && value.gameId.trim().length > 0
        && (value.entry === undefined || (typeof value.entry === "string" && value.entry.length > 0));
}

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value supplies a player and valid optional input and game-library dependencies.
export function isPsxConsoleConfig(value: unknown): value is PsxConsoleConfig {
    if (!isObject(value) || !isPlayer(value.player)
        || (value.gameStore !== undefined && !isGameStore(value.gameStore))) return false;
    const input = value.player.input ?? {
        machine: { core: "pending" }, createChannel() {}, onTick() {}, onRumble() {},
    };
    return (value.keyboard === undefined || isKeyboardSourceConfig({ ...value.keyboard, input }))
        && (value.gamepad === undefined
            || isGamepadSourceConfig({ ...value.gamepad, input, assignments: { 0: 1 } }));
}

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value coherently configures the high-level browser composition and persistence group.
export function isPsxConsoleInitConfig(value: unknown): value is PsxConsoleInitConfig {
    if (!isObject(value) || !isPsxAdapter(value.adapter) || !isPsxCanvasLike(value.canvas)
        || !isPsxContainerLike(value.container) || !isPsxGestureSourceLike(value.gestureSource)
        || (value.storage !== undefined && !isPsxPlayerStorageLike(value.storage))
        || (value.profileId !== undefined
            && (typeof value.profileId !== "string" || value.profileId.trim().length === 0))
        || (value.intervalScheduler !== undefined
            && !isPsxPlayerIntervalSchedulerLike(value.intervalScheduler))
        || (value.autoSaveIntervalMs !== undefined
            && (typeof value.autoSaveIntervalMs !== "number"
                || !Number.isFinite(value.autoSaveIntervalMs) || value.autoSaveIntervalMs <= 0))
        || (value.gameStore !== undefined && !isGameStore(value.gameStore))) return false;
    const persistent = value.storage !== undefined || value.profileId !== undefined
        || value.memoryCardIds !== undefined || value.intervalScheduler !== undefined
        || value.autoSaveIntervalMs !== undefined;
    if (persistent && (value.storage === undefined || typeof value.profileId !== "string"
        || !isObject(value.memoryCardIds) || typeof value.memoryCardIds[1] !== "string"
        || value.memoryCardIds[1].trim().length === 0 || typeof value.memoryCardIds[2] !== "string"
        || value.memoryCardIds[2].trim().length === 0)) return false;
    const input = { machine: { core: "pending" }, createChannel() {}, onTick() {}, onRumble() {} };
    return (value.keyboard === undefined || isKeyboardSourceConfig({ ...value.keyboard, input }))
        && (value.gamepad === undefined
            || isGamepadSourceConfig({ ...value.gamepad, input, assignments: { 0: 1 } }));
}
