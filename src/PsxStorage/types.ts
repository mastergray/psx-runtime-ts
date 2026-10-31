import { isPsxMachineInfo, isPsxSession } from "../shared.types.js";

import type { ControllerPort, PsxMachineInfo, PsxSession } from "../shared.types.js";

export const PSX_MEMORY_CARD_BYTES = 128 * 1024;

export type PsxStorageStore = "cards" | "states";

export interface PsxStorageMutation<T = unknown, R = unknown> {
    readonly value?: T;
    readonly delete?: true;
    readonly result: R;
}

export interface PsxStorageDriverLike {
    read(store: PsxStorageStore, key: string): Promise<unknown>;
    write(store: PsxStorageStore, key: string, value: unknown): Promise<void>;
    remove(store: PsxStorageStore, key: string): Promise<void>;
    list(store: PsxStorageStore): Promise<ReadonlyArray<unknown>>;
    update<T>(
        store: PsxStorageStore,
        key: string,
        updater: (current: unknown) => PsxStorageMutation<unknown, T>,
    ): Promise<T>;
}

export interface PsxIndexedDbFactoryLike {
    open(name: string, version?: number): IDBOpenDBRequest;
}

export interface PsxStorageConfig {
    readonly driver: PsxStorageDriverLike;
    readonly now: () => number;
}

export interface PsxStorageInitConfig {
    readonly indexedDB?: PsxIndexedDbFactoryLike;
    readonly now?: () => number;
    readonly databaseName?: string;
}

export interface PsxMemoryCardRecord {
    readonly profileId: string;
    readonly cardId: string;
    readonly revision: number;
    readonly updatedAt: string;
    readonly bytes: Uint8Array;
}

export interface PsxMemoryCardSaveConfig {
    readonly profileId: string;
    readonly cardId: string;
    readonly expectedRevision: number | null;
    readonly bytes: Uint8Array;
}

export interface PsxStateMetadata {
    readonly format: "psx-runtime-state";
    readonly version: 1;
    readonly adapter: "libretro-psx";
    readonly buildId: string;
    readonly core: string;
    readonly coreVersion: string;
    readonly gameId: string;
    readonly discIndex: number;
    readonly createdAt: string;
}

export interface PsxStateRecord {
    readonly profileId: string;
    readonly name: string;
    readonly metadata: PsxStateMetadata;
    readonly payload: Uint8Array;
}

export interface PsxStateSaveConfig {
    readonly profileId: string;
    readonly name: string;
    readonly machine: PsxMachineInfo;
    readonly discIndex: number;
    readonly payload: Uint8Array;
}

export interface PsxStateLoadConfig {
    readonly profileId: string;
    readonly name: string;
    readonly machine: PsxMachineInfo;
}

export interface PsxIntervalSchedulerLike {
    setInterval(callback: () => void, milliseconds: number): unknown;
    clearInterval(handle: unknown): void;
}

export interface PsxAutoSaveCardBinding {
    readonly cardId: string;
    readonly revision: number | null;
    readonly bytes?: Uint8Array;
}

