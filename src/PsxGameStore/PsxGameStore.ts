// Dependencies:
import DiscSetAudit from "../DiscSetAudit/DiscSetAudit.js";              // Validates and resolves disc structure before import
import PsxRuntimeError from "../PsxRuntimeError/PsxRuntimeError.js";    // Reports invalid requests and persistent-storage failures
import { createMountPlan } from "../worker/MountPlan.js";               // Produces canonical descriptors and resolved content paths
import IndexedDbGameDriver from "./IndexedDbGameDriver.js";            // Supplies the browser persistence backend used by init()
import WorkerBlobHasher from "./WorkerBlobHasher.js";                   // Supplies off-main-thread SHA-256 used by init()
import {
    isPsxGameStoreConfig,        // Validates direct construction dependencies
    isPsxGameStoreInitConfig,    // Validates browser factory options
    isPsxStoredGameRecord,       // Validates records returned by the persistence driver
} from "./types.js";

// Type dependencies:
import type {
    AuditedDisc,    // Fully resolved disc structure produced by the audit
    DiscFile,       // Normalized content path and blob pair
    DiscSet,        // Entry, identity, and files supplied to or returned from the store
} from "../shared.types.js";
import type {
    PsxGameImportOptions,       // Optional title and cancellation signal for import
    PsxGameStoreConfig,         // Driver, hasher, clock, and quota dependencies
    PsxGameStoreInitConfig,     // Optional browser factory settings
    PsxStoredGame,              // Lightweight immutable library summary
    PsxStoredGameRecord,        // Complete persisted content and metadata record
} from "./types.js";

/**
 *
 * Type Declarations
 *
 */

// TYPE :: {entry:STRING, files:[discFile], descriptors:[{path:STRING, text:STRING}], trackNames:MAP, sidecarNames:MAP}
// Deterministically renamed content and identity inputs produced before hashing.
interface CanonicalContent {
    readonly entry: string;                                                // Canonical descriptor basename used to start the set
    readonly files: ReadonlyArray<DiscFile>;                               // Canonically named descriptors, tracks, and sidecars
    readonly descriptors: ReadonlyArray<{ readonly path: string; readonly text: string }>; // Normalized descriptor identity inputs
    readonly trackNames: ReadonlyMap<string, string>;                      // Original track path to canonical name
    readonly sidecarNames: ReadonlyMap<string, string>;                    // Original sidecar path to canonical name
}

const FORMAT = "psx-runtime-game";                       // Persisted game-record format identifier
const VERSION = 1;                                       // Persisted identity and record schema version
const GAME_ID = /^psx-v1-[a-f0-9]{64}$/u;               // Content-addressed identity accepted by public lookups
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

/**
 *
 * Class
 *
 */

// Audits, content-addresses, and atomically persists normalized game disc sets.
export default class PsxGameStore {

    /* Static Fields */
    static readonly DEFAULT_DATABASE_NAME = "psx-runtime-games";    // Browser database name used by init()

    /* Instance Fields */
    private readonly _driver: PsxGameStoreConfig["driver"];                              // Atomic record persistence boundary
    private readonly _hasher: PsxGameStoreConfig["hasher"];                              // Streaming SHA-256 boundary
    private readonly _now: PsxGameStoreConfig["now"];                                    // Injectable clock for import metadata
    private readonly _storageManager: NonNullable<PsxGameStoreConfig["storageManager"]> | null; // Optional browser quota estimator

    // CONSTRUCTOR :: psxGameStoreConfig -> psxGameStore
    // Validates and retains persistence, hashing, clock, and quota dependencies.
    constructor(config: PsxGameStoreConfig) {
        if (!isPsxGameStoreConfig(config)) throw invalid("PsxGameStore config is invalid.", config);
        this._driver = config.driver;
        this._hasher = config.hasher;
        this._now = config.now;
        this._storageManager = config.storageManager ?? null;
    }

    /**
     *
     * Instance Methods
     *
     */

    // METHOD :: VOID -> PROMISE([psxStoredGame])
    // Lists validated immutable summaries ordered by title and identity.
    async list(): Promise<ReadonlyArray<PsxStoredGame>> {
        const values = await this._storageCall(() => this._driver.list());
        const records = values.map((value) => this._storedRecord(value));
        records.sort((left, right) => left.displayTitle.localeCompare(right.displayTitle)
            || left.gameId.localeCompare(right.gameId));
        return Object.freeze(records.map(summary));
    }

    // METHOD :: STRING -> PROMISE(discSet?)
    // Loads one validated immutable disc set by content identity.
    async get(gameId: string): Promise<DiscSet | null> {
        const id = assertGameId(gameId);
        const value = await this._storageCall(() => this._driver.read(id));
        if (value === undefined) return null;
        return copyGame(this._storedRecord(value, id));
    }

