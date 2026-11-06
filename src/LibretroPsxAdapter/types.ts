// Dependencies:
import {
    isFetchResponseLike,    // Validates fetched build metadata responses
    isFrameScheduler,       // Validates optional pacing injection
    isPsxBuildInfo,         // Validates immutable core-build metadata
} from "../shared.types.js";

// Type dependencies:
import type {
    FetchLike,          // Build metadata request boundary
    FrameScheduler,    // Animation-frame pacing boundary
    PsxBuildInfo,      // Immutable core capabilities and identity
} from "../shared.types.js";

/**
 *
 * Type Declarations
 *
 */

// INTERFACE :: {data:UNKNOWN}
// Minimal worker message event consumed by the client.
export interface WorkerMessageEventLike {
    readonly data: unknown;    // Untrusted payload requiring protocol validation
}

// INTERFACE :: {message:STRING?, error:UNKNOWN?}
// Minimal worker error event normalized by the client.
export interface WorkerErrorEventLike {
    readonly message?: string;    // Browser-provided failure text
    readonly error?: unknown;     // Browser-provided error object when available
}

// INTERFACE :: worker messaging, listener, and termination operations
// Minimal module-worker boundary owned by one client.
export interface PsxWorker {
    postMessage(message: unknown, transfer?: Transferable[]): void;                                     // Sends one command and optional ownership transfers
    addEventListener(type: "message", listener: (event: WorkerMessageEventLike) => void): void;         // Installs a message listener
    addEventListener(type: "error", listener: (event: WorkerErrorEventLike) => void): void;             // Installs an error listener
    removeEventListener(type: "message", listener: (event: WorkerMessageEventLike) => void): void;      // Removes a message listener
    removeEventListener(type: "error", listener: (event: WorkerErrorEventLike) => void): void;          // Removes an error listener
    terminate(): void;                                                                                    // Immediately ends worker ownership
}

// TYPE :: STRING -> psxWorker
// Factory that creates one module worker for a resolved artifact URL.
export type WorkerFactory = (url: string) => PsxWorker;

// TYPE :: VOID -> NUMBER
// Monotonic millisecond clock used when scheduler timestamps are invalid.
export type PsxClock = () => number;

// TYPE :: "baseline"|"instrumented"|"sequential-read-reuse"
// Development-only execution variant selected before a session starts.
export type PsxDiagnosticVariant = "baseline" | "instrumented" | "sequential-read-reuse";

// INTERFACE :: {buildUrl:STRING, build:psxBuildInfo, createWorker:workerFactory, scheduler:frameScheduler?, clock:psxClock?, diagnosticVariant:psxDiagnosticVariant?}
// Validated dependencies retained by a libretro adapter instance.
export interface LibretroPsxAdapterConfig {
    readonly buildUrl: string;                 // Root used to resolve worker and module artifacts
    readonly build: PsxBuildInfo;              // Validated immutable build metadata
    readonly createWorker: WorkerFactory;      // Worker construction boundary
    readonly scheduler?: FrameScheduler;       // Optional deterministic pacing override
    readonly clock?: PsxClock;                 // Optional deterministic clock override
    readonly diagnosticVariant?: PsxDiagnosticVariant; // Development-only measurement variant; defaults to baseline
}

// INTERFACE :: {buildUrl:STRING, fetch:fetchLike?, createWorker:workerFactory?, scheduler:frameScheduler?, clock:psxClock?, diagnosticVariant:psxDiagnosticVariant?}
// High-level factory input used before build metadata has been fetched.
export interface LibretroPsxAdapterInitConfig {
    readonly buildUrl: string;                 // Root containing build.json and core artifacts
    readonly fetch?: FetchLike;                // Optional build metadata request override
    readonly createWorker?: WorkerFactory;     // Optional worker construction override
    readonly scheduler?: FrameScheduler;       // Optional pacing override
    readonly clock?: PsxClock;                 // Optional monotonic clock override
    readonly diagnosticVariant?: PsxDiagnosticVariant; // Development-only measurement variant; defaults to baseline
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
// True when value is a string containing at least one non-whitespace character.
const isNonEmptyString = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value exposes the worker operations required by the client.
export function isPsxWorker(value: unknown): value is PsxWorker {
    return isObject(value) && typeof value.postMessage === "function"
        && typeof value.addEventListener === "function"
        && typeof value.removeEventListener === "function"
        && typeof value.terminate === "function";
}

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value is callable as a worker factory.
export function isWorkerFactory(value: unknown): value is WorkerFactory {
    return typeof value === "function";
}

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value selects a supported development-only measurement variant.
export function isPsxDiagnosticVariant(value: unknown): value is PsxDiagnosticVariant {
    return value === "baseline" || value === "instrumented" || value === "sequential-read-reuse";
}

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value supplies validated build metadata and runtime worker dependencies.
export function isLibretroPsxAdapterConfig(value: unknown): value is LibretroPsxAdapterConfig {
    return isObject(value) && isNonEmptyString(value.buildUrl) && isPsxBuildInfo(value.build)
        && isWorkerFactory(value.createWorker)
        && (value.scheduler === undefined || isFrameScheduler(value.scheduler))
        && (value.clock === undefined || typeof value.clock === "function")
        && (value.diagnosticVariant === undefined || isPsxDiagnosticVariant(value.diagnosticVariant));
}

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value supplies a build root and valid optional browser overrides.
export function isLibretroPsxAdapterInitConfig(value: unknown): value is LibretroPsxAdapterInitConfig {
    return isObject(value) && isNonEmptyString(value.buildUrl)
        && (value.fetch === undefined || typeof value.fetch === "function")
        && (value.createWorker === undefined || isWorkerFactory(value.createWorker))
        && (value.scheduler === undefined || isFrameScheduler(value.scheduler))
        && (value.clock === undefined || typeof value.clock === "function")
        && (value.diagnosticVariant === undefined || isPsxDiagnosticVariant(value.diagnosticVariant));
}

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value satisfies the build metadata fetch-response boundary.
export function isBuildFetchResponse(value: unknown): boolean {
    return isFetchResponseLike(value);
}
