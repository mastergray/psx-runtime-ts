import PsxRuntimeError from "../PsxRuntimeError/PsxRuntimeError.js";

import type { PsxBlobHasherLike } from "./types.js";

interface HashWorkerResult {
    readonly type: "result" | "error";
    readonly sha256?: string;
    readonly message?: string;
}

const failed = (message: string, data: unknown): PsxRuntimeError => new PsxRuntimeError({
    code: PsxRuntimeError.CODE.STORAGE_FAILED,
    message,
    data,
});

export default class WorkerBlobHasher implements PsxBlobHasherLike {
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
