import PsxRuntimeError from "../PsxRuntimeError/PsxRuntimeError.js";
import { isPsxMachineInfo } from "../shared.types.js";
import IndexedDbDriver from "./IndexedDbDriver.js";
import {
    isPsxMemoryCardRecord,
    isPsxMemoryCardSaveConfig,
    isPsxStateLoadConfig,
    isPsxStateRecord,
    isPsxStateSaveConfig,
    isPsxStorageConfig,
    isPsxStorageInitConfig,
    PSX_MEMORY_CARD_BYTES,
} from "./types.js";

import type { PsxMachineInfo } from "../shared.types.js";
import type {
    PsxMemoryCardRecord,
    PsxMemoryCardSaveConfig,
    PsxStateLoadConfig,
    PsxStateMetadata,
    PsxStateRecord,
    PsxStateSaveConfig,
    PsxStorageConfig,
    PsxStorageInitConfig,
} from "./types.js";

interface StoredCard {
    readonly current: PsxMemoryCardRecord;
    readonly previous: PsxMemoryCardRecord | null;
}

const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;

const invalid = (message: string, data: unknown): PsxRuntimeError => new PsxRuntimeError({
    code: PsxRuntimeError.CODE.INVALID_CONFIG,
    message,
    data,
});

const storageFailed = (message: string, data: unknown): PsxRuntimeError => new PsxRuntimeError({
    code: PsxRuntimeError.CODE.STORAGE_FAILED,
    message,
    data,
});

const incompatible = (data: unknown): PsxRuntimeError => new PsxRuntimeError({
    code: PsxRuntimeError.CODE.STATE_INCOMPATIBLE,
    message: "The save state is incompatible with this session.",
    data,
});

const normalizedIdentity = (value: unknown, label: string): string => {
    if (typeof value !== "string") throw invalid(`${label} must be a string.`, value);
    const normalized = value.trim().normalize("NFC");
    const codePoints = [...normalized];
    if (normalized.length === 0 || codePoints.length > 80 || CONTROL_PATTERN.test(normalized)) {
        throw invalid(`${label} must contain 1 to 80 non-control Unicode code points.`, value);
    }
    return normalized;
};

const copyCard = (record: PsxMemoryCardRecord): PsxMemoryCardRecord => Object.freeze({
    ...record,
    bytes: record.bytes.slice(),
});

const copyState = (record: PsxStateRecord): PsxStateRecord => Object.freeze({
    ...record,
    metadata: Object.freeze({ ...record.metadata }),
    payload: record.payload.slice(),
});

const isStoredCard = (value: unknown): value is StoredCard => typeof value === "object"
    && value !== null && isPsxMemoryCardRecord((value as StoredCard).current)
    && ((value as StoredCard).previous === null || isPsxMemoryCardRecord((value as StoredCard).previous));

const isStoredCardFor = (value: unknown, profileId: string, cardId: string): value is StoredCard => {
    if (!isStoredCard(value) || value.current.profileId !== profileId || value.current.cardId !== cardId) return false;
    return value.previous === null || (value.previous.profileId === profileId
        && value.previous.cardId === cardId && value.previous.revision < value.current.revision);
};

export default class PsxStorage {
    static readonly DATABASE_NAME = "psx-runtime";
    static readonly MEMORY_CARD_BYTES = PSX_MEMORY_CARD_BYTES;

    readonly #driver: PsxStorageConfig["driver"];
    readonly #now: () => number;

    constructor(config: PsxStorageConfig) {
        if (!isPsxStorageConfig(config)) throw invalid("PsxStorage config is invalid.", config);
        this.#driver = config.driver;
        this.#now = config.now;
    }

    async loadMemoryCard(profileId: string, cardId: string): Promise<PsxMemoryCardRecord | null> {
        const profile = normalizedIdentity(profileId, "profileId");
        const card = normalizedIdentity(cardId, "cardId");
        const stored = await this.#storageCall(() => this.#driver.read("cards", PsxStorage.cardKey(profile, card)));
        if (stored === undefined) return null;
        if (!isStoredCardFor(stored, profile, card)) {
            throw storageFailed("The stored memory card record is malformed.", null);
        }
        return copyCard(stored.current);
    }