    // METHOD :: discSet, psxGameImportOptions? -> PROMISE(psxStoredGame)
    // Audits, canonicalizes, hashes, quota-checks, and atomically stores one game.
    async import(game: DiscSet, options: PsxGameImportOptions = {}): Promise<PsxStoredGame> {
        if (typeof options !== "object" || options === null
            || (options.displayTitle !== undefined && typeof options.displayTitle !== "string")
            || (options.signal !== undefined && (typeof options.signal !== "object"
                || typeof options.signal.aborted !== "boolean"
                || typeof options.signal.addEventListener !== "function"
                || typeof options.signal.removeEventListener !== "function"))) {
            throw invalid("Game import options are invalid.", options);
        }
        this._assertNotCancelled(options.signal);
        const audit = await DiscSetAudit.audit(game);
        if (!audit.ok) throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.DISC_SET_INVALID,
            message: "The game failed disc-set validation.",
            data: audit,
        });
        const canonical = await canonicalContent(game, audit.audit);
        const hashes = new Map<string, string>();
        const source = new Map(game.files.map((file) => [file.path, file.blob]));
        const hashFor = async (path: string): Promise<string> => {
            const cached = hashes.get(path);
            if (cached !== undefined) return cached;
            const blob = source.get(path);
            if (blob === undefined) throw failed("Audited content disappeared during hashing.", path);
            const hash = await this._hasher.hash(blob, options.signal);
            if (!/^[a-f0-9]{64}$/u.test(hash)) throw failed("The Blob hasher returned an invalid digest.", null);
            hashes.set(path, hash);
            return hash;
        };
        const tracks: Array<Array<{
            readonly name: string | undefined;
            readonly kind: "data" | "audio";
            readonly bytes: number;
            readonly sha256: string;
        }>> = [];
        const sidecars: Array<{
            readonly name: string | undefined;
            readonly bytes: number;
            readonly sha256: string;
        }> = [];
        for (const disc of audit.audit.discs) {
            const discTracks: (typeof tracks)[number] = [];
            for (const track of disc.tracks) {
                discTracks.push({
                    name: canonical.trackNames.get(track.file),
                    kind: track.kind,
                    bytes: track.bytes,
                    sha256: await hashFor(track.file),
                });
            }
            tracks.push(discTracks);
            if (disc.sbi !== undefined) {
                const blob = source.get(disc.sbi)!;
                sidecars.push({
                    name: canonical.sidecarNames.get(disc.sbi),
                    bytes: blob.size,
                    sha256: await hashFor(disc.sbi),
                });
            }
        }
        const identity = JSON.stringify({
            format: FORMAT,
            version: VERSION,
            entry: canonical.entry,
            descriptors: canonical.descriptors,
            tracks,
            sidecars,
        });
        const digest = await this._hasher.hash(new Blob([identity]), options.signal);
        if (!/^[a-f0-9]{64}$/u.test(digest)) throw failed("The Blob hasher returned an invalid digest.", null);
        const gameId = `psx-v1-${digest}`;
        this._assertNotCancelled(options.signal);
        const existing = await this._storageCall(() => this._driver.read(gameId));
        if (existing !== undefined) return summary(this._storedRecord(existing, gameId));
        const displayTitle = normalizeTitle(options.displayTitle ?? game.gameId);
        const totalBytes = canonical.files.reduce((total, file) => total + file.blob.size, 0);
        await this._assertQuota(totalBytes);
        this._assertNotCancelled(options.signal);
        const timestamp = this._now();
        if (!Number.isFinite(timestamp)) throw failed("The game-library clock returned an invalid time.", timestamp);
        const storedGame: DiscSet = Object.freeze({
            gameId,
            entry: canonical.entry,
            files: canonical.files,
        });
        const record: PsxStoredGameRecord = Object.freeze({
            format: FORMAT,
            version: VERSION,
            gameId,
            displayTitle,
            importedAt: new Date(timestamp).toISOString(),
            totalBytes,
            fileCount: canonical.files.length,
            discCount: audit.audit.discs.length,
            game: storedGame,
        });
        try {
            await this._driver.write(gameId, record);
        } catch (error) {
            const estimate = await this._quotaData(totalBytes);
            throw failed("Game content could not be committed atomically.", {
                ...(estimate ?? {}),
                cause: error instanceof Error ? error.message : error,
            });
        }
        return summary(record);
    }

    // METHOD :: STRING, STRING -> PROMISE(psxStoredGame)
    // Atomically replaces display metadata without changing content identity.
    async renameDisplayTitle(gameId: string, displayTitle: string): Promise<PsxStoredGame> {
        const id = assertGameId(gameId);
        const title = normalizeTitle(displayTitle);
        return this._storageCall(() => this._driver.update(id, (value) => {
            if (value === undefined) throw failed("The stored game does not exist.", { gameId: id });
            const current = this._storedRecord(value, id);
            const updated = Object.freeze({ ...current, displayTitle: title });
            return { value: updated, result: summary(updated) };
        }));
    }

    // METHOD :: STRING -> PROMISE(VOID)
    // Removes one stored game by content identity.
    async delete(gameId: string): Promise<void> {
        const id = assertGameId(gameId);
        await this._storageCall(() => this._driver.remove(id));
    }

    /**
     *
     * Private Methods
     *
     */

    // METHOD :: NUMBER -> PROMISE(VOID)
    // Rejects an import known to exceed the browser's reported available quota.
    private async _assertQuota(requiredBytes: number): Promise<void> {
        const data = await this._quotaData(requiredBytes);
        if (data !== null && data.availableBytes !== null && requiredBytes > data.availableBytes) {
            throw failed("Game import exceeds the reported storage quota.", data);
        }
    }

    // METHOD :: NUMBER -> PROMISE({type:"quota", requiredBytes:NUMBER, availableBytes:NUMBER?}?)
    // Returns best-effort normalized quota diagnostics for an import.
    private async _quotaData(requiredBytes: number): Promise<{
        readonly type: "quota";
        readonly requiredBytes: number;
        readonly availableBytes: number | null;
    } | null> {
        if (this._storageManager === null) return null;
        try {
            const estimate = await this._storageManager.estimate();
            const usage = typeof estimate.usage === "number" && Number.isFinite(estimate.usage)
                ? Math.max(0, estimate.usage) : null;
            const quota = typeof estimate.quota === "number" && Number.isFinite(estimate.quota)
                ? Math.max(0, estimate.quota) : null;
            return {
                type: "quota",
                requiredBytes,
                availableBytes: usage === null || quota === null ? null : Math.max(0, quota - usage),
            };
        } catch {
            return null;
        }
    }

    // METHOD :: UNKNOWN, STRING? -> psxStoredGameRecord
    // Validates one persisted record and its optional lookup identity.
    private _storedRecord(value: unknown, gameId?: string): PsxStoredGameRecord {
        if (!isPsxStoredGameRecord(value) || (gameId !== undefined && value.gameId !== gameId)) {
            throw failed("A stored game record is malformed.", gameId ?? null);
        }
        return value;
    }

    // METHOD :: abortSignal? -> VOID
    // Converts a caller cancellation signal into a typed storage failure.
    private _assertNotCancelled(signal?: AbortSignal): void {
        if (signal?.aborted === true) throw failed("Game import was cancelled.", { type: "cancelled" });
    }

    // METHOD :: (VOID -> PROMISE(T)) -> PROMISE(T)
    // Preserves typed runtime errors and wraps untyped driver failures.
    private async _storageCall<T>(operation: () => Promise<T>): Promise<T> {
        try {
            return await operation();
        } catch (error) {
            if (PsxRuntimeError.is(error)) throw error;
            throw failed("Game-library storage failed.", error);
        }
    }

    /**
     *
     * Static Methods
     *
     */

    // Static Factory Method :: psxGameStoreInitConfig? -> psxGameStore
    // Creates browser storage with IndexedDB, worker hashing, and quota estimation.
    static init(config: PsxGameStoreInitConfig = {}): PsxGameStore {
        if (!isPsxGameStoreInitConfig(config)) throw invalid("PsxGameStore init config is invalid.", config);
        const factory = config.indexedDB ?? globalThis.indexedDB;
        if (factory === undefined) throw failed("IndexedDB is unavailable.", null);
        const storageManager = config.storageManager
            ?? (typeof navigator === "undefined" ? undefined : navigator.storage);
        return new PsxGameStore({
            driver: new IndexedDbGameDriver(factory, config.databaseName ?? PsxGameStore.DEFAULT_DATABASE_NAME),
            hasher: config.createHasher?.() ?? new WorkerBlobHasher(),
            now: config.now ?? Date.now,
            ...(storageManager === undefined ? {} : { storageManager }),
        });
    }
}

