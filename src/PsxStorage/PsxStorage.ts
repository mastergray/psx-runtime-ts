// Dependencies:
import PsxRuntimeError from "../PsxRuntimeError/PsxRuntimeError.js";    // Reports validation, persistence, and compatibility failures
import {
    isBiosImage,          // Validates firmware before persistence
    isPsxMachineInfo,     // Validates the machine identity used for state compatibility
    isPsxRegion,          // Validates firmware lookup and deletion keys
} from "../shared.types.js";
import IndexedDbDriver from "./IndexedDbDriver.js";                    // Supplies the browser persistence backend used by init()
import {
    isPsxMemoryCardRecord,       // Validates current and previous card revisions read from storage
    isPsxMemoryCardSaveConfig,   // Validates card identity, length, and expected revision
    isPsxFirmwareRecord,         // Validates firmware records read from storage
    isPsxStateLoadConfig,        // Validates save-state lookup input
    isPsxStateRecord,            // Validates save-state records read from storage
    isPsxStateSaveConfig,        // Validates save-state persistence input
    isPsxStorageConfig,          // Validates direct construction dependencies
    isPsxStorageInitConfig,      // Validates browser factory options
    PSX_MEMORY_CARD_BYTES,       // Canonical physical memory-card length
} from "./types.js";

// Type dependencies:
import type {
    BiosImage,         // Validated firmware image supplied for persistence
    PsxMachineInfo,    // Active build and content identity for save states
    PsxRegion,         // Firmware partition key
} from "../shared.types.js";
import type {
    PsxFirmwareRecord,          // Versioned firmware persistence shape
    PsxMemoryCardRecord,        // Versioned immutable card revision
    PsxMemoryCardSaveConfig,    // Optimistic card-write request
    PsxStateLoadConfig,         // Named state lookup and active machine identity
    PsxStateMetadata,           // Compatibility metadata embedded in a save state
    PsxStateRecord,             // Persisted save-state payload and metadata
    PsxStateSaveConfig,         // Named save-state write request
    PsxStorageConfig,           // Injected driver and clock dependencies
    PsxStorageInitConfig,       // Optional IndexedDB factory settings
} from "./types.js";

/**
 *
 * Type Declarations
 *
 */

// TYPE :: {current:psxMemoryCardRecord, previous:psxMemoryCardRecord?}
// Two-revision envelope used for current data and one recovery fallback.
interface StoredCard {
    readonly current: PsxMemoryCardRecord;            // Most recently committed card revision
    readonly previous: PsxMemoryCardRecord | null;     // Immediately preceding revision when one exists
}

const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;

/**
 *
 * Class
 *
 */

// Persists firmware, memory-card revisions, and compatible save states behind one driver.
export default class PsxStorage {

    /* Static Fields */
    static readonly DATABASE_NAME = "psx-runtime";                     // Default browser database name
    static readonly MEMORY_CARD_BYTES = PSX_MEMORY_CARD_BYTES;         // Public canonical card byte length

    /* Instance Fields */
    private readonly _driver: PsxStorageConfig["driver"];              // Transactional persistence boundary
    private readonly _now: () => number;                                // Injectable clock for deterministic metadata

    // CONSTRUCTOR :: psxStorageConfig -> psxStorage
    // Validates and retains the persistence driver and clock.
    constructor(config: PsxStorageConfig) {
        if (!isPsxStorageConfig(config)) throw invalid("PsxStorage config is invalid.", config);
        this._driver = config.driver;
        this._now = config.now;
    }

    /**
     *
     * Instance Methods
     *
     */

    // METHOD :: STRING, STRING -> PROMISE(psxMemoryCardRecord?)
    // Loads the current defensive card revision for one profile and card identity.
    async loadMemoryCard(profileId: string, cardId: string): Promise<PsxMemoryCardRecord | null> {
        const profile = normalizedIdentity(profileId, "profileId");
        const card = normalizedIdentity(cardId, "cardId");
        const stored = await this._storageCall(() => this._driver.read("cards", cardKey(profile, card)));
        if (stored === undefined) return null;
        if (!isStoredCardFor(stored, profile, card)) {
            throw storageFailed("The stored memory card record is malformed.", null);
        }
        return copyCard(stored.current);
    }

