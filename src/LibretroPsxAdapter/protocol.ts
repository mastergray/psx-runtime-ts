import {
    isControllerPort,
    isPsxAxis,
    isPsxButton,
    isPsxControllerType,
    isPsxMachineInfo,
    isPsxRegion,
} from "../shared.types.js";

import type {
    ControllerPort,
    PsxAxis,
    PsxButton,
    PsxControllerType,
    PsxMachineInfo,
    PsxRegion,
} from "../shared.types.js";

interface WorkerEnvelope {
    readonly requestId: number;
    readonly generation: number;
}

export interface WorkerStartPayload {
    readonly contentPath: string;
    readonly gameId: string;
    readonly region: PsxRegion;
    readonly controllers: Readonly<Record<ControllerPort, PsxControllerType>>;
    readonly options: Readonly<Record<string, string | number | boolean>>;
}

export type WorkerCommand =
    | (WorkerEnvelope & { readonly type: "start"; readonly payload: WorkerStartPayload })
    | (WorkerEnvelope & { readonly type: "tick"; readonly timestamp: number })
    | (WorkerEnvelope & { readonly type: "set-button"; readonly port: ControllerPort; readonly button: PsxButton; readonly pressed: boolean })
    | (WorkerEnvelope & { readonly type: "set-axis"; readonly port: ControllerPort; readonly axis: PsxAxis; readonly value: number })
    | (WorkerEnvelope & { readonly type: "pause" })
    | (WorkerEnvelope & { readonly type: "resume" })
    | (WorkerEnvelope & { readonly type: "reset"; readonly kind: "soft" | "hard" })
    | (WorkerEnvelope & { readonly type: "set-disc"; readonly index: number })
    | (WorkerEnvelope & { readonly type: "read-memory-card"; readonly slot: ControllerPort })
    | (WorkerEnvelope & { readonly type: "serialize-state" })
    | (WorkerEnvelope & { readonly type: "unserialize-state"; readonly bytes: Uint8Array })
    | (WorkerEnvelope & { readonly type: "return-video-buffer"; readonly bufferId: number; readonly buffer: ArrayBuffer })
    | (WorkerEnvelope & { readonly type: "exit" });

export type WorkerRequestType =
    | "start" | "pause" | "resume" | "reset" | "set-disc"
    | "read-memory-card" | "serialize-state" | "unserialize-state" | "exit";

export type WorkerResponseResult =
    | null
    | PsxMachineInfo
    | Uint8Array
    | { readonly discIndex: number; readonly trayOpen: boolean };

export interface WorkerErrorData {
    readonly code: number;
    readonly message: string;
    readonly data: unknown;
}

export type WorkerResponse =
    | (WorkerEnvelope & {
        readonly type: "response";
        readonly command: WorkerRequestType;
        readonly ok: true;
        readonly result: WorkerResponseResult;
    })
    | (WorkerEnvelope & {
        readonly type: "response";
        readonly command: WorkerRequestType;
        readonly ok: false;
        readonly error: WorkerErrorData;
    });

export type WorkerEvent =
    | { readonly type: "tick"; readonly generation: number }
    | { readonly type: "geometry"; readonly generation: number; readonly width: number; readonly height: number; readonly aspectRatio: number }
    | { readonly type: "frame"; readonly generation: number; readonly bufferId: number; readonly width: number; readonly height: number; readonly aspectRatio: number; readonly rgba: ArrayBuffer }
    | { readonly type: "sound"; readonly generation: number; readonly samples: ArrayBuffer; readonly frames: number }
    | { readonly type: "rumble"; readonly generation: number; readonly port: ControllerPort; readonly strong: number; readonly weak: number }
    | { readonly type: "dropped-time"; readonly generation: number; readonly milliseconds: number; readonly videoFrames: number }
    | { readonly type: "error"; readonly generation: number; readonly error: WorkerErrorData }
    | { readonly type: "exit"; readonly generation: number };

export type WorkerOutput = WorkerResponse | WorkerEvent;

const REQUEST_TYPES: ReadonlyArray<WorkerRequestType> = [
    "start", "pause", "resume", "reset", "set-disc", "read-memory-card",
    "serialize-state", "unserialize-state", "exit",
];

const COMMAND_TYPES: ReadonlyArray<WorkerCommand["type"]> = [
    ...REQUEST_TYPES,
    "tick", "set-button", "set-axis", "return-video-buffer",
];

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null;

const isNonEmptyString = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;

const isNonNegativeInteger = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const isPositiveInteger = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value > 0;

const isFiniteNumber = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value);

const isArrayBuffer = (value: unknown): value is ArrayBuffer =>
    value instanceof ArrayBuffer || Object.prototype.toString.call(value) === "[object ArrayBuffer]";

const isUint8Array = (value: unknown): value is Uint8Array =>
    value instanceof Uint8Array || Object.prototype.toString.call(value) === "[object Uint8Array]";