/**
 *
 *  Helper Functions
 *
 */

// Characters forbidden in display titles

// HELPER :: STRING, UNKNOWN -> psxRuntimeError
// Creates one invalid game-library request error.
const invalid = (message: string, data: unknown): PsxRuntimeError => new PsxRuntimeError({
    code: PsxRuntimeError.CODE.INVALID_CONFIG,
    message,
    data,
});

// HELPER :: STRING, UNKNOWN -> psxRuntimeError
// Creates one hashing, quota, record-integrity, or persistence error.
const failed = (message: string, data: unknown): PsxRuntimeError => new PsxRuntimeError({
    code: PsxRuntimeError.CODE.STORAGE_FAILED,
    message,
    data,
});

// HELPER :: psxStoredGameRecord -> psxStoredGame
// Projects a complete record into an immutable library summary.
const summary = (record: PsxStoredGameRecord): PsxStoredGame => Object.freeze({
    gameId: record.gameId,
    displayTitle: record.displayTitle,
    importedAt: record.importedAt,
    totalBytes: record.totalBytes,
    fileCount: record.fileCount,
    discCount: record.discCount,
});

// HELPER :: psxStoredGameRecord -> discSet
// Returns an immutable content view safe for session startup.
const copyGame = (record: PsxStoredGameRecord): DiscSet => Object.freeze({
    gameId: record.gameId,
    entry: record.game.entry,
    files: Object.freeze(record.game.files.map(({ path, blob }) => Object.freeze({ path, blob }))),
});