    // METHOD :: STRING, STRING -> PROMISE([psxMemoryCardRecord])
    // Loads current and previous defensive card revisions in descending recency.
    async loadMemoryCardRevisions(
        profileId: string,
        cardId: string,
    ): Promise<ReadonlyArray<PsxMemoryCardRecord>> {
        const profile = normalizedIdentity(profileId, "profileId");
        const card = normalizedIdentity(cardId, "cardId");
        const stored = await this._storageCall(() => this._driver.read("cards", cardKey(profile, card)));
        if (stored === undefined) return Object.freeze([]);
        if (!isStoredCardFor(stored, profile, card)) {
            throw storageFailed("The stored memory card record is malformed.", null);
        }
        return Object.freeze([stored.current, stored.previous]
            .filter((record): record is PsxMemoryCardRecord => record !== null)
            .map(copyCard));
    }

    // METHOD :: psxMemoryCardSaveConfig -> PROMISE(psxMemoryCardRecord)
    // Atomically writes one card revision using optimistic concurrency.
    async saveMemoryCard(config: PsxMemoryCardSaveConfig): Promise<PsxMemoryCardRecord> {
        if (!isPsxMemoryCardSaveConfig(config)) {
            throw invalid(`Memory cards must contain exactly ${PSX_MEMORY_CARD_BYTES} bytes.`, config);
        }
        const profileId = normalizedIdentity(config.profileId, "profileId");
        const cardId = normalizedIdentity(config.cardId, "cardId");
        const bytes = config.bytes.slice();
        const timestamp = this._timestamp();
        return this._storageCall(() => this._driver.update(
            "cards",
            cardKey(profileId, cardId),
            (stored) => {
                if (stored !== undefined && !isStoredCardFor(stored, profileId, cardId)) {
                    throw storageFailed("The stored memory card record is malformed.", null);
                }
                const current = stored?.current ?? null;
                const actualRevision = current?.revision ?? null;
                if (config.expectedRevision !== actualRevision) throw storageFailed(
                    "The memory card changed in another writer.",
                    Object.freeze({
                        type: "revision-conflict",
                        profileId,
                        cardId,
                        expectedRevision: config.expectedRevision,
                        actualRevision,
                    }),
                );
                const record: PsxMemoryCardRecord = {
                    profileId,
                    cardId,
                    revision: (actualRevision ?? 0) + 1,
                    updatedAt: timestamp,
                    bytes,
                };
                const value: StoredCard = { current: record, previous: current };
                return { value, result: copyCard(record) };
            },
        ));
    }

    // METHOD :: STRING, STRING -> PROMISE(VOID)
    // Deletes every retained revision for one profile card.
    async deleteMemoryCard(profileId: string, cardId: string): Promise<void> {
        const profile = normalizedIdentity(profileId, "profileId");
        const card = normalizedIdentity(cardId, "cardId");
        await this._storageCall(() => this._driver.remove("cards", cardKey(profile, card)));
    }

    // METHOD :: biosImage -> PROMISE(psxFirmwareRecord)
    // Stores a defensive versioned firmware record by region.
    async saveFirmware(image: BiosImage): Promise<PsxFirmwareRecord> {
        if (!isBiosImage(image)) throw invalid("Firmware image is invalid.", image);
        const record: PsxFirmwareRecord = {
            format: "psx-runtime-firmware",
            version: 1,
            name: image.name,
            region: image.region,
            blob: image.blob.slice(0, image.blob.size, image.blob.type),
            ...(image.sha256 === undefined ? {} : { sha256: image.sha256 }),
            storedAt: this._timestamp(),
        };
        await this._storageCall(() => this._driver.write("firmware", image.region, record));
        return copyFirmware(record);
    }

