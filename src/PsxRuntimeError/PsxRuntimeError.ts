// Dependencies and type dependencies:
import {
    isPsxRuntimeErrorConfig,          // Validates the constructor boundary before fields are committed
    type PsxRuntimeErrorConfig,       // Caller-supplied stable code, message, and diagnostic data
} from "./types.js";

/**
 *
 * Class
 *
 */

// Carries every stable runtime failure code across main-thread and Worker boundaries.
export default class PsxRuntimeError extends Error {

    /* Static Fields */
    static readonly CODE = Object.freeze({      // Frozen registry shared by validation, transport, and consumers
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
        ARCHIVE_INVALID: 21,
    } as const);

    /* Instance Fields */
    readonly code: number;                     // Stable numeric error code serialized across boundaries
    readonly data: unknown;                    // Optional structured diagnostics retained without interpretation

    // CONSTRUCTOR :: psxRuntimeErrorConfig -> psxRuntimeError
    // Validates and freezes one typed runtime error.
    constructor(config: PsxRuntimeErrorConfig) {
        super(isPsxRuntimeErrorConfig(config) ? config.message : "");
        const invalidCode = (data: unknown): PsxRuntimeError => {
            const error = Object.assign(
                Object.create(PsxRuntimeError.prototype) as PsxRuntimeError,
                {
                    name: "PsxRuntimeError",
                    message: "Error code is not a constructible registry code.",
                    code: PsxRuntimeError.CODE.INVALID_CODE,
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
                code: PsxRuntimeError.CODE.INVALID_MESSAGE,
                message: "Error message must be a non-empty string.",
                data: message,
            });
        }
        const constructibleCodes = Object.values(PsxRuntimeError.CODE) as ReadonlyArray<number>;
        if (code === PsxRuntimeError.CODE.INVALID_CODE || !constructibleCodes.includes(code)) {
            throw invalidCode(code);
        }
        this.name = "PsxRuntimeError";
        this.code = code;
        this.data = config.data ?? null;
        Object.freeze(this);
    }

    /**
     *
     * Properties
     *
     */

    // GETTER :: VOID -> STRING
    // Returns the symbolic registry label for this error code.
    get label(): string {
        return PsxRuntimeError.labelOf(this.code);
    }

    /**
     *
     * Static Methods
     *
     */

    // Static Factory Method :: C -> T
    // Constructs the polymorphic error type represented by this constructor.
    // NOTE: <T> is the constructed PsxRuntimeError subtype; <C> is its config.
    static init<T extends PsxRuntimeError, C>(this: new (config: C) => T, config: C): T {
        return new this(config);
    }

    // METHOD :: UNKNOWN -> BOOLEAN
    // Narrows a value to a runtime error instance.
    static is(value: unknown): value is PsxRuntimeError {
        return value instanceof PsxRuntimeError;
    }

    // METHOD :: NUMBER -> STRING
    // Resolves a stable numeric code to its symbolic registry label.
    static labelOf(code: number): string {
        const entry = Object.entries(PsxRuntimeError.CODE).find(([, registered]) => registered === code);
        return entry === undefined || code === PsxRuntimeError.CODE.INVALID_CODE ? "INVALID_CODE" : entry[0];
    }
}