// HELPER :: STRING -> STRING
// Returns the final normalized component of a content path.
const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

// HELPER :: UNKNOWN -> STRING
// Normalizes and validates a bounded printable display title.
const normalizeTitle = (value: unknown): string => {
    if (typeof value !== "string") throw invalid("Game display title must be a string.", value);
    const normalized = value.trim().normalize("NFC");
    if (normalized.length === 0 || [...normalized].length > 160 || CONTROL_CHARACTERS.test(normalized)) {
        throw invalid("Game display title must contain 1–160 printable characters.", value);
    }
    return normalized;
};

// HELPER :: UNKNOWN -> STRING
// Validates and returns an exact content-addressed game identity.
const assertGameId = (value: unknown): string => {
    if (typeof value !== "string" || !GAME_ID.test(value)) {
        throw invalid("Stored gameId is invalid.", value);
    }
    return value;
};

// HELPER :: uint8Array -> uint8Array
// Removes transient worker mount prefixes from descriptor identity bytes.
const normalizeDescriptor = (bytes: Uint8Array): Uint8Array => {
    const text = new TextDecoder().decode(bytes)
        .replaceAll("/content/blob/", "")
        .replaceAll("/content/index/", "");
    return new TextEncoder().encode(text);
};

// HELPER :: discSet, auditedDisc -> PROMISE(canonicalContent)
// Builds deterministic descriptor, track, and sidecar names for identity and storage.
const canonicalContent = async (set: DiscSet, audit: AuditedDisc): Promise<CanonicalContent> => {
    const plan = await createMountPlan(set, audit);
    const descriptors = plan.descriptors.map(({ path, bytes }) => {
        const normalized = normalizeDescriptor(bytes);
        return { path: basename(path), text: new TextDecoder().decode(normalized), bytes: normalized };
    });
    const trackNames = new Map<string, string>();
    let trackIndex = 0;
    for (const disc of audit.discs) {
        for (const track of disc.tracks) {
            if (!trackNames.has(track.file)) {
                trackNames.set(track.file, `track-${trackIndex.toString().padStart(3, "0")}.bin`);
                trackIndex++;
            }
        }
    }
    const sidecarNames = new Map<string, string>();
    for (let index = 0; index < audit.discs.length; index++) {
        const sidecar = audit.discs[index]!.sbi;
        if (sidecar !== undefined) sidecarNames.set(sidecar, `disc-${index.toString().padStart(3, "0")}.sbi`);
    }
    const source = new Map(set.files.map((file) => [file.path, file.blob]));
    const files: DiscFile[] = descriptors.map(({ path, bytes }) => ({
        path,
        blob: new Blob([Uint8Array.from(bytes).buffer], { type: "text/plain;charset=utf-8" }),
    }));
    for (const [path, name] of trackNames) {
        const blob = source.get(path);
        if (blob === undefined) throw failed("An audited track disappeared during import.", path);
        files.push({ path: name, blob });
    }
    for (const [path, name] of sidecarNames) {
        const blob = source.get(path);
        if (blob === undefined) throw failed("An audited sidecar disappeared during import.", path);
        files.push({ path: name, blob });
    }
    return {
        entry: basename(plan.entryPath),
        files: Object.freeze(files.map((file) => Object.freeze(file))),
        descriptors: Object.freeze(descriptors.map(({ path, text }) => Object.freeze({ path, text }))),
        trackNames,
        sidecarNames,
    };
};
