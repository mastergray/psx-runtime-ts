import { isPsxAdapter } from "../shared.types.js";
import { isPsxCanvasLike, isPsxContainerLike } from "../PsxDisplay/types.js";
import { isPsxGestureSourceLike } from "../PsxAudio/types.js";
import { isGamepadSourceConfig } from "../GamepadSource/types.js";
import { isKeyboardSourceConfig } from "../KeyboardSource/types.js";
import {
    isPsxPlayerIntervalSchedulerLike,
    isPsxPlayerStatus,
    isPsxPlayerStorageLike,
} from "../PsxPlayer/types.js";

import type { DiscSet, PsxAdapter, PsxStartConfig, Unsubscribe } from "../shared.types.js";
import type { PsxCanvasLike, PsxContainerLike } from "../PsxDisplay/types.js";
import type { PsxGestureSourceLike } from "../PsxAudio/types.js";
import type { GamepadSourceConfig } from "../GamepadSource/types.js";
import type { KeyboardSourceConfig } from "../KeyboardSource/types.js";
import type { PsxInputLike } from "../PsxInput/types.js";
import type {
    PsxPlayerConfig,
    PsxPlayerStatus,
    PsxPlayerStorageLike,
} from "../PsxPlayer/types.js";

export interface PsxLocalFileLike extends Blob {
    readonly name: string;
    readonly webkitRelativePath?: string;
}

export interface PsxFileListLike {
    readonly length: number;
    readonly [index: number]: PsxLocalFileLike;
    item?(index: number): PsxLocalFileLike | null;
}

export interface PsxLocalFilesConfig {
    readonly gameId: string;
    readonly entry?: string;
}

export interface PsxConsolePlayerLike {
    readonly status: PsxPlayerStatus;
    readonly input: PsxInputLike | null;
    start(config: PsxStartConfig): Promise<void>;
    stop(): Promise<void>;
    destroy(): Promise<void>;
    on(type: "status", listener: (status: PsxPlayerStatus) => void): Unsubscribe;
}

export interface PsxConsoleGameStoreLike {
    import(game: DiscSet, options?: { readonly displayTitle?: string }): Promise<{ readonly gameId: string }>;
    get(gameId: string): Promise<DiscSet | null>;
}

export interface PsxConsoleConfig {
    readonly player: PsxConsolePlayerLike;
    readonly keyboard?: Omit<KeyboardSourceConfig, "input">;
    readonly gamepad?: Omit<GamepadSourceConfig, "input" | "assignments">;
    readonly gameStore?: PsxConsoleGameStoreLike;
}

export interface PsxConsoleInitConfig {
    readonly adapter: PsxAdapter;
    readonly canvas: PsxCanvasLike;
    readonly container: PsxContainerLike;
    readonly gestureSource: PsxGestureSourceLike;
    readonly storage?: PsxPlayerStorageLike;
    readonly profileId?: string;
    readonly memoryCardIds?: PsxPlayerConfig["memoryCardIds"];
    readonly intervalScheduler?: PsxPlayerConfig["intervalScheduler"];
    readonly autoSaveIntervalMs?: number;
    readonly keyboard?: Omit<KeyboardSourceConfig, "input">;
    readonly gamepad?: Omit<GamepadSourceConfig, "input" | "assignments">;
    readonly gameStore?: PsxConsoleGameStoreLike;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null;

const isPlayer = (value: unknown): value is PsxConsolePlayerLike => isObject(value)
    && isPsxPlayerStatus(value.status) && (value.input === null || isObject(value.input))
    && typeof value.start === "function" && typeof value.stop === "function"
    && typeof value.destroy === "function" && typeof value.on === "function";

const isGameStore = (value: unknown): value is PsxConsoleGameStoreLike => isObject(value)
    && typeof value.import === "function" && typeof value.get === "function";

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

export function isPsxLocalFilesConfig(value: unknown): value is PsxLocalFilesConfig {
    return isObject(value) && typeof value.gameId === "string" && value.gameId.trim().length > 0
        && (value.entry === undefined || (typeof value.entry === "string" && value.entry.length > 0));
}

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
