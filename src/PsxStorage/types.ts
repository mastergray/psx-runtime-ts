// Dependencies:
import {
    isBiosImage,         // Validates firmware payloads read from persistence
    isPsxMachineInfo,    // Validates active machine identity for save-state operations
    isPsxRegion,         // Validates firmware record region identity
    isPsxSession,        // Validates the session observed by card autosave
} from "../shared.types.js";

// Type dependencies:
import type {
    BiosImage,         // Validated firmware image extended by persistent metadata
    ControllerPort,    // Physical memory-card slot
    PsxMachineInfo,    // Build, core, content, and disc identity for states
    PsxRegion,         // Firmware storage partition key
    PsxSession,        // Active source of memory-card bytes
} from "../shared.types.js";

/**
 *
 * Type Declarations
 *
 */

export const PSX_MEMORY_CARD_BYTES = 128 * 1024;    // Canonical physical PlayStation memory-card byte length

// TYPE :: "cards"|"states"|"firmware"
// Logical object stores owned by the persistence driver.
export type PsxStorageStore = "cards" | "states" | "firmware";

// INTERFACE :: {value:T?, delete:TRUE?, result:R}
// Atomic update result containing an optional write or deletion and a caller result.
// NOTE: <T> is the stored value and <R> is the operation result.
export interface PsxStorageMutation<T = unknown, R = unknown> {
    readonly value?: T;       // Replacement value written when present
    readonly delete?: true;   // Deletion instruction when true
    readonly result: R;       // Value returned to the caller after commit
}

// INTERFACE :: transactional storage operations partitioned by psxStorageStore
// Driver boundary implemented by IndexedDB and deterministic test fakes.
export interface PsxStorageDriverLike {
    read(store: PsxStorageStore, key: string): Promise<unknown>;                   // Reads one raw value
    write(store: PsxStorageStore, key: string, value: unknown): Promise<void>;     // Creates or replaces one value
    remove(store: PsxStorageStore, key: string): Promise<void>;                   // Deletes one value
    list(store: PsxStorageStore): Promise<ReadonlyArray<unknown>>;                // Lists every raw value in one store
    update<T>(
        store: PsxStorageStore,
        key: string,
        updater: (current: unknown) => PsxStorageMutation<unknown, T>,
    ): Promise<T>;                                                                // Atomically derives a mutation and result
}

// INTERFACE :: {open:(STRING, NUMBER? -> idbOpenDbRequest)}
// IndexedDB factory subset used by the browser storage factory.
export interface PsxIndexedDbFactoryLike {
    open(name: string, version?: number): IDBOpenDBRequest;    // Opens or upgrades one named database
}

// INTERFACE :: {driver:psxStorageDriverLike, now:(VOID -> NUMBER)}
// Direct storage construction dependencies.
export interface PsxStorageConfig {
    readonly driver: PsxStorageDriverLike;    // Transactional persistence backend
    readonly now: () => number;               // Clock used for record metadata
}

// INTERFACE :: {indexedDB:psxIndexedDbFactoryLike?, now:(VOID -> NUMBER)?, databaseName:STRING?}
// Optional browser overrides accepted by the storage factory.
export interface PsxStorageInitConfig {
    readonly indexedDB?: PsxIndexedDbFactoryLike;    // Factory override; defaults to globalThis.indexedDB
    readonly now?: () => number;                     // Clock override; defaults to Date.now
    readonly databaseName?: string;                  // Persistent database name override
}

// INTERFACE :: {profileId:STRING, cardId:STRING, revision:NUMBER, updatedAt:STRING, bytes:uint8Array}
// One immutable persistent memory-card revision.
export interface PsxMemoryCardRecord {
    readonly profileId: string;      // User or save namespace
    readonly cardId: string;         // Card identity within the profile
    readonly revision: number;       // Positive optimistic-concurrency revision
    readonly updatedAt: string;      // ISO commit timestamp
    readonly bytes: Uint8Array;      // Exact physical card image
}

// INTERFACE :: {profileId:STRING, cardId:STRING, expectedRevision:NUMBER?, bytes:uint8Array}
// Optimistic write request for one complete memory-card image.
export interface PsxMemoryCardSaveConfig {
    readonly profileId: string;                 // User or save namespace
    readonly cardId: string;                    // Card identity within the profile
    readonly expectedRevision: number | null;   // Current revision or NULL for first write
    readonly bytes: Uint8Array;                 // Exact replacement card image
}

// INTERFACE :: biosImage & {format:"psx-runtime-firmware", version:1, storedAt:STRING}
// Versioned browser-local firmware record.
export interface PsxFirmwareRecord extends BiosImage {
    readonly format: "psx-runtime-firmware";    // Stable record-format discriminant
    readonly version: 1;                        // Firmware record schema version
    readonly storedAt: string;                  // ISO commit timestamp
}

