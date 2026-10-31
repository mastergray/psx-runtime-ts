import CTGTest, { CTGTestPredicates as P } from "ctg-js-test";
import {
    isPsxRuntimeErrorConfig,
    PsxRuntimeError,
} from "../../src/index.ts";

import type { PsxRuntimeErrorConfig } from "../../src/index.ts";
import type { TestFile } from "../run.ts";

const CODES = {
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
} as const;

const capture = (action: () => unknown): unknown => {
    try {
        action();
        return null;
    } catch (error) {
        return error;
    }
};

const snapshot = (value: unknown): object => PsxRuntimeError.is(value)
    ? { code: value.code, label: value.label, message: value.message, data: value.data }
    : { notRuntimeError: true };

const invalidConfig = (value: unknown): PsxRuntimeErrorConfig => value as PsxRuntimeErrorConfig;

const testFile: TestFile = {
    label: "M1 PsxRuntimeError",
    cases: [
        {
            label: "the frozen registry exactly matches the stable public code table",
            run: () => CTGTest.init("registry")
                .assert("codes and labels", () => ({
                    codes: PsxRuntimeError.CODE,
                    frozen: Object.isFrozen(PsxRuntimeError.CODE),
                    first: PsxRuntimeError.labelOf(1),
                    last: PsxRuntimeError.labelOf(20),
                    invalid: PsxRuntimeError.labelOf(999),
                }), P.equals<unknown>({ codes: CODES, frozen: true, first: "INVALID_CONFIG", last: "MEMORY_EXCEEDED", invalid: "INVALID_CODE" }))
                .start(undefined),
        },
        {
            label: "every constructible code yields an immutable typed Error",
            run: () => CTGTest.init("constructible codes")
                .assert("all twenty public codes", () => Object.values(CODES)
                    .filter((code) => code > 0)
                    .every((code) => {
                        const error = new PsxRuntimeError({ code, message: "failure", data: { code } });
                        return error instanceof Error && PsxRuntimeError.is(error)
                            && error.name === "PsxRuntimeError" && error.code === code
                            && Object.isFrozen(error);
                    }), P.equals<boolean>(true))
                .start(undefined),
        },
        {
            label: "invalid codes and messages fail with the constructor sentinels",
            run: () => CTGTest.init("constructor validation")
                .assert("typed construction failures", () => [
                    capture(() => new PsxRuntimeError({ code: -1, message: "m" })),
                    capture(() => new PsxRuntimeError({ code: 0, message: "m" })),
                    capture(() => new PsxRuntimeError({ code: 21, message: "m" })),
                    capture(() => new PsxRuntimeError(invalidConfig({ code: "1", message: "m" }))),
                    capture(() => new PsxRuntimeError({ code: 1, message: " " })),
                    capture(() => new PsxRuntimeError(invalidConfig({ code: 1 }))),
                ].map(snapshot), P.equals<unknown>([
                    { code: -1, label: "INVALID_CODE", message: "Error code is not a constructible registry code.", data: -1 },
                    { code: -1, label: "INVALID_CODE", message: "Error code is not a constructible registry code.", data: 0 },
                    { code: -1, label: "INVALID_CODE", message: "Error code is not a constructible registry code.", data: 21 },
                    { code: -1, label: "INVALID_CODE", message: "Error code is not a constructible registry code.", data: null },
                    { code: 2, label: "INVALID_MESSAGE", message: "Error message must be a non-empty string.", data: " " },
                    { code: 2, label: "INVALID_MESSAGE", message: "Error message must be a non-empty string.", data: null },
                ]))
                .start(undefined),
        },
        {
            label: "data semantics, factory inheritance, identity guard, and config predicate are stable",
            run: () => CTGTest.init("error API")
                .assert("API behavior", () => {
                    class SpecificError extends PsxRuntimeError {}
                    const data = { detail: true };
                    const error = PsxRuntimeError.init({ code: 3, message: "internal", data });
                    const specific = SpecificError.init({ code: 4, message: "load" });
                    return {
                        reference: error.data === data,
                        omitted: specific.data,
                        subclass: specific instanceof SpecificError,
                        guard: [PsxRuntimeError.is(error), PsxRuntimeError.is(new Error("x")), PsxRuntimeError.is(null)],
                        configs: [
                            isPsxRuntimeErrorConfig({ code: 1, message: "m" }),
                            isPsxRuntimeErrorConfig({ code: 1, message: " " }),
                            isPsxRuntimeErrorConfig({ code: "1", message: "m" }),
                            isPsxRuntimeErrorConfig(null),
                        ],
                    };
                }, P.equals<unknown>({
                    reference: true,
                    omitted: null,
                    subclass: true,
                    guard: [true, false, false],
                    configs: [true, false, false, false],
                }))
                .start(undefined),
        },
    ],
};

export default testFile;
