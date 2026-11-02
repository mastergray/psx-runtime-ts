// Dependencies:
import { isPsxAdapter } from "../shared.types.js";    // Validates the backend adapter supplied to the player

// Type dependencies:
import type {
    ControllerPort,    // Physical memory-card slot
    PsxAdapter,        // Backend session factory
    PsxSession,        // Active emulation session
    Unsubscribe,       // Cleanup returned by display attachment
} from "../shared.types.js";
import type {
    PsxMemoryCardRecord,       // Persisted card revision
    PsxMemoryCardSaveConfig,   // Optimistic card write input
    PsxStateLoadConfig,        // Compatible state lookup input
    PsxStateRecord,            // Persisted save-state record
    PsxStateSaveConfig,        // Save-state persistence input
} from "../PsxStorage/types.js";

/**
 *
 * Type Declarations
 *
 */

// TYPE :: "idle"|"starting"|"running"|"paused"|"stopping"|"failed"|"destroyed"
// Closed lifecycle state set emitted by the player.
export type PsxPlayerStatus =
    | "idle" | "starting" | "running" | "paused" | "stopping" | "failed" | "destroyed";

// INTERFACE :: {hasFrame:BOOLEAN, attach:(psxSession -> unsubscribe), detach:(VOID -> VOID), destroy:(VOID -> VOID)}
// Display lifecycle surface composed with each session.
export interface PsxPlayerDisplayLike {
    readonly hasFrame: boolean;                   // Whether startup produced visible output
    attach(session: PsxSession): Unsubscribe;     // Subscribes to one session's frames
    detach(): void;                               // Removes the active frame subscription
    destroy(): void;                              // Ends display ownership
}

// INTERFACE :: {resetQueue:(VOID -> VOID), destroy:(VOID -> VOID)}
// Audio lifecycle surface composed with each session.
export interface PsxPlayerAudioLike {
    resetQueue(): void;    // Cancels transient audio continuity
    destroy(): void;       // Ends audio ownership
}

// INTERFACE :: memory-card and save-state persistence operations used by the player
// Storage subset required by player lifecycle and manual state controls.
export interface PsxPlayerStorageLike {
    loadMemoryCard(profileId: string, cardId: string): Promise<PsxMemoryCardRecord | null>; // Loads one current card revision
    saveMemoryCard(config: PsxMemoryCardSaveConfig): Promise<PsxMemoryCardRecord>;           // Optimistically writes one card revision
    saveState(config: PsxStateSaveConfig): Promise<PsxStateRecord>;                          // Persists one named save state
    loadState(config: PsxStateLoadConfig): Promise<PsxStateRecord | null>;                   // Loads one compatible named state
    deleteState(profileId: string, gameId: string, name: string): Promise<void>;             // Deletes one named state
}

// INTERFACE :: {setInterval:((VOID -> VOID), NUMBER -> UNKNOWN), clearInterval:(UNKNOWN -> VOID)}
// Injectable timer boundary used by periodic card autosave.
export interface PsxPlayerIntervalSchedulerLike {
    setInterval(callback: () => void, milliseconds: number): unknown;    // Starts one repeating callback
    clearInterval(handle: unknown): void;                                // Cancels one repeating callback
}

// INTERFACE :: {adapter:psxAdapter, display:psxPlayerDisplayLike, createAudio:(psxSession -> psxPlayerAudioLike), storage:psxPlayerStorageLike?, profileId:STRING?, memoryCardIds:ARRAY<controllerPort, STRING>?, intervalScheduler:psxPlayerIntervalSchedulerLike?, autoSaveIntervalMs:NUMBER?}
// Backend, presentation, audio, and optional persistence dependencies for one reusable player.
export interface PsxPlayerConfig {
    readonly adapter: PsxAdapter;                                      // Backend session factory
    readonly display: PsxPlayerDisplayLike;                            // Video lifecycle owner
    readonly createAudio: (session: PsxSession) => PsxPlayerAudioLike; // Audio factory invoked after visible startup
    readonly storage?: PsxPlayerStorageLike;                           // Optional cards and states persistence
    readonly profileId?: string;                                      // Persistence namespace
    readonly memoryCardIds?: Readonly<Record<ControllerPort, string>>; // Persistent card identity per slot
    readonly intervalScheduler?: PsxPlayerIntervalSchedulerLike;      // Autosave timer boundary
    readonly autoSaveIntervalMs?: number;                             // Autosave interval override
}

// INTERFACE :: {status:psxPlayerStatus, error:UNKNOWN}
// Payload map for player lifecycle and failure observers.
export interface PsxPlayerEventMap {
    readonly status: PsxPlayerStatus;    // New lifecycle state
    readonly error: unknown;             // Unmodified operation or cleanup failure
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
// True when value is one supported player lifecycle state.
export function isPsxPlayerStatus(value: unknown): value is PsxPlayerStatus {
    return value === "idle" || value === "starting" || value === "running" || value === "paused"
        || value === "stopping" || value === "failed" || value === "destroyed";
}

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value exposes the required display lifecycle surface.
export function isPsxPlayerDisplayLike(value: unknown): value is PsxPlayerDisplayLike {
    return isObject(value) && typeof value.hasFrame === "boolean" && typeof value.attach === "function"
        && typeof value.detach === "function" && typeof value.destroy === "function";
}

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value exposes queue reset and terminal audio cleanup.
export function isPsxPlayerAudioLike(value: unknown): value is PsxPlayerAudioLike {
    return isObject(value) && typeof value.resetQueue === "function" && typeof value.destroy === "function";
}

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value exposes every card and state persistence operation used by the player.
export function isPsxPlayerStorageLike(value: unknown): value is PsxPlayerStorageLike {
    return isObject(value) && ["loadMemoryCard", "saveMemoryCard", "saveState", "loadState", "deleteState"]
        .every((method) => typeof value[method] === "function");
}

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value exposes interval creation and cancellation.
export function isPsxPlayerIntervalSchedulerLike(value: unknown): value is PsxPlayerIntervalSchedulerLike {
    return isObject(value) && typeof value.setInterval === "function"
        && typeof value.clearInterval === "function";
}

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value supplies valid core dependencies and a coherent all-or-none persistence group.
export function isPsxPlayerConfig(value: unknown): value is PsxPlayerConfig {
    if (!isObject(value) || !isPsxAdapter(value.adapter) || !isPsxPlayerDisplayLike(value.display)
        || typeof value.createAudio !== "function"
        || (value.storage !== undefined && !isPsxPlayerStorageLike(value.storage))
        || (value.profileId !== undefined
            && (typeof value.profileId !== "string" || value.profileId.trim().length === 0))
        || (value.intervalScheduler !== undefined
            && !isPsxPlayerIntervalSchedulerLike(value.intervalScheduler))
        || (value.autoSaveIntervalMs !== undefined
            && (typeof value.autoSaveIntervalMs !== "number" || !Number.isFinite(value.autoSaveIntervalMs)
                || value.autoSaveIntervalMs <= 0))) return false;
    if (value.memoryCardIds !== undefined && (!isObject(value.memoryCardIds)
        || typeof value.memoryCardIds[1] !== "string" || value.memoryCardIds[1].trim().length === 0
        || typeof value.memoryCardIds[2] !== "string" || value.memoryCardIds[2].trim().length === 0)) return false;
    const persistent = value.storage !== undefined || value.profileId !== undefined
        || value.memoryCardIds !== undefined || value.intervalScheduler !== undefined;
    return !persistent || (value.storage !== undefined && value.profileId !== undefined
        && value.memoryCardIds !== undefined && value.intervalScheduler !== undefined);
}
