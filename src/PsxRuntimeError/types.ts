/**
 *
 * Type Declarations
 *
 */

// INTERFACE :: {code:NUMBER, message:STRING, data:UNKNOWN?}
// Constructor input for one stable runtime error.
export interface PsxRuntimeErrorConfig {
    readonly code: number;        // Stable numeric code from the public registry
    readonly message: string;     // Non-empty human-readable failure summary
    readonly data?: unknown;      // Optional structured diagnostic detail
}

/**
 *
 * Type Predicates
 *
 */

// PREDICATE :: UNKNOWN -> BOOLEAN
// True when value supplies a numeric code and a non-empty message.
export function isPsxRuntimeErrorConfig(value: unknown): value is PsxRuntimeErrorConfig {
    return typeof value === "object" && value !== null
        && typeof (value as PsxRuntimeErrorConfig).code === "number"
        && typeof (value as PsxRuntimeErrorConfig).message === "string"
        && (value as PsxRuntimeErrorConfig).message.trim().length > 0;
}
