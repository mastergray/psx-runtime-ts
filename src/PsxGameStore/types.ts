// Dependencies:
import { isDiscSet } from "../shared.types.js";    // Validates complete persisted game content

// Type dependencies:
import type { DiscSet } from "../shared.types.js"; // Normalized content retained in a stored record

/**
 *
 * Type Declarations
 *
 */

// INTERFACE :: {gameId:STRING, displayTitle:STRING, importedAt:STRING, totalBytes:NUMBER, fileCount:NUMBER, discCount:NUMBER}
// Lightweight immutable summary displayed by the browser game library.
export interface PsxStoredGame {
    readonly gameId: string;         // Content-addressed psx-v1 identity
    readonly displayTitle: string;   // Mutable user-facing library title
    readonly importedAt: string;     // ISO timestamp of first committed import
    readonly totalBytes: number;     // Aggregate canonical content bytes
    readonly fileCount: number;      // Canonical descriptor, track, and sidecar count
    readonly discCount: number;      // Audited disc count
}

// INTERFACE :: {displayTitle:STRING?, signal:abortSignal?}
// Optional presentation and cancellation input for one game import.
export interface PsxGameImportOptions {
    readonly displayTitle?: string;    // User-facing title; defaults to the incoming game identity
    readonly signal?: AbortSignal;     // Caller cancellation observed between expensive phases
}

// INTERFACE :: atomic persistent game-record operations
// Driver boundary implemented by the IndexedDB backend and test fakes.
export interface PsxGameStoreDriverLike {
    read(gameId: string): Promise<unknown>;                    // Reads one record by exact identity
    list(): Promise<ReadonlyArray<unknown>>;                   // Lists every raw record
    write(gameId: string, value: unknown): Promise<void>;      // Atomically creates or replaces one record
    remove(gameId: string): Promise<void>;                     // Deletes one record
    update<T>(gameId: string, updater: (current: unknown) => {
        readonly value: unknown;
        readonly result: T;
    }): Promise<T>;                                            // Atomically derives a record and caller result
}

// INTERFACE :: {hash:(blob, abortSignal? -> PROMISE(STRING))}
// Streaming SHA-256 boundary used for tracks and canonical identity.
export interface PsxBlobHasherLike {
    hash(blob: Blob, signal?: AbortSignal): Promise<string>;    // Returns lowercase hexadecimal SHA-256
}

// INTERFACE :: {usage:NUMBER?, quota:NUMBER?}
// Best-effort browser storage estimate.
export interface PsxStorageEstimate {
    readonly usage?: number;    // Bytes currently consumed by the origin
    readonly quota?: number;    // Bytes currently granted to the origin
}

// INTERFACE :: {estimate:(VOID -> PROMISE(psxStorageEstimate))}
// Browser storage-manager subset used for quota diagnostics.
export interface PsxStorageManagerLike {
    estimate(): Promise<PsxStorageEstimate>;    // Returns best-effort origin usage and quota
}

// INTERFACE :: {driver:psxGameStoreDriverLike, hasher:psxBlobHasherLike, now:(VOID -> NUMBER), storageManager:psxStorageManagerLike?}
// Direct game-store construction dependencies.
export interface PsxGameStoreConfig {
    readonly driver: PsxGameStoreDriverLike;          // Atomic persistence backend
    readonly hasher: PsxBlobHasherLike;               // Streaming content hasher
    readonly now: () => number;                       // Clock used for import metadata
    readonly storageManager?: PsxStorageManagerLike;  // Optional quota estimator
}

// INTERFACE :: {indexedDB:idbFactory?, storageManager:psxStorageManagerLike?, now:(VOID -> NUMBER)?, databaseName:STRING?, createHasher:(VOID -> psxBlobHasherLike)?}
// Optional browser overrides accepted by the high-level factory.
export interface PsxGameStoreInitConfig {
    readonly indexedDB?: IDBFactory;                       // IndexedDB factory; defaults to globalThis.indexedDB
    readonly storageManager?: PsxStorageManagerLike;       // Quota estimator; defaults to navigator.storage
    readonly now?: () => number;                           // Clock override; defaults to Date.now
    readonly databaseName?: string;                        // Persistent database name override
    readonly createHasher?: () => PsxBlobHasherLike;       // Hasher factory override
}

// INTERFACE :: psxStoredGame & {format:"psx-runtime-game", version:1, game:discSet}
// Complete versioned record committed under its content identity.
export interface PsxStoredGameRecord extends PsxStoredGame {
    readonly format: "psx-runtime-game";    // Stable record-format discriminant
    readonly version: 1;                    // Record schema and identity version
    readonly game: DiscSet;                 // Canonically named Blob-backed content
}

const GAME_ID = /^psx-v1-[a-f0-9]{64}$/u;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T/u;

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
// True when value is a non-negative safe integer.
const isNonNegativeSafeInteger = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value is a valid content-addressed library summary.
export function isPsxStoredGame(value: unknown): value is PsxStoredGame {
    return isObject(value) && typeof value.gameId === "string" && GAME_ID.test(value.gameId)
        && typeof value.displayTitle === "string" && value.displayTitle.length > 0
        && value.displayTitle.length <= 160 && typeof value.importedAt === "string"
        && ISO_DATE.test(value.importedAt) && !Number.isNaN(Date.parse(value.importedAt))
        && isNonNegativeSafeInteger(value.totalBytes) && value.totalBytes > 0
        && isNonNegativeSafeInteger(value.fileCount) && value.fileCount > 0
        && isNonNegativeSafeInteger(value.discCount) && value.discCount > 0;
}

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value is a coherent versioned record whose content matches its summary.
export function isPsxStoredGameRecord(value: unknown): value is PsxStoredGameRecord {
    if (!isObject(value) || !isPsxStoredGame(value)) return false;
    return value.format === "psx-runtime-game" && value.version === 1
        && isDiscSet(value.game) && value.game.gameId === value.gameId
        && value.game.files.length === value.fileCount;
}

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value exposes every atomic game-record operation.
export function isPsxGameStoreDriverLike(value: unknown): value is PsxGameStoreDriverLike {
    return isObject(value) && ["read", "list", "write", "remove", "update"]
        .every((method) => typeof value[method] === "function");
}

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value exposes streaming Blob hashing.
export function isPsxBlobHasherLike(value: unknown): value is PsxBlobHasherLike {
    return isObject(value) && typeof value.hash === "function";
}

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value exposes browser storage estimation.
export function isPsxStorageManagerLike(value: unknown): value is PsxStorageManagerLike {
    return isObject(value) && typeof value.estimate === "function";
}

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value supplies valid driver, hasher, clock, and optional quota dependencies.
export function isPsxGameStoreConfig(value: unknown): value is PsxGameStoreConfig {
    return isObject(value) && isPsxGameStoreDriverLike(value.driver)
        && isPsxBlobHasherLike(value.hasher) && typeof value.now === "function"
        && (value.storageManager === undefined || isPsxStorageManagerLike(value.storageManager));
}

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value supplies coherent optional browser factory overrides.
export function isPsxGameStoreInitConfig(value: unknown): value is PsxGameStoreInitConfig {
    return isObject(value) && (value.indexedDB === undefined
        || (isObject(value.indexedDB) && typeof value.indexedDB.open === "function"))
        && (value.storageManager === undefined || isPsxStorageManagerLike(value.storageManager))
        && (value.now === undefined || typeof value.now === "function")
        && (value.databaseName === undefined || (typeof value.databaseName === "string"
            && value.databaseName.trim().length > 0))
        && (value.createHasher === undefined || typeof value.createHasher === "function");
}
