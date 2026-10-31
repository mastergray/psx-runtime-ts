import {
    isPsxRuntimeErrorConfig,
    type PsxRuntimeErrorConfig,
} from "./types.js";

const CODE = Object.freeze({
    INVALID_CODE: -1,
    INVALID_CONFIG: 1,
    INVALID_MESSAGE: 2,
    INTERNAL_ERROR: 3,
    CORE_LOAD_FAILED: 4,
    CONTENT_LOAD_FAILED: 5,
    DISC_SET_INVALID: 6,
    BIOS_INVALID: 7,
    CORE_START_FAILED: 8,
    NOT_STARTED: 9,
    ALREADY_STARTED: 10,
    DESTROYED: 11,
    FULLSCREEN_FAILED: 12,
    AUDIO_FAILED: 13,
    STORAGE_FAILED: 14,
    STATE_FAILED: 15,
    STATE_INCOMPATIBLE: 16,
    DISC_CHANGE_FAILED: 17,
    UNSUPPORTED: 18,
    WORKER_FAILED: 19,
    MEMORY_EXCEEDED: 20,
} as const);

export default class PsxRuntimeError extends Error {
    static readonly CODE = CODE;

    readonly code: number;
    readonly data: unknown;

    constructor(config: PsxRuntimeErrorConfig) {
        super(isPsxRuntimeErrorConfig(config) ? config.message : "");
        const invalidCode = (data: unknown): PsxRuntimeError => {
            const error = Object.assign(
                Object.create(PsxRuntimeError.prototype) as PsxRuntimeError,
                {
                    name: "PsxRuntimeError",
                    message: "Error code is not a constructible registry code.",
                    code: CODE.INVALID_CODE,
                    data,
                },
            );
            return Object.freeze(error);
        };
        const given = config as unknown;
        const code = typeof given === "object" && given !== null
            ? (given as { code?: unknown }).code
            : undefined;
        if (typeof code !== "number") throw invalidCode(null);
        if (!isPsxRuntimeErrorConfig(config)) {
            const message = typeof given === "object" && given !== null
                ? (given as { message?: unknown }).message ?? null
                : null;
            throw new PsxRuntimeError({
                code: CODE.INVALID_MESSAGE,
                message: "Error message must be a non-empty string.",
                data: message,
            });
        }
        const constructibleCodes = Object.values(CODE) as ReadonlyArray<number>;
        if (code === CODE.INVALID_CODE || !constructibleCodes.includes(code)) {
            throw invalidCode(code);
        }
        this.name = "PsxRuntimeError";
        this.code = code;
        this.data = config.data ?? null;
        Object.freeze(this);
    }

    get label(): string {
        return PsxRuntimeError.labelOf(this.code);
    }

    static init<T extends PsxRuntimeError, C>(this: new (config: C) => T, config: C): T {
        return new this(config);
    }

    static is(value: unknown): value is PsxRuntimeError {
        return value instanceof PsxRuntimeError;
    }

    static labelOf(code: number): string {
        const entry = Object.entries(CODE).find(([, registered]) => registered === code);
        return entry === undefined || code === CODE.INVALID_CODE ? "INVALID_CODE" : entry[0];
    }
}
