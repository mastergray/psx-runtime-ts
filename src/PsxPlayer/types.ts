import { isPsxAdapter } from "../shared.types.js";

import type {
    ControllerPort,
    PsxAdapter,
    PsxSession,
    Unsubscribe,
} from "../shared.types.js";
import type {
    PsxMemoryCardRecord,
    PsxMemoryCardSaveConfig,
    PsxStateLoadConfig,
    PsxStateRecord,
    PsxStateSaveConfig,
} from "../PsxStorage/types.js";

export type PsxPlayerStatus =
    | "idle" | "starting" | "running" | "paused" | "stopping" | "failed" | "destroyed";

export interface PsxPlayerDisplayLike {
    readonly hasFrame: boolean;
    attach(session: PsxSession): Unsubscribe;
    detach(): void;
    destroy(): void;
}
export interface PsxPlayerAudioLike {
    resetQueue(): void;
    destroy(): void;
}

export interface PsxPlayerStorageLike {
    loadMemoryCard(profileId: string, cardId: string): Promise<PsxMemoryCardRecord | null>;
    saveMemoryCard(config: PsxMemoryCardSaveConfig): Promise<PsxMemoryCardRecord>;
    saveState(config: PsxStateSaveConfig): Promise<PsxStateRecord>;
    loadState(config: PsxStateLoadConfig): Promise<PsxStateRecord | null>;
    deleteState(profileId: string, gameId: string, name: string): Promise<void>;
}

export interface PsxPlayerIntervalSchedulerLike {
    setInterval(callback: () => void, milliseconds: number): unknown;
    clearInterval(handle: unknown): void;
}

export interface PsxPlayerConfig {
    readonly adapter: PsxAdapter;
    readonly display: PsxPlayerDisplayLike;
    readonly createAudio: (session: PsxSession) => PsxPlayerAudioLike;
    readonly storage?: PsxPlayerStorageLike;
    readonly profileId?: string;
    readonly memoryCardIds?: Readonly<Record<ControllerPort, string>>;
    readonly intervalScheduler?: PsxPlayerIntervalSchedulerLike;
    readonly autoSaveIntervalMs?: number;
}

export interface PsxPlayerEventMap {
    readonly status: PsxPlayerStatus;
    readonly error: unknown;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null;

export function isPsxPlayerStatus(value: unknown): value is PsxPlayerStatus {
    return value === "idle" || value === "starting" || value === "running" || value === "paused"
        || value === "stopping" || value === "failed" || value === "destroyed";
}

export function isPsxPlayerDisplayLike(value: unknown): value is PsxPlayerDisplayLike {
    return isObject(value) && typeof value.hasFrame === "boolean" && typeof value.attach === "function"
        && typeof value.detach === "function" && typeof value.destroy === "function";
}

export function isPsxPlayerAudioLike(value: unknown): value is PsxPlayerAudioLike {
    return isObject(value) && typeof value.resetQueue === "function" && typeof value.destroy === "function";
}

export function isPsxPlayerStorageLike(value: unknown): value is PsxPlayerStorageLike {
    return isObject(value) && ["loadMemoryCard", "saveMemoryCard", "saveState", "loadState", "deleteState"]
        .every((method) => typeof value[method] === "function");
}

export function isPsxPlayerIntervalSchedulerLike(value: unknown): value is PsxPlayerIntervalSchedulerLike {
    return isObject(value) && typeof value.setInterval === "function"
        && typeof value.clearInterval === "function";
}

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
