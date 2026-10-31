import {
    isFetchResponseLike,
    isFrameScheduler,
    isPsxBuildInfo,
} from "../shared.types.js";

import type {
    FetchLike,
    FrameScheduler,
    PsxBuildInfo,
} from "../shared.types.js";

export interface WorkerMessageEventLike {
    readonly data: unknown;
}

export interface WorkerErrorEventLike {
    readonly message?: string;
    readonly error?: unknown;
}

export interface PsxWorker {
    postMessage(message: unknown, transfer?: Transferable[]): void;
    addEventListener(type: "message", listener: (event: WorkerMessageEventLike) => void): void;
    addEventListener(type: "error", listener: (event: WorkerErrorEventLike) => void): void;
    removeEventListener(type: "message", listener: (event: WorkerMessageEventLike) => void): void;
    removeEventListener(type: "error", listener: (event: WorkerErrorEventLike) => void): void;
    terminate(): void;
}

export type WorkerFactory = (url: string) => PsxWorker;
export type PsxClock = () => number;

export interface LibretroPsxAdapterConfig {
    readonly buildUrl: string;
    readonly build: PsxBuildInfo;
    readonly createWorker: WorkerFactory;
    readonly scheduler?: FrameScheduler;
    readonly clock?: PsxClock;
}

export interface LibretroPsxAdapterInitConfig {
    readonly buildUrl: string;
    readonly fetch?: FetchLike;
    readonly createWorker?: WorkerFactory;
    readonly scheduler?: FrameScheduler;
    readonly clock?: PsxClock;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null;

const isNonEmptyString = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;

export function isPsxWorker(value: unknown): value is PsxWorker {
    return isObject(value) && typeof value.postMessage === "function"
        && typeof value.addEventListener === "function"
        && typeof value.removeEventListener === "function"
        && typeof value.terminate === "function";
}

export function isWorkerFactory(value: unknown): value is WorkerFactory {
    return typeof value === "function";
}

export function isLibretroPsxAdapterConfig(value: unknown): value is LibretroPsxAdapterConfig {
    return isObject(value) && isNonEmptyString(value.buildUrl) && isPsxBuildInfo(value.build)
        && isWorkerFactory(value.createWorker)
        && (value.scheduler === undefined || isFrameScheduler(value.scheduler))
        && (value.clock === undefined || typeof value.clock === "function");
}

export function isLibretroPsxAdapterInitConfig(value: unknown): value is LibretroPsxAdapterInitConfig {
    return isObject(value) && isNonEmptyString(value.buildUrl)
        && (value.fetch === undefined || typeof value.fetch === "function")
        && (value.createWorker === undefined || isWorkerFactory(value.createWorker))
        && (value.scheduler === undefined || isFrameScheduler(value.scheduler))
        && (value.clock === undefined || typeof value.clock === "function");
}

export function isBuildFetchResponse(value: unknown): boolean {
    return isFetchResponseLike(value);
}
