import Sha256 from "./Sha256.js";

interface HashRequest {
    readonly type: "hash";
    readonly blob: Blob;
}

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = ({ data }: MessageEvent<HashRequest>) => {
    void (async () => {
        if (data?.type !== "hash" || !(data.blob instanceof Blob)) throw new Error("Invalid hash request.");
        const hash = new Sha256();
        const reader = data.blob.stream().getReader();
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            hash.update(value);
        }
        scope.postMessage({ type: "result", sha256: hash.digestHex() });
    })().catch((error: unknown) => {
        scope.postMessage({
            type: "error",
            message: error instanceof Error ? error.message : "Blob hashing failed.",
        });
    });
};
