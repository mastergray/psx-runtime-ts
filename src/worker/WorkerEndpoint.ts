// Dependencies:
import PsxRuntimeError from "../PsxRuntimeError/PsxRuntimeError.js";        // Normalizes endpoint failures into the public error vocabulary
import { isWorkerOutput } from "../LibretroPsxAdapter/protocol.js";        // Guards every runtime output before crossing the Worker boundary

// Type dependencies:
import type { WorkerOutput } from "../LibretroPsxAdapter/protocol.js";     // Validated messages posted back to the main thread
import type WorkerRuntime from "./WorkerRuntime.js";                      // Command runtime delegated to by the endpoint

/**
 *
 * Type Declarations
 *
 */

// TYPE :: {postMessage:(workerOutput, [transferable]) -> VOID}
// Worker-global boundary used to post validated output and transfer ownership.
export interface WorkerPostTarget {
    postMessage(message: WorkerOutput, transfer: Transferable[]): void;    // Posts one output with its transferable payloads
}

// METHOD :: UNKNOWN -> NUMBER
// Recovers a valid generation for errors raised before command validation.
const generationOf = (value: unknown): number => {
    if (typeof value !== "object" || value === null) return 1;
    const generation = (value as { generation?: unknown }).generation;
    return typeof generation === "number" && Number.isSafeInteger(generation) && generation > 0
        ? generation
        : 1;
};

// METHOD :: workerOutput -> [transferable]
// Selects owned binary payloads that can be transferred without copying.
const transferablesFor = (output: WorkerOutput): Transferable[] => {
    if (output.type === "frame") return [output.rgba];
    if (output.type === "sound") return [output.samples];
    if (output.type === "response" && output.ok && output.result instanceof Uint8Array) {
        return [output.result.buffer as ArrayBuffer];
    }
    return [];
};

/**
 *
 * Class
 *
 */

// Validates and posts all messages produced by one Worker runtime.
export default class WorkerEndpoint {

    /* Instance Fields */
    private readonly _runtime: WorkerRuntime;       // Runtime that validates and executes incoming commands
    private readonly _target: WorkerPostTarget;     // Worker-global destination for validated outputs

    // CONSTRUCTOR :: workerRuntime, workerPostTarget -> workerEndpoint
    // Creates an endpoint around one runtime and one posting boundary.
    constructor(runtime: WorkerRuntime, target: WorkerPostTarget) {
        this._runtime = runtime;
        this._target = target;
    }

    /**
     *
     * Instance Methods
     *
     */

    // METHOD :: UNKNOWN -> PROMISE(VOID)
    // Dispatches an untrusted command and posts validated outputs or one normalized error.
    async receive(value: unknown): Promise<void> {
        try {
            const outputs = await this._runtime.dispatch(value);
            for (const output of outputs) {
                if (!isWorkerOutput(output)) throw new Error("Worker runtime produced an invalid message");
                this._target.postMessage(output, transferablesFor(output));
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
            this._target.postMessage(output, []);
        }
    }

}