    // METHOD :: psxRegion -> PROMISE(psxFirmwareRecord?)
    // Loads and validates a defensive firmware record for one region.
    async loadFirmware(region: PsxRegion): Promise<PsxFirmwareRecord | null> {
        if (!isPsxRegion(region)) throw invalid("Firmware region is invalid.", region);
        const stored = await this._storageCall(() => this._driver.read("firmware", region));
        if (stored === undefined) return null;
        if (!isPsxFirmwareRecord(stored) || stored.region !== region) {
            throw storageFailed("The stored firmware record is malformed.", region);
        }
        return copyFirmware(stored);
    }

    // METHOD :: VOID -> PROMISE([psxFirmwareRecord])
    // Lists validated defensive firmware records in regional order.
    async listFirmware(): Promise<ReadonlyArray<PsxFirmwareRecord>> {
        const values = await this._storageCall(() => this._driver.list("firmware"));
        const records = values.map((value) => {
            if (!isPsxFirmwareRecord(value)) {
                throw storageFailed("A stored firmware record is malformed.", null);
            }
            return copyFirmware(value);
        });
        records.sort((left, right) => left.region.localeCompare(right.region));
        return Object.freeze(records);
    }

    // METHOD :: psxRegion -> PROMISE(VOID)
    // Deletes the firmware record for one region.
    async deleteFirmware(region: PsxRegion): Promise<void> {
        if (!isPsxRegion(region)) throw invalid("Firmware region is invalid.", region);
        await this._storageCall(() => this._driver.remove("firmware", region));
    }

    // METHOD :: psxStateSaveConfig -> PROMISE(psxStateRecord)
    // Stores one named state with immutable build and content compatibility metadata.
    async saveState(config: PsxStateSaveConfig): Promise<PsxStateRecord> {
        if (!isPsxStateSaveConfig(config)) throw invalid("Save-state config is invalid.", config);
        const profileId = normalizedIdentity(config.profileId, "profileId");
        const name = normalizedIdentity(config.name, "Save-state name");
        const metadata: PsxStateMetadata = Object.freeze({
            format: "psx-runtime-state",
            version: 1,
            adapter: "libretro-psx",
            buildId: config.machine.buildId,
            core: config.machine.core,
            coreVersion: config.machine.coreVersion,
            gameId: config.machine.gameId,
            discIndex: config.discIndex,
            createdAt: this._timestamp(),
        });
        const record: PsxStateRecord = { profileId, name, metadata, payload: config.payload.slice() };
        await this._storageCall(() => this._driver.write(
            "states",
            stateKey(profileId, metadata.gameId, name),
            record,
        ));
        return copyState(record);
    }

    // METHOD :: psxStateLoadConfig -> PROMISE(psxStateRecord?)
    // Loads one named state only when it matches the active session identity.
    async loadState(config: PsxStateLoadConfig): Promise<PsxStateRecord | null> {
        if (!isPsxStateLoadConfig(config)) throw invalid("Save-state lookup is invalid.", config);
        const profileId = normalizedIdentity(config.profileId, "profileId");
        const name = normalizedIdentity(config.name, "Save-state name");
        const stored = await this._storageCall(() => this._driver.read(
            "states",
            stateKey(profileId, config.machine.gameId, name),
        ));
        if (stored === undefined) return null;
        if (!isPsxStateRecord(stored)) throw incompatible({ reason: "malformed" });
        assertCompatible(stored, profileId, name, config.machine);
        return copyState(stored);
    }

    // METHOD :: STRING, STRING -> PROMISE([psxStateRecord])
    // Lists defensive state records for an exact profile and game identity.
    async listStates(profileId: string, gameId: string): Promise<ReadonlyArray<PsxStateRecord>> {
        const profile = normalizedIdentity(profileId, "profileId");
        const game = exactGameId(gameId);
        const stored = await this._storageCall(() => this._driver.list("states"));
        const records: PsxStateRecord[] = [];
        for (const value of stored) {
            if (!isPsxStateRecord(value)) throw storageFailed("A stored save-state record is malformed.", null);
            if (value.profileId === profile && value.metadata.gameId === game) records.push(copyState(value));
        }
        records.sort((left, right) => left.name.localeCompare(right.name));
        return Object.freeze(records);
    }