// INTERFACE :: {format:"psx-runtime-state", version:1, adapter:"libretro-psx", buildId:STRING, core:STRING, coreVersion:STRING, gameId:STRING, discIndex:NUMBER, createdAt:STRING}
// Compatibility envelope embedded in every save state.
export interface PsxStateMetadata {
    readonly format: "psx-runtime-state";    // Stable state-format discriminant
    readonly version: 1;                     // State schema version
    readonly adapter: "libretro-psx";        // Backend family required for restoration
    readonly buildId: string;                // Exact deterministic build identity
    readonly core: string;                   // Exact libretro core identity
    readonly coreVersion: string;            // Exact core source version
    readonly gameId: string;                 // Exact active content identity
    readonly discIndex: number;              // Zero-based active disc captured with the state
    readonly createdAt: string;              // ISO capture timestamp
}

// INTERFACE :: {profileId:STRING, name:STRING, metadata:psxStateMetadata, payload:uint8Array}
// One named save-state payload and compatibility envelope.
export interface PsxStateRecord {
    readonly profileId: string;            // User or save namespace
    readonly name: string;                 // Normalized user-facing state name
    readonly metadata: PsxStateMetadata;   // Immutable compatibility identity
    readonly payload: Uint8Array;          // Non-empty core serialization bytes
}

// INTERFACE :: {profileId:STRING, name:STRING, machine:psxMachineInfo, discIndex:NUMBER, payload:uint8Array}
// Input used to create one versioned named save-state record.
export interface PsxStateSaveConfig {
    readonly profileId: string;       // User or save namespace
    readonly name: string;            // Requested state name
    readonly machine: PsxMachineInfo; // Active compatibility identity
    readonly discIndex: number;       // Active zero-based disc
    readonly payload: Uint8Array;     // Non-empty core serialization bytes
}

// INTERFACE :: {profileId:STRING, name:STRING, machine:psxMachineInfo}
// Lookup input carrying the active compatibility identity.
export interface PsxStateLoadConfig {
    readonly profileId: string;       // User or save namespace
    readonly name: string;            // Requested state name
    readonly machine: PsxMachineInfo; // Active identity required for compatibility
}

// INTERFACE :: {setInterval:((VOID -> VOID), NUMBER -> UNKNOWN), clearInterval:(UNKNOWN -> VOID)}
// Injectable repeating-timer boundary used by card autosave.
export interface PsxIntervalSchedulerLike {
    setInterval(callback: () => void, milliseconds: number): unknown;    // Starts one repeating callback
    clearInterval(handle: unknown): void;                                // Cancels one repeating callback
}

// INTERFACE :: {cardId:STRING, revision:NUMBER?, bytes:uint8Array?}
// Persistent identity and baseline for one autosaved physical card slot.
export interface PsxAutoSaveCardBinding {
    readonly cardId: string;            // Persistent card identity
    readonly revision: number | null;   // Loaded revision or NULL before first write
    readonly bytes?: Uint8Array;        // Optional loaded baseline bytes
}

