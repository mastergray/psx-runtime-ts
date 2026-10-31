import PsxRuntimeError from "../PsxRuntimeError/PsxRuntimeError.js";
import { isWorkerOutput } from "../LibretroPsxAdapter/protocol.js";

import type { WorkerOutput } from "../LibretroPsxAdapter/protocol.js";
import type WorkerRuntime from "./WorkerRuntime.js";

export interface WorkerPostTarget {
    postMessage(message: WorkerOutput, transfer: Transferable[]): void;
}

const generationOf = (value: unknown): number => {
    if (typeof value !== "object" || value === null) return 1;
    const generation = (value as { generation?: unknown }).generation;
    return typeof generation === "number" && Number.isSafeInteger(generation) && generation > 0
        ? generation
        : 1;
};

const transferablesFor = (output: WorkerOutput): Transferable[] => {
    if (output.type === "frame") return [output.rgba];
    if (output.type === "sound") return [output.samples];
    if (output.type === "response" && output.ok && output.result instanceof Uint8Array) {
        return [output.result.buffer as ArrayBuffer];
    }
    return [];
};

export default class WorkerEndpoint {
    readonly #runtime: WorkerRuntime;
    readonly #target: WorkerPostTarget;

    constructor(runtime: WorkerRuntime, target: WorkerPostTarget) {
        this.#runtime = runtime;
        this.#target = target;
    }

    async receive(value: unknown): Promise<void> {
        try {
            const outputs = await this.#runtime.dispatch(value);
            for (const output of outputs) {
                if (!isWorkerOutput(output)) throw new Error("Worker runtime produced an invalid message");
                this.#target.postMessage(output, transferablesFor(output));
            }
        } catch (caught) {
            const error = PsxRuntimeError.is(caught)
                ? caught
                : new PsxRuntimeError({
                    code: PsxRuntimeError.CODE.INTERNAL_ERROR,
                    message: caught instanceof Error ? caught.message : "Worker endpoint failed.",
                });
            const output: WorkerOutput = {
                type: "error",
                generation: generationOf(value),
                error: { code: error.code, message: error.message, data: error.data },
            };
            this.#target.postMessage(output, []);
        }
    }
}
