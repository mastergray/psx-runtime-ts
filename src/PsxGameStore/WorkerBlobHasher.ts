// Dependencies:
import PsxRuntimeError from "../PsxRuntimeError/PsxRuntimeError.js";    // Produces stable storage errors for Worker and cancellation failures

// Type dependencies:
import type { PsxBlobHasherLike } from "./types.js";                   // Public hashing boundary implemented by this Worker-backed class

/**
 *
 * Type Declarations
 *
 */

// TYPE :: {type:"result"|"error", sha256:STRING?, message:STRING?}
// Message returned by the isolated incremental hashing Worker.
interface HashWorkerResult {
    readonly type: "result" | "error";        // Result discriminant emitted by the hashing Worker
    readonly sha256?: string;                  // Lowercase digest supplied for successful results
    readonly message?: string;                 // Failure detail supplied for error results
}

// METHOD :: STRING, UNKNOWN -> psxRuntimeError
// Creates a stable storage failure for hashing boundary errors.
const failed = (message: string, data: unknown): PsxRuntimeError => new PsxRuntimeError({
    code: PsxRuntimeError.CODE.STORAGE_FAILED,
    message,
    data,
});

/**
 *
 * Class
 *
 */

// Hashes large Blobs incrementally in a disposable module Worker.
export default class WorkerBlobHasher implements PsxBlobHasherLike {

    // CONSTRUCTOR :: VOID -> workerBlobHasher
    // Creates a stateless worker-backed hashing boundary.
    constructor() {}

    /**
     *
     * Instance Methods
     *
     */

    // METHOD :: blob, abortSignal? -> PROMISE(STRING)
    // Returns the Blob's lowercase SHA-256 digest without loading it on the main thread.
    hash(blob: Blob, signal?: AbortSignal): Promise<string> {
        if (!(blob instanceof Blob)) return Promise.reject(failed("Only Blob content can be hashed.", null));
        if (signal?.aborted === true) return Promise.reject(failed("Game import was cancelled.", { type: "cancelled" }));
        return new Promise((resolve, reject) => {
            let settled = false;
            let worker: Worker;
            const finish = (result: { readonly hash: string } | { readonly error: unknown }): void => {
                if (settled) return;
                settled = true;
                signal?.removeEventListener("abort", abort);
                worker.terminate();
                if ("hash" in result) resolve(result.hash);
                else reject(result.error);
            };
            const abort = (): void => finish({
                error: failed("Game import was cancelled.", { type: "cancelled" }),
            });
            try {
                worker = new Worker(new URL("./hash.worker.js", import.meta.url), { type: "module" });
            } catch (error) {
                reject(failed("The game-content hashing Worker could not be created.", error));
                return;
            }
            worker.onmessage = ({ data }: MessageEvent<HashWorkerResult>) => {
                if (data?.type === "result" && typeof data.sha256 === "string"
                    && /^[a-f0-9]{64}$/u.test(data.sha256)) {
                    finish({ hash: data.sha256 });
                    return;
                }
                finish({ error: failed(data?.message ?? "The hashing Worker returned invalid output.", data) });
            };
            worker.onerror = (event) => finish({
                error: failed("The game-content hashing Worker failed.", event.message),
            });
            signal?.addEventListener("abort", abort, { once: true });
            worker.postMessage({ type: "hash", blob });
        });
    }

}
