import { isDiscSet } from "../shared.types.js";

import type { DiscSet } from "../shared.types.js";

export interface PsxStoredGame {
    readonly gameId: string;
    readonly displayTitle: string;
    readonly importedAt: string;
    readonly totalBytes: number;
    readonly fileCount: number;
    readonly discCount: number;
}

export interface PsxGameImportOptions {
    readonly displayTitle?: string;
    readonly signal?: AbortSignal;
}

export interface PsxGameStoreDriverLike {
    read(gameId: string): Promise<unknown>;
    list(): Promise<ReadonlyArray<unknown>>;
    write(gameId: string, value: unknown): Promise<void>;
    remove(gameId: string): Promise<void>;
    update<T>(gameId: string, updater: (current: unknown) => {
        readonly value: unknown;
        readonly result: T;
    }): Promise<T>;
}

export interface PsxBlobHasherLike {
    hash(blob: Blob, signal?: AbortSignal): Promise<string>;
}

export interface PsxStorageEstimate {
    readonly usage?: number;
    readonly quota?: number;
}

export interface PsxStorageManagerLike {
    estimate(): Promise<PsxStorageEstimate>;
}

export interface PsxGameStoreConfig {
    readonly driver: PsxGameStoreDriverLike;
    readonly hasher: PsxBlobHasherLike;
    readonly now: () => number;
    readonly storageManager?: PsxStorageManagerLike;
}

export interface PsxGameStoreInitConfig {
    readonly indexedDB?: IDBFactory;
    readonly storageManager?: PsxStorageManagerLike;
    readonly now?: () => number;
    readonly databaseName?: string;
    readonly createHasher?: () => PsxBlobHasherLike;
}

export interface PsxStoredGameRecord extends PsxStoredGame {
    readonly format: "psx-runtime-game";
    readonly version: 1;
    readonly game: DiscSet;
}

const GAME_ID = /^psx-v1-[a-f0-9]{64}$/u;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T/u;

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null;

const isNonNegativeSafeInteger = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export function isPsxStoredGame(value: unknown): value is PsxStoredGame {
    return isObject(value) && typeof value.gameId === "string" && GAME_ID.test(value.gameId)
        && typeof value.displayTitle === "string" && value.displayTitle.length > 0
        && value.displayTitle.length <= 160 && typeof value.importedAt === "string"
        && ISO_DATE.test(value.importedAt) && !Number.isNaN(Date.parse(value.importedAt))
        && isNonNegativeSafeInteger(value.totalBytes) && value.totalBytes > 0
        && isNonNegativeSafeInteger(value.fileCount) && value.fileCount > 0
        && isNonNegativeSafeInteger(value.discCount) && value.discCount > 0;
}

export function isPsxStoredGameRecord(value: unknown): value is PsxStoredGameRecord {
    if (!isObject(value) || !isPsxStoredGame(value)) return false;
    return value.format === "psx-runtime-game" && value.version === 1
        && isDiscSet(value.game) && value.game.gameId === value.gameId
        && value.game.files.length === value.fileCount;
}

export function isPsxGameStoreDriverLike(value: unknown): value is PsxGameStoreDriverLike {
    return isObject(value) && ["read", "list", "write", "remove", "update"]
        .every((method) => typeof value[method] === "function");
}

export function isPsxBlobHasherLike(value: unknown): value is PsxBlobHasherLike {
    return isObject(value) && typeof value.hash === "function";
}

export function isPsxStorageManagerLike(value: unknown): value is PsxStorageManagerLike {
    return isObject(value) && typeof value.estimate === "function";
}

export function isPsxGameStoreConfig(value: unknown): value is PsxGameStoreConfig {
    return isObject(value) && isPsxGameStoreDriverLike(value.driver)
        && isPsxBlobHasherLike(value.hasher) && typeof value.now === "function"
        && (value.storageManager === undefined || isPsxStorageManagerLike(value.storageManager));
}

export function isPsxGameStoreInitConfig(value: unknown): value is PsxGameStoreInitConfig {
    return isObject(value) && (value.indexedDB === undefined
        || (isObject(value.indexedDB) && typeof value.indexedDB.open === "function"))
        && (value.storageManager === undefined || isPsxStorageManagerLike(value.storageManager))
        && (value.now === undefined || typeof value.now === "function")
        && (value.databaseName === undefined || (typeof value.databaseName === "string"
            && value.databaseName.trim().length > 0))
        && (value.createHasher === undefined || typeof value.createHasher === "function");
}