export interface PsxCardAutoSaveConfig {
    readonly storage: {
        saveMemoryCard(config: PsxMemoryCardSaveConfig): Promise<PsxMemoryCardRecord>;
    };
    readonly session: PsxSession;
    readonly profileId: string;
    readonly cards: Readonly<Record<ControllerPort, PsxAutoSaveCardBinding>>;
    readonly scheduler: PsxIntervalSchedulerLike;
    readonly intervalMs?: number;
    readonly onError?: (error: unknown) => void;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null;

const isNonNegativeInteger = (value: unknown): value is number =>
    typeof value === "number" && Number.isInteger(value) && value >= 0;

const isUint8Array = (value: unknown): value is Uint8Array =>
    value instanceof Uint8Array || Object.prototype.toString.call(value) === "[object Uint8Array]";

export function isPsxStorageDriverLike(value: unknown): value is PsxStorageDriverLike {
    return isObject(value) && ["read", "write", "remove", "list", "update"]
        .every((method) => typeof value[method] === "function");
}

export function isPsxIndexedDbFactoryLike(value: unknown): value is PsxIndexedDbFactoryLike {
    return isObject(value) && typeof value.open === "function";
}

export function isPsxStorageConfig(value: unknown): value is PsxStorageConfig {
    return isObject(value) && isPsxStorageDriverLike(value.driver) && typeof value.now === "function";
}

export function isPsxStorageInitConfig(value: unknown): value is PsxStorageInitConfig {
    return isObject(value)
        && (value.indexedDB === undefined || isPsxIndexedDbFactoryLike(value.indexedDB))
        && (value.now === undefined || typeof value.now === "function")
        && (value.databaseName === undefined
            || (typeof value.databaseName === "string" && value.databaseName.trim().length > 0));
}

export function isPsxMemoryCardRecord(value: unknown): value is PsxMemoryCardRecord {
    return isObject(value) && typeof value.profileId === "string" && value.profileId.length > 0
        && typeof value.cardId === "string" && value.cardId.length > 0
        && typeof value.revision === "number" && Number.isInteger(value.revision) && value.revision > 0
        && typeof value.updatedAt === "string" && !Number.isNaN(Date.parse(value.updatedAt))
        && isUint8Array(value.bytes) && value.bytes.byteLength === PSX_MEMORY_CARD_BYTES;
}

export function isPsxMemoryCardSaveConfig(value: unknown): value is PsxMemoryCardSaveConfig {
    return isObject(value) && typeof value.profileId === "string" && typeof value.cardId === "string"
        && (value.expectedRevision === null || (isNonNegativeInteger(value.expectedRevision)
            && value.expectedRevision > 0))
        && isUint8Array(value.bytes) && value.bytes.byteLength === PSX_MEMORY_CARD_BYTES;
}

export function isPsxStateMetadata(value: unknown): value is PsxStateMetadata {
    return isObject(value) && value.format === "psx-runtime-state" && value.version === 1
        && value.adapter === "libretro-psx" && typeof value.buildId === "string"
        && /^[a-f0-9]{64}$/u.test(value.buildId) && typeof value.core === "string" && value.core.length > 0
        && typeof value.coreVersion === "string" && value.coreVersion.length > 0
        && typeof value.gameId === "string" && value.gameId.length > 0
        && isNonNegativeInteger(value.discIndex) && typeof value.createdAt === "string"
        && !Number.isNaN(Date.parse(value.createdAt));
}

export function isPsxStateRecord(value: unknown): value is PsxStateRecord {
    return isObject(value) && typeof value.profileId === "string" && value.profileId.length > 0
        && typeof value.name === "string" && value.name.length > 0
        && isPsxStateMetadata(value.metadata) && isUint8Array(value.payload)
        && value.payload.byteLength > 0;
}

export function isPsxStateSaveConfig(value: unknown): value is PsxStateSaveConfig {
    return isObject(value) && typeof value.profileId === "string" && typeof value.name === "string"
        && isPsxMachineInfo(value.machine) && isNonNegativeInteger(value.discIndex)
        && value.discIndex < value.machine.discCount && isUint8Array(value.payload)
        && value.payload.byteLength > 0;
}

export function isPsxStateLoadConfig(value: unknown): value is PsxStateLoadConfig {
    return isObject(value) && typeof value.profileId === "string" && typeof value.name === "string"
        && isPsxMachineInfo(value.machine);
}

export function isPsxIntervalSchedulerLike(value: unknown): value is PsxIntervalSchedulerLike {
    return isObject(value) && typeof value.setInterval === "function"
        && typeof value.clearInterval === "function";
}

const isBinding = (value: unknown): value is PsxAutoSaveCardBinding => isObject(value)
    && typeof value.cardId === "string" && value.cardId.trim().length > 0
    && (value.revision === null || (isNonNegativeInteger(value.revision) && value.revision > 0))
    && (value.bytes === undefined || (isUint8Array(value.bytes)
        && value.bytes.byteLength === PSX_MEMORY_CARD_BYTES));

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