// INTERFACE :: autosave storage, session, card, scheduler, and error dependencies
// Complete configuration for one two-slot card autosave lifecycle.
export interface PsxCardAutoSaveConfig {
    readonly storage: {
        saveMemoryCard(config: PsxMemoryCardSaveConfig): Promise<PsxMemoryCardRecord>;
    };                                                                            // Persistence surface receiving dirty cards
    readonly session: PsxSession;                                                 // Live source of physical card bytes
    readonly profileId: string;                                                   // Persistence namespace
    readonly cards: Readonly<Record<ControllerPort, PsxAutoSaveCardBinding>>;      // Card identity and baseline by slot
    readonly scheduler: PsxIntervalSchedulerLike;                                 // Repeating flush timer boundary
    readonly intervalMs?: number;                                                 // Flush interval; defaults to the class constant
    readonly onError?: (error: unknown) => void;                                  // Non-terminal persistence failure observer
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
// True when value is an integer of at least zero.
const isNonNegativeInteger = (value: unknown): value is number =>
    typeof value === "number" && Number.isInteger(value) && value >= 0;

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value is a Uint8Array, including compatible cross-realm instances.
const isUint8Array = (value: unknown): value is Uint8Array =>
    value instanceof Uint8Array || Object.prototype.toString.call(value) === "[object Uint8Array]";

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value exposes every transactional storage operation.
export function isPsxStorageDriverLike(value: unknown): value is PsxStorageDriverLike {
    return isObject(value) && ["read", "write", "remove", "list", "update"]
        .every((method) => typeof value[method] === "function");
}

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value exposes IndexedDB database opening.
export function isPsxIndexedDbFactoryLike(value: unknown): value is PsxIndexedDbFactoryLike {
    return isObject(value) && typeof value.open === "function";
}

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value supplies a valid driver and clock.
export function isPsxStorageConfig(value: unknown): value is PsxStorageConfig {
    return isObject(value) && isPsxStorageDriverLike(value.driver) && typeof value.now === "function";
}

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value supplies coherent optional browser factory overrides.
export function isPsxStorageInitConfig(value: unknown): value is PsxStorageInitConfig {
    return isObject(value)
        && (value.indexedDB === undefined || isPsxIndexedDbFactoryLike(value.indexedDB))
        && (value.now === undefined || typeof value.now === "function")
        && (value.databaseName === undefined
            || (typeof value.databaseName === "string" && value.databaseName.trim().length > 0));
}

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value is a complete exact-size positive-revision memory-card record.
export function isPsxMemoryCardRecord(value: unknown): value is PsxMemoryCardRecord {
    return isObject(value) && typeof value.profileId === "string" && value.profileId.length > 0
        && typeof value.cardId === "string" && value.cardId.length > 0
        && typeof value.revision === "number" && Number.isInteger(value.revision) && value.revision > 0
        && typeof value.updatedAt === "string" && !Number.isNaN(Date.parse(value.updatedAt))
        && isUint8Array(value.bytes) && value.bytes.byteLength === PSX_MEMORY_CARD_BYTES;
}

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value is an exact-size optimistic memory-card write request.
export function isPsxMemoryCardSaveConfig(value: unknown): value is PsxMemoryCardSaveConfig {
    return isObject(value) && typeof value.profileId === "string" && typeof value.cardId === "string"
        && (value.expectedRevision === null || (isNonNegativeInteger(value.expectedRevision)
            && value.expectedRevision > 0))
        && isUint8Array(value.bytes) && value.bytes.byteLength === PSX_MEMORY_CARD_BYTES;
}

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value is a coherent versioned firmware record.
export function isPsxFirmwareRecord(value: unknown): value is PsxFirmwareRecord {
    return isObject(value) && value.format === "psx-runtime-firmware" && value.version === 1
        && isBiosImage(value) && isPsxRegion(value.region) && typeof value.storedAt === "string"
        && !Number.isNaN(Date.parse(value.storedAt));
}

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value is a complete versioned state compatibility envelope.
export function isPsxStateMetadata(value: unknown): value is PsxStateMetadata {
    return isObject(value) && value.format === "psx-runtime-state" && value.version === 1
        && value.adapter === "libretro-psx" && typeof value.buildId === "string"
        && /^[a-f0-9]{64}$/u.test(value.buildId) && typeof value.core === "string" && value.core.length > 0
        && typeof value.coreVersion === "string" && value.coreVersion.length > 0
        && typeof value.gameId === "string" && value.gameId.length > 0
        && isNonNegativeInteger(value.discIndex) && typeof value.createdAt === "string"
        && !Number.isNaN(Date.parse(value.createdAt));
}

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value contains a named state, valid metadata, and a non-empty payload.
export function isPsxStateRecord(value: unknown): value is PsxStateRecord {
    return isObject(value) && typeof value.profileId === "string" && value.profileId.length > 0
        && typeof value.name === "string" && value.name.length > 0
        && isPsxStateMetadata(value.metadata) && isUint8Array(value.payload)
        && value.payload.byteLength > 0;
}

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value supplies valid identity, active machine, disc, and payload for persistence.
export function isPsxStateSaveConfig(value: unknown): value is PsxStateSaveConfig {
    return isObject(value) && typeof value.profileId === "string" && typeof value.name === "string"
        && isPsxMachineInfo(value.machine) && isNonNegativeInteger(value.discIndex)
        && value.discIndex < value.machine.discCount && isUint8Array(value.payload)
        && value.payload.byteLength > 0;
}

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value supplies state identity and a valid active machine.
export function isPsxStateLoadConfig(value: unknown): value is PsxStateLoadConfig {
    return isObject(value) && typeof value.profileId === "string" && typeof value.name === "string"
        && isPsxMachineInfo(value.machine);
}

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value exposes interval creation and cancellation.
export function isPsxIntervalSchedulerLike(value: unknown): value is PsxIntervalSchedulerLike {
    return isObject(value) && typeof value.setInterval === "function"
        && typeof value.clearInterval === "function";
}

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value supplies a card identity, valid revision, and optional exact-size baseline.
const isBinding = (value: unknown): value is PsxAutoSaveCardBinding => isObject(value)
    && typeof value.cardId === "string" && value.cardId.trim().length > 0
    && (value.revision === null || (isNonNegativeInteger(value.revision) && value.revision > 0))
    && (value.bytes === undefined || (isUint8Array(value.bytes)
        && value.bytes.byteLength === PSX_MEMORY_CARD_BYTES));

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value coherently configures storage, session, both cards, scheduling, and error reporting.
export function isPsxCardAutoSaveConfig(value: unknown): value is PsxCardAutoSaveConfig {
    return isObject(value) && isObject(value.storage)
        && typeof value.storage.saveMemoryCard === "function" && isPsxSession(value.session)
        && typeof value.profileId === "string" && value.profileId.trim().length > 0
        && isObject(value.cards)
        && isBinding(value.cards[1]) && isBinding(value.cards[2])
        && isPsxIntervalSchedulerLike(value.scheduler)
        && (value.intervalMs === undefined || (typeof value.intervalMs === "number"
            && Number.isFinite(value.intervalMs) && value.intervalMs > 0))
        && (value.onError === undefined || typeof value.onError === "function");
}