const isEnvelope = (value: Record<string, unknown>): boolean =>
    isPositiveInteger(value.requestId) && isPositiveInteger(value.generation);

const isControllerRecord = (value: unknown): boolean => isObject(value)
    && Reflect.ownKeys(value).length === 2
    && isPsxControllerType(value["1"]) && isPsxControllerType(value["2"]);

const isOptions = (value: unknown): boolean => isObject(value) && !Array.isArray(value)
    && Reflect.ownKeys(value).every((key) => typeof key === "string" && isNonEmptyString(key)
        && (typeof value[key] === "string" || typeof value[key] === "boolean" || isFiniteNumber(value[key])));

export function isWorkerStartPayload(value: unknown): value is WorkerStartPayload {
    if (!isObject(value) || !isNonEmptyString(value.contentPath)
        || !value.contentPath.startsWith("/content/") || value.contentPath.includes("\\")
        || /[\u0000-\u001f\u007f]/u.test(value.contentPath)) return false;
    const segments = value.contentPath.split("/");
    return segments.every((segment, index) => index === 0 || (segment.length > 0 && segment !== "." && segment !== ".."))
        && isNonEmptyString(value.gameId) && isPsxRegion(value.region)
        && isControllerRecord(value.controllers) && isOptions(value.options);
}

export function isWorkerCommand(value: unknown): value is WorkerCommand {
    if (!isObject(value) || !isEnvelope(value)
        || !COMMAND_TYPES.includes(value.type as WorkerCommand["type"])) return false;
    switch (value.type) {
        case "start": return isWorkerStartPayload(value.payload);
        case "tick": return isFiniteNumber(value.timestamp) && value.timestamp >= 0;
        case "set-button": return isControllerPort(value.port)
            && isPsxButton(value.button) && typeof value.pressed === "boolean";
        case "set-axis": return isControllerPort(value.port) && isPsxAxis(value.axis)
            && isFiniteNumber(value.value) && value.value >= -1 && value.value <= 1;
        case "reset": return value.kind === "soft" || value.kind === "hard";
        case "set-disc": return isNonNegativeInteger(value.index);
        case "read-memory-card": return isControllerPort(value.slot);
        case "unserialize-state": return isUint8Array(value.bytes) && value.bytes.byteLength > 0;
        case "return-video-buffer": return isNonNegativeInteger(value.bufferId)
            && isArrayBuffer(value.buffer);
        default: return true;
    }
}

const isErrorData = (value: unknown): value is WorkerErrorData => isObject(value)
    && typeof value.code === "number" && Number.isSafeInteger(value.code)
    && isNonEmptyString(value.message);

const isGeometry = (value: Record<string, unknown>): boolean =>
    isPositiveInteger(value.width) && isPositiveInteger(value.height)
    && isFiniteNumber(value.aspectRatio) && value.aspectRatio > 0;

const isResponseResult = (command: WorkerRequestType, result: unknown): boolean => {
    switch (command) {
        case "start": return isPsxMachineInfo(result);
        case "read-memory-card":
            return isUint8Array(result) && result.byteLength === 128 * 1024;
        case "serialize-state": return isUint8Array(result) && result.byteLength > 0;
        case "set-disc": return isObject(result) && isNonNegativeInteger(result.discIndex)
            && typeof result.trayOpen === "boolean";
        default: return result === null;
    }
};

export function isWorkerOutput(value: unknown): value is WorkerOutput {
    if (!isObject(value) || !isPositiveInteger(value.generation) || !isNonEmptyString(value.type)) return false;
    if (value.type === "response") {
        if (!isPositiveInteger(value.requestId)
            || !REQUEST_TYPES.includes(value.command as WorkerRequestType)
            || typeof value.ok !== "boolean") return false;
        return value.ok
            ? isResponseResult(value.command as WorkerRequestType, value.result)
            : isErrorData(value.error);
    }
    switch (value.type) {
        case "tick":
        case "exit": return true;
        case "geometry": return isGeometry(value);
        case "frame": return isGeometry(value) && isNonNegativeInteger(value.bufferId)
            && isArrayBuffer(value.rgba)
            && value.rgba.byteLength === (value.width as number) * (value.height as number) * 4;
        case "sound": return isArrayBuffer(value.samples) && isNonNegativeInteger(value.frames)
            && value.samples.byteLength === value.frames * 2 * Float32Array.BYTES_PER_ELEMENT;
        case "rumble": return isControllerPort(value.port)
            && isFiniteNumber(value.strong) && value.strong >= 0 && value.strong <= 1
            && isFiniteNumber(value.weak) && value.weak >= 0 && value.weak <= 1;
        case "dropped-time": return isFiniteNumber(value.milliseconds) && value.milliseconds >= 0
            && isNonNegativeInteger(value.videoFrames);
        case "error": return isErrorData(value.error);
        default: return false;
    }
}

export function isWorkerRequestType(value: unknown): value is WorkerRequestType {
    return REQUEST_TYPES.includes(value as WorkerRequestType);
}