    // METHOD :: STRING, STRING, STRING -> PROMISE(VOID)
    // Deletes one named state for an exact profile and game identity.
    async deleteState(profileId: string, gameId: string, name: string): Promise<void> {
        const profile = normalizedIdentity(profileId, "profileId");
        const game = exactGameId(gameId);
        const normalizedName = normalizedIdentity(name, "Save-state name");
        await this._storageCall(() => this._driver.remove(
            "states",
            stateKey(profile, game, normalizedName),
        ));
    }

    /**
     *
     * Private Methods
     *
     */

    // METHOD :: VOID -> STRING
    // Samples the clock and returns a validated ISO timestamp.
    private _timestamp(): string {
        const now = this._now();
        if (!Number.isFinite(now)) throw storageFailed("The storage clock returned an invalid time.", now);
        return new Date(now).toISOString();
    }

    // METHOD :: (VOID -> PROMISE(T)) -> PROMISE(T)
    // Preserves typed runtime errors and wraps untyped driver failures.
    private async _storageCall<T>(operation: () => Promise<T>): Promise<T> {
        try {
            return await operation();
        } catch (error) {
            if (PsxRuntimeError.is(error)) throw error;
            throw storageFailed("Persistent storage failed.", error);
        }
    }

    /**
     *
     * Static Methods
     *
     */

    // Static Factory Method :: psxStorageInitConfig? -> psxStorage
    // Creates browser storage from IndexedDB and the configured clock.
    static init(config: PsxStorageInitConfig = {}): PsxStorage {
        if (!isPsxStorageInitConfig(config)) throw invalid("PsxStorage init config is invalid.", config);
        const indexedDB = config.indexedDB ?? globalThis.indexedDB;
        if (indexedDB === undefined) throw new PsxRuntimeError({
            code: PsxRuntimeError.CODE.UNSUPPORTED,
            message: "IndexedDB is unavailable.",
        });
        return new PsxStorage({
            driver: new IndexedDbDriver(indexedDB, config.databaseName ?? PsxStorage.DATABASE_NAME),
            now: config.now ?? (() => Date.now()),
        });
    }
}

/**
 *
 *  Helper Functions
 *
 */

// Unicode control characters forbidden in user identities

// HELPER :: STRING, UNKNOWN -> psxRuntimeError
// Creates one invalid public storage request error.
const invalid = (message: string, data: unknown): PsxRuntimeError => new PsxRuntimeError({
    code: PsxRuntimeError.CODE.INVALID_CONFIG,
    message,
    data,
});

// HELPER :: STRING, UNKNOWN -> psxRuntimeError
// Creates one persistence or record-integrity error.
const storageFailed = (message: string, data: unknown): PsxRuntimeError => new PsxRuntimeError({
    code: PsxRuntimeError.CODE.STORAGE_FAILED,
    message,
    data,
});

// HELPER :: UNKNOWN -> psxRuntimeError
// Creates one save-state compatibility error.
const incompatible = (data: unknown): PsxRuntimeError => new PsxRuntimeError({
    code: PsxRuntimeError.CODE.STATE_INCOMPATIBLE,
    message: "The save state is incompatible with this session.",
    data,
});

// HELPER :: UNKNOWN, STRING -> STRING
// Normalizes bounded user-facing identifiers without changing their meaning.
const normalizedIdentity = (value: unknown, label: string): string => {
    if (typeof value !== "string") throw invalid(`${label} must be a string.`, value);
    const normalized = value.trim().normalize("NFC");
    const codePoints = [...normalized];
    if (normalized.length === 0 || codePoints.length > 80 || CONTROL_PATTERN.test(normalized)) {
        throw invalid(`${label} must contain 1 to 80 non-control Unicode code points.`, value);
    }
    return normalized;
};

