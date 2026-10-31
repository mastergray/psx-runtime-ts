export interface PsxRuntimeErrorConfig {
    readonly code: number;
    readonly message: string;
    readonly data?: unknown;
}

export function isPsxRuntimeErrorConfig(value: unknown): value is PsxRuntimeErrorConfig {
    return typeof value === "object" && value !== null
        && typeof (value as PsxRuntimeErrorConfig).code === "number"
        && typeof (value as PsxRuntimeErrorConfig).message === "string"
        && (value as PsxRuntimeErrorConfig).message.trim().length > 0;
}