    async loadMemoryCardRevisions(
        profileId: string,
        cardId: string,
    ): Promise<ReadonlyArray<PsxMemoryCardRecord>> {
        const profile = normalizedIdentity(profileId, "profileId");
        const card = normalizedIdentity(cardId, "cardId");
        const stored = await this.#storageCall(() => this.#driver.read("cards", PsxStorage.cardKey(profile, card)));
        if (stored === undefined) return Object.freeze([]);
        if (!isStoredCardFor(stored, profile, card)) {
            throw storageFailed("The stored memory card record is malformed.", null);
        }
        return Object.freeze([stored.current, stored.previous]
            .filter((record): record is PsxMemoryCardRecord => record !== null)
            .map(copyCard));
    }

    async saveMemoryCard(config: PsxMemoryCardSaveConfig): Promise<PsxMemoryCardRecord> {
        if (!isPsxMemoryCardSaveConfig(config)) {
            throw invalid(`Memory cards must contain exactly ${PSX_MEMORY_CARD_BYTES} bytes.`, config);
        }
        const profileId = normalizedIdentity(config.profileId, "profileId");
        const cardId = normalizedIdentity(config.cardId, "cardId");
        const bytes = config.bytes.slice();
        const timestamp = this.#timestamp();
        return this.#storageCall(() => this.#driver.update(
            "cards",
            PsxStorage.cardKey(profileId, cardId),
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

    async deleteMemoryCard(profileId: string, cardId: string): Promise<void> {
        const profile = normalizedIdentity(profileId, "profileId");
        const card = normalizedIdentity(cardId, "cardId");
        await this.#storageCall(() => this.#driver.remove("cards", PsxStorage.cardKey(profile, card)));
    }

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
            createdAt: this.#timestamp(),
        });
        const record: PsxStateRecord = { profileId, name, metadata, payload: config.payload.slice() };
        await this.#storageCall(() => this.#driver.write(
            "states",
            PsxStorage.stateKey(profileId, metadata.gameId, name),
            record,
        ));
        return copyState(record);
    }

    async loadState(config: PsxStateLoadConfig): Promise<PsxStateRecord | null> {
        if (!isPsxStateLoadConfig(config)) throw invalid("Save-state lookup is invalid.", config);
        const profileId = normalizedIdentity(config.profileId, "profileId");
        const name = normalizedIdentity(config.name, "Save-state name");
        const stored = await this.#storageCall(() => this.#driver.read(
            "states",
            PsxStorage.stateKey(profileId, config.machine.gameId, name),
        ));
        if (stored === undefined) return null;
        if (!isPsxStateRecord(stored)) throw incompatible({ reason: "malformed" });
        PsxStorage.assertCompatible(stored, profileId, name, config.machine);
        return copyState(stored);
    }

    async listStates(profileId: string, gameId: string): Promise<ReadonlyArray<PsxStateRecord>> {
        const profile = normalizedIdentity(profileId, "profileId");
        const game = PsxStorage.exactGameId(gameId);
        const stored = await this.#storageCall(() => this.#driver.list("states"));
        const records: PsxStateRecord[] = [];
        for (const value of stored) {
            if (!isPsxStateRecord(value)) throw storageFailed("A stored save-state record is malformed.", null);
            if (value.profileId === profile && value.metadata.gameId === game) records.push(copyState(value));
        }
        records.sort((left, right) => left.name.localeCompare(right.name));
        return Object.freeze(records);
    }

    async deleteState(profileId: string, gameId: string, name: string): Promise<void> {
        const profile = normalizedIdentity(profileId, "profileId");
        const game = PsxStorage.exactGameId(gameId);
        const normalizedName = normalizedIdentity(name, "Save-state name");
        await this.#storageCall(() => this.#driver.remove(
            "states",
            PsxStorage.stateKey(profile, game, normalizedName),
        ));
    }

    #timestamp(): string {
        const now = this.#now();
        if (!Number.isFinite(now)) throw storageFailed("The storage clock returned an invalid time.", now);
        return new Date(now).toISOString();
    }

    async #storageCall<T>(operation: () => Promise<T>): Promise<T> {
        try {
            return await operation();
        } catch (error) {
            if (PsxRuntimeError.is(error)) throw error;
            throw storageFailed("Persistent storage failed.", error);
        }
    }

    private static cardKey(profileId: string, cardId: string): string {
        return JSON.stringify([profileId, cardId]);
    }

    private static stateKey(profileId: string, gameId: string, name: string): string {
        return JSON.stringify([profileId, gameId, name]);
    }

    private static exactGameId(value: unknown): string {
        if (typeof value !== "string" || value.trim().length === 0) {
            throw invalid("gameId must be a non-empty string.", value);
        }
        return value;
    }

    private static assertCompatible(
        record: PsxStateRecord,
        profileId: string,
        name: string,
        machine: PsxMachineInfo,
    ): void {
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
    }

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