// HELPER :: psxMemoryCardRecord -> psxMemoryCardRecord
// Returns an immutable defensive copy of a card revision.
const copyCard = (record: PsxMemoryCardRecord): PsxMemoryCardRecord => Object.freeze({
    ...record,
    bytes: record.bytes.slice(),
});

// HELPER :: psxStateRecord -> psxStateRecord
// Returns an immutable defensive copy of a save-state record.
const copyState = (record: PsxStateRecord): PsxStateRecord => Object.freeze({
    ...record,
    metadata: Object.freeze({ ...record.metadata }),
    payload: record.payload.slice(),
});

// HELPER :: psxFirmwareRecord -> psxFirmwareRecord
// Returns an immutable defensive copy of a firmware record.
const copyFirmware = (record: PsxFirmwareRecord): PsxFirmwareRecord => Object.freeze({
    ...record,
    blob: record.blob.slice(0, record.blob.size, record.blob.type),
});

// HELPER :: UNKNOWN -> BOOLEAN
// Narrows persisted data to a structurally valid two-revision card envelope.
const isStoredCard = (value: unknown): value is StoredCard => typeof value === "object"
    && value !== null && isPsxMemoryCardRecord((value as StoredCard).current)
    && ((value as StoredCard).previous === null || isPsxMemoryCardRecord((value as StoredCard).previous));

// HELPER :: UNKNOWN, STRING, STRING -> BOOLEAN
// Narrows a card envelope and verifies its key identities and revision ordering.
const isStoredCardFor = (value: unknown, profileId: string, cardId: string): value is StoredCard => {
    if (!isStoredCard(value) || value.current.profileId !== profileId || value.current.cardId !== cardId) return false;
    return value.previous === null || (value.previous.profileId === profileId
        && value.previous.cardId === cardId && value.previous.revision < value.current.revision);
};

// HELPER :: STRING, STRING -> STRING
// Produces the collision-safe storage key for one profile memory card.
const cardKey = (profileId: string, cardId: string): string => JSON.stringify([profileId, cardId]);

// HELPER :: STRING, STRING, STRING -> STRING
// Produces the collision-safe storage key for one named save state.
const stateKey = (profileId: string, gameId: string, name: string): string =>
    JSON.stringify([profileId, gameId, name]);

// HELPER :: UNKNOWN -> STRING
// Preserves an exact non-empty game identity without display-name normalization.
const exactGameId = (value: unknown): string => {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw invalid("gameId must be a non-empty string.", value);
    }
    return value;
};

// HELPER :: psxStateRecord, STRING, STRING, psxMachineInfo -> VOID
// Rejects a save state whose identity or build contract differs from the active session.
const assertCompatible = (
    record: PsxStateRecord,
    profileId: string,
    name: string,
    machine: PsxMachineInfo,
): void => {
    if (!isPsxMachineInfo(machine) || record.profileId !== profileId || record.name !== name
        || record.metadata.format !== "psx-runtime-state" || record.metadata.version !== 1
        || record.metadata.adapter !== "libretro-psx" || record.metadata.buildId !== machine.buildId
        || record.metadata.core !== machine.core || record.metadata.coreVersion !== machine.coreVersion
        || record.metadata.gameId !== machine.gameId
        || record.metadata.discIndex >= machine.discCount) {
        throw incompatible({
            expected: {
                profileId,
                name,
                buildId: machine.buildId,
                core: machine.core,
                coreVersion: machine.coreVersion,
                gameId: machine.gameId,
            },
            actual: {
                profileId: record.profileId,
                name: record.name,
                buildId: record.metadata.buildId,
                core: record.metadata.core,
                coreVersion: record.metadata.coreVersion,
                gameId: record.metadata.gameId,
            },
        });
    }
};
